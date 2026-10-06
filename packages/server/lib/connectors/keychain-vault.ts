import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {track} from '../process';
export interface SecretVault {put(value:unknown,reference?:string):Promise<string>;get<T=unknown>(reference:string):Promise<T|null>;remove(reference:string):Promise<void>}
export interface VaultOptions {helperPath?:string;run?:(command:string[],stdin:string)=>Promise<{code:number;stdout:string}>}
const REFERENCE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const defaultHelper=join(import.meta.dir,'../../../desktop/native-keychain/.build/heed-keychain');
interface VaultProcess {stdin:{write(value:string):unknown;end():unknown};stdout:ReadableStream<Uint8Array>;exited:Promise<number>;kill(signal?:'SIGKILL'):void}
export async function runNativeVault(command:string[],stdin:string,launch:(command:string[])=>VaultProcess=(command)=>track(Bun.spawn(command,{stdin:'pipe',stdout:'pipe',stderr:'ignore'}))){
 const child=launch(command);const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
 try {child.stdin.write(stdin);child.stdin.end();const stdout=await new Response(child.stdout).text();return {code:await child.exited,stdout};}catch(error){child.kill('SIGKILL');await child.exited.catch(()=>{});throw error;}finally{clearTimeout(timer);}
}
/** Secret payloads cross the native boundary on stdin only; configuration keeps an opaque reference. */
export function createKeychainVault(options:VaultOptions={}):SecretVault {
 const operation=async(kind:string,reference:string,value?:unknown)=>{
  if(!REFERENCE.test(reference))throw new Error('Invalid secret reference');
  const serialized=value===undefined?undefined:JSON.stringify(value);if(serialized!==undefined&&Buffer.byteLength(serialized)>65536)throw new Error('Secret exceeds protected storage limit');
  try{
   const result=await (options.run||runNativeVault)([options.helperPath||defaultHelper],JSON.stringify({service:'local.heed.connectors.v1',operation:kind,reference,...(serialized!==undefined?{value:serialized}:{})}));
   if(result.code!==0||result.stdout.length>70000)throw new Error();const response=JSON.parse(result.stdout);if(response.ok!==true)throw new Error();
   if(kind==='get'){if(response.value===null)return null;if(typeof response.value!=='string')throw new Error();return JSON.parse(response.value);}
   return null;
  }catch{throw new Error('Protected credential storage is unavailable; unlock Keychain or reconnect');}
 };
 return {async put(value,reference=randomUUID()){await operation('put',reference,value);return reference;},async get<T>(reference:string){return await operation('get',reference) as T|null;},async remove(reference){await operation('remove',reference);}};
}
