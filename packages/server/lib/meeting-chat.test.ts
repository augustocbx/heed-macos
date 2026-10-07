import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AiWaitingReason, Session } from "@heed/shared";
import { sourceRevision } from "./automatic-notes";
import { MeetingChatService, chatFailure, transcriptEvidence, meetingMetadataEvidence, answerMeetingQuestion as answerRetrieved } from "./meeting-chat";
import {controlledChatRetrieval,testCoverage} from './chat-retrieval-test-utils';
const answerMeetingQuestion=({sessions,...input}:any)=>{const evidence=sessions.flatMap(transcriptEvidence).slice(0,32);return answerRetrieved({...input,evidence,coverage:testCoverage(evidence)});};
const dirs: string[] = [];
const directory = () => { const d = mkdtempSync(join(tmpdir(), "heed-chat-test-")); dirs.push(d); return d; };
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
function meeting(): Session { const s: Session = { id: "meeting-a", title: "Planning", createdAt: "2026-10-05T12:00:00Z", duration: 40, language: "pt", transcript: "", speakers: ["Ana", "Bruno"], segments: [{speaker:"Ana",start:1,end:5,text:"O orçamento não foi aprovado."}, {speaker:"Bruno",start:10,end:15,text:"I will review it on Friday."}], aiNotes: "", summary: "", tags: [], pinned: false, transcriptFinalized: true }; s.transcriptRevision = sourceRevision(s); return s; }
const result = (id: string) => JSON.stringify({ claims: [{ text: "The budget was not approved.", evidenceIds: [id] }], notFound: false });
const flush = async () => { await new Promise(r => setTimeout(r, 10)); };

test('a local model timeout keeps its specific chat failure reason',()=>{
 expect(chatFailure(new Error('generation-timeout'))).toBe('generation-timeout');
});

test("evidence identities are revision-qualified and legacy paragraphs remain text navigable", () => {
 const s = meeting(); const evidence = transcriptEvidence(s);
 expect(evidence[0]).toMatchObject({sessionId:"meeting-a", sourceRevision:s.transcriptRevision, segmentIndex:0, speaker:"Ana", start:1, end:5, quote:"O orçamento não foi aprovado."});
 expect(evidence[0]!.id).not.toBe("0");
 const renamed = {...s, segments:s.segments.map(v=>({...v,speaker:"Alice"}))}; renamed.transcriptRevision = sourceRevision(renamed);
 expect(transcriptEvidence(renamed)[0]!.id).not.toBe(evidence[0]!.id);
 expect(transcriptEvidence({...s,segments:[],transcript:"First decision.\n\nSecond decision."})[1]).toMatchObject({quote:"Second decision.",start:null,end:null,segmentIndex:null});
});

test("answers reject invented citations and factual claims without evidence", async () => {
 const s = meeting();
 await expect(answerMeetingQuestion({sessions:[s],question:"Budget?",history:[],model:"local",generate:async()=>result("invented")})).rejects.toThrow("invalid-evidence");
 await expect(answerMeetingQuestion({sessions:[s],question:"Budget?",history:[],model:"local",generate:async()=>JSON.stringify({claims:[{text:"Approved",evidenceIds:[]}],notFound:false})})).rejects.toThrow("invalid-evidence");
 const answer = await answerMeetingQuestion({sessions:[s],question:"Budget?",history:[],model:"local",generate:async (input:any)=>result(input.evidence[0]!.id)});
 expect(answer.claims[0]!.citations[0]).toMatchObject({quote:"O orçamento não foi aprovado."});
 expect(answer.coverage.complete).toBe(false);
});

test("recorded start is distinct, revision-qualified metadata and missing dates supply none", async () => {
 const s=meeting(),metadata=meetingMetadataEvidence(s);
 expect(metadata).toMatchObject({kind:'meeting-metadata',sessionId:s.id,recordedAt:'2026-10-05T12:00:00.000Z',durationSeconds:40});
 expect(metadata!.id).toContain(':meeting-metadata:');
 expect(meetingMetadataEvidence({...s,createdAt:'invalid'})).toBeNull();
 expect(meetingMetadataEvidence({...s,createdAt:'2026-02-30T12:00:00Z'})).toBeNull();
 expect(meetingMetadataEvidence({...s,createdAt:'2026-10-06T12:00:00Z'})!.id).not.toBe(metadata!.id);
 const evidence=transcriptEvidence(s),coverage=testCoverage(evidence);
 await expect(answerRetrieved({evidence,metadata:[metadata!],coverage,question:'When was the meeting?',history:[],model:'local',generate:async()=>result(evidence[0]!.id).replace('The budget was not approved.','The meeting was on October 5, 2026.')})).rejects.toThrow('invalid-evidence');
 const answer=await answerRetrieved({evidence,metadata:[metadata!],coverage:testCoverage(evidence),question:'When was the meeting?',history:[],model:'local',generate:async input=>JSON.stringify({claims:[{text:'The meeting was on October 5, 2026.',evidenceIds:[input.metadata[0]!.id]}],notFound:false})});
 expect(answer.claims[0]!.citations[0]).toEqual(metadata);
 expect(answer.coverage.retrieval!.citedEvidence).toBe(0);
});

