import {existsSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {atomicWriteJson} from './atomic-json';
import {MacSmbNative,SmbProvider,smbProbe,destinationHeader,type SmbNative,type SmbBinding,type SmbIdentity} from './smb-provider';
interface Job {attempts:number;next:number}
interface Connection extends SmbBinding {enabled:boolean;jobs:Record<string,Job>;acknowledged:string[];retryAt:number;failures:number;lastSync:number|null;error:string|null;imported:number;skipped:number;bytes:number}
interface State {version:1;connections:Connection[]}
interface Library {selectProvider(provider?:SmbProvider):void;snapshot():{localMeetings?:{id:string;title:string}[];previews:{revisionId:string;state:string;bytes?:number;local?:boolean}[];imported:number;skipped:number;complete:boolean;error?:string};discover(signal?:AbortSignal):Promise<unknown>;importSelected(ids?:string[],signal?:AbortSignal):Promise<unknown>;queueLocal(id:string,signal?:AbortSignal):Promise<{revisionId:string;state:string}>;publish(id:string,signal?:AbortSignal):Promise<unknown>}
interface Options {path:string;native?:SmbNative;library:Library;busy:()=>boolean;write?:typeof atomicWriteJson;now?:()=>number}
interface Receipt {receipt:string;folder:string;identity:SmbIdentity;destinationId:string|null;security:SmbBinding['security'];readOnly:boolean;createdAt:number}
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const notice='SMB destination unavailable. Check the mount, permissions, security and library integrity, then test the connection again.';
function name(value:string){if(typeof value!=='string'||!value.trim()||value.length>80||/[\x00-\x1f\x7f]/.test(value))throw new Error('Invalid synchronization destination name.');return value.trim();}
function folder(value:string){if(typeof value!=='string'||!value.startsWith('/')||value.length>4096||value.split('/').some(p=>p==='.'||p==='..')||/[\x00-\x1f\x7f]/.test(value))throw new Error('Invalid mounted SMB folder.');return value.replace(/\/+$/,'');}
export function smbAddress(value:string):string {
 if(typeof value!=='string'||value.length>2048||/[@\\\x00-\x20]/.test(value)||!/^smb:\/\/[^/?#]+\/[^/?#]+\/?$/i.test(value))throw new Error('Enter a credential-free smb://server/share address.');
 const raw=value.replace(/^smb:/i,'https:');const url=new URL(raw);
 if(url.username||url.password||url.search||url.hash||url.port||!url.hostname||!/^\/[\w% .\-\u0080-\uffff]+\/?$/.test(url.pathname))throw new Error('Enter a credential-free smb://server/share address.');
 const part=decodeURIComponent(url.pathname);if(part.includes('..')||/[\\/@\x00-\x1f]/.test(part.slice(1))||url.pathname.includes('%25'))throw new Error('Enter a credential-free smb://server/share address.');
 return `smb://${url.host}${url.pathname.replace(/\/$/,'')}`;
}
export class SmbConnections {
 private state:State={version:1,connections:[]};private native:SmbNative;private receipts=new Map<string,Receipt>();private running=false;private controller:AbortController|null=null;private timer:ReturnType<typeof setInterval>|null=null;
 private desktop:{id:string;action:'folder'|'mount';address?:string;createdAt:number}|null=null;private selectedFolder:string|null=null;private desktopError:string|null=null;
 constructor(private options:Options){
  this.native=options.native||new MacSmbNative();
  if(existsSync(options.path)){const value=JSON.parse(readFileSync(options.path,'utf8')) as State;if(Object.keys(value).sort().join(',')!=='connections,version'||value.version!==1||!Array.isArray(value.connections)||value.connections.length>8||value.connections.filter(c=>c.enabled).length>1)throw new Error('Invalid SMB configuration; preserve it for recovery.');
   for(const c of value.connections){if(Object.keys(c).some(key=>!['id','name','root','identity','destinationId','readOnly','security','enabled','jobs','acknowledged','retryAt','failures','lastSync','error','imported','skipped','bytes'].includes(key))||!Number.isFinite(c.retryAt)||c.retryAt<0||!Number.isSafeInteger(c.failures)||c.failures<0||c.failures>30||![c.imported,c.skipped,c.bytes].every(n=>Number.isSafeInteger(n)&&n>=0)||!(c.lastSync===null||Number.isFinite(c.lastSync)&&c.lastSync>=0)||!(c.error===null||typeof c.error==='string'&&c.error.length<=512)||!UUID.test(c.id)||!UUID.test(c.destinationId)||name(c.name)!==c.name||folder(c.root)!==c.root||typeof c.enabled!=='boolean'||typeof c.readOnly!=='boolean'||!['signed','encrypted','unknown'].includes(c.security)||!c.jobs||typeof c.jobs!=='object'||Array.isArray(c.jobs)||Object.keys(c.jobs).length>10000||Object.entries(c.jobs).some(([id,j])=>!UUID.test(id)||!Number.isSafeInteger(j.attempts)||j.attempts<0||!Number.isFinite(j.next))||!Array.isArray(c.acknowledged)||c.acknowledged.length>10000||c.acknowledged.some(id=>!UUID.test(id)))throw new Error('Invalid SMB configuration; preserve it for recovery.');smbProbe({identity:c.identity,security:c.security,dialect:'unknown',authentication:'macOS-session'});}this.state=value;}
  this.select();
 }
 private now(){return this.options.now?.()??Date.now();}
 private edit(change:(next:State)=>void){const next=structuredClone(this.state);change(next);(this.options.write||atomicWriteJson)(this.options.path,next);this.state=next;}
 private current(id:string){const c=this.state.connections.find(c=>c.id===id);if(!c)throw new Error('Synchronization destination not found.');return c;}
 private select(){if(this.running)return;const c=this.state.connections.find(c=>c.enabled);this.options.library.selectProvider(c?new SmbProvider(c,this.native):undefined);}
 protectedRevisionIds():string[]{const ids=new Set(this.state.connections.flatMap(c=>Object.keys(c.jobs)));const active=this.state.connections.find(c=>c.enabled&&!c.readOnly);if(active)for(const p of this.options.library.snapshot().previews)if(p.local&&!active.acknowledged.includes(p.revisionId))ids.add(p.revisionId);return [...ids];}
 snapshot(){return {connections:this.state.connections.map(({jobs,identity,acknowledged,retryAt,failures,...c})=>({...c,pending:Object.keys(jobs).length,nextRetryAt:retryAt||null,capabilities:{read:c.security!=='unknown',write:!c.readOnly&&c.security!=='unknown',transportSecurity:c.security,authentication:'macOS-session' as const,durability:'share-readback' as const,remoteDeletion:false}})),syncing:this.running,selectedFolder:this.selectedFolder,desktopPending:!!this.desktop,desktopError:this.desktopError};}
 start(){if(this.timer)return;this.timer=setInterval(()=>void this.tick(),30_000);this.timer.unref();}
 close(){if(this.timer)clearInterval(this.timer);this.timer=null;this.controller?.abort();}
 async test(selected:string){
  const root=folder(selected);try{const probe=smbProbe(await this.native.json({action:'probe',root}));if(probe.security==='unknown')throw new Error('SMB signing or encryption could not be verified. Reconnect using a protected SMB 2/3 session.');
   const header=destinationHeader(await this.native.json({action:'library',root,identity:probe.identity}));const readOnly=probe.identity.readOnly||await this.native.json({action:'test-write',root:header?join(root,'Heed Library'):root,identity:probe.identity}).then(()=>false,()=>true);
   if(!header&&readOnly)throw new Error('A read-only destination must contain an existing Heed library.');const receipt:Receipt={receipt:randomUUID(),folder:root,identity:probe.identity,destinationId:header?.destinationId??null,security:probe.security,readOnly,createdAt:this.now()};
   for(const [key,value] of this.receipts)if(this.now()-value.createdAt>600_000)this.receipts.delete(key);if(this.receipts.size>=16)this.receipts.delete(this.receipts.keys().next().value!);this.receipts.set(receipt.receipt,receipt);
   return {receipt:receipt.receipt,destinationId:receipt.destinationId,needsCreation:!header,readOnly,security:probe.security,dialect:probe.dialect,authentication:probe.authentication,folder:root};
  }catch(error){if(error instanceof Error&&/signing or encryption|read-only destination|Unsupported or corrupt/.test(error.message))throw error;throw new Error(notice);}
 }
 async connect(input:{name:string;receipt:string;create:boolean;connectionId?:string}){
  const title=name(input.name),receipt=this.receipts.get(input.receipt);if(!receipt||this.now()-receipt.createdAt>600_000)throw new Error('The access test expired. Test the destination again.');if(!receipt.destinationId&&!input.create)throw new Error('Confirm creation of the dedicated Heed library first.');
  if(this.running)throw new Error('Wait for synchronization to finish before changing destinations.');if(!input.connectionId&&this.state.connections.length>=8)throw new Error('Synchronization destination limit reached.');
  const probe=smbProbe(await this.native.json({action:'probe',root:receipt.folder}));if(probe.security==='unknown'||(receipt.security==='encrypted'&&probe.security!=='encrypted')||['fsid','sourceHash','mountPath'].some(k=>probe.identity[k as keyof SmbIdentity]!==receipt.identity[k as keyof SmbIdentity]))throw new Error(notice);
  let header=destinationHeader(await this.native.json({action:'library',root:receipt.folder,identity:receipt.identity}));
  if(header?.destinationId!==receipt.destinationId&&!(header===null&&receipt.destinationId===null))throw new Error('The SMB destination changed after the access test. Test it again.');
  if(!header){if(receipt.readOnly)throw new Error('SMB destination is read-only.');await this.native.json({action:'prepare',root:receipt.folder,identity:receipt.identity});header={format:'heed-portable-library',schemaVersion:1,destinationId:randomUUID()};await this.native.json({action:'create',root:join(receipt.folder,'Heed Library'),identity:receipt.identity,header});}
  const old=input.connectionId?this.current(input.connectionId):undefined;if(old&&old.destinationId!==header.destinationId)throw new Error('Destination identity changed. Disconnect it before connecting a different library.');
  const connection:Connection={id:old?.id||randomUUID(),name:title,root:join(receipt.folder,'Heed Library'),identity:probe.identity,destinationId:header.destinationId,readOnly:receipt.readOnly||probe.identity.readOnly,security:probe.security,enabled:true,jobs:old?.jobs||{},acknowledged:old?.acknowledged||[],retryAt:0,failures:0,lastSync:old?.lastSync||null,error:null,imported:old?.imported||0,skipped:old?.skipped||0,bytes:old?.bytes||0};
  this.edit(next=>{for(const c of next.connections)c.enabled=false;if(old)next.connections=next.connections.map(c=>c.id===old.id?connection:c);else next.connections.push(connection);});this.receipts.delete(input.receipt);this.select();if(this.timer)queueMicrotask(()=>void this.tick());return this.snapshot();
 }
 rename(id:string,value:string){this.current(id);const title=name(value);this.edit(next=>{next.connections.find(c=>c.id===id)!.name=title;});this.select();return this.snapshot();}
 enable(id:string,enabled:boolean){this.current(id);this.edit(next=>{for(const c of next.connections)if(c.id===id)c.enabled=enabled;else if(enabled)c.enabled=false;});this.controller?.abort();this.select();return this.snapshot();}
 disconnect(id:string){this.current(id);this.edit(next=>{next.connections=next.connections.filter(c=>c.id!==id);});this.controller?.abort();this.select();return this.snapshot();}
 desktopRequest(action:'folder'|'mount',address?:string){if(this.desktop&&this.now()-this.desktop.createdAt<90_000)throw new Error('A macOS connection request is already pending.');const safe=action==='mount'?smbAddress(address!):undefined;this.desktop={id:randomUUID(),action,address:safe,createdAt:this.now()};this.desktopError=null;return this.snapshot();}
 desktopCommand(){if(this.desktop&&this.now()-this.desktop.createdAt>=90_000){this.desktop=null;this.desktopError='The macOS request expired. Open the Heed menu bar app and try again.';}return this.desktop?{id:this.desktop.id,action:this.desktop.action,address:this.desktop.address}:null;}
 desktopReport(id:string,selected:string|null,error:boolean){if(this.desktop?.id!==id)throw new Error('The macOS request expired.');if(this.desktop.action==='folder'&&selected)this.selectedFolder=folder(selected);this.desktop=null;this.desktopError=error?'The macOS connection request was canceled or unavailable.':null;return this.snapshot();}
 async tick(force=false){
  if(this.running||this.options.busy())return this.snapshot();const initial=this.state.connections.find(c=>c.enabled);if(!initial||!force&&initial.retryAt>this.now())return this.snapshot();this.running=true;const controller=this.controller=new AbortController();const signal=controller.signal;
  try{
   const provider=new SmbProvider(initial,this.native);this.options.library.selectProvider(provider);await this.options.library.discover(signal);signal.throwIfAborted();let snap=this.options.library.snapshot();if(!snap.complete||snap.error)throw new Error(notice);await this.options.library.importSelected(undefined,signal);signal.throwIfAborted();
   snap=this.options.library.snapshot();this.edit(next=>{const c=next.connections.find(c=>c.id===initial.id);if(c){c.imported=snap.imported;c.skipped=snap.skipped;c.bytes=snap.previews.reduce((sum,p)=>sum+(p.bytes||0),0);}});
   if(!initial.readOnly){
    for(const meeting of (snap.localMeetings||[]).slice(0,10000)){signal.throwIfAborted();if(this.options.busy())break;const preview=await this.options.library.queueLocal(meeting.id,signal);if(this.current(initial.id).acknowledged.includes(preview.revisionId))continue;this.edit(next=>{const c=next.connections.find(c=>c.id===initial.id);if(c&&!c.jobs[preview.revisionId]){if(Object.keys(c.jobs).length>=10000)throw new Error('Synchronization queue limit reached.');c.jobs[preview.revisionId]={attempts:0,next:0};}});}
    const queued=this.current(initial.id).jobs;
    for(const [id,job] of Object.entries(queued)){signal.throwIfAborted();if(this.options.busy())break;if(!force&&job.next>this.now())continue;await this.options.library.publish(id,signal);const verified=this.options.library.snapshot().previews.find(p=>p.revisionId===id)?.state==='verified';this.edit(next=>{const c=next.connections.find(c=>c.id===initial.id);if(!c)return;if(verified){if(c.acknowledged.length>=10000&&!c.acknowledged.includes(id))throw new Error('Synchronization acknowledgment limit reached.');delete c.jobs[id];if(!c.acknowledged.includes(id))c.acknowledged.push(id);}else{const attempts=Math.min(30,job.attempts+1);c.jobs[id]={attempts,next:this.now()+Math.min(3_600_000,30_000*2**Math.min(attempts,7))};}});}
   }
   this.edit(next=>{const c=next.connections.find(c=>c.id===initial.id);if(c){c.lastSync=this.now();c.failures=0;c.retryAt=0;c.error=Object.keys(c.jobs).length?'Some revisions are pending. Retry after checking access and quota.':null;}});
  }catch{if(!signal.aborted){try{this.edit(next=>{const c=next.connections.find(c=>c.id===initial.id);if(c){c.error=notice;c.failures=Math.min(30,c.failures+1);c.retryAt=this.now()+Math.min(3_600_000,30_000*2**Math.min(c.failures,7));}});}catch{/* Preserve previous durable state; do not leak private OS error strings. */}}}
  finally{this.running=false;this.controller=null;this.select();}
  return this.snapshot();
 }
}
