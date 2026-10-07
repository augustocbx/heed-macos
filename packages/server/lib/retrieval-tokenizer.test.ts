import { expect, test } from "bun:test";
const tokenizer = await import("./retrieval-tokenizer").catch(() => null);
const policies = await import("./retrieval-policy").catch(() => null);
function module() { expect(tokenizer).not.toBeNull(); return tokenizer!; }

test("real FTS tokens fold PT accents identically for queries and evidence with exact frequencies", () => {
 const { ScratchTokenizer, normalizeRetrievalQuery } = module(), scratch = new ScratchTokenizer();
 try {
  expect(scratch.tokenize("Ação ação São João café CAFE\u0301")).toEqual([{ term: "acao", frequency: 2 }, { term: "cafe", frequency: 2 }, { term: "joao", frequency: 1 }, { term: "sao", frequency: 1 }]);
  expect(normalizeRetrievalQuery("São AÇÃO café São")).toEqual(["acao", "cafe", "sao"]);
  expect(scratch.tokenize("Different")).toEqual([{ term: "different", frequency: 1 }]);
 } finally { scratch.close(); }
});
test("literal punctuation and SQL-shaped queries never become SQLite commands", () => {
 const { normalizeRetrievalQuery } = module();
 expect(normalizeRetrievalQuery("' DROP TABLE quotes; -- action_item José's")).toEqual(["action", "drop", "item", "jose", "quotes", "s", "table"]);
 expect(normalizeRetrievalQuery("... !!!")).toEqual([]); expect(normalizeRetrievalQuery("Still works")).toEqual(["still", "works"]);
});
test("raw scalar and character bounds are enforced before tokenization", () => {
 const { normalizeRetrievalQuery } = module();
 for (const value of ["\0", "\ud800", "\udc00", "x".repeat(2001)]) expect(() => normalizeRetrievalQuery(value)).toThrow();
 expect(normalizeRetrievalQuery("x".repeat(2000))).toHaveLength(1);
});
test("distinct term budget rejects the next term rather than changing the question", () => {
 const { normalizeRetrievalQuery } = module();
 expect(normalizeRetrievalQuery(Array.from({ length: 64 }, (_, i) => `word${i}`).join(" "))).toHaveLength(64);
 expect(() => normalizeRetrievalQuery(Array.from({ length: 65 }, (_, i) => `word${i}`).join(" "))).toThrow();
});
test("smaller byte policy rejects raw multibyte overflow even when character budget fits", () => {
 expect(policies).not.toBeNull(); const policy = policies!.createRetrievalPolicy({ queryBytes: 8 });
 const { normalizeRetrievalQuery } = module(); expect(normalizeRetrievalQuery("ação", policy)).toEqual(["acao"]);
 expect(normalizeRetrievalQuery("açãoab", policy)).toEqual(["acaoab"]);
 expect(() => normalizeRetrievalQuery("açãoabc", policy)).toThrow();
 expect(() => normalizeRetrievalQuery("açãoação", policy)).toThrow();
});
test("runtime capability failure is typed unavailable and scratch data is released", () => {
 const { ScratchTokenizer, RetrievalUnavailableError } = module();
 expect(() => new ScratchTokenizer(() => { throw new Error("SQLite not available"); })).toThrow(RetrievalUnavailableError);
 const scratch = new ScratchTokenizer(); scratch.close(); expect(() => scratch.tokenize("Closed")).toThrow(RetrievalUnavailableError);
});
test("policy overrides cannot increase hard bounds or permit impossible hit allocations", () => {
 expect(policies).not.toBeNull(); const { createRetrievalPolicy } = policies!;
 for (const value of [{ queryRows: 100001 }, { databaseBytes: 67108865 }, { cacheEntries: 33 }, { queryTerms: 0 }, { candidateHits: 8 }, { anchors: 17 }]) expect(() => createRetrievalPolicy(value)).toThrow();
 expect(createRetrievalPolicy({ queryRows: 10 }).queryRows).toBe(10);
});
