import {afterEach,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import type {Session} from "@heed/shared";
import {LibraryChatService} from "./library-chat";
import {meetingMetadataEvidence} from './meeting-chat';
import {controlledChatRetrieval} from './chat-retrieval-test-utils';
const directories:string[]=[];afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
const labels=(...names:string[])=>({mode:"labels" as const,labels:names,match:"any" as const});
const all={mode:"all" as const,labels:[],match:"any" as const};
function meeting(id:string,tags:string[],text:string,final=true):Session{return {id,title:id,tags,transcript:text,transcriptFinalized:final,language:"pt",speakers:["Ana"],segments:[{speaker:"Ana",text,start:1,end:3}],files:{wav:"",srt:"",txt:""},aiNotes:"",summary:"",pinned:false,createdAt:"2026-10-05",duration:3} as Session;}
function fixture(generate?:ConstructorParameters<typeof LibraryChatService>[0]["generate"]){
 const directory=mkdtempSync(join(tmpdir(),"heed-library-chat-"));directories.push(directory);
 const meetings=[meeting("interview",["Entrevistas"],"INTERVIEW_ALLOWED Rails"),meeting("both",["Entrevistas","Planejamento"],"BOTH_ALLOWED Rails"),meeting("plan",["Planejamento"],"EXCLUDED_SECRET Rails"),meeting("unlabelled",[],"UNLABELLED_SECRET Rails"),meeting("draft",["Entrevistas"],"DRAFT_SECRET Rails",false)];
 const inputs:any[]=[];let held=false;const options={...controlledChatRetrieval(()=>meetings),directory,getSession:(id:string)=>meetings.find(s=>s.id===id)??null,isBusy:()=>held,generate:generate|| (async(input:any)=>{inputs.push(structuredClone({...input,signal:undefined}));return JSON.stringify({claims:[{text:input.evidence[0].quote,evidenceIds:[input.evidence[0].id]}],notFound:false});})};
 const service=new LibraryChatService(options);return {service,directory,meetings,inputs,options,hold:()=>{held=true;},release:()=>{held=false;}};
}
function send(f:ReturnType<typeof fixture>,scope:ReturnType<typeof labels>|typeof all,requestId="send",question="Who mentioned Rails?"){
 const {preview,thread}=f.service.get(scope);return f.service.command(scope,{action:"send",requestId,question,model:"local:latest",expectedSourceRevision:preview.snapshot.key,expectedThreadRevision:thread.revision});
}
async function completed(f:ReturnType<typeof fixture>,scope:ReturnType<typeof labels>|typeof all){for(let i=0;i<100;i++){const thread=f.service.get(scope).thread;if(thread.turns.at(-1)?.status==="completed")return thread;await Bun.sleep(2);}throw new Error("Chat did not complete");}

test("backend label selection constrains any/all and keeps empty or unmatched scopes unready",()=>{
 const f=fixture();const any=f.service.preview(labels("entrevistas","planejamento"));expect(any.snapshot.sources.map(s=>s.sessionId)).toEqual(["both","interview","plan"]);expect(any.matchingCount).toBe(4);expect(any.unavailableCount).toBe(1);
 expect(f.service.preview({...labels("Entrevistas","Planejamento"),match:"all"}).snapshot.sources.map(s=>s.sessionId)).toEqual(["both"]);
 expect(f.service.preview(labels()).ready).toBe(false);expect(f.service.preview(labels("missing")).snapshot.sources).toEqual([]);
 expect(f.service.preview(all).snapshot.sources.map(s=>s.sessionId)).toEqual(["both","interview","plan","unlabelled"]);
 expect(()=>send(f,labels())).toThrow("scope-empty");expect(()=>send(f,labels("missing"))).toThrow("scope-empty");expect(f.inputs).toHaveLength(0);
});
test("generation and narrow history exclude every nonmatching secret even after broad chat",async()=>{
 const f=fixture();send(f,all,"broad");await completed(f,all);
 send(f,labels("Entrevistas"),"narrow");const narrow=await completed(f,labels("Entrevistas"));
 const calls=f.inputs.filter(input=>input.evidence.every((item:any)=>["both","interview"].includes(item.sessionId)));
 expect(calls.length).toBeGreaterThan(0);for(const input of calls){expect(JSON.stringify(input)).not.toContain("EXCLUDED_SECRET");expect(JSON.stringify(input)).not.toContain("UNLABELLED_SECRET");expect(JSON.stringify(input)).not.toContain("DRAFT_SECRET");expect(input.history).toHaveLength(0);}
 expect(narrow.turns).toHaveLength(1);expect(narrow.turns[0].snapshot.scope.labels).toEqual(["entrevistas"]);expect(narrow.turns[0].answer!.claims.flatMap(c=>c.citations).every(c=>["both","interview"].includes(c.sessionId))).toBe(true);
 expect(readFileSync(join(f.directory,`${narrow.id}.json`),"utf8")).not.toContain("EXCLUDED_SECRET");
});
test("requests pin immutable source snapshots and stale previews fail before generation",async()=>{
 const f=fixture();const scope=labels("Entrevistas");const preview=f.service.preview(scope);f.meetings[0].tags=[];
 expect(()=>f.service.command(scope,{action:"send",requestId:"stale",question:"Rails?",model:"local",expectedSourceRevision:preview.snapshot.key})).toThrow("scope-changed");expect(f.inputs).toHaveLength(0);
 send(f,scope);const saved=await completed(f,scope);const pinned=structuredClone(saved.turns[0].snapshot);f.meetings[1].segments[0].text="Revised transcript";
 const historical=f.service.get(scope).thread.turns[0];expect(historical.stale).toBe(true);expect(historical.snapshot).toEqual(pinned);
 send(f,scope,"fresh");await completed(f,scope);expect(f.inputs.at(-1).history).toHaveLength(0);
});
test("label edits during generation discard the answer and invalidate subsequent chunks",async()=>{
 let release:(value:string)=>void=()=>{};const f=fixture(async input=>new Promise(resolve=>{release=()=>resolve(JSON.stringify({claims:[{text:"Supported",evidenceIds:[input.evidence[0].id]}],notFound:false}));}));
 const scope=labels("Entrevistas");send(f,scope);await Bun.sleep(0);f.meetings[0].tags=[];release("");
 for(let i=0;i<100&&f.service.busy;i++)await Bun.sleep(2);
 expect(f.service.get(scope).thread.turns[0]).toMatchObject({status:"failed",reason:"scope-changed",stale:true});expect(f.service.get(scope).thread.turns[0].answer).toBeUndefined();
});
test("scope revision changes cancel queued turns and restart retains historical evidence",async()=>{
 const f=fixture();const scope=labels("Entrevistas");send(f,scope);const first=await completed(f,scope);f.hold();send(f,scope,"queued");f.meetings.splice(0,1);f.release();await f.service.tick();
 expect(f.service.get(scope).thread.turns[1]).toMatchObject({status:"failed",reason:"scope-changed"});const restarted=new LibraryChatService(f.options);expect(restarted.get(scope).thread.turns[0].answer).toEqual(first.turns[0].answer);expect(restarted.get(scope).thread.turns[0].stale).toBe(true);
});
test("same-snapshot followups are durable while stale clears and conflicting requests are rejected",async()=>{
 const f=fixture();const scope=labels("Entrevistas");send(f,scope,"one");await completed(f,scope);send(f,scope,"two","And what else?");const done=await completed(f,scope);expect(f.inputs.at(-1).history).toHaveLength(1);
 expect(()=>send(f,scope,"one","Different question")).toThrow("request-conflict");expect(()=>f.service.command(scope,{action:"clear",expectedThreadRevision:"old"})).toThrow("history-changed");expect(f.service.command(scope,{action:"clear",expectedThreadRevision:done.revision}).turns).toEqual([]);
});
test("long eligible corpus reports partial coverage and never scans excluded meetings",async()=>{
 const f=fixture();f.meetings[0].segments=Array.from({length:100},(_,i)=>({speaker:"Ana",text:`Allowed ${i} `+"x".repeat(1190),start:i,end:i+1}));send(f,labels("Entrevistas"));const done=await completed(f,labels("Entrevistas"));expect(done.turns[0].answer!.coverage.complete).toBe(false);expect(done.turns[0].answer!.coverage.reviewedChunks).toBeLessThanOrEqual(4);expect(done.turns[0].answer!.coverage.retrieval?.partialReasons).toContain('generation-limit');expect(f.inputs.every(input=>input.evidence.every((s:any)=>s.sessionId!=="plan"))).toBe(true);
});
test("malformed scope input cannot request hidden broad access",()=>{
 const f=fixture();for(const scope of [null,{mode:"all",labels:["Entrevistas"],match:"any"},{mode:"labels",labels:[1],match:"any"},{mode:"labels",labels:["Entrevistas"],match:"bad"}])expect(()=>f.service.preview(scope as never)).toThrow("invalid-scope");
});

test("citation source reads reject excluded evidence and stale membership",async()=>{
 const f=fixture();const scope=labels('Entrevistas');send(f,scope);const saved=await completed(f,scope);const turn=saved.turns[0];const citation=turn.answer!.claims[0].citations[0];
 expect(f.service.source(scope,turn.snapshot.key,citation.id).id).toBe(citation.sessionId);
 const broad=f.service.preview(all);expect(()=>f.service.source(scope,turn.snapshot.key,`plan:${broad.snapshot.sources.find(source=>source.sessionId==='plan')!.sourceRevision}:0:0`)).toThrow('invalid-evidence');
 f.meetings[1].tags=[];expect(()=>f.service.source(scope,turn.snapshot.key,citation.id)).toThrow('scope-changed');
});

test('scoped generation supplies only dated eligible meetings and validates metadata navigation',async()=>{
 const f=fixture(async input=>JSON.stringify({claims:[{text:'The meeting was recorded on October 5, 2026.',evidenceIds:[input.metadata[0]!.id]}],notFound:false}));
 f.meetings[0]!.createdAt='2026-10-05T12:00:00Z';f.meetings[1]!.createdAt='2026-10-06T12:00:00Z';f.meetings[2]!.createdAt='2026-10-07T12:00:00Z';
 const scope=labels('Entrevistas');send(f,scope);const thread=await completed(f,scope),turn=thread.turns[0]!,citation=turn.answer!.claims[0]!.citations[0]!;
 expect(citation).toMatchObject({kind:'meeting-metadata',sessionId:'both',recordedAt:'2026-10-06T12:00:00.000Z'});
 expect(f.service.source(scope,turn.snapshot.key,citation.id).id).toBe('both');
 expect(()=>f.service.source(scope,turn.snapshot.key,meetingMetadataEvidence(f.meetings[2]!)!.id)).toThrow('invalid-evidence');
 expect(()=>f.service.source(scope,turn.snapshot.key,`${citation.id}x`)).toThrow('invalid-evidence');
 f.meetings[1]!.createdAt='2026-10-08T12:00:00Z';
 expect(f.service.get(scope).thread.turns[0]).toMatchObject({stale:true});
 expect(()=>f.service.source(scope,turn.snapshot.key,citation.id)).toThrow('scope-changed');
});

test('recorded-time changes cancel queued and in-flight scoped answers',async()=>{
 const f=fixture(async input=>{await Bun.sleep(20);return JSON.stringify({claims:[{text:'October 5, 2026.',evidenceIds:[input.metadata[0]!.id]}],notFound:false});});
 f.meetings[0]!.createdAt='2026-10-05T12:00:00Z';const scope=labels('Entrevistas');f.hold();send(f,scope);f.meetings[0]!.createdAt='2026-10-06T12:00:00Z';f.release();await f.service.tick();
 expect(f.service.get(scope).thread.turns[0]).toMatchObject({status:'failed',reason:'scope-changed'});
 send(f,scope,'next');await Bun.sleep(0);f.meetings[0]!.createdAt='2026-10-07T12:00:00Z';for(let i=0;i<100&&f.service.busy;i++)await Bun.sleep(2);
 expect(f.service.get(scope).thread.turns[1]).toMatchObject({status:'failed',reason:'scope-changed'});
});

test('cancel and model retry preserve one durable question without late answer overwrite',async()=>{
 let release:()=>void=()=>{};let blocked=true;const models:string[]=[];
 const f=fixture(async input=>{models.push(input.model);if(blocked)await new Promise<void>(resolve=>{release=resolve;});return JSON.stringify({claims:[{text:'Allowed',evidenceIds:[input.evidence[0].id]}],notFound:false});});const scope=labels('Entrevistas');send(f,scope);await Bun.sleep(0);const turn=f.service.get(scope).thread.turns[0];
 expect(f.service.command(scope,{action:'cancel',turnId:turn.id}).turns[0].status).toBe('cancelled');release();for(let i=0;i<100&&f.service.busy;i++)await Bun.sleep(2);expect(f.service.get(scope).thread.turns[0].answer).toBeUndefined();
 blocked=false;f.service.command(scope,{action:'retry',turnId:turn.id,model:'replacement:local'});const done=await completed(f,scope);expect(done.turns).toHaveLength(1);expect(models.at(-1)).toBe('replacement:local');
});
test('recording preemption cancels the scoped worker before releasing its busy slot',async()=>{
 const f=fixture(input=>new Promise((_resolve,reject)=>{input.signal!.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});}));const scope=labels('Entrevistas');send(f,scope);await Bun.sleep(0);expect(f.service.busy).toBe(true);await f.service.preempt();expect(f.service.busy).toBe(false);expect(f.service.get(scope).thread.turns[0]).toMatchObject({status:'cancelled',reason:'resources-busy'});
});
test('restart makes waiting scoped requests retryable without silently resuming them',async()=>{
 const f=fixture();const scope=labels('Entrevistas');f.hold();send(f,scope);const restarted=new LibraryChatService(f.options);const interrupted=restarted.get(scope).thread.turns[0];expect(interrupted).toMatchObject({status:'failed',reason:'interrupted'});f.release();restarted.command(scope,{action:'retry',turnId:interrupted.id});for(let i=0;i<100&&restarted.get(scope).thread.turns[0].status!=='completed';i++)await Bun.sleep(2);expect(restarted.get(scope).thread.turns[0].status).toBe('completed');
});

test('waiting scope status changes without rewriting history and stale scope releases its queue',()=>{
 const f=fixture();f.hold();send(f,labels('Entrevistas'));
 let blocker:'tasks'|'recording'='tasks';Object.assign(f.options,{waitingReason:()=>blocker});
 const file=join(f.directory,`${f.service.get(labels('Entrevistas')).thread.id}.json`),bytes=readFileSync(file,'utf8');
 const first=f.service.get(labels('Entrevistas'));expect(first.thread.turns[0]).toMatchObject({waitingReason:'tasks'});blocker='recording';
 const next=f.service.get(labels('Entrevistas'));expect(next.thread.turns[0]).toMatchObject({waitingReason:'recording'});expect(next.thread.revision).toBe(first.thread.revision);expect(readFileSync(file,'utf8')).toBe(bytes);
 expect(f.service.pending).toBe(true);f.meetings[0]!.transcript='Changed';expect(f.service.get(labels('Entrevistas')).thread.turns[0]).toMatchObject({status:'failed',reason:'scope-changed'});expect(f.service.pending).toBe(false);
});
