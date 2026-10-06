import {mkdirSync,lstatSync,realpathSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ChatAnswer,ChatTurn,LibraryChatTurn,PortableCommit,Session} from '../../../shared/types';
import {ManagedQuota} from '../managed-quota';
import {SessionTags} from '../session-tags';
import {PortableLibrary} from '../portable-library';
import type {LibraryProvider} from '../portable-provider';
import {encode,makeBundle,revisionPath} from '../portable-schema';
import {MeetingChatService,transcriptEvidence,type ChatGenerator} from '../meeting-chat';
import {LibraryChatService} from '../library-chat';
import {sourceRevision} from '../automatic-notes';
import {publicSynchronizationFixture} from './synchronization-integrity';

/** Explicit public seeding is synthetic; this fixture never establishes remote replication. */
class PublicFixtureProvider implements LibraryProvider{
 readonly id='public-offline-qa';readonly name='Public synthetic QA';readonly transport='os-managed-folder' as const;
 readonly objects=new Map<string,Uint8Array>();readonly commits:PortableCommit[]=[];calls=0;disabled=false;
 private check(){this.calls++;if(this.disabled)throw Error('Synthetic provider disabled');}
 seed(bundle:ReturnType<typeof makeBundle>){this.commits.push(bundle.marker);this.objects.set(bundle.marker.manifestPath,encode(bundle.manifest));this.objects.set(`${revisionPath(bundle.manifest.meetingId,bundle.manifest.revisionId)}/meeting.json`,encode(bundle.payload));}
 async list(cursor:string|null,limit:number){this.check();const offset=Number(cursor||0);return {commits:this.commits.slice(offset,offset+limit),next:offset+limit<this.commits.length?String(offset+limit):null,complete:true};}
 async read(path:string,maxBytes:number){this.check();const bytes=this.objects.get(path);if(!bytes||bytes.length>maxBytes)throw Error('Synthetic artifact unavailable');return bytes;}
 async *stream(path:string,maxBytes:number){yield await this.read(path,maxBytes);}
 async writeImmutable(){this.check();throw Error('Synthetic source is read-only');}
 async writeObjectImmutable(){this.check();throw Error('Synthetic source is read-only');}
 async confirm():Promise<'local-only'>{this.check();throw Error('Synthetic source is read-only');}
}

export function verifyOfflineCitations(answer:ChatAnswer,sessions:Session[]):string[]{
 const differences=new Set<string>(),eligible=new Map(sessions.map(session=>[session.id,session]));
 const evidence=new Map(sessions.flatMap(transcriptEvidence).map(item=>[item.id,item]));
 for(const claim of answer.claims){
  if(!claim.citations.length)differences.add('citation.missing');
  for(const citation of claim.citations){
   const session=eligible.get(citation.sessionId);
   if(!session){differences.add('citation.excluded');continue;}
   if(citation.sourceRevision!==sourceRevision(session))differences.add('citation.revision');
   const current=evidence.get(citation.id);
   if(!current){differences.add('citation.identity');continue;}
   if(citation.quote!==current.quote)differences.add('citation.quote');
   for(const key of ['speaker','start','end','segmentIndex','paragraphIndex','sessionId','sourceRevision'] as const)if(citation[key]!==current[key])differences.add('citation.metadata');
  }
 }
 return [...differences].sort();
}

/** Closed fixture assertions deliberately send unrecognized paraphrases to review. */
export function verifyPublicBudgetCorrection(answer:ChatAnswer,locale:'en'|'pt'):string[]{
 const correction=publicSynchronizationFixture(locale).payload.segments[2]!.text;
 const normalize=(value:string)=>value.normalize('NFC').replace(/\s+/g,' ').trim().replace(/\.$/,'').toLocaleLowerCase(locale);
 const withoutPrefix=correction.replace(/^(Correction|Correção):\s*/,''),clause=withoutPrefix.split(',')[0]!;
 const assertions=new Set([correction,withoutPrefix,clause,locale==='en'?'The final approved budget is 43 credits.':'O orçamento final aprovado é de 43 créditos.'].map(normalize));
 if(!answer.claims.length||answer.claims.some(claim=>!assertions.has(normalize(claim.text))||!claim.citations.some(citation=>citation.quote===correction)))return ['answer.correction-needs-review'];
 return [];
}

