import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {reserveAtomicWrite} from './atomic-json';
import { normalizeTag, tagKey, uniqueTags, type Session, type SessionPatch, type TagMutation, type TagSnapshot } from "@heed/shared";

import type {SessionLocalIo} from './local-store-io';

export class TagError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function atomicWrite(path: string, data: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const release=reserveAtomicWrite(path,Buffer.byteLength(data,'utf8'),temporary);
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    try {if (existsSync(temporary)) unlinkSync(temporary);}finally{release();}
  }
}

type Entry = { id: string; before: string; after: string };
type Journal = { committed: boolean; entries: Entry[] };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const assignmentRevision = (session: Session) => hash(session.tags ?? []);

/** All operations are synchronous after request parsing, so one server cannot interleave commits. */
export class SessionTags {
  private journal: string;
  constructor(private directory: string, private io = { writeAtomic: atomicWrite }, private readonly localIo?: SessionLocalIo) {
    this.journal = join(directory, ".tag-transaction");
  }

  private exists(path:string){return this.localIo ? this.localIo.exists(path) : existsSync(path);}
  private stat(path:string){return this.localIo ? this.localIo.stat(path) : lstatSync(path);}
  private unlink(path:string){if(this.localIo)this.localIo.unlink(path);else unlinkSync(path);}
  private readText(path:string,maximum:number){return this.localIo ? this.localIo.readFile(path,maximum).toString('utf8') : readFileSync(path,'utf8');}

  private path(id: string): string {
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new TagError("Invalid meeting ID");
    const path = join(this.directory, `${id}.json`);
    if (this.exists(path) && !this.stat(path).isFile()) throw new TagError("Invalid meeting file", 500);
    return path;
  }

  recover(): void {
    if (!this.exists(this.journal)) return;
    if (!this.stat(this.journal).isFile()) throw new TagError("Invalid tag transaction", 500);
    const journal: Journal = JSON.parse(this.readText(this.journal, 131_072));
    if (!Array.isArray(journal.entries) || typeof journal.committed !== "boolean") throw new TagError("Invalid tag transaction", 500);
    // Validate the entire journal before restoring any file.
    for (const entry of journal.entries) {
      this.path(entry.id);
      if (typeof entry.before !== "string" || typeof entry.after !== "string") throw new TagError("Invalid tag transaction", 500);
    }
    if (!journal.committed) {
      for (const entry of journal.entries) this.io.writeAtomic(this.path(entry.id), entry.before);
      this.unlink(this.journal);
    } else {
      // The commit is durable; a cleanup failure must not turn success into a false failed save.
      try { this.unlink(this.journal); } catch { /* Retry cleanup on the next request. */ }
    }
  }

  read(id: string): Session | null {
    this.recover();
    const path = this.path(id);
    if (!this.exists(path)) return null;
    const session = JSON.parse(this.readText(path, 65_536)) as Session;
    if (!session || session.id !== id || (session.tags !== undefined && (!Array.isArray(session.tags) || session.tags.some(t => typeof t !== "string")))) {
      throw new TagError("Invalid meeting file", 500);
    }
    return { ...session, tags: session.tags ?? [], tagsRevision: assignmentRevision(session) };
  }

  snapshot(): TagSnapshot {
    this.recover();
    const sessions = (this.localIo ? this.localIo.list(this.directory,512) : readdirSync(this.directory)).filter(f => f.endsWith(".json")).sort().map(file => this.read(file.slice(0, -5))!);
    const tags = new Map<string, { name: string; meetingCount: number }>();
    for (const session of sessions) {
      for (const name of uniqueTags(session.tags)) {
        const key = tagKey(name);
        const existing = tags.get(key);
        if (existing) existing.meetingCount++; else tags.set(key, { name, meetingCount: 1 });
      }
    }
    return {
      sessions,
      tags: [...tags.values()].sort((a, b) => a.name.localeCompare(b.name)),
      revision: hash(sessions.map(s => [s.id, s.tags])),
    };
  }

  create(session: Session): Session {
    this.recover();
    const path = this.path(session.id);
    if (this.exists(path)) throw new TagError("Meeting already exists", 409);
    const tags = uniqueTags(session.tags ?? [], this.snapshot().tags.map(t => t.name));
    this.io.writeAtomic(path, JSON.stringify({ ...session, tags, tagsRevision: undefined }, null, 2));
    return this.read(session.id)!;
  }

  /** Validate the raw client patch before merging so missing revisions cannot be inherited. */
  preparePatch(existing: Session, patch: SessionPatch): SessionPatch {
    const { tagsRevision, ...fields } = patch;
    if (fields.tags !== undefined) {
      if (tagsRevision !== existing.tagsRevision) throw new TagError("Tags changed. Reload and try again.", 409);
      if (!Array.isArray(fields.tags) || fields.tags.some(t => typeof t !== "string" || !normalizeTag(t))) throw new TagError("Enter a tag name");
      fields.tags = uniqueTags(fields.tags, this.snapshot().tags.map(t => t.name));
    }
    return fields;
  }

