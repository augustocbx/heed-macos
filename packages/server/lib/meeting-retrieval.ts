import {createHash} from 'node:crypto';
import type {Session,TranscriptEvidence} from '@heed/shared';
import type {RetrievalResult,RetrievalSnapshot,RetrievalHit,RetrievalSourceStamp} from '../../shared/types/retrieval';
import {sourceRevision} from '../../shared/lib/transcript-source';
import {RetrievalCatalog} from './retrieval-catalog';
import {RetrievalIndex,tokenizeTranscriptEvidence} from './retrieval-index';
import type {RetrievalPolicy} from './retrieval-policy';
import {SessionTags} from './session-tags';
import {iterateTranscriptEvidence} from './meeting-chat';
import {ScratchTokenizer,normalizeRetrievalQuery,RetrievalUnavailableError} from './retrieval-tokenizer';
import {CandidateRanking,recordRetrieved,type Candidate} from './retrieval-ranking';
interface Options {catalog:RetrievalCatalog;index:RetrievalIndex;store:SessionTags;policy:RetrievalPolicy;now:()=>number;}
interface CacheEntry {expires:number;bytes:number;result:Omit<RetrievalResult,'snapshot'>;}
const stampMatches=(session:Session|null,stamp:RetrievalSourceStamp):session is Session=>!!session&&session.transcriptFinalized===true&&session.transcriptRevision===stamp.sourceRevision&&session.transcriptVersion===stamp.transcriptVersion&&sourceRevision(session)===stamp.sourceRevision;
const sameEvidence=(a:TranscriptEvidence,b:TranscriptEvidence)=>a.id===b.id&&a.sessionId===b.sessionId&&a.sourceRevision===b.sourceRevision&&a.segmentIndex===b.segmentIndex&&a.paragraphIndex===b.paragraphIndex&&a.speaker===b.speaker&&a.start===b.start&&a.end===b.end&&Buffer.from(a.quote,'utf16le').equals(Buffer.from(b.quote,'utf16le'));
/** Disposable IDs/scores/counts only. Every quote is re-read from accepted source JSON. */
export class MeetingRetriever {
 private cache=new Map<string,CacheEntry>();
 private cacheBytes=0;
 private closed=false;
 private retrieving=false;
 private unsubscribe:()=>void;
 constructor(private options:Options){this.unsubscribe=options.store.subscribeCommitted(change=>{if(change.kind==='invalidate')this.clear();},()=>this.clear());}
 private clear(){this.cache.clear();this.cacheBytes=0;}
 invalidateCache(){this.clear();}
 private check(snapshot:RetrievalSnapshot,signal?:AbortSignal){signal?.throwIfAborted();if(this.closed)throw new RetrievalUnavailableError();this.options.catalog.validate(snapshot);}
 private guard(stamp:RetrievalSourceStamp):Session {
  const session=this.options.store.read(stamp.sessionId,this.options.policy.sourceRecordBytes);if(!stampMatches(session,stamp))throw new RetrievalUnavailableError();return session;
 }
 private guardHits(hits:RetrievalHit[]){for(const stamp of new Map(hits.map(h=>[h.sessionId,h])).values())this.guard(stamp);}
 private remember(key:string,result:RetrievalResult){
  const {snapshot:_,...payload}=result,bytes=Buffer.byteLength(key)+Buffer.byteLength(JSON.stringify(payload));if(bytes>this.options.policy.cacheBytes)return;
  const old=this.cache.get(key);if(old){this.cache.delete(key);this.cacheBytes-=old.bytes;}
  while(this.cache.size>=this.options.policy.cacheEntries||this.cacheBytes+bytes>this.options.policy.cacheBytes){const [first,entry]=this.cache.entries().next().value!;this.cache.delete(first);this.cacheBytes-=entry.bytes;}
  this.cache.set(key,{bytes,expires:this.options.now()+this.options.policy.cacheTTLMilliseconds,result:structuredClone(payload)});this.cacheBytes+=bytes;
 }
 async retrieve(snapshot:RetrievalSnapshot,question:string,signal?:AbortSignal):Promise<RetrievalResult>{
  this.check(snapshot,signal);if(!this.options.index.available())throw new RetrievalUnavailableError();if(this.retrieving)throw new RetrievalUnavailableError();let terms:string[],capabilityUnavailable=false;try{terms=normalizeRetrievalQuery(question,this.options.policy);}catch(error){if(!(error instanceof RetrievalUnavailableError))throw error;terms=[];capabilityUnavailable=true;}const description=this.options.index.describe(snapshot);
  const key=createHash('sha256').update(JSON.stringify({capabilityUnavailable,snapshot:snapshot.key,terms,generation:description.generationId,sources:description.sources.map(s=>[s.sessionId,s.sourceRevision,s.transcriptVersion,s.epoch,s.current,s.indexedPrefix,s.reason??null]),ranker:'distinct100-cap3-speaker-v1',policy:this.options.policy})).digest('hex');
  const entry=this.cache.get(key);
  if(entry&&entry.expires>this.options.now()){
   this.guardHits(entry.result.hits);this.check(snapshot,signal);this.cache.delete(key);this.cache.set(key,entry);return {...structuredClone(entry.result),snapshot};
  }
  if(entry){this.cache.delete(key);this.cacheBytes-=entry.bytes;}
  this.retrieving=true;
  try{
   const deadline=this.options.now()+this.options.policy.queryMilliseconds;
   const result=await this.options.index.search(snapshot,terms,signal),needsFallback=!terms.length||description.sources.some(s=>s.indexedPrefix<s.totalEvidence);
   if(needsFallback)await this.fallback(result,terms,description.sources,deadline,signal);
   if(capabilityUnavailable){result.coverage.lookupComplete=false;result.coverage.partialReasons=[...new Set([...result.coverage.partialReasons,'index-missing' as const])];}
   this.check(snapshot,signal);this.remember(key,result);return result;
  }finally{this.retrieving=false;}
 }
 private async fallback(result:RetrievalResult,terms:string[],sources:ReturnType<RetrievalIndex['describe']>['sources'],deadline:number,signal?:AbortSignal){
  const {policy}=this.options,coverage=result.coverage,ranking=new CandidateRanking(policy),ids=new Map<string,string>(),ranges=new Map<string,{from:number;to:number}>();
  for(const hit of result.hits)if(hit.score>0){ranking.add(hit);ids.set(`${hit.sessionId}:${hit.evidenceOrdinal}`,hit.evidenceId);}
  const started=new Set(sources.filter(s=>terms.length&&s.current&&s.indexedPrefix>0).slice(0,coverage.searchedMeetings).map(s=>s.sessionId));
  let readBytes=0,examined=0,loaded=0,limited=false;
  const scratch=terms.length?new ScratchTokenizer():null;
  try{
   for(const source of sources){
    if(terms.length&&source.indexedPrefix>=source.totalEvidence)continue;
    this.check(result.snapshot,signal);
    if(!this.options.index.available()||loaded>=policy.fallbackSources||examined>=policy.fallbackEvidence||readBytes>=policy.fallbackSourceBytes||this.options.now()>=deadline){limited=true;break;}
    let session:Session|null;
    try{const read=this.options.store.readSized(source.sessionId,Math.min(policy.sourceRecordBytes,policy.fallbackSourceBytes-readBytes));readBytes+=read.bytes;session=read.session;}
    catch{limited=true;break;}
    if(!stampMatches(session,source))throw new RetrievalUnavailableError();loaded++;
    if(!started.has(source.sessionId)){coverage.searchedMeetings++;started.add(source.sessionId);}
    const from=terms.length?source.indexedPrefix:0,stamp={sessionId:source.sessionId,sourceRevision:source.sourceRevision,transcriptVersion:source.transcriptVersion};let ordinal=0,to=from;
    const iterator=iterateTranscriptEvidence(session);
    while(ordinal<source.totalEvidence){
     if(ordinal>=from&&(!this.options.index.available()||examined>=policy.fallbackEvidence||this.options.now()>=deadline)){limited=true;break;}
     const next=iterator.next();if(next.done)break;const evidence=next.value;
     if(ordinal<from){ordinal++;if(ordinal%policy.evidenceSlice===0){await Bun.sleep(0);this.check(result.snapshot,signal);if(!this.options.index.available()||this.options.now()>=deadline){limited=true;break;}}continue;}
     if(!this.options.index.available()||examined>=policy.fallbackEvidence||this.options.now()>=deadline){limited=true;break;}
     const frequencies=scratch?tokenizeTranscriptEvidence(scratch,evidence):[],matched=frequencies.filter(row=>terms.includes(row.term)),score=matched.length*100+matched.reduce((n,row)=>n+Math.min(row.frequency,3),0);
     ids.set(`${source.sessionId}:${ordinal}`,evidence.id);to=ordinal+1;examined++;if(coverage.searchedEvidence!==null)coverage.searchedEvidence++;
     if(score>0){coverage.matchedEvidence++;ranking.add({...stamp,evidenceOrdinal:ordinal,evidenceId:evidence.id,score});}
     else if(!terms.length)ranking.add({...stamp,evidenceOrdinal:ordinal,evidenceId:evidence.id,score:0});
     ordinal++;
     if(examined%policy.evidenceSlice===0){await Bun.sleep(0);this.check(result.snapshot,signal);}
    }
    ranges.set(source.sessionId,{from,to});
    if(to<source.totalEvidence)limited=true;
    this.check(result.snapshot,signal);
   }
  }finally{scratch?.close();}
  const anchors=ranking.anchors(),hits:RetrievalHit[]=[],seen=new Set<string>();
  // Existing indexed IDs and examined fallback IDs qualify all allowed neighbors.
  const old=new Map(result.hits.map(h=>[`${h.sessionId}:${h.evidenceOrdinal}`,h.evidenceId]));
  const candidates:Candidate[]=[...anchors];for(const anchor of anchors)for(const ordinal of [anchor.evidenceOrdinal-1,anchor.evidenceOrdinal+1])if(ordinal>=0)candidates.push({...anchor,evidenceOrdinal:ordinal,score:0});
  const missing=candidates.filter(c=>!ids.has(`${c.sessionId}:${c.evidenceOrdinal}`)&&!old.has(`${c.sessionId}:${c.evidenceOrdinal}`)&&c.evidenceOrdinal<(terms.length?(sources.find(s=>s.sessionId===c.sessionId)?.indexedPrefix??0):0));
  // A bounded ID-only lookup handles neighbors which were not in the lexical top16.
  const resolved=this.options.index.identify(result.snapshot,missing.slice(0,policy.excerpts));
  for(const hit of resolved)if(hit)ids.set(`${hit.sessionId}:${hit.evidenceOrdinal}`,hit.evidenceId);
  for(const candidate of candidates){
   if(hits.length>=policy.excerpts)break;const key=`${candidate.sessionId}:${candidate.evidenceOrdinal}`,range=ranges.get(candidate.sessionId),source=sources.find(s=>s.sessionId===candidate.sessionId)!;
   const allowed=terms.length&&candidate.evidenceOrdinal<source.indexedPrefix||!!range&&candidate.evidenceOrdinal>=range.from&&candidate.evidenceOrdinal<range.to;
   const evidenceId=ids.get(key)??old.get(key);if(allowed&&evidenceId&&!seen.has(evidenceId)){hits.push({...candidate,evidenceId});seen.add(evidenceId);}
  }
  coverage.strategy='fallback';coverage.lookupComplete=coverage.lookupComplete||!terms.length;
  if(limited){coverage.lookupComplete=false;coverage.partialReasons.push('fallback-limit');}
  else if(!coverage.partialReasons.includes('query-budget'))coverage.lookupComplete=true;
  coverage.partialReasons=[...new Set(coverage.partialReasons)];result.hits=hits;recordRetrieved(coverage,hits);
 }
 async materialize(result:RetrievalResult,signal?:AbortSignal):Promise<TranscriptEvidence[]>{
  try{return await this.materializeCurrent(result,signal);}catch(error){
   if(error instanceof RetrievalUnavailableError){this.clear();if(!this.closed)this.options.index.enqueue({kind:'invalidate'});}
   throw error;
  }
 }
 private async materializeCurrent(result:RetrievalResult,signal?:AbortSignal):Promise<TranscriptEvidence[]>{
  this.check(result.snapshot,signal);const {hits}=result;if(hits.length>this.options.policy.excerpts||new Set(hits.map(h=>h.evidenceId)).size!==hits.length)throw new RetrievalUnavailableError();
  const bindings=this.options.index.bindings(result.snapshot,hits),selected=new Map(result.snapshot.sources.map(s=>[s.sessionId,s])),evidence=new Map<string,TranscriptEvidence>();
  const groups=new Map<string,RetrievalHit[]>();for(const hit of hits){const group=groups.get(hit.sessionId)??[];group.push(hit);groups.set(hit.sessionId,group);}
  for(const [id,wanted] of groups){
   const source=selected.get(id);if(!source||wanted.some(h=>h.sourceRevision!==source.sourceRevision||h.transcriptVersion!==source.transcriptVersion||!Number.isSafeInteger(h.evidenceOrdinal)||h.evidenceOrdinal<0))throw new RetrievalUnavailableError();
   const session=this.guard(source),ordinals=new Map(wanted.map(h=>[h.evidenceOrdinal,h.evidenceId]));let ordinal=0;
   for(const chunk of iterateTranscriptEvidence(session)){
    const expected=ordinals.get(ordinal++);if(expected){if(chunk.id!==expected)throw new RetrievalUnavailableError();evidence.set(expected,chunk);ordinals.delete(ordinal-1);if(!ordinals.size)break;}
    if(ordinal%this.options.policy.evidenceSlice===0){await Bun.sleep(0);this.check(result.snapshot,signal);}
   }
   if(ordinals.size)throw new RetrievalUnavailableError();this.guard(source);this.check(result.snapshot,signal);
  }
  const materialized=hits.map((hit,index)=>{const current=evidence.get(hit.evidenceId);if(!current||bindings[index]&&!sameEvidence(current,bindings[index]!))throw new RetrievalUnavailableError();return current;});
  this.check(result.snapshot,signal);return materialized;
 }
 close(){if(this.closed)return;this.closed=true;this.unsubscribe();this.clear();}
}
