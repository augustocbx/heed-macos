import {afterEach,expect,test} from 'bun:test';
import {fixture,cleanupFixtures} from './connection-fixtures';
import {AiPlanner} from './planning';
import {AiAuthorizations} from './authorization';
import {AiRuntime,type AiAdmissionHooks} from './runtime';
afterEach(cleanupFixtures);
async function setup(){
 const f=fixture();const connection=await f.manager.register({provider:'openai',model:'gpt-6-luna',key:'SECRET_KEY'});await f.manager.validate(connection.id);
 const selection={provider:'openai' as const,model:connection.model,connectionId:connection.id};f.manager.saveSelection('notes',selection);
 let version=1,clock=1000,uploads=0;const outcomes:unknown[]=[];
 const planner=new AiPlanner(f.manager,()=>clock);const authorizations=new AiAuthorizations(planner,()=>clock);
 planner.register('notes',async()=>({jobId:'notes-1',feature:'notes',selection,calls:[{id:'one',system:'Use supplied text',data:{text:'SELECTED'},contextTokens:8192,maxOutputTokens:100}],sources:[{sessionId:'meeting-1',sourceRevision:'r1',sourceVersion:1}],validate:()=>{if(version!==1)throw Error('source-changed');},attach:()=>{},dispatched:()=>{}}));
 const hooks:AiAdmissionHooks={reserve:async summary=>{outcomes.push(summary);return {dispatch:async id=>{outcomes.push(id);},outcome:async(id,result)=>{outcomes.push(result);},finish:async status=>{outcomes.push(status);}};},acquire:async()=>({release:()=>{}})};
 const runtime=new AiRuntime({planner,authorizations,connections:f.manager,hooks,generate:async input=>{uploads++;return {text:'Notes',usage:{supported:false},finish:'completed',provenance:{provider:input.selection.provider,model:input.selection.model!}};}});
 return {...f,planner,authorizations,runtime,hooks,selection,outcomes,uploads:()=>uploads,change:()=>version++,advance:()=>clock+=600001};
}
test('exact immutable review requires one-use authorization before any upload',async()=>{
 const f=await setup();const plan=await f.planner.prepare({feature:'notes',sessionId:'meeting-1'});
 expect(JSON.stringify(f.authorizations.preview(plan))).toContain('SELECTED');expect(JSON.stringify(plan)).not.toContain('SECRET_KEY');expect(Object.isFrozen(plan.calls[0]!.data)).toBe(true);
 await expect(f.runtime.execute(plan,new AbortController().signal)).rejects.toThrow('authorization-required');expect(f.uploads()).toBe(0);
 expect(()=>f.authorizations.authorize(plan.id,{allowRemote:true,expectedPayloadHash:'changed'})).toThrow('payload-changed');
 f.authorizations.authorize(plan.id,{allowRemote:true,expectedPayloadHash:plan.payloadHash});await f.runtime.execute(plan,new AbortController().signal);expect(f.uploads()).toBe(1);
 await expect(f.runtime.execute(plan,new AbortController().signal)).rejects.toThrow('authorization-consumed');expect(f.uploads()).toBe(1);
 expect(JSON.stringify(f.outcomes)).not.toContain('SELECTED');expect(JSON.stringify(f.outcomes)).not.toContain('SECRET_KEY');
});
test('source, settings, key and expiry invalidate exact reviewed plans',async()=>{
 for(const mutation of ['source','settings','key','expiry'] as const){const f=await setup(),plan=await f.planner.prepare({feature:'notes'});f.authorizations.authorize(plan.id,{allowRemote:true,expectedPayloadHash:plan.payloadHash});
 if(mutation==='source')f.change();if(mutation==='settings')f.manager.saveSelection('tasks',{provider:'ollama',connectionId:null,model:'different'});if(mutation==='key')await f.manager.replace(f.selection.connectionId,{provider:'openai',model:f.selection.model,key:'NEW_SECRET'});if(mutation==='expiry')f.advance();
 await expect(f.runtime.execute(plan,new AbortController().signal)).rejects.toThrow();expect(f.uploads()).toBe(0);
 }
});
test('remote admission defaults deny even explicitly authorized plans',async()=>{
 const f=await setup(),plan=await f.planner.prepare({feature:'notes'});f.authorizations.authorize(plan.id,{allowRemote:true,expectedPayloadHash:plan.payloadHash});
 const runtime=new AiRuntime({planner:f.planner,authorizations:f.authorizations,connections:f.manager});
 await expect(runtime.execute(plan,new AbortController().signal)).rejects.toThrow('budget-unavailable');expect(f.uploads()).toBe(0);
});
test('restart invalidates unsubmitted reviews without serializing raw content',async()=>{
 const f=await setup(),plan=await f.planner.prepare({feature:'notes'});const restarted=new AiPlanner(f.manager);
 expect(()=>new AiAuthorizations(restarted).authorize(plan.id,{allowRemote:true,expectedPayloadHash:plan.payloadHash})).toThrow('plan-not-found');
});

