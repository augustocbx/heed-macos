import { Database } from "bun:sqlite";
import { defaultRetrievalPolicy, type RetrievalPolicy } from "./retrieval-policy";

export class RetrievalUnavailableError extends Error {
 readonly reason = "retrieval-unavailable";
 readonly status = 409;
 constructor() { super("Local retrieval is unavailable. Retry after source reconciliation."); }
}
export class RetrievalQueryError extends Error {
 readonly status = 400;
 constructor() { super("Use a valid question within the local retrieval size and term limits."); }
}
export interface RetrievalTerm { term: string; frequency: number; }
/** FTS5 is scratch-only: it supplies identical query/evidence tokens, never global ranking. */
export class ScratchTokenizer {
 private db: Database | null = null;
 constructor(open: () => Database = () => new Database(":memory:")) {
  try {
   this.db = open();
   this.db.exec("PRAGMA temp_store=MEMORY; PRAGMA mmap_size=0; CREATE VIRTUAL TABLE tokens USING fts5(text, tokenize='unicode61 remove_diacritics 2'); CREATE VIRTUAL TABLE terms USING fts5vocab(tokens, instance)");
   if (this.tokenize("Ação")[0]?.term !== "acao") throw new Error("Unsupported tokenizer");
  } catch { this.close(); throw new RetrievalUnavailableError(); }
 }
 tokenize(text: string): RetrievalTerm[] {
  if (!this.db) throw new RetrievalUnavailableError();
  // Existing evidence splits at UTF-16 boundaries, including an isolated half of an emoji.
  // Replace isolated halves before the Bun SQLite UTF-8 binding; otherwise it
  // can combine the half with the next character and swallow an adjacent term.
  // Exact original quote/offset bytes stay authoritative.
  if (typeof text !== "string" || text.length > defaultRetrievalPolicy.queryCharacters) throw new RetrievalQueryError();
  try {
   this.db.query("INSERT INTO tokens(rowid,text) VALUES(1,?)").run(Buffer.from(text,"utf8").toString("utf8"));
   return this.db.query("SELECT term, COUNT(*) AS frequency FROM terms GROUP BY term ORDER BY term COLLATE BINARY").all() as RetrievalTerm[];
  } catch { throw new RetrievalUnavailableError(); }
  finally { this.db.exec("DELETE FROM tokens"); }
 }
 close() { const db = this.db; this.db = null; db?.close(); }
}
function validScalarText(text: string): boolean {
 if (text.includes("\0")) return false;
 for (let i = 0; i < text.length; i++) {
  const code = text.charCodeAt(i);
  if (code >= 0xd800 && code <= 0xdbff) { const next = text.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
  else if (code >= 0xdc00 && code <= 0xdfff) return false;
 }
 return true;
}
export function normalizeRetrievalQuery(question: string, policy: RetrievalPolicy = defaultRetrievalPolicy): string[] {
 if (typeof question !== "string" || question.length > policy.queryCharacters || Buffer.byteLength(question) > policy.queryBytes || !validScalarText(question)) throw new RetrievalQueryError();
 const scratch = new ScratchTokenizer();
 try {
  const terms = scratch.tokenize(question).map(row => row.term);
  if (terms.length > policy.queryTerms) throw new RetrievalQueryError();
  return terms;
 } finally { scratch.close(); }
}