test("metadata-only questions generate and reject unsupplied or incomplete latest claims",async()=>{
 const s=meeting(),metadata=meetingMetadataEvidence(s)!,coverage=testCoverage([]);
 const answer=await answerRetrieved({evidence:[],metadata:[metadata],metadataCoverage:{selectedMeetings:1,suppliedMeetings:1,complete:true},coverage,question:'When?',history:[],model:'local',generate:async input=>JSON.stringify({claims:[{text:'October 5, 2026 at 12:00 UTC.',evidenceIds:[input.metadata[0]!.id]}],notFound:false})});
 expect(answer.claims[0]!.citations[0]!.id).toBe(metadata.id);
 await expect(answerRetrieved({evidence:[],metadata:[metadata],metadataCoverage:{selectedMeetings:2,suppliedMeetings:1,complete:false},coverage:testCoverage([]),question:'What was latest?',history:[],model:'local',generate:async input=>JSON.stringify({claims:[{text:'The latest meeting was October 5, 2026.',evidenceIds:[input.metadata[0]!.id]}],notFound:false})})).rejects.toThrow('invalid-evidence');
});

test('Portuguese natural dates and clock times cannot cite transcript speech as recording metadata',async()=>{
 const s=meeting(),evidence=transcriptEvidence(s),metadata=meetingMetadataEvidence(s)!;
 for(const claim of ['A reunião ocorreu em 5 de outubro de 2026.', 'A reunião começou às 08h19.', 'The meeting was on October 5, 2026.']){
  await expect(answerRetrieved({evidence,metadata:[metadata],coverage:testCoverage(evidence),question:'Quando?',history:[],model:'local',generate:async()=>JSON.stringify({claims:[{text:claim,evidenceIds:[evidence[0]!.id]}],notFound:false})})).rejects.toThrow('invalid-evidence');
 }
 const answer=await answerRetrieved({evidence:[],metadata:[metadata],coverage:testCoverage([]),question:'Quando?',history:[],model:'local',generate:async()=>JSON.stringify({claims:[{text:'A reunião ocorreu em 5 de outubro de 2026.',evidenceIds:[metadata.id]}],notFound:false})});
 expect(answer.claims[0]!.citations[0]!.id).toBe(metadata.id);
});
test('a spoken deadline date and the word may remain valid transcript claims',async()=>{
 const s=meeting(),evidence=transcriptEvidence(s);
 const answer=await answerRetrieved({evidence,coverage:testCoverage(evidence),question:'What did the team say about the deadline?',history:[],model:'local',generate:async()=>JSON.stringify({claims:[{text:'The deadline may move to May 5, 2027.',evidenceIds:[evidence[0]!.id]}],notFound:false})});
 expect(answer.claims[0]!.citations[0]!.id).toBe(evidence[0]!.id);
});
test('a bare calendar answer to a latest meeting question still requires metadata and complete coverage',async()=>{
 const s=meeting(),evidence=transcriptEvidence(s),metadata=meetingMetadataEvidence(s)!;
 const question='Quando foi a última reunião com Ana?';
 await expect(answerRetrieved({evidence,metadata:[metadata],coverage:testCoverage(evidence),question,history:[],model:'local',generate:async()=>JSON.stringify({claims:[{text:'Foi em 5 de outubro de 2026.',evidenceIds:[evidence[0]!.id]}],notFound:false})})).rejects.toThrow('invalid-evidence');
 const partial=testCoverage(evidence);partial.lookupComplete=false;
 await expect(answerRetrieved({evidence,metadata:[metadata],coverage:partial,question,history:[],model:'local',generate:async()=>JSON.stringify({claims:[{text:'Foi em 5 de outubro de 2026.',evidenceIds:[metadata.id,evidence[0]!.id]}],notFound:false})})).rejects.toThrow('invalid-evidence');
});

