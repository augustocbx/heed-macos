import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** The rename is the transaction boundary: readers see a complete old or new record. */
export function atomicWriteJson(path: string, value: unknown): void {
 const temporary = `${path}.${randomUUID()}.tmp`;
 let descriptor: number | undefined;
 try {
  descriptor = openSync(temporary, "wx", 0o600);
  writeFileSync(descriptor, JSON.stringify(value, null, 2), "utf8");
  fsyncSync(descriptor);
  closeSync(descriptor); descriptor = undefined;
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
 } finally {
  if (descriptor !== undefined) closeSync(descriptor);
  try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
 }
}
