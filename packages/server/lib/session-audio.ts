import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Expose session audio only from configured legacy and managed media roots. */
export async function sessionAudioResponse(req:Request,id:string,sessionsDir:string,recordingsDir:string|string[]):Promise<Response>{
 if(!/^[a-zA-Z0-9_-]+$/.test(id))return new Response(null,{status:403});
 let session:any;
 try{const root=realpathSync(sessionsDir);const file=realpathSync(join(root,`${id}.json`));if(relative(root,file)!==`${id}.json`)return new Response(null,{status:403});session=JSON.parse(readFileSync(file,'utf8'));}catch{return new Response(null,{status:404});}
 const path=session?.files?.wav;
 if(typeof path!=='string'||!path)return new Response(null,{status:404});
 if(!isAbsolute(path))return new Response(null,{status:403});
 const roots=Array.isArray(recordingsDir)?recordingsDir:[recordingsDir];
 const contained=(root:string,file:string)=>{const child=relative(root,file);return !!child&&child!=='..'&&!child.startsWith(`..${sep}`)&&!isAbsolute(child);};
 const candidates=roots.filter(root=>contained(resolve(root),resolve(path)));if(!candidates.length)return new Response(null,{status:403});
 let actual:string,size:number;
 try{actual=realpathSync(path);if(!candidates.some(root=>{try{return contained(realpathSync(root),actual);}catch{return false;}}))return new Response(null,{status:403});const stat=statSync(actual);if(!stat.isFile())return new Response(null,{status:404});size=stat.size;}catch{return new Response(null,{status:404});}
 const headers=new Headers({'Content-Type':'audio/wav','Accept-Ranges':'bytes','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
 let start=0,end=size-1,status=200;
 const range=req.headers.get('range');
 if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);let valid=!!match && !!(match[1]||match[2]) && size>0;
 if(valid&&match){if(match[1]){start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),size-1):size-1;}else{const suffix=Number(match[2]);valid=suffix>0;start=Math.max(0,size-suffix);}valid=valid&&Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&start<size&&end>=start;}
 if(!valid){headers.set('Content-Range',`bytes */${size}`);return new Response(null,{status:416,headers});}
 status=206;headers.set('Content-Range',`bytes ${start}-${end}/${size}`);
 }
 headers.set('Content-Length',String(Math.max(0,end-start+1)));
 return new Response(req.method==='HEAD'?null:Bun.file(actual).slice(start,end+1),{status,headers});
}
