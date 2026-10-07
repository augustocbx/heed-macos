import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AiWaitingReason, Session } from "@heed/shared";
import { sourceRevision } from "./automatic-notes";
import { MeetingChatService, transcriptEvidence, answerMeetingQuestion as answerRetrieved } from "./meeting-chat";
import {controlledChatRetrieval,testCoverage} from './chat-retrieval-test-utils';
const answerMeetingQuestion=({sessions,...input}:any)=>{const evidence=sessions.flatMap(transcriptEvidence).slice(0,32);return answerRetrieved({...input,evidence,coverage:testCoverage(evidence)});};
const dirs: string[] = [];
const directory = () => { const d = mkdtempSync(join(tmpdir(), "heed-chat-test-")); dirs.push(d); return d; };
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
function meeting(): Session { const s: Session = { id: "meeting-a", title: "Planning", createdAt: "2026-10-05T12:00:00Z", duration: 40, language: "pt", transcript: "", speakers: ["Ana", "Bruno"], segments: [{speaker:"Ana",start:1,end:5,text:"O orçamento não foi aprovado."}, {speaker:"Bruno",start:10,end:15,text:"I will review it on Friday."}], aiNotes: "", summary: "", tags: [], pinned: false, transcriptFinalized: true }; s.transcriptRevision = sourceRevision(s); return s; }
const result = (id: string) => JSON.stringify({ claims: [{ text: "The budget was not approved.", evidenceIds: [id] }], notFound: false });
const flush = async () => { await new Promise(r => setTimeout(r, 10)); };

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
 expect(answer.claims[0]!.citations[0]!.quote).toBe("O orçamento não foi aprovado.");
 expect(answer.coverage.complete).toBe(false);
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

test('pure preparation freezes every bounded chat call before generation and completion validates each batch',async()=>{
 const api=await import('./meeting-chat');
 expect(typeof api.prepareMeetingQuestion).toBe('function');
 const s=meeting();s.segments=Array.from({length:32},(_,i)=>({speaker:'Ana',start:i,end:i+1,text:`Selected excerpt ${i}. `+'context '.repeat(130)}));
 const evidence=transcriptEvidence(s).slice(0,32),coverage=testCoverage(evidence);
 const prepared=api.prepareMeetingQuestion({evidence,coverage,question:'Context?',history:[],model:'local'});
 const calls=api.chatPlanCalls(prepared);expect(calls).toHaveLength(4);expect(Object.isFrozen(prepared.requests[0]!.data)).toBe(true);
 for(const call of calls){expect(Buffer.byteLength(call.system)+Buffer.byteLength(JSON.stringify(call.data))).toBeLessThanOrEqual(5500);expect(call.contextTokens).toBe(8192);expect(call.maxOutputTokens).toBe(1800);}
 const outputs=calls.map(()=>JSON.stringify({claims:[],notFound:true}));
 expect(api.completeMeetingQuestion(prepared,outputs).coverage.reviewedChunks).toBe(4);
 expect(()=>api.completeMeetingQuestion(prepared,outputs.slice(1))).toThrow('invalid-answer');
 expect(()=>api.completeMeetingQuestion(prepared,outputs.map((text,index)=>index===0?result('unselected'):text))).toThrow('invalid-evidence');
});

test('local batched chat still stops at its first invalid answer',async()=>{
 const s=meeting();s.segments=Array.from({length:12},(_,i)=>({speaker:'Ana',start:i,end:i+1,text:'Evidence '.repeat(130)}));let calls=0;
 await expect(answerMeetingQuestion({sessions:[s],question:'Evidence?',history:[],model:'local',generate:async()=>{calls++;return result('invented');}})).rejects.toThrow('invalid-evidence');expect(calls).toBe(1);
});