test('latest speaker claim refuses incomplete transcript matches even when all eight dates were supplied',async()=>{
 const sessions=Array.from({length:8},(_,i)=>({...meeting(),id:`meeting-${i}`,createdAt:`2026-10-${String(i+1).padStart(2,'0')}T12:00:00Z`}));
 const metadata=sessions.map(s=>meetingMetadataEvidence(s)!),evidence=transcriptEvidence(sessions[0]!)[0]!,coverage=testCoverage([evidence]);
 coverage.selectedMeetings=8;coverage.searchedMeetings=8;coverage.matchedEvidence=17;coverage.retrievedEvidence=1;
 const claim={claims:[{text:'The latest meeting with Ana was on October 1, 2026.',evidenceIds:[metadata[0]!.id,evidence.id]}],notFound:false};
 await expect(answerRetrieved({evidence:[evidence],metadata,metadataCoverage:{selectedMeetings:8,suppliedMeetings:8,complete:true},coverage,question:'When was the latest meeting with Ana?',history:[],model:'local',generate:async()=>JSON.stringify(claim)})).rejects.toThrow('invalid-evidence');
});
test('one eligible meeting can answer latest speaker despite many matching excerpts being omitted',async()=>{
 const s=meeting(),evidence=transcriptEvidence(s),metadata=meetingMetadataEvidence(s)!,coverage=testCoverage(evidence);
 coverage.matchedEvidence=77;coverage.retrievedEvidence=32;
 const answer=await answerRetrieved({evidence,metadata:[metadata],metadataCoverage:{selectedMeetings:1,suppliedMeetings:1,complete:true},coverage,question:'When was the latest meeting with Ana?',history:[],model:'local',generate:async()=>JSON.stringify({claims:[{text:'The latest meeting with Ana was on October 5, 2026.',evidenceIds:[evidence[0]!.id,metadata.id]}],notFound:false})});
 expect(answer.claims[0]!.citations).toHaveLength(2);
});
test('a name mentioned by another speaker cannot prove a latest meeting with that person',async()=>{
 const s=meeting();s.segments=[{speaker:'Ana',text:'Bruno will receive the notes.',start:0,end:1}];
 const evidence=transcriptEvidence(s),metadata=meetingMetadataEvidence(s)!;
 await expect(answerRetrieved({evidence,metadata:[metadata],metadataCoverage:{selectedMeetings:1,suppliedMeetings:1,complete:true},coverage:testCoverage(evidence),question:'When was the latest meeting with Bruno?',history:[],model:'local',generate:async()=>JSON.stringify({claims:[{text:'The latest meeting with Bruno was on October 5, 2026.',evidenceIds:[evidence[0]!.id,metadata.id]}],notFound:false})})).rejects.toThrow('invalid-evidence');
});

test("generation respects the retrieved excerpt set and discloses context/model-call limits",async()=>{
 const s=meeting();s.segments=Array.from({length:32},(_,i)=>({speaker:'Ana',start:i,end:i+1,text:i===31?'Budget approved at the end.':'Budget context '.repeat(85)}));s.transcriptRevision=sourceRevision(s);
 const inputs:any[]=[];const value=await answerMeetingQuestion({sessions:[s],question:'Budget?',history:[],model:'local',generate:async(request:any)=>{inputs.push(request);return JSON.stringify({claims:[],notFound:true});}});
 expect(value.coverage.complete).toBe(false);expect(value.coverage.reviewedChunks).toBeLessThanOrEqual(4);expect(value.coverage.totalChunks).toBeGreaterThan(value.coverage.reviewedChunks);expect(value.coverage.retrieval!.partialReasons).toContain('generation-limit');for(const input of inputs)expect(Buffer.byteLength(JSON.stringify(input.data))).toBeLessThanOrEqual(5500);
});

test("accepted question retries are idempotent and history survives service restart", async () => {
 const s=meeting(); const d=directory(); let calls=0;
 const options={...controlledChatRetrieval(()=>[s]),directory:d,getSession:()=>s,isBusy:()=>false,generate:async(input:any)=>{calls++;return result(input.evidence[0].id);}};
 const service=new MeetingChatService(options); const command={action:"send" as const,requestId:"request-a",question:"Budget?",model:"local",expectedSourceRevision:s.transcriptRevision!};
 service.command(s.id,command); await flush();
 const saved=service.get(s.id); expect(saved.turns).toHaveLength(1); expect(saved.turns[0]!.status).toBe("completed");
 service.command(s.id,command); await flush(); expect(calls).toBe(1);
 expect(new MeetingChatService(options).get(s.id).turns[0]!.answer!.claims[0]!.text).toBe("The budget was not approved.");
 expect(()=>service.command(s.id,{...command,question:"Changed?"})).toThrow("request-conflict");
});

