import {Database} from 'bun:sqlite';
import {randomUUID} from 'node:crypto';
import {chmodSync,closeSync,constants,fstatSync,fsyncSync,lstatSync,mkdirSync,openSync,readdirSync,readSync,rmSync,rmdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import type {RetrievalSnapshot,RetrievalSourceStamp,RetrievalPartialReason,RetrievalResult,RetrievalHit} from '../../shared/types/retrieval';
import {sourceRevision} from '../../shared/lib/transcript-source';
import type {Session,TranscriptEvidence} from '@heed/shared';
import {atomicWriteJson} from './atomic-json';
import {RetrievalCatalog,type RetrievalDescriptor,type RetrievalScope} from './retrieval-catalog';
import {defaultRetrievalPolicy,type RetrievalPolicy} from './retrieval-policy';
import {SessionTags,type CommittedSessionChange} from './session-tags';
import type {ManagedQuota} from './managed-quota';
import {iterateTranscriptEvidence} from './meeting-chat';
import {ScratchTokenizer,normalizeRetrievalQuery,RetrievalQueryError,RetrievalUnavailableError,type RetrievalTerm} from './retrieval-tokenizer';
import {CandidateRanking,initialCoverage,recordRetrieved,type Candidate} from './retrieval-ranking';

interface Options {directory:string;catalog:RetrievalCatalog;store:SessionTags;quota:ManagedQuota;isBusy:()=>boolean;isQueryBusy?:()=>boolean;policy:RetrievalPolicy;now:()=>number;}
interface Manifest extends RetrievalSourceStamp {totalEvidence:number;indexedEvidence:number;indexedPrefix:number;epoch:number;}
export interface RetrievalIndexedSource extends Manifest {current:boolean;reason?:RetrievalPartialReason;}
export interface RetrievalIndexDescription {generationId:string|null;sources:RetrievalIndexedSource[];}
interface Generation {id:string;path:string;writer:Database;reader:Database;readers:number;retired:boolean;}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const signature=(s:RetrievalSourceStamp)=>`${s.sourceRevision}:${s.transcriptVersion}`;
const all:RetrievalScope={kind:'library',scope:{mode:'all',labels:[],match:'any'}};
class InterruptedIndexWork extends Error {}

/** Search both accepted speech and its speaker label; the stored quote stays exact. */
export function tokenizeTranscriptEvidence(scratch:ScratchTokenizer,evidence:TranscriptEvidence):RetrievalTerm[]{
 const frequencies=new Map<string,number>();
 for(const text of [evidence.quote,evidence.speaker.slice(0,defaultRetrievalPolicy.queryCharacters)]){
  if(!text)continue;
  for(const {term,frequency} of scratch.tokenize(text))frequencies.set(term,(frequencies.get(term)??0)+frequency);
 }
 return [...frequencies].map(([term,frequency])=>({term,frequency}));
}

/** Disposable accepted-source data. Authoritative JSON is never modified here. */
export class RetrievalIndex {
 private active?:Generation;
 private querying=false;
 private retired=new Set<Generation>();
 private pending=new Set<string>();
 private indexed=new Map<string,string>();
 private partial=new Set<string>();
 private failures=new Map<string,RetrievalPartialReason>();
 private rebuildNeeded=false;
 private running?:Promise<void>;
 private closed=false;
 private unsubscribe:()=>void;
 private stage?:Generation;
 private uncertainPublication=false;
 private claims=new Set<string>();
 private config:string;
 constructor(private options:Options){
  const p=options.policy;this.config=JSON.stringify({schemaVersion:1,tokenizer:'unicode61-diacritics2-scalar-v1',chunker:'legacy1200-utf16-v1',quote:'utf16le-v1',searchFields:'quote-speaker-v1',databaseBytes:p.databaseBytes,evidenceRows:p.evidenceRows,postingRows:p.postingRows});
  mkdirSync(options.directory,{recursive:true,mode:0o700});
  if(lstatSync(options.directory).isSymbolicLink())throw new Error('Retrieval directory must be private local storage');
  chmodSync(options.directory,0o700);this.recover();
  this.unsubscribe=options.store.subscribeCommitted(change=>this.enqueue(change),()=>this.enqueue({kind:'invalidate'}));
 }
 private dbPath(id:string){return join(this.options.directory,id,'index.sqlite');}
 private pointer(){return join(this.options.directory,'active.json');}
 private selectedGeneration():string|undefined {
  let file:number|undefined;
  try{
   const stat=lstatSync(this.pointer());if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)return;
   file=openSync(this.pointer(),constants.O_RDONLY|constants.O_NOFOLLOW);const opened=fstatSync(file);if(!opened.isFile()||opened.size>4096)return;
   const bytes=Buffer.alloc(4097);let size=0,read:number;
   while(size<bytes.length&&(read=readSync(file,bytes,size,bytes.length-size,null))>0)size+=read;
   if(size>4096)return;
   const pointer=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size)));
   if(pointer?.schemaVersion===1&&typeof pointer.generationId==='string'&&uuid.test(pointer.generationId)&&Object.keys(pointer).length===2)return pointer.generationId;
  }catch{}finally{if(file!==undefined)closeSync(file);}
 }
 private syncDirectory(path:string){const file=openSync(path,'r');try{fsyncSync(file);}finally{closeSync(file);}}
 private fileBytes(path:string){return existsSync(path)&&lstatSync(path).isFile()?lstatSync(path).size:0;}
 private ownedBytes():number {
  let bytes=this.fileBytes(this.pointer());
  for(const id of readdirSync(this.options.directory))if(uuid.test(id)){
   const path=join(this.options.directory,id),stat=lstatSync(path);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Unsafe retrieval generation');
   for(const name of readdirSync(path)){const file=join(path,name),entry=lstatSync(file);if(!entry.isFile()||entry.isSymbolicLink()||!['index.sqlite','index.sqlite-journal'].includes(name))throw new Error('Unexpected retrieval generation file');bytes+=entry.size;}
  }
  return bytes;
 }
 private reserve(id:string,bytes:number,maximum:number){
  if(bytes>maximum||bytes>this.options.policy.workingDiskBytes)throw new Error('Retrieval working disk limit');
  this.options.quota.reserve(id,bytes,[this.options.directory]);this.claims.add(id);
 }
 private release(id:string){this.options.quota.release(id);this.claims.delete(id);}
 private configure(db:Database){
  const p=this.options.policy;db.exec(`PRAGMA page_size=4096; PRAGMA max_page_count=${Math.floor(p.databaseBytes/4096)}; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY; PRAGMA mmap_size=0; PRAGMA cache_size=-${p.sqliteCacheKiB}; PRAGMA cache_spill=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0`);
 }
 private open(id:string,create=false):Generation {
  const path=join(this.options.directory,id);if(create)mkdirSync(path,{recursive:true,mode:0o700});
  const file=this.dbPath(id);if(!create&&(lstatSync(file).isSymbolicLink()||this.fileBytes(file)>this.options.policy.databaseBytes))throw new Error('Invalid retrieval database');
  const writer=new Database(file);let reader:Database|undefined;
  try{
   this.configure(writer);
   if(create){
    writer.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
     CREATE TABLE manifests(sessionId TEXT PRIMARY KEY,sourceRevision TEXT NOT NULL,transcriptVersion INTEGER NOT NULL CHECK(transcriptVersion>=0),totalEvidence INTEGER NOT NULL CHECK(totalEvidence>=0),indexedEvidence INTEGER NOT NULL CHECK(indexedEvidence>=0 AND indexedEvidence<=totalEvidence),indexedPrefix INTEGER NOT NULL CHECK(indexedPrefix=indexedEvidence),epoch INTEGER NOT NULL CHECK(epoch>=1),UNIQUE(sessionId,sourceRevision,transcriptVersion));
     CREATE TABLE chunks(sessionId TEXT NOT NULL,sourceRevision TEXT NOT NULL,transcriptVersion INTEGER NOT NULL,evidenceOrdinal INTEGER NOT NULL CHECK(evidenceOrdinal>=0),evidenceId TEXT NOT NULL,quote BLOB NOT NULL,location TEXT NOT NULL,PRIMARY KEY(sessionId,evidenceOrdinal),UNIQUE(sessionId,evidenceId),UNIQUE(sessionId,sourceRevision,transcriptVersion,evidenceOrdinal),FOREIGN KEY(sessionId,sourceRevision,transcriptVersion) REFERENCES manifests(sessionId,sourceRevision,transcriptVersion) ON DELETE CASCADE);
     CREATE TABLE postings(sessionId TEXT NOT NULL,sourceRevision TEXT NOT NULL,transcriptVersion INTEGER NOT NULL,term TEXT NOT NULL,evidenceOrdinal INTEGER NOT NULL,frequency INTEGER NOT NULL CHECK(frequency>0),PRIMARY KEY(sessionId,sourceRevision,transcriptVersion,term,evidenceOrdinal),FOREIGN KEY(sessionId,sourceRevision,transcriptVersion,evidenceOrdinal) REFERENCES chunks(sessionId,sourceRevision,transcriptVersion,evidenceOrdinal) ON DELETE CASCADE);`);
    writer.query('INSERT INTO metadata VALUES(?,?)').run('configuration',this.config);writer.query('INSERT INTO metadata VALUES(?,?)').run('generation',id);
   }
   const config=writer.query("SELECT value FROM metadata WHERE key='configuration'").get() as {value:string}|null;
   const generation=writer.query("SELECT value FROM metadata WHERE key='generation'").get() as {value:string}|null;
   if(config?.value!==this.config||generation?.value!==id||Object.values(writer.query('PRAGMA quick_check').get()??{})[0]!=='ok'||writer.query('PRAGMA foreign_key_check').all().length)throw new Error('Unusable retrieval generation');
   chmodSync(file,0o600);reader=new Database(file,{readonly:true});reader.exec(`PRAGMA mmap_size=0; PRAGMA cache_size=-${this.options.policy.sqliteCacheKiB}; PRAGMA temp_store=MEMORY; PRAGMA foreign_keys=ON`);
   return {id,path,writer,reader,readers:0,retired:false};
  }catch(error){reader?.close();writer.close();throw error;}
 }
 private recover(){
  const selected=this.selectedGeneration();let claim:string|undefined;
  try{
   if(!selected&&existsSync(this.pointer())&&!lstatSync(this.pointer()).isSymbolicLink()&&lstatSync(this.pointer()).isFile())rmSync(this.pointer());
   // IDs are tied to owned generation directories, so interrupted reservations
   // can be audited without releasing unrelated quota owners.
   for(const id of readdirSync(this.options.directory))if(uuid.test(id)){
    const path=join(this.options.directory,id);if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isDirectory())continue;
    for(const prefix of ['retrieval-work-','retrieval-rebuild-']){
     const key=prefix+id,allocation=this.options.quota.allocation(key);
     if(allocation&&allocation.paths.length===1&&allocation.paths[0]===this.options.directory)this.options.quota.release(key);
    }
    if(id!==selected)rmSync(path,{recursive:true});
   }
   if(selected){
    if(this.ownedBytes()>this.options.policy.workingDiskBytes)throw new Error('Retrieval disk capacity');
    if(existsSync(this.dbPath(selected)+'-journal')){
     claim='retrieval-work-'+selected;
     this.reserve(claim,this.ownedBytes()+this.journalAllowance(this.fileBytes(this.dbPath(selected)))+8192,Math.min(this.options.policy.workingDiskBytes,2*this.options.policy.databaseBytes));
    }
    this.active=this.open(selected);this.refreshStamps();
    // A verified read lets SQLite finish hot recovery. After closing every
    // owned connection, a leftover cold journal is disposable derived data.
    if(claim){this.active.reader.close();this.active.writer.close();rmSync(this.dbPath(selected)+'-journal',{force:true});this.active=this.open(selected);}
   }
  }catch{
   this.active?.reader.close();this.active?.writer.close();this.active=undefined;this.rebuildNeeded=true;
  }finally{if(claim&&this.claims.has(claim))this.release(claim);}
 }
 private refreshStamps(){
  this.indexed.clear();this.partial.clear();if(!this.active)return;
  const rows=this.active.reader.query('SELECT sessionId,sourceRevision,transcriptVersion,totalEvidence,indexedEvidence FROM manifests LIMIT ?').all(this.options.policy.catalogSources+1) as Manifest[];
  if(rows.length>this.options.policy.catalogSources)throw new Error('Retrieval manifest capacity');
  for(const row of rows){this.indexed.set(row.sessionId,signature(row));if(row.indexedEvidence<row.totalEvidence)this.partial.add(row.sessionId);}
 }
 private queue(id:string){
  if(!this.pending.has(id)&&this.pending.size>=this.options.policy.catalogSources){this.pending.clear();this.rebuildNeeded=true;return false;}
  this.pending.add(id);return true;
 }
 private failed(id:string){
  if(!this.failures.has(id)&&this.failures.size>=this.options.policy.catalogSources)this.failures.delete(this.failures.keys().next().value!);
  this.failures.set(id,'index-capacity');
 }
 enqueue(change:CommittedSessionChange){
  if(this.closed)return;
  if(change.kind==='invalidate'){this.rebuildNeeded=true;this.pending.clear();this.failures.clear();return;}
  const id=change.kind==='upsert'?change.session.id:change.sessionId;
  if(change.kind==='upsert'&&change.session.transcriptFinalized&&this.indexed.get(id)===signature({sessionId:id,sourceRevision:change.session.transcriptRevision!,transcriptVersion:change.session.transcriptVersion!}))return;
  this.queue(id);this.failures.delete(id);
 }
 available(){return !this.closed&&!(this.options.isQueryBusy?.()??this.options.isBusy());}
 describe(snapshot:RetrievalSnapshot):RetrievalIndexDescription {
  return this.describeGeneration(snapshot,this.active);
 }
 private describeGeneration(snapshot:RetrievalSnapshot,g?:Generation):RetrievalIndexDescription {
  const descriptors=this.options.catalog.describe(snapshot);
  const sources=descriptors.map(source=>{
   const row=g?.reader.query('SELECT * FROM manifests WHERE sessionId=? AND sourceRevision=? AND transcriptVersion=?').get(source.sessionId,source.sourceRevision,source.transcriptVersion) as Manifest|null;
   const current=!!row&&row.totalEvidence===source.evidenceCount;
   return {...source,totalEvidence:source.evidenceCount,indexedEvidence:current?row.indexedEvidence:0,indexedPrefix:current?row.indexedPrefix:0,epoch:current?row.epoch:0,current,
    ...(!current?{reason:this.failures.get(source.sessionId)??(this.indexed.has(source.sessionId)?'index-stale':'index-missing')}:row.indexedEvidence<row.totalEvidence?{reason:'index-capacity'}:{})} as RetrievalIndexedSource;
  });
  return {generationId:g?.id??null,sources};
 }
 /** Only exact selected accepted stamps enter SQL; the query pins a readonly generation. */
 async search(snapshot:RetrievalSnapshot,terms:string[],signal?:AbortSignal):Promise<RetrievalResult> {
  this.options.catalog.validate(snapshot);
  if(!Array.isArray(terms)||terms.length>this.options.policy.queryTerms||terms.some(t=>typeof t!=='string'))throw new RetrievalQueryError();
  const normalized=terms.length?normalizeRetrievalQuery(terms.join(' '),this.options.policy):[];
  if(JSON.stringify(normalized)!==JSON.stringify([...new Set(terms)].sort()))throw new RetrievalQueryError();
  if(this.querying||!this.available())throw new RetrievalUnavailableError();
  signal?.throwIfAborted();const g=this.active;if(g?.writer.inTransaction)throw new RetrievalUnavailableError();this.querying=true;let transaction=false;
  if(g)g.readers++;
  try{
   if(g){g.reader.exec('BEGIN');transaction=true;}
   const description=this.describeGeneration(snapshot,g),coverage=initialCoverage(snapshot,description),ranking=new CandidateRanking(this.options.policy);
   const deadline=this.options.now()+this.options.policy.queryMilliseconds;let fetched=0,partial=false,sourcesExamined=0;
   const check=()=>{signal?.throwIfAborted();this.options.catalog.validate(snapshot);if(this.closed)throw new RetrievalUnavailableError();if(!this.available()||this.options.now()>=deadline)throw new InterruptedIndexWork();};
   try{
    if(g&&normalized.length)for(const source of description.sources){
     check();if(!source.current||!source.indexedPrefix)continue;
     coverage.searchedMeetings++;
     type Posting={evidenceOrdinal:number;frequency:number};
     const streams=normalized.map(term=>({term,cursor:-1,rows:[] as Posting[],offset:0,eof:false}));
     const head=async(stream:typeof streams[number]):Promise<Posting|undefined>=>{
      if(stream.offset===stream.rows.length&&!stream.eof){
       check();const remaining=this.options.policy.queryRows-fetched;if(remaining<=0)throw new InterruptedIndexWork();
       const limit=Math.min(this.options.policy.evidenceSlice,remaining);
       stream.rows=g.reader.query('SELECT evidenceOrdinal,frequency FROM postings WHERE sessionId=? AND sourceRevision=? AND transcriptVersion=? AND term=? AND evidenceOrdinal>? ORDER BY evidenceOrdinal LIMIT ?').all(source.sessionId,source.sourceRevision,source.transcriptVersion,stream.term,stream.cursor,limit) as Posting[];
       fetched+=stream.rows.length;stream.offset=0;stream.eof=stream.rows.length<limit;
       if(stream.rows.length===this.options.policy.evidenceSlice)await Bun.sleep(0);check();
      }
      return stream.rows[stream.offset];
     };
     while(true){
      check();const heads=[] as Array<Posting|undefined>;for(const stream of streams)heads.push(await head(stream));
      const ordinals=heads.flatMap(row=>row?[row.evidenceOrdinal]:[]);if(!ordinals.length)break;
      const ordinal=Math.min(...ordinals);let distinct=0,frequency=0;
      for(let i=0;i<streams.length;i++){const row=heads[i];if(row?.evidenceOrdinal===ordinal){distinct++;frequency+=Math.min(row.frequency,3);streams[i].cursor=ordinal;streams[i].offset++;coverage.matchingRowsVisited++;}}
      coverage.matchedEvidence++;ranking.add({sessionId:source.sessionId,sourceRevision:source.sourceRevision,transcriptVersion:source.transcriptVersion,evidenceOrdinal:ordinal,score:100*distinct+frequency});
     }
     coverage.searchedEvidence!+=source.indexedPrefix;
     if(++sourcesExamined%this.options.policy.evidenceSlice===0){await Bun.sleep(0);check();}
    }
   }catch(error){if(!(error instanceof InterruptedIndexWork))throw error;partial=true;}
   if(partial){coverage.lookupComplete=false;coverage.searchedEvidence=null;coverage.partialReasons.push('query-budget');}
   if(!coverage.indexComplete)coverage.lookupComplete=false;
   const getHit=(candidate:Candidate):RetrievalHit|undefined=>{
    const row=g?.reader.query('SELECT evidenceId FROM chunks WHERE sessionId=? AND sourceRevision=? AND transcriptVersion=? AND evidenceOrdinal=?').get(candidate.sessionId,candidate.sourceRevision,candidate.transcriptVersion,candidate.evidenceOrdinal) as {evidenceId:string}|null;
    return row?{...candidate,evidenceId:row.evidenceId}:undefined;
   };
   const anchors=ranking.anchors(),hits:RetrievalHit[]=[],seen=new Set<string>();
   for(const anchor of anchors){const hit=getHit(anchor);if(!hit)throw new RetrievalUnavailableError();hits.push(hit);seen.add(hit.evidenceId);}
   for(const anchor of anchors)for(const ordinal of [anchor.evidenceOrdinal-1,anchor.evidenceOrdinal+1]){
    if(hits.length>=this.options.policy.excerpts)break;
    const source=description.sources.find(s=>s.sessionId===anchor.sessionId)!;if(ordinal<0||ordinal>=source.indexedPrefix)continue;
    const hit=getHit({...anchor,evidenceOrdinal:ordinal,score:0});if(hit&&!seen.has(hit.evidenceId)){hits.push(hit);seen.add(hit.evidenceId);}
   }
   signal?.throwIfAborted();this.options.catalog.validate(snapshot);if(this.closed)throw new RetrievalUnavailableError();
   recordRetrieved(coverage,hits);return {snapshot,generationId:g?.id??null,hits,coverage};
  }finally{
   if(transaction)try{g!.reader.exec('ROLLBACK');}catch{}
   this.querying=false;
   if(g){g.readers--;if(g.retired&&!this.uncertainPublication&&!g.readers)this.dispose(g);else if(this.closed&&!g.readers){g.reader.close();g.writer.close();}}
  }
 }
 /** ID-only neighbor expansion. Never look up outside the caller's selected stamps. */
 identify(snapshot:RetrievalSnapshot,candidates:Candidate[]):Array<RetrievalHit|null>{
  this.options.catalog.validate(snapshot);if(this.closed||candidates.length>this.options.policy.excerpts)throw new RetrievalUnavailableError();
  const selected=new Map(snapshot.sources.map(s=>[s.sessionId,s]));return candidates.map(candidate=>{
   const source=selected.get(candidate.sessionId);
   if(!source||source.sourceRevision!==candidate.sourceRevision||source.transcriptVersion!==candidate.transcriptVersion||!Number.isSafeInteger(candidate.evidenceOrdinal)||candidate.evidenceOrdinal<0)throw new RetrievalUnavailableError();
   const row=this.active?.reader.query('SELECT evidenceId FROM chunks WHERE sessionId=? AND sourceRevision=? AND transcriptVersion=? AND evidenceOrdinal=?').get(candidate.sessionId,candidate.sourceRevision,candidate.transcriptVersion,candidate.evidenceOrdinal) as {evidenceId:string}|null;
   return row?{...candidate,evidenceId:row.evidenceId}:null;
  });
 }
 /** Bounded stored bindings, for verification against authoritative accepted JSON. */
 bindings(snapshot:RetrievalSnapshot,hits:RetrievalHit[]):Array<TranscriptEvidence|null>{
  this.options.catalog.validate(snapshot);if(this.closed||hits.length>this.options.policy.excerpts)throw new RetrievalUnavailableError();
  const selected=new Map(snapshot.sources.map(s=>[s.sessionId,s]));
  return hits.map(hit=>{
   const source=selected.get(hit.sessionId);
   if(!source||source.sourceRevision!==hit.sourceRevision||source.transcriptVersion!==hit.transcriptVersion||!Number.isSafeInteger(hit.evidenceOrdinal)||hit.evidenceOrdinal<0)throw new RetrievalUnavailableError();
   const row=this.active?.reader.query('SELECT evidenceId,quote,location FROM chunks WHERE sessionId=? AND sourceRevision=? AND transcriptVersion=? AND evidenceOrdinal=?').get(hit.sessionId,hit.sourceRevision,hit.transcriptVersion,hit.evidenceOrdinal) as {evidenceId:string;quote:Uint8Array;location:string}|null;
   if(!row)return null;if(row.evidenceId!==hit.evidenceId)throw new RetrievalUnavailableError();
   try{return {id:row.evidenceId,...JSON.parse(row.location),quote:Buffer.from(row.quote).toString('utf16le')};}catch{throw new RetrievalUnavailableError();}
  });
 }
 private check(signal?:AbortSignal){signal?.throwIfAborted();if(this.closed||this.options.isBusy())throw new InterruptedIndexWork();}
 private source(descriptor:RetrievalDescriptor):Session {
  const session=this.options.store.read(descriptor.sessionId,this.options.policy.sourceRecordBytes);
  if(!session||session.transcriptRevision!==descriptor.sourceRevision||session.transcriptVersion!==descriptor.transcriptVersion||sourceRevision(session)!==descriptor.sourceRevision||!session.transcriptFinalized)throw new InterruptedIndexWork();
  return session;
 }
 private async replace(g:Generation,descriptor:RetrievalDescriptor,signal?:AbortSignal){
  this.check(signal);const session=this.source(descriptor),db=g.writer,scratch=new ScratchTokenizer();let transaction=false;
  try{
   const old=db.query('SELECT epoch FROM manifests WHERE sessionId=?').get(descriptor.sessionId) as {epoch:number}|null;
   db.exec('BEGIN IMMEDIATE');transaction=true;db.query('DELETE FROM manifests WHERE sessionId=?').run(descriptor.sessionId);
   const total=db.query('SELECT COALESCE(SUM(indexedEvidence),0) AS n FROM manifests').get() as {n:number};
   let rows=total.n,postings=(db.query('SELECT COUNT(*) AS n FROM postings').get() as {n:number}).n,indexed=0;
   db.query('INSERT INTO manifests VALUES(?,?,?,?,?,?,?)').run(descriptor.sessionId,descriptor.sourceRevision,descriptor.transcriptVersion,descriptor.evidenceCount,0,0,(old?.epoch??0)+1);
   for(const evidence of iterateTranscriptEvidence(session)){
    const terms=tokenizeTranscriptEvidence(scratch,evidence);
    if(rows>=this.options.policy.evidenceRows||postings+terms.length>this.options.policy.postingRows)break;
    const {id,quote,...location}=evidence;
    db.query('INSERT INTO chunks VALUES(?,?,?,?,?,?,?)').run(descriptor.sessionId,descriptor.sourceRevision,descriptor.transcriptVersion,indexed,id,Buffer.from(quote,'utf16le'),JSON.stringify(location));
    for(const {term,frequency} of terms)db.query('INSERT INTO postings VALUES(?,?,?,?,?,?)').run(descriptor.sessionId,descriptor.sourceRevision,descriptor.transcriptVersion,term,indexed,frequency);
    indexed++;rows++;postings+=terms.length;
    if(indexed%this.options.policy.evidenceSlice===0){await Bun.sleep(0);this.check(signal);this.source(descriptor);}
   }
   this.check(signal);this.source(descriptor);
   db.query('UPDATE manifests SET indexedEvidence=?,indexedPrefix=? WHERE sessionId=?').run(indexed,indexed,descriptor.sessionId);db.exec('COMMIT');transaction=false;
  }finally{if(transaction)try{db.exec('ROLLBACK');}catch{}scratch.close();}
 }
 private journalAllowance(bytes:number){return bytes+Math.ceil(bytes/4096)*8+4096;}
 private rowCounts(g:Generation){return {evidence:(g.writer.query('SELECT COALESCE(SUM(indexedEvidence),0) AS n FROM manifests').get() as {n:number}).n,postings:(g.writer.query('SELECT COUNT(*) AS n FROM postings').get() as {n:number}).n};}
 private async update(id:string,descriptor:RetrievalDescriptor|undefined,signal?:AbortSignal){
  const g=this.active!;const bytes=this.fileBytes(this.dbPath(g.id)),claim='retrieval-work-'+g.id;
  this.reserve(claim,this.ownedBytes()+Math.max(0,this.options.policy.databaseBytes-bytes)+this.journalAllowance(bytes)+8192,Math.min(this.options.policy.workingDiskBytes,2*this.options.policy.databaseBytes));
  try{
   this.check(signal);const before=this.rowCounts(g);
   if(descriptor)await this.replace(g,descriptor,signal);
   else g.writer.query('DELETE FROM manifests WHERE sessionId=?').run(id);
   if(descriptor){this.indexed.set(id,signature(descriptor));const row=g.reader.query('SELECT totalEvidence,indexedEvidence FROM manifests WHERE sessionId=?').get(id) as Manifest;if(row.indexedEvidence<row.totalEvidence)this.partial.add(id);else this.partial.delete(id);}else{this.indexed.delete(id);this.partial.delete(id);}this.failures.delete(id);
   const after=this.rowCounts(g);if(after.evidence<before.evidence||after.postings<before.postings)for(const source of this.partial)if(!this.queue(source))break;
  }finally{this.release(claim);}
 }
 tick(signal?:AbortSignal):Promise<void>{
  if(this.running)return this.running;
  this.running=this.maintain(signal).finally(()=>{this.running=undefined;});return this.running;
 }
 private async maintain(signal?:AbortSignal){
  if(this.closed||this.options.isBusy()||this.options.catalog.state()!=='ready')return;
  if(!this.confirmPublication())return;
  if(!this.active||this.rebuildNeeded){await this.build(signal);return;}
  if(this.active.readers)return;
  const descriptors=this.options.catalog.resolve(all).descriptors,byId=new Map(descriptors.map(s=>[s.sessionId,s]));
  for(const id of this.indexed.keys())if(!byId.has(id)&&!this.queue(id))break;
  if(!this.rebuildNeeded)for(const source of descriptors)if(this.indexed.get(source.sessionId)!==signature(source)&&!this.queue(source.sessionId))break;
  if(this.rebuildNeeded){await this.build(signal);return;}
  const id=[...this.pending].sort((a,b)=>Number(byId.has(a))-Number(byId.has(b))||(a<b?-1:a>b?1:0))[0];if(!id)return;
  try{await this.update(id,byId.get(id),signal);this.pending.delete(id);}catch(error){if(signal?.aborted)throw error;if(!(error instanceof InterruptedIndexWork)){if(byId.has(id))this.failed(id);this.pending.delete(id);}}
 }
 rebuild(signal?:AbortSignal):Promise<void>{
  if(this.running)return this.running;
  this.running=this.build(signal).finally(()=>{this.running=undefined;});return this.running;
 }
 private async build(signal?:AbortSignal){
  if(this.closed||this.options.isBusy()||this.options.catalog.state()!=='ready'||this.retired.size)return;
  const selection=this.options.catalog.resolve(all),id=randomUUID(),claim='retrieval-rebuild-'+id,path=join(this.options.directory,id);
  let g:Generation|undefined,published=false;
  try{
   mkdirSync(path,{mode:0o700});
   this.reserve(claim,this.ownedBytes()+this.options.policy.databaseBytes+this.journalAllowance(this.options.policy.databaseBytes)+8192,this.options.policy.workingDiskBytes);
   g=this.open(id,true);this.stage=g;
   for(const source of selection.descriptors){this.check(signal);await this.replace(g,source,signal);await Bun.sleep(0);}
   this.check(signal);this.options.catalog.validate(selection.snapshot);
   const file=openSync(this.dbPath(id),'r');try{fsyncSync(file);}finally{closeSync(file);}
   this.syncDirectory(path);
   atomicWriteJson(this.pointer(),{schemaVersion:1,generationId:id});published=true;
   this.activate(g);
  }catch(error){
   if(!published&&g&&this.selectedGeneration()===id){
    // The rename may be durable even when acknowledgment/cleanup threw. Never
    // remove a generation the pointer already names. Preserve the old one if
    // directory durability is still uncertain, then retry that fence later.
    published=true;try{this.syncDirectory(this.options.directory);}catch{this.uncertainPublication=true;}
    this.activate(g);
   }
   if(!published&&g){g.reader.close();g.writer.close();this.stage=undefined;}
   if(!published)rmSync(path,{recursive:true,force:true});
   if(signal?.aborted)throw error;
   if(!(error instanceof InterruptedIndexWork))for(const source of selection.descriptors)this.failed(source.sessionId);
  }finally{if(this.claims.has(claim))this.release(claim);}
 }
 private activate(g:Generation){
  const old=this.active;this.active=g;this.stage=undefined;this.refreshStamps();this.pending.clear();this.failures.clear();this.rebuildNeeded=false;
  if(old){if(this.uncertainPublication){old.retired=true;this.retired.add(old);}else this.retire(old);}
  if(!this.uncertainPublication)this.cleanupUnreferenced();
 }
 private cleanupUnreferenced(){
  const retained=new Set([this.active?.id,this.stage?.id,...[...this.retired].map(g=>g.id)]);
  for(const id of readdirSync(this.options.directory))if(uuid.test(id)&&!retained.has(id)){
   const path=join(this.options.directory,id);if(lstatSync(path).isDirectory()&&!lstatSync(path).isSymbolicLink())rmSync(path,{recursive:true});
  }
 }
 private confirmPublication(){
  if(!this.uncertainPublication)return true;
  try{this.syncDirectory(this.options.directory);}catch{return false;}
  this.uncertainPublication=false;for(const g of this.retired)if(!g.readers)this.dispose(g);this.cleanupUnreferenced();return true;
 }
 private retire(g:Generation){g.retired=true;this.retired.add(g);if(!g.readers)this.dispose(g);}
 private dispose(g:Generation){g.reader.close();g.writer.close();this.retired.delete(g);rmSync(g.path,{recursive:true,force:true});}
 /** Exact single-link local cache files, only after every reader/writer has left. */
 disposableFiles():string[]{
  if(this.closed||this.running||this.querying||this.claims.size||this.stage||this.retired.size||this.uncertainPublication||!this.active||this.active.readers||this.active.writer.inTransaction)return [];
  try{
   if(this.selectedGeneration()!==this.active.id)return [];
   const names=readdirSync(this.active.path);if(!names.includes('index.sqlite'))return [];
   const files=[this.pointer(),...names.map(name=>join(this.active!.path,name))];
   this.ownedBytes();
   if(files.some(path=>{const stat=lstatSync(path);return !stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1;}))return [];
   return files.sort();
  }catch{return [];}
 }
 /** Synchronous quota token validation precedes this whole-generation retirement. */
 reclaim(files:string[]):void {
  const eligible=this.disposableFiles();if(!files.length||JSON.stringify([...files].sort())!==JSON.stringify(eligible))throw new Error('Wait for active retrieval before reclaiming its cache');
  const g=this.active!;
  // Remove the pointer first: interruption may leave an unreferenced derived
  // directory, never a pointer to a partly deleted generation.
  rmSync(this.pointer());this.rebuildNeeded=true;this.syncDirectory(this.options.directory);
  g.reader.close();g.writer.close();this.active=undefined;this.indexed.clear();this.partial.clear();this.pending.clear();this.failures.clear();
  for(const path of eligible)if(path!==this.pointer())rmSync(path);
  // Never recursively remove an unreviewed file injected into the directory.
  rmdirSync(g.path);this.syncDirectory(this.options.directory);
 }
 close(){
  if(this.closed)return;this.closed=true;this.unsubscribe();
  if(this.stage){try{this.stage.writer.exec('ROLLBACK');}catch{}this.stage.reader.close();this.stage.writer.close();rmSync(this.stage.path,{recursive:true,force:true});this.stage=undefined;}
  if(this.active){try{this.active.writer.exec('ROLLBACK');}catch{}if(!this.active.readers){this.active.reader.close();this.active.writer.close();}this.active=undefined;}
  for(const g of this.retired){if(g.readers)continue;if(this.uncertainPublication){g.reader.close();g.writer.close();this.retired.delete(g);}else this.dispose(g);}for(const claim of [...this.claims])this.release(claim);this.pending.clear();this.indexed.clear();this.partial.clear();this.failures.clear();
 }
}
