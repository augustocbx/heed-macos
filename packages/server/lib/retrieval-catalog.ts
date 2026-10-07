import { createHash } from "node:crypto";
import { tagKey,uniqueTags,type LibraryChatPreview, type LibraryChatScope, type Session } from "@heed/shared";
import type { RetrievalSnapshot, RetrievalSourceStamp } from "../../shared/types/retrieval";
import { normalizeChatScope } from "./library-chat";
import { iterateTranscriptEvidence } from "./meeting-chat";
import { SessionTags, type CommittedSessionChange } from "./session-tags";
import type { RetrievalPolicy } from "./retrieval-policy";

export interface RetrievalDescriptor extends RetrievalSourceStamp { title: string; tags: string[]; displayTags:string[]; finalized: boolean; nonempty: boolean; evidenceCount: number; }
export type RetrievalScope = { kind: "meeting"; sessionId: string } | { kind: "library"; scope: LibraryChatScope };
export class RetrievalCatalogError extends Error {
 readonly status = 409;
 constructor(readonly reason: "retrieval-not-ready" | "retrieval-capacity" | "scope-changed") { super(reason); }
}
interface Options { store: SessionTags; isBusy: () => boolean; now: () => number; policy: RetrievalPolicy; }
interface Pass { ids: IterableIterator<string>; descriptors: Map<string, RetrievalDescriptor>; changes: Map<string, RetrievalDescriptor | null>; invalidation: number; seen: number; bytes: number; }
const binary = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const stamp = (value: RetrievalDescriptor): RetrievalSourceStamp => ({ sessionId: value.sessionId, sourceRevision: value.sourceRevision, transcriptVersion: value.transcriptVersion });