test("clear and cancel prevent late answers, retry reuses the original turn", async () => {
 const s=meeting(); let finish:(s:string)=>void=()=>{}; const service=new MeetingChatService({...controlledChatRetrieval(()=>s?[s]:[]),directory:directory(),getSession:()=>s,isBusy:()=>false,generate:()=>new Promise(resolve=>{finish=resolve;})});
 service.command(s.id,{action:"send",requestId:"request-a",question:"Budget?",model:"local",expectedSourceRevision:s.transcriptRevision!}); await flush();
 const turnId=service.get(s.id).turns[0]!.id;
 service.command(s.id,{action:"cancel",turnId}); finish(result(transcriptEvidence(s)[0]!.id)); await flush(); expect(service.get(s.id).turns[0]!.status).toBe("cancelled");
 service.command(s.id,{action:"retry",turnId}); await flush(); expect(service.get(s.id).turns).toHaveLength(1);
 service.command(s.id,{action:"clear",expectedThreadRevision:service.get(s.id).revision}); finish(result(transcriptEvidence(s)[0]!.id)); await flush(); expect(service.get(s.id).turns).toHaveLength(0);
});

test("changed sources mark stored answers stale and block late generation", async () => {
 let s=meeting(); let finish:(s:string)=>void=()=>{};
 const service=new MeetingChatService({...controlledChatRetrieval(()=>s?[s]:[]),directory:directory(),getSession:()=>s,isBusy:()=>false,generate:()=>new Promise(resolve=>{finish=resolve;})});
 service.command(s.id,{action:"send",requestId:"a",question:"Budget?",model:"local",expectedSourceRevision:s.transcriptRevision!}); await flush();
 const evidence=transcriptEvidence(s)[0]!.id; s={...s,transcript:"Edited"};s.transcriptRevision=sourceRevision(s);finish(result(evidence));await flush();
 expect(service.get(s.id).turns[0]!.status).toBe("failed");expect(service.get(s.id).turns[0]!.reason).toBe("source-changed");
});

test("recording priority queues chat and preemption cancels before returning", async () => {
 const s=meeting(); let busy=true; let aborted=false;
 const service=new MeetingChatService({...controlledChatRetrieval(()=>s?[s]:[]),directory:directory(),getSession:()=>s,isBusy:()=>busy,generate:input=>new Promise((_,reject)=>input.signal!.addEventListener("abort",()=>{aborted=true;reject(new Error("aborted"));}))});
 service.command(s.id,{action:"send",requestId:"a",question:"Budget?",model:"local",expectedSourceRevision:s.transcriptRevision!}); await flush(); expect(service.get(s.id).turns[0]!.status).toBe("waiting");
 busy=false;void service.tick();await flush(); await service.preempt();expect(aborted).toBe(true);expect(service.get(s.id).turns[0]!.status).toBe("cancelled");
});

test("saved answers become stale without mutating their citations", async () => {
 let s=meeting();const original=transcriptEvidence(s)[0]!.id;
 const service=new MeetingChatService({...controlledChatRetrieval(()=>s?[s]:[]),directory:directory(),getSession:()=>s,isBusy:()=>false,generate:async()=>result(original)});
 service.command(s.id,{action:"send",requestId:"a",question:"Budget?",model:"local",expectedSourceRevision:s.transcriptRevision!});await flush();
 s={...s,segments:s.segments.map(v=>({...v,speaker:"Renamed"}))};s.transcriptRevision=sourceRevision(s);
 expect(service.get(s.id).turns[0]!.stale).toBe(true);expect(service.get(s.id).turns[0]!.answer!.claims[0]!.citations[0]!.id).toBe(original);
});

