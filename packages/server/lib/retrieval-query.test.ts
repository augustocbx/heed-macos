import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {existsSync,readFileSync,writeFileSync,linkSync,unlinkSync,renameSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {closeRetrievalFixtures,retrievalFixture} from './retrieval-test-utils';
import {RetrievalUnavailableError} from './retrieval-tokenizer';
import {transcriptGuard} from './session-tags';
afterEach(closeRetrievalFixtures);
test('every posting lookup uses exact eligible stamps and the compound primary-key access path',async()=>{
 const f=await retrievalFixture();f.add('selected','alpha beta',['Work']);f.add('excluded','alpha beta',['Other']);await f.index.tick();
 const snapshot=f.snapshot({kind:'library',scope:{mode:'labels',labels:['work'],match:'any'}}),original=Database.prototype.query,queries:Array<{sql:string;args:any[];rows:any[]}>=[],wrapped=new WeakSet<object>();
 Database.prototype.query=function(this:Database,sql:string){const statement=original.call(this,sql);if(sql.includes(' FROM postings ')&&!wrapped.has(statement)){wrapped.add(statement);const all=statement.all.bind(statement);statement.all=((...args:any[])=>{const rows=all(...args);queries.push({sql,args,rows});return rows;}) as typeof statement.all;}return statement;} as typeof Database.prototype.query;
 try{const result=await f.index.search(snapshot,['alpha','beta']);expect(result.hits.every(h=>h.sessionId==='selected')).toBe(true);}finally{Database.prototype.query=original;}
 expect(queries.length).toBe(2);for(const query of queries){expect(query.args.slice(0,3)).toEqual(['selected',snapshot.sources[0].sourceRevision,snapshot.sources[0].transcriptVersion]);expect(query.sql).not.toMatch(/MATCH|bm25|GROUP BY|JOIN/i);expect(query.rows.length).toBeLessThanOrEqual(128);}
 const db=new Database(join(f.directory,f.index.describe(snapshot).generationId!,'index.sqlite'),{readonly:true});try{const plan=db.query('EXPLAIN QUERY PLAN '+queries[0].sql).all(...queries[0].args);expect(JSON.stringify(plan)).toContain('SEARCH postings USING INDEX sqlite_autoindex_postings_1');expect(JSON.stringify(plan)).not.toMatch(/TEMP B-TREE|SCAN postings/);}finally{db.close();}
});
test('row prefetch never reads more than the configured raw posting budget',async()=>{
 const f=await retrievalFixture({queryRows:129});f.add('meeting-a',Array.from({length:300},()=> 'alpha beta').join('\n\n'));await f.index.tick();const original=Database.prototype.query,wrapped=new WeakSet<object>();let fetched=0;
 Database.prototype.query=function(this:Database,sql:string){const statement=original.call(this,sql);if(sql.includes(' FROM postings ')&&!wrapped.has(statement)){wrapped.add(statement);const all=statement.all.bind(statement);statement.all=((...args:any[])=>{const rows=all(...args);fetched+=rows.length;return rows;}) as typeof statement.all;}return statement;} as typeof Database.prototype.query;
 try{const result=await f.index.search(f.snapshot(),['alpha','beta']);expect(fetched).toBe(129);expect(result.coverage).toMatchObject({matchingRowsVisited:2,matchedEvidence:1,searchedEvidence:null,lookupComplete:false});}finally{Database.prototype.query=original;}
});
test('deadline and mandatory admission changes stop before the next inference-facing lookup page',async()=>{
 for(const mode of ['deadline','busy'] as const){const f=await retrievalFixture();f.add('meeting-a',Array.from({length:300},()=> 'alpha').join('\n\n'));await f.index.tick();const original=Bun.sleep;
  Bun.sleep=(async(...args:Parameters<typeof Bun.sleep>)=>{if(mode==='deadline')f.time(250);else f.busy(true);return original(...args);}) as typeof Bun.sleep;
  try{const result=await f.index.search(f.snapshot(),['alpha']);expect(result.coverage).toMatchObject({lookupComplete:false,searchedEvidence:null,matchingRowsVisited:0,matchedEvidence:0});expect(result.coverage.partialReasons).toContain('query-budget');}finally{Bun.sleep=original;f.busy(false);}
 }
});
test('abort and close release a held reader without deleting the active generation or leaking a lease',async()=>{
 const f=await retrievalFixture();f.add('meeting-a',Array.from({length:200},()=> 'alpha').join('\n\n'));await f.index.tick();const snapshot=f.snapshot(),generation=f.index.describe(snapshot).generationId!,controller=new AbortController(),original=Bun.sleep;
 let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve),barrier=new Promise<void>(resolve=>release=resolve);Bun.sleep=(()=>{entered();return barrier;}) as typeof Bun.sleep;
 let query:Promise<any>|undefined;try{query=f.index.search(snapshot,['alpha'],controller.signal);await ready;f.index.close();controller.abort();release();await expect(query).rejects.toThrow();expect(existsSync(join(f.directory,generation))).toBe(true);expect((f.index as any).querying).toBe(false);}finally{release();Bun.sleep=original;await query?.catch(()=>{});}
});
test('quota retirement rejects a held reader before unlink, clears cache and permits a later rebuild',async()=>{
 const f=await retrievalFixture();f.add('meeting-a',Array.from({length:200},()=> 'alpha').join('\n\n'));await f.index.tick();const snapshot=f.snapshot(),generation=f.index.describe(snapshot).generationId!,paths=f.index.disposableFiles(),source=readFileSync(join(f.root,'sessions/meeting-a.json'));
 await f.retriever.retrieve(snapshot,'alpha');expect((f.retriever as any).cache.size).toBe(1);
 const original=Bun.sleep;let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve),barrier=new Promise<void>(resolve=>release=resolve);Bun.sleep=(()=>{entered();return barrier;}) as typeof Bun.sleep;
 let query:Promise<any>|undefined;try{query=f.index.search(snapshot,['alpha']);await ready;expect(f.index.disposableFiles()).toEqual([]);expect(()=>f.index.reclaim(paths)).toThrow('active retrieval');expect(existsSync(join(f.directory,generation))).toBe(true);release();await query;}finally{release();Bun.sleep=original;await query?.catch(()=>{});}
 f.index.reclaim(paths);f.retriever.invalidateCache();expect((f.retriever as any).cache.size).toBe(0);expect(existsSync(join(f.directory,'active.json'))).toBe(false);expect(existsSync(join(f.directory,generation))).toBe(false);expect(readFileSync(join(f.root,'sessions/meeting-a.json'))).toEqual(source);
 expect((await f.retriever.retrieve(snapshot,'alpha')).coverage.strategy).toBe('fallback');await f.index.tick();expect(f.index.describe(snapshot).generationId).toBeString();expect(f.index.describe(snapshot).generationId).not.toBe(generation);
});
test('quota eligibility excludes unexpected generation data and hard-linked cache files',async()=>{
 const f=await retrievalFixture();f.add('meeting-a','alpha');await f.index.tick();const generation=f.index.describe(f.snapshot()).generationId!,database=join(f.directory,generation,'index.sqlite'),foreign=join(f.directory,generation,'provider.json');
 writeFileSync(foreign,'foreign');expect(f.index.disposableFiles()).toEqual([]);expect(()=>f.index.reclaim([database])).toThrow();expect(readFileSync(foreign,'utf8')).toBe('foreign');unlinkSync(foreign);
 const linked=join(f.root,'provider-index.sqlite');linkSync(database,linked);expect(f.index.disposableFiles()).toEqual([]);expect(()=>f.index.reclaim([database])).toThrow();expect(existsSync(linked)).toBe(true);unlinkSync(linked);expect(f.index.disposableFiles()).toContain(database);
 const backup=join(f.root,'owned-database.sqlite');renameSync(database,backup);writeFileSync(linked,'foreign target');symlinkSync(linked,database);try{expect(f.index.disposableFiles()).toEqual([]);expect(()=>f.index.reclaim([database])).toThrow();expect(readFileSync(linked,'utf8')).toBe('foreign target');}finally{unlinkSync(database);renameSync(backup,database);}
});
test('quota retirement rejects an active update transaction without consuming its claim or accepted text',async()=>{
 const f=await retrievalFixture();f.add('meeting-a','alpha');await f.index.tick();const paths=f.index.disposableFiles(),generation=f.index.describe(f.snapshot()).generationId!;
 const current=f.store.read('meeting-a')!;f.store.commitSource(current.id,transcriptGuard(current),()=>({...current,transcript:Array.from({length:200},()=> 'alpha updated').join('\n\n')}));
 const source=readFileSync(join(f.root,'sessions/meeting-a.json')),original=Bun.sleep,controller=new AbortController();let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(resolve=>entered=resolve),barrier=new Promise<void>(resolve=>release=resolve);Bun.sleep=(()=>{entered();return barrier;}) as typeof Bun.sleep;
 let update:Promise<void>|undefined;try{update=f.index.tick(controller.signal);await ready;expect(f.quota.snapshot().reservedBytes).toBeGreaterThan(0);expect(f.index.disposableFiles()).toEqual([]);expect(()=>f.index.reclaim(paths)).toThrow();expect(existsSync(join(f.directory,generation))).toBe(true);expect(readFileSync(join(f.root,'sessions/meeting-a.json'))).toEqual(source);controller.abort();release();await expect(update).rejects.toThrow();}finally{release();Bun.sleep=original;await update?.catch(()=>{});}
 expect(f.quota.snapshot().reservedBytes).toBe(0);expect(f.index.disposableFiles()).toContain(join(f.directory,generation,'index.sqlite'));
});
test('a third generation cannot grow while a retired generation has an active reader',async()=>{
 const f=await retrievalFixture();f.add('meeting-a',Array.from({length:200},()=> 'alpha').join('\n\n'));await f.index.tick();const snapshot=f.snapshot(),original=Bun.sleep;let held=false,release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r),barrier=new Promise<void>(r=>release=r);
 Bun.sleep=((...args:Parameters<typeof Bun.sleep>)=>{if(!held){held=true;entered();return barrier;}return original(...args);}) as typeof Bun.sleep;
 let query:Promise<any>|undefined;try{query=f.index.search(snapshot,['alpha']);await ready;await f.index.rebuild();const second=f.index.describe(snapshot).generationId;await f.index.rebuild();expect(f.index.describe(snapshot).generationId).toBe(second);expect((f.index as any).retired.size).toBe(1);release();await query;expect((f.index as any).retired.size).toBe(0);}finally{release();Bun.sleep=original;await query?.catch(()=>{});}
});
test('materialization preserves untimed surrogate halves and rejects corrupted stored quote/location bindings',async()=>{
 const f=await retrievalFixture();f.add('meeting-a','a'.repeat(1199)+'😀 delivery');await f.index.tick();const snapshot=f.snapshot(),result=await f.retriever.retrieve(snapshot,'delivery'),materialized=await f.retriever.materialize(result);expect(materialized.some(e=>e.quote.charCodeAt(0)===0xde00)).toBe(true);expect(materialized.some(e=>e.quote.endsWith('\ud83d'))).toBe(true);
 const db=new Database(join(f.directory,result.generationId!,'index.sqlite'));try{db.query('UPDATE chunks SET quote=? WHERE evidenceOrdinal=?').run(Buffer.from('forged','utf16le'),result.hits[0].evidenceOrdinal);}finally{db.close();}await expect(f.retriever.materialize(result)).rejects.toThrow();expect((f.retriever as any).cache.size).toBe(0);await f.index.tick();expect(f.index.describe(snapshot).generationId).not.toBe(result.generationId);expect(await f.retriever.materialize(await f.retriever.retrieve(snapshot,'delivery'))).toEqual(materialized);
});
test('malformed derived locations report a controlled failure and schedule disposable-index repair',async()=>{
 const f=await retrievalFixture();f.add('meeting-a','delivery');await f.index.tick();const snapshot=f.snapshot(),result=await f.retriever.retrieve(snapshot,'delivery');
 const db=new Database(join(f.directory,result.generationId!,'index.sqlite'));try{db.query('UPDATE chunks SET location=?').run('{');}finally{db.close();}
 await expect(f.retriever.materialize(result)).rejects.toThrow(RetrievalUnavailableError);expect((f.retriever as any).cache.size).toBe(0);await f.index.tick();expect(f.index.describe(snapshot).generationId).not.toBe(result.generationId);expect((await f.retriever.materialize(await f.retriever.retrieve(snapshot,'delivery')))[0].quote).toBe('delivery');
});
test('fallback independently caps four sources and256 evidence without expanding neighbors beyond its examined prefix',async()=>{
 const f=await retrievalFixture();for(let i=0;i<5;i++)f.add(`meeting-${i}`,'delivery');const sources=await f.retriever.retrieve(f.snapshot(),'delivery');expect(sources.coverage).toMatchObject({searchedMeetings:4,searchedEvidence:4,matchedEvidence:4,lookupComplete:false});expect(sources.hits).toHaveLength(4);
 const many=await retrievalFixture();many.add('meeting-a',Array.from({length:300},()=> 'delivery').join('\n\n'));const evidence=await many.retriever.retrieve(many.snapshot(),'delivery');expect(evidence.coverage).toMatchObject({searchedMeetings:1,searchedEvidence:256,matchedEvidence:256,lookupComplete:false});expect(evidence.hits.every(h=>h.evidenceOrdinal<256)).toBe(true);expect(evidence.hits.length).toBeLessThanOrEqual(32);
});
test('missing FTS capability gives an honest bounded current-source prefix, without weakening query input limits',async()=>{
 const f=await retrievalFixture();f.add('meeting-a','alpha\n\nbeta');await f.index.tick();const original=Database.prototype.exec;
 Database.prototype.exec=function(this:Database,sql:string){if(sql.includes('USING fts5'))throw new Error('No FTS capability');return original.call(this,sql);};
 try{const result=await f.retriever.retrieve(f.snapshot(),'alpha');expect(result.coverage).toMatchObject({strategy:'fallback',searchedEvidence:2,matchedEvidence:0,lookupComplete:false});expect(result.coverage.partialReasons).toContain('index-missing');expect((await f.retriever.materialize(result)).map(e=>e.quote)).toEqual(['alpha','beta']);await expect(f.retriever.retrieve(f.snapshot(),'a'.repeat(2001))).rejects.toThrow();}finally{Database.prototype.exec=original;}
});