export async function createOfflineSynchronizationFixture(location:string,generate:ChatGenerator){
 const root=resolve(location);
 if(realpathSync(dirname(root))!==dirname(root))throw Error('Offline fixture parent must be physical');
 mkdirSync(root,{mode:0o700});const receipt=lstatSync(root);
 writeFileSync(join(root,'ownership.json'),JSON.stringify({version:1,kind:'public-synchronization-offline',dev:receipt.dev,ino:receipt.ino}),{flag:'wx',mode:0o600});
 const sessionsDir=join(root,'sessions');mkdirSync(sessionsDir);
 const sessions=new SessionTags(sessionsDir),provider=new PublicFixtureProvider();
 const en=publicSynchronizationFixture('en'),pt=publicSynchronizationFixture('pt');provider.seed(en);provider.seed(pt);
 const excluded={...en.payload,meetingId:'476e5fe3-0531-4a43-9077-57b3c2a58d85',tags:['Excluded QA'],title:'Public excluded distractor',transcript:'DISTRACTOR_QA_9999: weather was violet.',segments:[{speaker:'Distractor QA',text:'DISTRACTOR_QA_9999: weather was violet.',start:0,end:1}],speakers:['Distractor QA'],aiNotes:'',summary:''};
 provider.seed(makeBundle(en.manifest.libraryId,en.marker.deviceId,excluded,[],'c44b1fdb-1b7d-4f03-b7e3-de9b4c7d43b8'));
 const libraryRoot=join(root,'library');
 const quota=new ManagedQuota({ledgerPath:join(root,'quota.json'),roots:{text:[sessionsDir,join(libraryRoot,'catalog')],media:[join(libraryRoot,'media')],indexes:[join(libraryRoot,'indexes')],staging:[join(libraryRoot,'staging')]},getLimit:()=>2_000_000_000,setLimit:()=>{throw Error('QA limit is fixed');},protectedPaths:()=>[sessionsDir,libraryRoot]});
 let library=new PortableLibrary({root:libraryRoot,sessions,sessionsDir,quota,provider});
 await library.discover();await library.importSelected();
 if(sessions.snapshot().sessions.length!==3)throw Error('Synthetic production imports did not commit');
 library.selectProvider();provider.disabled=true;const importedCalls=provider.calls;
 let meetingChat:MeetingChatService,labelChat:LibraryChatService;
 const assertOffline=()=>{if(library.snapshot().configured||!provider.disabled||provider.calls!==importedCalls)throw Error('Offline provider isolation failed');};
 const guarded:ChatGenerator=async input=>{assertOffline();const result=await generate(input);assertOffline();return result;};
 const restart=()=>{
  if(meetingChat?.busy||labelChat?.busy)throw Error('Cannot restart an active QA chat');
  library=new PortableLibrary({root:libraryRoot,sessions,sessionsDir,quota});
  meetingChat=new MeetingChatService({directory:join(root,'meeting-chat'),getSession:id=>sessions.read(id),isBusy:()=>false,generate:guarded});
  labelChat=new LibraryChatService({directory:join(root,'label-chat'),listSessions:()=>sessions.snapshot().sessions,isBusy:()=>false,generate:guarded});assertOffline();
 };
 restart();
 const meeting=(locale:'en'|'pt')=>{const found=sessions.snapshot().sessions.find(session=>session.language===locale&&session.tags.includes('Synchronization QA'));if(!found)throw Error('Public imported meeting unavailable');return found;};
 const stop=async()=>{const results=await Promise.allSettled([meetingChat.preempt(),labelChat.preempt()]);if(results.some(result=>result.status==='rejected')||meetingChat.busy||labelChat.busy)throw Error('QA chats did not stop');};
 const wait=async<T extends ChatTurn|LibraryChatTurn>(read:()=>T|undefined,timeoutMs:number):Promise<T>=>{
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){const turn=read();if(turn&&!['waiting','running'].includes(turn.status)){assertOffline();return turn;}await Bun.sleep(10);}
  await stop();throw Error('Offline QA chat timed out');
 };
 return {root,receipt,sessions,get library(){return library;},restart,meeting,stop,assertOffline,providerCalls:()=>provider.calls,
  async askMeeting(locale:'en'|'pt',question:string,model:string,timeoutMs=300_000){
   const session=meeting(locale),thread=meetingChat.get(session.id),requestId=randomUUID();
   meetingChat.command(session.id,{action:'send',question,model,requestId,expectedSourceRevision:sourceRevision(session),expectedThreadRevision:thread.revision});
   return wait(()=>meetingChat.get(session.id).turns.find(turn=>turn.requestId===requestId),timeoutMs);
  },
  async askLabels(locale:'en'|'pt',question:string,model:string,timeoutMs=300_000){
   const scope={mode:'labels' as const,labels:[locale==='en'?'Planning':'Planejamento'],match:'any' as const},context=labelChat.get(scope),requestId=randomUUID();
   labelChat.command(scope,{action:'send',question,model,requestId,expectedSourceRevision:context.preview.snapshot.key,expectedThreadRevision:context.thread.revision});
   return wait(()=>labelChat.get(scope).thread.turns.find(turn=>turn.requestId===requestId),timeoutMs);
  }
 };
}
