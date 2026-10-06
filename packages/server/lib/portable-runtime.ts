import {existsSync,lstatSync,readFileSync} from 'node:fs';import {join} from 'node:path';
import {PortableLibrary,type PortableLibraryOptions} from './portable-library';import {migrateLegacyAudio,migrationProtectedPaths} from './portable-migration';import {UUID} from './portable-schema';
/** Lazy initialization leaves existing text usable even when no catalog write fits the quota. */
export class PortableLibraryRuntime {
 private library?:PortableLibrary;
 private cache?:{signature:string;entries:Array<{revisionId:string;state:string;deleted:boolean;hash?:string;source?:string}>;migration:string[]};
 constructor(private options:PortableLibraryOptions&{recordingsDir:string;protectedPaths?:()=>string[]}){}
 get():PortableLibrary {return this.library||=(new PortableLibrary(this.options));}
 markDeleted(sessionId:string):void {if(this.library||existsSync(join(this.options.root,'catalog','state.json')))this.get().markDeleted(sessionId);}
 protectedPaths(revisionIds?:string[]):string[]{
  const fallback=[this.options.recordingsDir,join(this.options.root,'media')];
  try{
   const paths=['state.json','migrations.json'].map(name=>join(this.options.root,'catalog',name));const signature=paths.map(path=>{if(!existsSync(path))return 'missing';const stat=lstatSync(path);if(!stat.isFile()||stat.size>64_000_000)throw new Error('Invalid library protection journal');return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;}).join('|');
   if(!this.cache||this.cache.signature!==signature){
    const entries:NonNullable<PortableLibraryRuntime['cache']>['entries']=[];
    if(existsSync(paths[0]!)){const state=JSON.parse(readFileSync(paths[0]!,'utf8'));if(state.version!==1||!state.entries||typeof state.entries!=='object'||Array.isArray(state.entries)||Object.keys(state.entries).length>10000)throw new Error('Invalid protection catalog');
     for(const entry of Object.values(state.entries) as any[]){if(!entry?.manifest||!UUID.test(entry.manifest.revisionId)||!entry.preview||typeof entry.preview.state!=='string'||(entry.audioHash!==undefined&&!/^[a-f0-9]{64}$/.test(entry.audioHash))||(entry.audioSource!==undefined&&typeof entry.audioSource!=='string'))throw new Error('Invalid protection entry');if(entry.preview.audio&&!entry.audioHash)throw new Error('Archived protection reference is incomplete');entries.push({revisionId:entry.manifest.revisionId,state:entry.preview.state,deleted:!!state.tombstones?.[`${entry.manifest.libraryId}/${entry.manifest.meetingId}`],hash:entry.audioHash,source:entry.audioSource});}
    }
    this.cache={signature,entries,migration:migrationProtectedPaths(this.options.root)};
   }
   const requested=new Set(revisionIds);return [...(this.library?this.library.protectedPaths(revisionIds):this.cache.entries.filter(e=>!e.deleted&&(e.state!=='verified'||requested.has(e.revisionId))).flatMap(e=>e.hash?[join(this.options.root,'media',`${e.hash}.wav`),...(e.source?[e.source]:[])]:[])),...this.cache.migration];
  }catch{return fallback;}
 }
 async migrate(signal?:AbortSignal){return this.get().runMaintenance(()=>migrateLegacyAudio({libraryRoot:this.options.root,recordingsDir:this.options.recordingsDir,sessionsDir:this.options.sessionsDir,sessions:this.options.sessions,quota:this.options.quota,protectedPaths:()=>[...this.get().protectedPaths(),...(this.options.protectedPaths?.()||[])],signal}),signal);}
}
