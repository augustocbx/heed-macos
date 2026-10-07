import {existsSync,lstatSync,mkdirSync,readFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {atomicWriteJson} from './atomic-json';
import type {VocabularyLibrary,VocabularyGlossary,VocabularySelection,VocabularySnapshot} from '../../shared/types/vocabulary';
import {validateVocabularyEntries,validateVocabularySnapshot,vocabularyText} from '../../shared/lib/vocabulary';
const empty=():VocabularyLibrary=>({schemaVersion:1,version:0,defaultGlossaryId:null,glossaries:[]});
function validate(value:any):VocabularyLibrary {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['schemaVersion','version','defaultGlossaryId','glossaries'].includes(key))||value.schemaVersion!==1||!Array.isArray(value.glossaries)||value.glossaries.length>20||!(value.defaultGlossaryId===null||typeof value.defaultGlossaryId==='string'))throw Error('Invalid vocabulary library');
 const ids=new Set<string>(),names=new Set<string>();const glossaries:VocabularyGlossary[]=value.glossaries.map((g:any)=>{
  if(!g||typeof g!=='object'||Array.isArray(g)||Object.keys(g).some(key=>!['id','name','version','entries'].includes(key))||typeof g.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(g.id)||ids.has(g.id))throw Error('Invalid or duplicate glossary ID');
  const name=vocabularyText(g.name,100),identity=name.normalize('NFC').trim().toLowerCase();if(names.has(identity))throw Error('Duplicate glossary name');names.add(identity);ids.add(g.id);
  if(g.version!==undefined&&(!Number.isSafeInteger(g.version)||g.version<1))throw Error('Invalid glossary version');
  return {id:g.id,name,version:g.version||1,entries:validateVocabularyEntries(g.entries)};
 });
 if(value.defaultGlossaryId!==null&&!ids.has(value.defaultGlossaryId))throw Error('Default glossary was removed; choose another glossary');
 if(value.version!==undefined&&(!Number.isSafeInteger(value.version)||value.version<0))throw Error('Invalid vocabulary library version');
 return {schemaVersion:1,version:value.version||0,defaultGlossaryId:value.defaultGlossaryId,glossaries};
}
export class LocalVocabulary {
 constructor(private readonly path:string){mkdirSync(dirname(path),{recursive:true,mode:0o700});}
 read():VocabularyLibrary {if(!existsSync(this.path))return empty();if(lstatSync(this.path).isSymbolicLink())throw Error('Vocabulary path cannot be a symbolic link');if(lstatSync(this.path).size>1_000_000)throw Error('Vocabulary library exceeds its size limit');return validate(JSON.parse(readFileSync(this.path,'utf8')));}
 save(value:unknown,expectedVersion:number):VocabularyLibrary {
  const current=this.read();if(!Number.isSafeInteger(expectedVersion)||expectedVersion!==current.version)throw Error('Vocabulary changed; reload before saving');const next=validate(value);
  next.version=current.version+1;for(const glossary of next.glossaries){const previous=current.glossaries.find(g=>g.id===glossary.id);glossary.version=previous?previous.version+(JSON.stringify({...previous,version:0})!==JSON.stringify({...glossary,version:0})?1:0):1;}
  atomicWriteJson(this.path,next);return next;
 }
 search(query:string){if(typeof query!=='string'||query.length>200)throw Error('Invalid vocabulary search');const key=query.normalize('NFC').toLowerCase();return this.read().glossaries.flatMap(g=>g.entries).filter(entry=>`${entry.term} ${entry.hint||''}`.normalize('NFC').toLowerCase().includes(key));}
 snapshot(selection:VocabularySelection={}):VocabularySnapshot {
  if(!selection||typeof selection!=='object'||Array.isArray(selection)||Object.keys(selection).some(key=>!['glossaryId','additions'].includes(key)))throw Error('Invalid vocabulary selection');const library=this.read(),id=selection.glossaryId===undefined?library.defaultGlossaryId:selection.glossaryId;
  const glossary=library.glossaries.find(g=>g.id===id);if(id!==null&&!glossary)throw Error('Selected glossary does not exist');
  return validateVocabularySnapshot({schemaVersion:1,libraryVersion:library.version,glossaryId:id,glossaryVersion:glossary?.version??null,entries:glossary?.entries??[],additions:selection.additions??[]});
 }
 export(){return JSON.stringify(this.read(),null,2);}
 import(text:string,expectedVersion:number){if(typeof text!=='string'||Buffer.byteLength(text)>1_000_000)throw Error('Vocabulary import exceeds its size limit');return this.save(JSON.parse(text),expectedVersion);}
}
