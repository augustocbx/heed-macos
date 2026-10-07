import {expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalVocabulary} from './vocabulary';
const entry={term:'João São José',hint:'John',language:'pt' as const};
test('local library supports unchanged Unicode CRUD, search, export/import and restart without touching meetings',()=>{
 const dir=mkdtempSync(join(tmpdir(),'heed-vocabulary-')),path=join(dir,'vocabulary.json');
 try{
  writeFileSync(join(dir,'meeting.json'),'private existing meeting');
  const store=new LocalVocabulary(path);let library=store.read();
  library=store.save({schemaVersion:1,defaultGlossaryId:'work',glossaries:[{id:'work',name:'Work',version:1,entries:[entry,{term:'TypeScript / API'}]}]},library.version);
  expect(new LocalVocabulary(path).read().glossaries[0]!.entries).toEqual([entry,{term:'TypeScript / API'}]);
  expect(store.search('JOÃO')).toEqual([entry]);
  const frozen=store.snapshot({additions:[{term:'Ana'}]});expect(frozen.entries[0]).toEqual(entry);
  const exported=store.export();expect(JSON.parse(exported).schemaVersion).toBe(1);
  library=store.save({...library,glossaries:[{...library.glossaries[0]!,entries:[{term:'API'}]}]},library.version);
  expect(frozen.entries[0]).toEqual(entry);expect(library.glossaries[0]!.version).toBe(2);
  expect(()=>store.save({...library,glossaries:[]},1)).toThrow('changed');
  library=store.import(exported,library.version);expect(library.glossaries[0]!.entries[0]).toEqual(entry);
  expect(readFileSync(join(dir,'meeting.json'),'utf8')).toBe('private existing meeting');
  library=store.save({...library,defaultGlossaryId:null,glossaries:[]},library.version);expect(library.glossaries).toEqual([]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('invalid vocabulary never replaces the previous library',()=>{
 const dir=mkdtempSync(join(tmpdir(),'heed-vocabulary-invalid-')),path=join(dir,'vocabulary.json');
 try{const store=new LocalVocabulary(path);const valid=store.save({schemaVersion:1,defaultGlossaryId:null,glossaries:[{id:'work',name:'Work',entries:[entry]}]},0);const before=readFileSync(path,'utf8');
 for(const entries of [[{term:''}],[{term:'a'.repeat(121)}],[{term:'API'},{term:'api'}],[{term:'José'},{term:'Jose\u0301'}],[{term:'a\0b'}],[{term:'valid',language:'xx'}],[{term:'x',unexpected:true}],Array.from({length:101},(_,i)=>({term:String(i)}))]){
  expect(()=>store.save({...valid,glossaries:[{...valid.glossaries[0]!,entries}]},valid.version)).toThrow();expect(readFileSync(path,'utf8')).toBe(before);
 }
 expect(()=>store.import('{',valid.version)).toThrow();expect(()=>store.snapshot({glossaryId:'missing'})).toThrow();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
