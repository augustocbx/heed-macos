import {openSync,closeSync,readSync,fstatSync,constants} from 'node:fs';
/** Read a bounded regular file, including growth after open; never follow a substituted symlink. */
export function readPrivateJson<T=unknown>(path:string,maxBytes:number):T {
 let descriptor:number|undefined;
 try{descriptor=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=fstatSync(descriptor);if(!stat.isFile()||stat.size>maxBytes)throw new Error();const chunks:Buffer[]=[];let count=0;while(true){const chunk=Buffer.alloc(Math.min(65536,maxBytes+1-count));const length=readSync(descriptor,chunk,0,chunk.length,null);if(!length)break;count+=length;if(count>maxBytes)throw new Error();chunks.push(chunk.subarray(0,length));}return JSON.parse(Buffer.concat(chunks,count).toString('utf8')) as T;}
 catch{throw new Error('Invalid private connector state; preserve it for recovery');}
 finally{if(descriptor!==undefined)closeSync(descriptor);}
}
export function privateRecord(value:unknown,maxEntries:number):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length<=maxEntries;}
