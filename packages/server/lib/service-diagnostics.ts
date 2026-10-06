import {join} from 'node:path';
import {spawn} from 'node:child_process';
import type {ServiceDiagnostic} from '../../shared/types';
import {track,untrack,killTree} from './process';

type Ports={api:number;ui:number;transcription:number};
type Options={root:string;ports:Ports;env:Record<string,string|undefined>;apiOrigin?:string;now?:()=>number;run?:(refresh:boolean)=>Promise<unknown>};
const roles=['api','ui','transcription'] as const;
const states=['ready','stopped','starting','unhealthy','conflict','unavailable'];

function valid(value:unknown,ports:Ports,external:string|undefined):value is ServiceDiagnostic[]{
 if(!Array.isArray(value)||value.length!==3)return false;
 const expected={...ports};if(external){try{const url=new URL(external);expected.transcription=Number(url.port|| (url.protocol==='https:'?443:80));}catch{return false;}}
 const seen=new Set<string>();
 for(const item of value){
  if(!item||typeof item!=='object'||Object.keys(item).some(key=>!['service','port','state','application'].includes(key))||!roles.includes(item.service)||seen.has(item.service)||item.port!==expected[item.service as keyof Ports]||!states.includes(item.state))return false;
  if(item.application!==undefined&&(item.state!=='conflict'||typeof item.application!=='string'||!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(item.application)))return false;
  seen.add(item.service);
 }
 return seen.size===3;
}

/** The API and Vite share the same bounded local helper; public values contain no process metadata. */
export class ServiceDiagnostics {
 private cached?:{at:number;value:ServiceDiagnostic[]};
 private active?:Promise<ServiceDiagnostic[]>;
 private workers=new Set<{pid?:number;kill:(signal?:number|NodeJS.Signals)=>void;exited:Promise<number>}>();
 constructor(private options:Options){}
 async get(refresh=false):Promise<ServiceDiagnostic[]>{
  const now=this.options.now?.()??Date.now();
  if(!refresh&&this.cached&&now-this.cached.at>=0&&now-this.cached.at<5000)return structuredClone(this.cached.value);
  if(this.active){if(!refresh)return structuredClone(await this.active);await this.active;return this.get(true);}
  const operation=this.observe(refresh).then(value=>{this.cached={at:this.options.now?.()??Date.now(),value};return structuredClone(value);});
  this.active=operation;
  try{return await operation;}finally{if(this.active===operation)this.active=undefined;}
 }
 dispose():void{for(const worker of this.workers)killTree(worker,'SIGKILL');}
 private async observe(refresh:boolean):Promise<ServiceDiagnostic[]>{
  try{
   const value=await(this.options.run?this.options.run(refresh):this.run(refresh));
   if(valid(value,this.options.ports,this.options.env.HEED_TRANSCRIPTION_URL))return value;
  }catch{/* Failure cannot identify a foreign process; report unavailable without raw errors. */}
  const ports={...this.options.ports};const external=this.options.env.HEED_TRANSCRIPTION_URL;
  if(external){try{const url=new URL(external);ports.transcription=Number(url.port||(url.protocol==='https:'?443:80));}catch{}}
  return roles.map(service=>({service,port:ports[service],state:'unavailable'}));
 }
 private async run(refresh:boolean):Promise<unknown>{
  const args=['/usr/bin/python3',join(this.options.root,'scripts/service_diagnostics.py'),'--root',this.options.root,...(this.options.apiOrigin?['--api-origin',this.options.apiOrigin]:[]),...(refresh?['--refresh']:[])];
  const child=spawn(args[0],args.slice(1),{cwd:this.options.root,env:this.options.env,stdio:['ignore','pipe','ignore'],detached:true});
  let closed=false;
  const exited=new Promise<number>(resolve=>{child.once('error',()=>{closed=true;resolve(1);});child.once('close',code=>{closed=true;resolve(code??1);});});
  const proc=track({pid:child.pid,kill:(signal?:number|NodeJS.Signals)=>{child.kill(signal);},exited});
  this.workers.add(proc);
  const timer=setTimeout(()=>killTree(proc,'SIGKILL'),6000);
  try{
   const chunks:Uint8Array[]=[];let size=0;
   if(!child.stdout)throw Error('Diagnostics unavailable');
   for await(const chunk of child.stdout){size+=chunk.length;if(size>8192)throw Error('Invalid diagnostics');chunks.push(chunk);}
   if(await proc.exited!==0)throw Error('Diagnostics unavailable');
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
   return JSON.parse(new TextDecoder().decode(bytes));
  }finally{clearTimeout(timer);if(!closed)killTree(proc,'SIGKILL');await exited;this.workers.delete(proc);untrack(proc);}
 }
}