  /** Trusted synchronous metadata writes preserve assignments exactly. */
  save(session: Session): Session {
    this.recover();
    this.io.writeAtomic(this.path(session.id), JSON.stringify({ ...session, tagsRevision: undefined }, null, 2));
    return this.read(session.id)!;
  }

  patch(id: string, patch: SessionPatch): Session {
    const existing = this.read(id);
    if (!existing) throw new TagError("Meeting not found", 404);
    const fields = this.preparePatch(existing, patch);
    return this.save({ ...existing, ...fields, id: existing.id, createdAt: existing.createdAt, updatedAt: new Date().toISOString() });
  }

  remove(id: string): void {
    this.recover();
    const path = this.path(id);
    if (this.exists(path)) this.unlink(path);
  }

  mutate(input: TagMutation): TagSnapshot {
    const snapshot = this.snapshot();
    if (!input || typeof input.tag !== "string" || !normalizeTag(input.tag)) throw new TagError("Enter a tag name");
    if (!["add", "remove", "rename", "delete"].includes(input.action)) throw new TagError("Invalid tag action");
    if (input.expectedRevision !== snapshot.revision) throw new TagError("Tags changed. Reload and try again.", 409);
    const key = tagKey(input.tag);
    const known = snapshot.tags.find(t => tagKey(t.name) === key);
    let name = known?.name ?? normalizeTag(input.tag);
    if (input.action === "rename") {
      if (typeof input.name !== "string" || !normalizeTag(input.name)) throw new TagError("Enter a tag name");
      name = normalizeTag(input.name);
      if (snapshot.tags.some(t => tagKey(t.name) === tagKey(name) && tagKey(t.name) !== key)) throw new TagError("Tag already exists", 409);
    }
    if (input.action !== "add" && !known) throw new TagError("Tag not found", 404);
    if ((input.action === "add" || input.action === "remove") && !snapshot.sessions.some(s => s.id === input.sessionId)) throw new TagError("Meeting not found", 404);

    const entries: Entry[] = [];
    for (const session of snapshot.sessions) {
      if ((input.action === "add" || input.action === "remove") && session.id !== input.sessionId) continue;
      const hasTag = session.tags.some(t => tagKey(t) === key);
      let tags = session.tags;
      if (input.action === "add") tags = uniqueTags([...tags, name], snapshot.tags.map(t => t.name));
      else if (input.action === "rename" && hasTag) tags = uniqueTags(tags.map(t => tagKey(t) === key ? name : t));
      else if (hasTag) tags = tags.filter(t => tagKey(t) !== key);
      if (JSON.stringify(tags) === JSON.stringify(session.tags)) continue;
      const path = this.path(session.id);
      entries.push({ id: session.id, before: this.readText(path, 65_536), after: JSON.stringify({ ...session, tags, tagsRevision: undefined, updatedAt: new Date().toISOString() }, null, 2) });
    }
    if (!entries.length) return snapshot;
    // One durable journal stages every original and replacement before the first change.
    this.io.writeAtomic(this.journal, JSON.stringify({ committed: false, entries }));
    try {
      for (const entry of entries) this.io.writeAtomic(this.path(entry.id), entry.after);
      this.io.writeAtomic(this.journal, JSON.stringify({ committed: true, entries }));
    } catch (error) {
      this.recover();
      throw error;
    }
    this.recover();
    return this.snapshot();
  }
}

export async function tagResponse(req: Request, store: SessionTags, normalize: (session: Session) => Session = session => session): Promise<Response> {
  try {
    const snapshot = req.method === "GET" ? store.snapshot() : store.mutate(await req.json());
    return Response.json({ ...snapshot, sessions: snapshot.sessions.map(normalize) });
  } catch (error) {
    const message = error instanceof TagError ? error.message : "Failed to save tags";
    return Response.json({ error: message }, { status: error instanceof TagError ? error.status : 500 });
  }
}

export async function sessionResponse(req: Request, store: SessionTags): Promise<Response> {
  try {
    if (req.method === "GET") return Response.json(store.snapshot().sessions.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
    if (req.method === "POST") {
      const input = await req.json();
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new TagError("Invalid meeting");
      const session = store.create({ ...input, id: input.id || `session-${Date.now()}`, createdAt: input.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() });
      return Response.json(session);
    }
    const id = new URL(req.url).searchParams.get("id");
    if (!id) throw new TagError("No id");
    if (req.method === "PATCH") {
      const patch = await req.json();
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TagError("Invalid meeting patch");
      return Response.json(store.patch(id, patch));
    }
    if (req.method === "DELETE") { store.remove(id); return Response.json({ ok: true }); }
    return new Response(null, { status: 405 });
  } catch (error) {
    return Response.json({ error: error instanceof TagError ? error.message : "Failed to save meeting" }, { status: error instanceof TagError ? error.status : 500 });
  }
}