/** Text-free authoritative scope metadata; only a completed discovery admits queries. */
export class RetrievalCatalog {
 private descriptors = new Map<string, RetrievalDescriptor>();
 private descriptorBytes = 0;
 private sizes = new WeakMap<RetrievalDescriptor, number>();
 private status: "discovering" | "ready" | "capacity" | "unavailable" = "discovering";
 private scopes = new WeakMap<RetrievalSnapshot, RetrievalScope>();
 private invalidation = 0;
 private epoch = 0;
 private validated = new WeakMap<RetrievalSnapshot, number>();
 private pass?: Pass;
 private running?: Promise<void>;
 private closed = false;
 private unsubscribe: () => void;
 private lastReconciled = -Infinity;
 constructor(private options: Options) {
  this.unsubscribe = options.store.subscribeCommitted(change => this.observe(change), () => this.observe({ kind: "invalidate" }));
 }
 state() { return this.status; }
 reconciliationDue() { return this.status !== "ready" || this.options.now() - this.lastReconciled >= 30_000; }
 private descriptor(session: Session): RetrievalDescriptor {
  if (typeof session.id !== "string" || typeof session.title !== "string" || typeof session.transcript !== "string" || !Array.isArray(session.segments) || !Array.isArray(session.tags) || typeof session.transcriptRevision !== "string" || !Number.isSafeInteger(session.transcriptVersion) || session.transcriptVersion! < 0) throw new RetrievalCatalogError("retrieval-not-ready");
  const prior = this.descriptors.get(session.id);
  const sameSource = prior?.sourceRevision === session.transcriptRevision && prior.transcriptVersion === session.transcriptVersion;
  let evidenceCount = sameSource ? prior!.evidenceCount : 0;
  if (!sameSource) for (const _evidence of iterateTranscriptEvidence(session)) evidenceCount++;
  return { sessionId: session.id, sourceRevision: session.transcriptRevision, transcriptVersion: session.transcriptVersion!, title: session.title,
   tags: [...new Set(session.tags.map(tagKey).filter(Boolean))].sort(binary), displayTags:uniqueTags(session.tags).sort(), finalized: session.transcriptFinalized === true, nonempty: evidenceCount > 0, evidenceCount };
 }
 private bytes(value: RetrievalDescriptor | undefined | null): number {
  if (!value) return 0;
  let size = this.sizes.get(value); if (size === undefined) { size = Buffer.byteLength(JSON.stringify(value)); this.sizes.set(value, size); } return size;
 }
 private withinBudget(size: number, bytes: number): boolean {
  return size <= this.options.policy.catalogSources && bytes <= this.options.policy.catalogBytes;
 }
 private replace(values: Map<string, RetrievalDescriptor>, id: string, descriptor: RetrievalDescriptor | null, bytes: number): number {
  bytes += this.bytes(descriptor) - this.bytes(values.get(id));
  if (descriptor) values.set(id, descriptor); else values.delete(id); return bytes;
 }
 observe(change: CommittedSessionChange): void {
  if (this.closed) return;
  this.epoch++;
  if (change.kind === "invalidate") { this.invalidation++; this.status = "unavailable"; return; }
  const descriptor = change.kind === "upsert" ? this.descriptor(change.session) : null;
  const id = change.kind === "upsert" ? change.session.id : change.sessionId;
  const bytes = this.descriptorBytes + this.bytes(descriptor) - this.bytes(this.descriptors.get(id));
  const size = this.descriptors.size + (descriptor ? Number(!this.descriptors.has(id)) : -Number(this.descriptors.has(id)));
  if (!this.withinBudget(size, bytes)) { this.invalidation++; this.status = "capacity"; return; }
  this.descriptorBytes = this.replace(this.descriptors, id, descriptor, this.descriptorBytes);
  if (this.pass && !this.pass.changes.has(id) && this.pass.changes.size >= this.options.policy.catalogSources) {
   // A busy discovery may outlive arbitrarily many create/delete operations. Restart its
   // bounded overlay instead of retaining tombstones for every historical identity.
   this.invalidation++; this.status = "unavailable"; return;
  }
  this.pass?.changes.set(id, descriptor);
 }
 private normalize(scope: RetrievalScope): RetrievalScope {
  if (scope?.kind === "library") return { kind: "library", scope: normalizeChatScope(scope.scope) };
  if (scope?.kind !== "meeting" || typeof scope.sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(scope.sessionId)) throw new RetrievalCatalogError("scope-changed");
  return { kind: "meeting", sessionId: scope.sessionId };
 }
 private selected(scope: RetrievalScope) {
  const values = [...this.descriptors.values()].filter(value => {
   if (!value.finalized || !value.nonempty) return false;
   if (scope.kind === "meeting") return value.sessionId === scope.sessionId;
   const selection = scope.scope;
   return selection.mode === "all" || (selection.labels.length > 0 && (selection.match === "all" ? selection.labels.every(label => value.tags.includes(label)) : selection.labels.some(label => value.tags.includes(label))));
  }).sort((a, b) => binary(a.sessionId, b.sessionId));
  const sources = values.map(stamp);
  const key = createHash("sha256").update(JSON.stringify({ scope, descriptors: values })).digest("hex");
  for(const source of sources)Object.freeze(source);Object.freeze(sources);
  return { snapshot: Object.freeze({ key, sources }) as RetrievalSnapshot, descriptors: values.map(value => ({ ...value, tags: [...value.tags], displayTags: [...value.displayTags] })) };
 }
 resolve(scope: RetrievalScope) {
  if (this.status !== "ready") throw new RetrievalCatalogError(this.status === "capacity" ? "retrieval-capacity" : "retrieval-not-ready");
  const normalized = this.normalize(scope), result = this.selected(normalized); this.scopes.set(result.snapshot, normalized); this.validated.set(result.snapshot, this.epoch); return result;
 }
 validate(snapshot: RetrievalSnapshot): void {
  if (this.status !== "ready") throw new RetrievalCatalogError(this.status === "capacity" ? "retrieval-capacity" : "retrieval-not-ready");
  const scope = this.scopes.get(snapshot); if (!scope) throw new RetrievalCatalogError("scope-changed");
  if(this.validated.get(snapshot)===this.epoch)return;
  const current = this.selected(scope).snapshot;
  if (snapshot.key !== current.key || JSON.stringify(snapshot.sources) !== JSON.stringify(current.sources)) throw new RetrievalCatalogError("scope-changed");
  this.validated.set(snapshot,this.epoch);
 }
 /** Existing public preview serialization, without loading transcript/history arrays. */
 preview(value:LibraryChatScope):LibraryChatPreview {
  if(this.status!=="ready")throw new RetrievalCatalogError(this.status==="capacity"?"retrieval-capacity":"retrieval-not-ready");
  const scope=normalizeChatScope(value),all=[...this.descriptors.values()],matching=all.filter(source=>scope.mode==='all'||scope.labels.length>0&&(scope.match==='all'?scope.labels.every(label=>source.tags.includes(label)):scope.labels.some(label=>source.tags.includes(label))));
  const sources=matching.filter(source=>source.finalized&&source.nonempty).map(source=>({sessionId:source.sessionId,title:source.title,tags:[...source.displayTags],sourceRevision:source.sourceRevision})).sort((a,b)=>a.sessionId.localeCompare(b.sessionId));
  const key=createHash('sha256').update(JSON.stringify({scope,sources})).digest('hex');
  return {snapshot:{key,scope,sources},ready:sources.length>0,matchingCount:matching.length,unavailableCount:matching.length-sources.length,availableLabels:uniqueTags(all.flatMap(source=>source.displayTags)).sort()};
 }
 describe(snapshot: RetrievalSnapshot): RetrievalDescriptor[] {
  this.validate(snapshot);return this.selected(this.scopes.get(snapshot)!).descriptors;
 }
 reconcile(signal?: AbortSignal): Promise<void> {
  if (this.running) return this.running;
  this.running = this.discover(signal).finally(() => { this.running = undefined; }); return this.running;
 }
 private async discover(signal?: AbortSignal): Promise<void> {
  if (this.closed) return;
  try {
   if (this.pass && this.pass.invalidation !== this.invalidation) { this.pass.ids.return?.(); this.pass = undefined; }
   this.pass ??= { ids: this.options.store.sourceIds(this.options.policy.catalogSources + 1), descriptors: new Map(), changes: new Map(), invalidation: this.invalidation, seen: 0, bytes: 0 };
   const pass = this.pass;
   while (!this.closed && !this.options.isBusy()) {
    signal?.throwIfAborted();
    if (pass.invalidation !== this.invalidation) { pass.ids.return?.(); this.pass = undefined; return; }
    const item = pass.ids.next();
    if (item.done) {
     for (const [id, descriptor] of pass.changes) pass.bytes = this.replace(pass.descriptors, id, descriptor, pass.bytes);
     if (!this.withinBudget(pass.descriptors.size, pass.bytes)) this.status = "capacity";
     else { this.descriptors = pass.descriptors; this.descriptorBytes = pass.bytes; this.epoch++; this.status = "ready"; this.lastReconciled = this.options.now(); }
     this.pass = undefined; return;
    }
    if (++pass.seen > this.options.policy.catalogSources) { this.status = "capacity"; pass.ids.return?.(); this.pass = undefined; return; }
    const session = this.options.store.read(item.value, this.options.policy.sourceRecordBytes);
    if (session) pass.bytes = this.replace(pass.descriptors, item.value, this.descriptor(session), pass.bytes);
    if (!this.withinBudget(pass.descriptors.size, pass.bytes)) { this.status = "capacity"; pass.ids.return?.(); this.pass = undefined; return; }
    await Bun.sleep(0);
   }
  } catch (error) {
   this.pass?.ids.return?.(); this.pass = undefined;
   if (signal?.aborted) throw error;
   this.status = "unavailable";
  }
 }
 close() { this.closed = true; this.unsubscribe(); this.pass?.ids.return?.(); this.pass = undefined; this.descriptors.clear(); this.descriptorBytes = 0; this.status = "unavailable"; }
}
