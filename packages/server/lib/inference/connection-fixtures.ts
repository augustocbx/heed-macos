import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiConnections} from './connections';
import type {SecretVault} from '../connectors/keychain-vault';
const roots:string[]=[];
export function cleanupFixtures(){for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});}
type FixtureFetch=(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>Promise<Response>;
export function fixture(fetcher:FixtureFetch=async()=>Response.json({data:[]})){
 const root=mkdtempSync(join(tmpdir(),'heed-ai-connections-'));roots.push(root);
 const values=new Map<string,unknown>();let locked=false;
 const vault:SecretVault={async put(value,reference){if(locked)throw Error('SECRET_KEY locked');values.set(reference!,value);return reference!;},async get<T>(reference:string){if(locked)throw Error('SECRET_KEY locked');return (values.get(reference)??null) as T|null;},async remove(reference){if(locked)throw Error('SECRET_KEY locked');values.delete(reference);}};
 const options={appDir:root,vault,fetch:fetcher as typeof fetch,localEndpoint:'http://127.0.0.1:11435'};
 return {root,values,vault,options,manager:new AiConnections(options),lock:(value:boolean)=>locked=value};
}
