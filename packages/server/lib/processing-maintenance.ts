import {closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, unlinkSync} from 'node:fs';
import {atomicWriteJson} from './atomic-json';

export type ProcessingKind = 'mediaImport' | 'migration' | 'synchronization';
export interface UpdateLease {schema:1; transactionId:string; owner:string}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function validOwner(owner:unknown):owner is string {return typeof owner === 'string' && !!owner.trim() && owner.length <= 128;}

/** Admission and durable update ownership are synchronous, before any work yields. */
export class ProcessingMaintenance {
 private currentOwner?:string;
 private lease?:UpdateLease;
 private recoveryRequired = false;
 private operations = new Map<ProcessingKind, number>();
 constructor(private options:{path:string; active:()=>string[]; write?:typeof atomicWriteJson; setRecording?:(acquire:boolean,owner:string)=>void}) {
  try {this.lease = this.readLease(); this.currentOwner = this.lease?.owner;}
  catch {this.recoveryRequired = true;}
 }
 private readLease():UpdateLease|undefined {
  let fd:number;
  try {fd = openSync(this.options.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);}
  catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;}
  try {
   const info = fstatSync(fd);
   if (!info.isFile() || info.size > 4096) throw Error('Invalid update maintenance lease');
   const value = JSON.parse(readFileSync(fd,'utf8'));
   if (!value || value.schema !== 1 || !validOwner(value.owner) || typeof value.transactionId !== 'string' || !UUID.test(value.transactionId)) throw Error('Invalid update maintenance lease');
   return {schema:1, transactionId:value.transactionId, owner:value.owner};
  } finally {closeSync(fd);}
 }
 owner(){return this.currentOwner;}
 transactionId():string|null {return this.lease?.transactionId ?? null;}
 blocked(){return this.recoveryRequired || this.currentOwner !== undefined;}
 active():string[] {return [...new Set([...this.options.active(), ...[...this.operations].filter(([,count])=>count>0).map(([kind])=>kind), ...(this.recoveryRequired ? ['maintenanceRecovery'] : [])])];}
 enter(kind:ProcessingKind):()=>void {
  if (this.blocked()) throw Error('Processing is unavailable during maintenance');
  this.operations.set(kind, (this.operations.get(kind) ?? 0) + 1);
  let released = false;
  return () => {if (!released) {released = true; this.operations.set(kind, this.operations.get(kind)! - 1);}};
 }
 acquire(owner:string, transactionId?:string):void {
  if (this.recoveryRequired) throw Error('Update maintenance recovery is required; preserve the lease');
  if (!validOwner(owner) || transactionId !== undefined && !UUID.test(transactionId)) throw Error('Choose a valid maintenance owner and transaction');
  if (this.currentOwner !== undefined && this.currentOwner !== owner) throw Error('The maintenance guard belongs to another owner');
  if (this.lease && transactionId !== undefined && this.lease.transactionId !== transactionId) throw Error('Another update transaction owns maintenance');
  if (!this.currentOwner && this.active().length) throw Error('Wait for active processing to finish before maintenance');
  const alreadyHeld = this.currentOwner !== undefined;
  this.options.setRecording?.(true, owner);
  const lease = transactionId ? {schema:1 as const, owner, transactionId} : this.lease;
  try {
   if (lease && !this.lease) (this.options.write ?? atomicWriteJson)(this.options.path, lease);
   this.lease = lease; this.currentOwner = owner;
  } catch (error) {
   // Atomic replacement may succeed before its directory fsync fails.
   try {
    const actual = this.readLease();
    if (actual) {this.lease = actual; this.currentOwner = actual.owner;}
    else if (!alreadyHeld) this.options.setRecording?.(false, owner);
   } catch {this.recoveryRequired = true;}
   throw error;
  }
 }
 release(owner:string):void {
  if (this.recoveryRequired) throw Error('Update maintenance recovery is required; preserve the lease');
  if (!validOwner(owner) || this.currentOwner !== undefined && this.currentOwner !== owner) throw Error('The maintenance guard belongs to another owner');
  if (this.lease) {
   const actual = this.readLease();
   if (!actual || actual.owner !== owner || actual.transactionId !== this.lease.transactionId) throw Error('The update lease changed; recovery is required');
   // Keep admission blocked until both recording and the durable lease are released.
   unlinkSync(this.options.path);
   const parent = openSync(this.options.path.substring(0, this.options.path.lastIndexOf('/')), constants.O_RDONLY);
   try {fsyncSync(parent);} catch (error) {
    (this.options.write ?? atomicWriteJson)(this.options.path, this.lease); throw error;
   } finally {closeSync(parent);}
  }
  try {this.options.setRecording?.(false, owner);}
  catch (error) {
   if (this.lease) (this.options.write ?? atomicWriteJson)(this.options.path, this.lease);
   throw error;
  }
  this.lease = undefined; this.currentOwner = undefined;
 }
}