test('whole-plan reservation and resource admission precede every call; source change stops the remainder',async()=>{
 const f=await setup();f.manager.saveSelection('chat',f.selection);let current=true,uploads=0;const events:string[]=[],callOutcomes:string[]=[];
 f.planner.register('chat',async()=>({jobId:'chat-1',feature:'chat',selection:f.selection,calls:Array.from({length:4},(_,i)=>({id:`call-${i}`,system:'Only scoped evidence',data:{evidence:`SELECTED_${i}`},contextTokens:8192,maxOutputTokens:1800})),sources:[{sessionId:'m',sourceRevision:'r'}],validate:()=>{if(!current)throw Error('source-changed');},attach:()=>{},dispatched:()=>{events.push('durable-dispatch');}}));
 const plan=await f.planner.prepare({feature:'chat'});f.authorizations.authorize(plan.id,{allowRemote:true,expectedPayloadHash:plan.payloadHash});
 const runtime=new AiRuntime({planner:f.planner,authorizations:f.authorizations,connections:f.manager,hooks:{reserve:async summary=>{expect(summary.calls).toHaveLength(4);expect(JSON.stringify(summary)).not.toContain('SELECTED_');events.push('reserve-all');return {dispatch:async id=>{events.push(`dispatch:${id}`);},outcome:async(_id,result)=>{callOutcomes.push(result.status);},finish:async status=>{events.push(status);}};},acquire:async()=>{events.push('acquire');return {release:()=>{events.push('release');}};}},generate:async input=>{uploads++;events.push('upload');current=false;return {text:'answer',usage:{supported:false},finish:'completed',provenance:{provider:input.selection.provider,model:input.selection.model!}};}});
 await expect(runtime.execute(plan,new AbortController().signal)).rejects.toThrow('source-changed');expect(uploads).toBe(1);expect(events).toEqual(['reserve-all','acquire','durable-dispatch','dispatch:call-0','upload','uncertain','release']);expect(callOutcomes).toEqual(['completed']);
});
test('preview does not read Keychain, and runtime rechecks after async key lookup and admission',async()=>{
 const f=await setup();f.lock(true);const plan=await f.planner.prepare({feature:'notes'});f.authorizations.preview(plan);f.authorizations.authorize(plan.id,{allowRemote:true,expectedPayloadHash:plan.payloadHash});
 await expect(f.runtime.execute(plan,new AbortController().signal)).rejects.toThrow('credential-unavailable');expect(f.uploads()).toBe(0);
});
test('repreparing old provider selection cannot silently review a changed feature setting',async()=>{
 const f=await setup();f.manager.saveSelection('notes',{provider:'ollama',connectionId:null,model:'local'});
 await expect(f.planner.prepare({feature:'notes'})).rejects.toThrow('settings-changed');
});
test('uncertain dispatch journal failure never releases a possibly persisted liability',async()=>{
 const f=await setup(),plan=await f.planner.prepare({feature:'notes'});f.authorizations.authorize(plan.id,{allowRemote:true,expectedPayloadHash:plan.payloadHash});let outcome='';
 const runtime=new AiRuntime({planner:f.planner,authorizations:f.authorizations,connections:f.manager,hooks:{reserve:async()=>({dispatch:async()=>{throw Error('disk outcome unknown');},outcome:async()=>{},finish:async status=>{outcome=status;}}),acquire:async()=>({release:()=>{}})}});
 await expect(runtime.execute(plan,new AbortController().signal)).rejects.toThrow();expect(outcome).toBe('uncertain');expect(f.uploads()).toBe(0);
});

test('expired plans discard their raw preview instead of remaining retrievable',async()=>{
 const f=await setup(),plan=await f.planner.prepare({feature:'notes'});f.advance();expect(()=>f.planner.get(plan.id)).toThrow('authorization-expired');expect(()=>f.planner.get(plan.id)).toThrow('plan-not-found');
});

test('cost consent stays immutable while asynchronous admission is held',async()=>{
 const f=await setup(),plan=await f.planner.prepare({feature:'notes'});let release!:()=>void,reserved=false,decision:boolean|undefined;
 const hold=new Promise<void>(resolve=>release=resolve);
 f.hooks.reserve=async summary=>{reserved=true;decision=summary.allowUnknownCost;await hold;return {dispatch:async()=>{},outcome:async()=>{},finish:async()=>{}};};
 const accepted=f.authorizations.authorize(plan.id,{allowRemote:true,expectedPayloadHash:plan.payloadHash,allowUnknownCost:true});const execution=f.runtime.execute(plan,new AbortController().signal);
 while(!reserved)await Bun.sleep(1);
 try{expect(()=>f.authorizations.authorize(plan.id,{allowRemote:true,expectedPayloadHash:plan.payloadHash})).toThrow('authorization-conflict');expect(f.authorizations.authorize(plan.id,{allowRemote:true,expectedPayloadHash:plan.payloadHash,allowUnknownCost:true})).toEqual(accepted);}
 finally{release();await execution;}
 expect(decision).toBe(true);expect(f.uploads()).toBe(1);
});
