import {existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {atomicWriteJson} from './atomic-json';

export const DEFAULT_MANAGED_LIMIT=2_000_000_000;
export const MIN_MANAGED_LIMIT=1_048_576;
export const MAX_MANAGED_LIMIT=8_000_000_000_000;
export function validManagedLimit(value:unknown):value is number {
 return typeof value==='number' && Number.isSafeInteger(value) && value>=MIN_MANAGED_LIMIT && value<=MAX_MANAGED_LIMIT;
}
export function configuredManagedLimit(value:unknown):number {return validManagedLimit(value)?value:DEFAULT_MANAGED_LIMIT;}
export type ManagedCategory='text'|'media'|'indexes'|'staging';
interface Reservation {bytes:number;paths:string[]}
const containsPath=(parent:string,path:string)=>path===parent || path.startsWith(`${parent}${sep}`);
interface ManagedFile {path:string;bytes:number;modified:number;category:ManagedCategory;identity:string}
export interface QuotaSnapshot {
 limitBytes:number;usedBytes:number;reservedBytes:number;protectedBytes:number;reclaimableBytes:number;availableBytes:number;
 categories:Record<ManagedCategory,number>;
}
export interface QuotaPreview extends QuotaSnapshot {requestedLimit:number;removals:Array<{path:string;bytes:number}>;token:string}
interface Options {
 ledgerPath:string;roots:Partial<Record<ManagedCategory,string[]>>;getLimit:()=>number;setLimit:(bytes:number)=>void;
 protectedPaths:()=>string[];onEvicted?:(paths:string[])=>void;
}

/** One server owns synchronous claims; durable remaining allocations survive restarts. */
export class ManagedQuota {
 private reservations:Record<string,Reservation>={};
 constructor(private options:Options){
  mkdirSync(dirname(options.ledgerPath),{recursive:true,mode:0o700});
  if(existsSync(options.ledgerPath)){
   const ledger=JSON.parse(readFileSync(options.ledgerPath,'utf8'));
   if(ledger.version!==1 || !ledger.reservations || typeof ledger.reservations!=='object')throw new Error('Invalid quota reservation ledger; retain it for recovery');
   for(const [id,entry] of Object.entries(ledger.reservations)){
    const item=entry as Reservation;
    if(!Number.isSafeInteger(item.bytes) || item.bytes<0 || !Array.isArray(item.paths) || item.paths.some(path=>typeof path!=='string' || !this.managedPath(path)))throw new Error('Invalid quota reservation ledger');
    this.reservations[id]=item;
   }
   // Atomic writers cannot still be running in this newly started authoritative server.
   let recovered=false;
   for(const [id,item] of Object.entries(this.reservations))if(id.startsWith('write-')){
    const primary=item.paths[0];
    for(const path of item.paths.slice(1))if(path.startsWith(`${primary}.`) && /^\.[0-9a-f-]{36}\.tmp$/.test(path.slice(primary.length)) && existsSync(path) && lstatSync(path).isFile())unlinkSync(path);
    delete this.reservations[id];recovered=true;
   }
   if(recovered)this.persist();
  }
 }
 private persist(){atomicWriteJson(this.options.ledgerPath,{version:1,reservations:this.reservations});}
 private managedPath(path:string):boolean{
  const target=resolve(path);
  return Object.values(this.options.roots).flat().some(root=>{
   const base=resolve(root);const rel=relative(base,target);
   if(rel==='..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep))return false;
   if(existsSync(base) && lstatSync(base).isSymbolicLink())return false;
   // Existing ancestors cannot redirect a future allocation outside the managed root.
   let ancestor=target;while(!existsSync(ancestor) && ancestor!==dirname(ancestor))ancestor=dirname(ancestor);
   if(!existsSync(base))return ancestor===base || base.startsWith(`${ancestor}${sep}`);
   const actual=realpathSync(ancestor),actualRoot=realpathSync(base);
   return actual===actualRoot || actual.startsWith(`${actualRoot}${sep}`);
  });
 }
 private files():ManagedFile[]{
  const files:ManagedFile[]=[];const seen=new Set<string>();
  const visit=(path:string,category:ManagedCategory)=>{
   if(!existsSync(path))return;const stat=lstatSync(path);if(stat.isSymbolicLink())return;
   if(stat.isDirectory()){for(const name of readdirSync(path).sort())visit(join(path,name),category);return;}
   if(!stat.isFile() || resolve(path)===resolve(this.options.ledgerPath))return;
   const identity=`${stat.dev}:${stat.ino}`;if(seen.has(identity))return;seen.add(identity);
   files.push({path:resolve(path),bytes:stat.size,modified:stat.mtimeMs,category,identity});
  };
  for(const [category,roots] of Object.entries(this.options.roots))for(const root of roots)visit(root,category as ManagedCategory);
  return files;
 }
 private inspect(){
  const files=this.files();const protectedPaths=new Set([...this.options.protectedPaths(),...Object.values(this.reservations).flatMap(item=>item.paths)].map(path=>resolve(path)));
  const reclaimable=files.filter(file=>file.category==='media' && ![...protectedPaths].some(path=>containsPath(path,file.path))).sort((a,b)=>a.modified-b.modified || a.path.localeCompare(b.path));
  const categories={text:0,media:0,indexes:0,staging:0};for(const file of files)categories[file.category]+=file.bytes;
  const usedBytes=files.reduce((sum,file)=>sum+file.bytes,0);
  const reservedBytes=Object.values(this.reservations).reduce((sum,item)=>sum+Math.max(0,item.bytes-files.filter(file=>item.paths.some(path=>containsPath(path,file.path))).reduce((n,file)=>n+file.bytes,0)),0);
  const reclaimableBytes=reclaimable.reduce((sum,file)=>sum+file.bytes,0);const limitBytes=this.options.getLimit();
  const snapshot:QuotaSnapshot={limitBytes,usedBytes,reservedBytes,reclaimableBytes,protectedBytes:usedBytes-reclaimableBytes+reservedBytes,availableBytes:Math.max(0,limitBytes-usedBytes-reservedBytes),categories};
  return {files,reclaimable,snapshot};
 }
 snapshot():QuotaSnapshot{return this.inspect().snapshot;}
 atomicWriteBudget(path:string,bytes:number,temporary?:string):()=>void{
  if(resolve(path)===resolve(this.options.ledgerPath) || !this.managedPath(path))return ()=>{};
  const current=existsSync(path)?lstatSync(path).size:0;
  const allocation=Object.values(this.reservations).find(item=>item.paths.some(root=>containsPath(root,resolve(path))));
  if(allocation){
   const used=this.files().filter(file=>allocation.paths.some(root=>containsPath(root,file.path))).reduce((sum,file)=>sum+file.bytes,0);
   if(used+bytes>allocation.bytes)throw new Error('Managed meeting quota reservation cannot fit the atomic replacement copy');
   return ()=>{};
  }
  const id=`write-${randomUUID()}`;
  this.reserve(id,current+bytes,[path,...(temporary?[temporary]:[])]);return ()=>this.release(id);
 }
 reserve(id:string,bytes:number,paths:string[]=[]):void{
  if(typeof id!=='string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id) || !Number.isSafeInteger(bytes) || bytes<0 || !Array.isArray(paths) || paths.some(path=>typeof path!=='string' || !this.managedPath(path)))throw new Error('Invalid quota reservation');
  const entry={bytes,paths:[...new Set(paths.map(path=>resolve(path)))].sort()};const previous=this.reservations[id];
  if(previous){if(JSON.stringify(previous)!==JSON.stringify(entry))throw new Error('Quota reservation key was reused');return;}
  if(Object.values(this.reservations).some(item=>item.paths.some(path=>entry.paths.some(candidate=>containsPath(path,candidate)||containsPath(candidate,path)))))throw new Error('Managed file already has a quota reservation');
  const before=this.reservations;this.reservations={...before,[id]:entry};
  if(this.snapshot().usedBytes+this.snapshot().reservedBytes>this.options.getLimit()){this.reservations=before;throw new Error('Managed meeting quota has insufficient available space');}
  try{this.persist();}catch(error){this.reservations=before;throw error;}
 }
 release(id:string):void{
  if(!this.reservations[id])return;const before=this.reservations;this.reservations={...before};delete this.reservations[id];
  try{this.persist();}catch(error){this.reservations=before;throw error;}
 }
 preview(requestedLimit:number):QuotaPreview{
  // Public HTTP settings enforce the documented range; tiny controlled budgets test the service.
  if(!Number.isSafeInteger(requestedLimit) || requestedLimit<=0)throw new Error('Choose a valid integer-byte quota');
  const {files,reclaimable,snapshot}=this.inspect();
  if(requestedLimit<snapshot.protectedBytes)throw new Error('Requested quota is below protected meeting data and reservations');
  const removals:Array<{path:string;bytes:number}>=[];let remaining=snapshot.usedBytes+snapshot.reservedBytes;
  for(const file of reclaimable){if(remaining<=requestedLimit)break;removals.push({path:file.path,bytes:file.bytes});remaining-=file.bytes;}
  const token=createHash('sha256').update(JSON.stringify({requestedLimit,limit:snapshot.limitBytes,files,reservations:this.reservations,protected:this.options.protectedPaths().sort()})).digest('hex');
  return {...snapshot,requestedLimit,removals,token};
 }
 apply(requestedLimit:number,token:string):QuotaSnapshot{
  const preview=this.preview(requestedLimit);if(typeof token!=='string' || token!==preview.token)throw new Error('Quota preview changed; review cleanup again');
  // No await: no second server job can acquire space between review and removal.
  for(const file of preview.removals)unlinkSync(file.path);
  if(preview.removals.length)this.options.onEvicted?.(preview.removals.map(file=>file.path));
  const updated=this.snapshot();if(updated.usedBytes+updated.reservedBytes>requestedLimit)throw new Error('Quota usage changed during cleanup; review the storage limit again');
  this.options.setLimit(requestedLimit);return this.snapshot();
 }
}