test('single-meeting generation supplies recorded metadata and date changes stale its saved answer',async()=>{
 let s=meeting();const service=new MeetingChatService({...controlledChatRetrieval(()=>[s]),directory:directory(),getSession:()=>s,isBusy:()=>false,generate:async input=>JSON.stringify({claims:[{text:'The meeting was recorded on October 5, 2026.',evidenceIds:[input.metadata[0]!.id]}],notFound:false})});
 service.command(s.id,{action:'send',requestId:'recorded-at',question:'When was the meeting?',model:'local',expectedSourceRevision:s.transcriptRevision!});await flush();
 const turn=service.get(s.id).turns[0]!;
 expect(turn.answer!.claims[0]!.citations[0]).toMatchObject({kind:'meeting-metadata',recordedAt:'2026-10-05T12:00:00.000Z'});
 expect(turn.answer!.coverage.retrieval!.citedEvidence).toBe(0);
 s={...s,createdAt:'2026-10-06T12:00:00Z'};
 expect(service.get(s.id).turns[0]).toMatchObject({stale:true});
});

test('a queued meeting question fails when recorded time changes before retrieval',async()=>{
 let s=meeting(),busy=true;const service=new MeetingChatService({...controlledChatRetrieval(()=>[s]),directory:directory(),getSession:()=>s,isBusy:()=>busy,generate:async()=>{throw new Error('Stale meeting must not generate');}});
 service.command(s.id,{action:'send',requestId:'queued-time',question:'When was the meeting?',model:'local',expectedSourceRevision:s.transcriptRevision!});
 s={...s,createdAt:'2026-10-06T12:00:00Z'};busy=false;await service.tick();
 expect(service.get(s.id).turns[0]).toMatchObject({status:'failed',reason:'source-changed',stale:true});
});

test("meeting deletion removes chat and cannot resurrect a late answer", async () => {
 let s:Session|null=meeting();let finish:(v:string)=>void=()=>{};const d=directory();
 const service=new MeetingChatService({...controlledChatRetrieval(()=>s?[s]:[]),directory:d,getSession:()=>s,isBusy:()=>false,generate:()=>new Promise(resolve=>{finish=resolve;})});
 service.command(s.id,{action:"send",requestId:"a",question:"Budget?",model:"local",expectedSourceRevision:s.transcriptRevision!});await flush();
 const ref=transcriptEvidence(s)[0]!.id;service.remove(s.id);s=null;finish(result(ref));await flush();expect(()=>service.get("meeting-a")).toThrow("meeting-not-found");
 expect(new MeetingChatService({...controlledChatRetrieval(()=>s?[s]:[]),directory:d,getSession:()=>s,isBusy:()=>false,generate:async()=>""}).busy).toBe(false);
});

test("chat API rejects untrusted requests, serves saved history, and validates methods", async () => {
 const { chatApiResponse }=await import("./meeting-chat");const s=meeting();const service=new MeetingChatService({...controlledChatRetrieval(()=>s?[s]:[]),directory:directory(),getSession:()=>s,isBusy:()=>true,generate:async()=>""});
 const url="http://localhost/api/sessions/meeting-a/chat";
 expect((await chatApiResponse(new Request(url),service,async()=>["local"],false))!.status).toBe(403);
 expect((await chatApiResponse(new Request(url),service,async()=>["local"],true))!.status).toBe(200);
 expect((await chatApiResponse(new Request(url,{method:"PUT"}),service,async()=>[],true))!.status).toBe(405);
 expect((await chatApiResponse(new Request(url,{method:"POST",body:"not json"}),service,async()=>[],true))!.status).toBe(400);
 const response=await chatApiResponse(new Request(url,{method:"POST",body:JSON.stringify({action:"send",requestId:"a",question:"Budget?",model:"local",expectedSourceRevision:s.transcriptRevision})}),service,async()=>[],true);
 expect((await response!.json()).turns[0].status).toBe("waiting");
 expect(await chatApiResponse(new Request("http://localhost/api/unrelated"),service,async()=>[],true)).toBeNull();
});

test("a persistent storage failure cannot leave a recovered answer running forever", async () => {
 const {atomicWriteJson}=await import("./atomic-json");const s=meeting();let blocked=false;
 const service=new MeetingChatService({...controlledChatRetrieval(()=>s?[s]:[]),directory:directory(),getSession:()=>s,isBusy:()=>false,write:(path,value)=>{if(blocked)throw new Error("disk-full");atomicWriteJson(path,value);},generate:async input=>{blocked=true;return result(input.evidence[0]!.id);}});
 service.command(s.id,{action:"send",requestId:"a",question:"Budget?",model:"local",expectedSourceRevision:s.transcriptRevision!});await flush();blocked=false;
 expect(service.get(s.id).turns[0]!.status).toBe("failed");expect(service.get(s.id).turns[0]!.reason).toBe("interrupted");
});

