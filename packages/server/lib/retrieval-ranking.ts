import type {RetrievalCoverage,RetrievalHit,RetrievalSnapshot} from '../../shared/types/retrieval';
import type {RetrievalIndexDescription} from './retrieval-index';
import type {RetrievalPolicy} from './retrieval-policy';
export type Candidate=Omit<RetrievalHit,'evidenceId'> & {evidenceId?:string};
export const compareCandidates=(a:Candidate,b:Candidate)=>b.score-a.score||(a.sessionId<b.sessionId?-1:a.sessionId>b.sessionId?1:0)||a.evidenceOrdinal-b.evidenceOrdinal;
/** At most48 global candidates and16 source winners; quotes never enter ranking. */
export class CandidateRanking {
 private global:Candidate[]=[];
 private globalCandidate(hit:Candidate){
  const heap=this.global,limit=this.policy.globalHits;
  if(heap.length<limit){heap.push(hit);let i=heap.length-1;while(i>0){const parent=(i-1)>>1;if(compareCandidates(heap[i],heap[parent])<=0)break;[heap[i],heap[parent]]=[heap[parent],heap[i]];i=parent;}return;}
  if(compareCandidates(hit,heap[0])>=0)return;heap[0]=hit;let i=0;
  while(2*i+1<heap.length){let child=2*i+1;if(child+1<heap.length&&compareCandidates(heap[child+1],heap[child])>0)child++;if(compareCandidates(heap[child],heap[i])<=0)break;[heap[i],heap[child]]=[heap[child],heap[i]];i=child;}
 }
 private winners=new Map<string,Candidate>();
 constructor(private policy:RetrievalPolicy){}
 add(hit:Candidate){
  this.globalCandidate(hit);
  const old=this.winners.get(hit.sessionId);if(!old||compareCandidates(hit,old)<0)this.winners.set(hit.sessionId,hit);
  if(this.winners.size>this.policy.sourceWinners){const last=[...this.winners.values()].sort(compareCandidates).at(-1)!;this.winners.delete(last.sessionId);}
 }
 anchors():Candidate[]{
  const protectedHits=[...this.winners.values()].sort(compareCandidates).slice(0,this.policy.anchors),keys=new Set(protectedHits.map(h=>`${h.sessionId}:${h.evidenceOrdinal}`));
  for(const hit of [...this.global].sort(compareCandidates))if(protectedHits.length<this.policy.anchors&&!keys.has(`${hit.sessionId}:${hit.evidenceOrdinal}`)){protectedHits.push(hit);keys.add(`${hit.sessionId}:${hit.evidenceOrdinal}`);}
  return protectedHits.sort(compareCandidates);
 }
}
export function initialCoverage(snapshot:RetrievalSnapshot,description:RetrievalIndexDescription):RetrievalCoverage {
 const sources=description.sources;return {version:1,strategy:'lexical',selectedMeetings:snapshot.sources.length,selectedEvidence:sources.reduce((n,s)=>n+s.totalEvidence,0),indexedMeetings:sources.filter(s=>s.current).length,indexedEvidence:sources.reduce((n,s)=>n+s.indexedEvidence,0),searchedMeetings:0,searchedEvidence:0,matchingRowsVisited:0,matchedEvidence:0,retrievedEvidence:0,retrievedMeetings:0,suppliedEvidence:0,suppliedMeetings:0,citedEvidence:0,citedMeetings:0,indexComplete:sources.every(s=>s.current&&s.indexedPrefix===s.totalEvidence),lookupComplete:true,generationComplete:false,partialReasons:[...new Set(sources.flatMap(s=>s.reason?[s.reason]:[]))]};
}
export function recordRetrieved(coverage:RetrievalCoverage,hits:RetrievalHit[]){coverage.retrievedEvidence=hits.length;coverage.retrievedMeetings=new Set(hits.map(h=>h.sessionId)).size;}
