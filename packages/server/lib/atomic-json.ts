import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

let writeBudget:((path:string,bytes:number,temporary?:string)=>()=>void)|undefined;
/** The server registers its managed roots; config/credentials remain outside this budget. */
export function setAtomicWriteBudget(budget:typeof writeBudget):void {writeBudget=budget;}
export function reserveAtomicWrite(path:string,bytes:number,temporary?:string):()=>void{return writeBudget?.(path,bytes,temporary) ?? (()=>{});}

/** The rename is the transaction boundary: readers see a complete old or new record. */
export function atomicWriteJson(path: string, value: unknown): void {
 const data=JSON.stringify(value,null,2);
 const temporary = `${path}.${randomUUID()}.tmp`;
 const release=reserveAtomicWrite(path,Buffer.byteLength(data,'utf8'),temporary);
 let descriptor: number | undefined;
 try {
  descriptor = openSync(temporary, "wx", 0o600);
  writeFileSync(descriptor, data, "utf8");
  fsyncSync(descriptor);
  closeSync(descriptor); descriptor = undefined;
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
 } finally {
  if (descriptor !== undefined) closeSync(descriptor);
  try { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
  finally {release();}
 }
}