test("retry can explicitly select another compatible installed model while preserving request identity", async () => {
 const s=meeting();const service=new MeetingChatService({...controlledChatRetrieval(()=>s?[s]:[]),directory:directory(),getSession:()=>s,isBusy:()=>false,generate:async input=>{if(input.model==="missing")throw new Error("model-missing");return result(input.evidence[0]!.id);}});
 const command={action:"send" as const,requestId:"a",question:"Budget?",model:"missing",expectedSourceRevision:s.transcriptRevision!};service.command(s.id,command);await flush();const turn=service.get(s.id).turns[0]!;expect(turn.status).toBe("failed");
 service.command(s.id,{action:"retry",turnId:turn.id,model:"installed"});await flush();expect(service.get(s.id).turns[0]!.status).toBe("completed");expect(service.get(s.id).turns[0]!.model).toBe("installed");expect(service.command(s.id,command).turns).toHaveLength(1);
});

test("tool-shaped model output cannot mutate a meeting or become an answer",async()=>{
 const s=meeting();const before=JSON.stringify(s);
 await expect(answerMeetingQuestion({sessions:[s],question:"Budget?",history:[],model:"local",generate:async()=>'{"tool":"delete_meeting","arguments":{"sessionId":"meeting-a"}}'})).rejects.toThrow("invalid-answer");
 expect(JSON.stringify(s)).toBe(before);
});

test('captured installed-model shape without mandatory notFound remains rejected despite valid cited claims',async()=>{
 const session=meeting();const evidence=transcriptEvidence(session);
 const captured=JSON.stringify({claims:[{text:'The budget was not approved.',evidenceIds:[evidence[0]!.id]}]});
 await expect(answerMeetingQuestion({sessions:[session],question:'Budget?',history:[],model:'local',generate:async()=>captured})).rejects.toThrow('invalid-answer');
});


test('decoder compatibility never removes strict postdecode claim and citation limits',async()=>{
 const session=meeting(),id=transcriptEvidence(session)[0]!.id;
 for(const [claims,reason] of [[[{text:'',evidenceIds:[id]}],'invalid-evidence'],[[{text:'x'.repeat(2001),evidenceIds:[id]}],'invalid-evidence'],[Array.from({length:13},()=>({text:'Supported',evidenceIds:[id]})),'invalid-answer'],[[{text:'Supported',evidenceIds:Array(21).fill(id)}],'invalid-evidence']] as const){await expect(answerMeetingQuestion({sessions:[session],question:'Budget?',history:[],model:'local',generate:async()=>JSON.stringify({claims,notFound:false})})).rejects.toThrow(reason);}
});


test("waiting chat reports the live blocker without rewriting durable history", async () => {
 const s=meeting(); let blocker:AiWaitingReason="tasks";
 const service=new MeetingChatService({...controlledChatRetrieval(()=>s?[s]:[]),directory:directory(),getSession:()=>s,isBusy:()=>true,waitingReason:()=>blocker,generate:async()=>result(transcriptEvidence(s)[0]!.id)});
 service.command(s.id,{action:"send",requestId:"waiting-reason",question:"Budget?",model:"local",expectedSourceRevision:s.transcriptRevision!});
 const first=service.get(s.id); expect(first.turns[0]).toMatchObject({status:"waiting",waitingReason:"tasks"});
 blocker="recording";const next=service.get(s.id);expect(next.turns[0]).toMatchObject({status:"waiting",waitingReason:"recording"});expect(next.revision).toBe(first.revision);
 expect(service.pending).toBe(true);
 service.command(s.id,{action:"cancel",turnId:first.turns[0]!.id});expect(service.pending).toBe(false);expect(service.get(s.id).turns[0]!.waitingReason).toBeUndefined();
});

test('stale pending chat fails and releases admission for background work',async()=>{
 let s=meeting(),busy=true;
 const service=new MeetingChatService({...controlledChatRetrieval(()=>s?[s]:[]),directory:directory(),getSession:()=>s,isBusy:()=>busy,generate:async()=>{throw new Error('Stale source must not generate');}});
 service.command(s.id,{action:'send',requestId:'stale-pending',question:'Budget?',model:'local',expectedSourceRevision:s.transcriptRevision!});
 expect(service.pending).toBe(true);s={...s,transcript:'Changed source'};busy=false;
 await service.tick();expect(service.get(s.id).turns[0]).toMatchObject({status:'failed',reason:'source-changed'});expect(service.pending).toBe(false);
});
