import {beforeEach,expect,test,vi} from 'vitest';
import type {Session} from '@heed/shared';
import {useSessionsStore} from './sessions';
import {sessionsApi} from '@/api/sessions';
import {tagsApi} from '@/api/tags';
import {transcriptEditingApi} from '@/api/transcript-editing';
import {automaticNotesApi} from '@/api/automaticNotes';
import {ApiError} from '@/api/client';
vi.mock('@/api/sessions',()=>({sessionsApi:{patch:vi.fn(),list:vi.fn()}}));vi.mock('@/api/tags',()=>({tagsApi:{list:vi.fn(),mutate:vi.fn()}}));
const meeting=(version=1):Session=>({id:'guarded',title:'Meeting',createdAt:'2026-10-06T12:00:00Z',duration:1,language:'en',transcript:'Current',segments:[],speakers:[],tags:[],pinned:false,aiNotes:'',summary:'',transcriptVersion:version,transcriptRevision:'a'.repeat(64)});
beforeEach(()=>{vi.resetAllMocks();vi.unstubAllGlobals();const s=meeting();useSessionsStore.setState({sessions:[s],viewing:s,tagsBusy:false});});
test('old direct notes acceptance and later polling cannot replace a newer accepted source',async()=>{
 const current={...meeting(3),transcript:'Corrected',aiNotes:'Retained',notesMetadata:{origin:'manual' as const,sourceRevision:'b'.repeat(64),stale:true}};useSessionsStore.setState({sessions:[current],viewing:current});useSessionsStore.getState().accept({...meeting(2),transcript:'Old',aiNotes:'Old completion'});vi.mocked(tagsApi.list).mockResolvedValue({sessions:[meeting(2)],tags:[],revision:'r'});await useSessionsStore.getState().load(true);expect(useSessionsStore.getState().viewing).toMatchObject({transcript:'Corrected',transcriptVersion:3,aiNotes:'Retained',notesMetadata:{stale:true}});
});
test('source writes carry opening hash and version; metadata patches carry no source guard',async()=>{
 const initial=meeting();vi.mocked(sessionsApi.patch).mockResolvedValue({...initial,transcript:'New',transcriptVersion:2});await useSessionsStore.getState().update(initial.id,{transcript:'New'});expect(sessionsApi.patch).toHaveBeenLastCalledWith(initial.id,expect.objectContaining({expectedTranscriptRevision:initial.transcriptRevision,expectedTranscriptVersion:1}));await useSessionsStore.getState().update(initial.id,{title:'Title'});expect(sessionsApi.patch).toHaveBeenLastCalledWith(initial.id,{title:'Title'});
});
test('an explicitly displayed stale guard is not replaced with a newer cached one and 409 preserves source',async()=>{
 const current=meeting(3);useSessionsStore.setState({sessions:[current],viewing:current});vi.mocked(sessionsApi.patch).mockRejectedValue(new ApiError('Transcript changed',409));const patch={transcript:'Draft',expectedTranscriptRevision:'b'.repeat(64),expectedTranscriptVersion:2};await expect(useSessionsStore.getState().update(current.id,patch)).rejects.toThrow('Transcript changed');expect(sessionsApi.patch).toHaveBeenLastCalledWith(current.id,patch);expect(useSessionsStore.getState().viewing).toEqual(current);
});
test('missing source cache blocks saved source mutation before sending an unguarded guess',async()=>{
 useSessionsStore.setState({sessions:[],viewing:null});await expect(useSessionsStore.getState().update('missing',{segments:[]})).rejects.toThrow(/Refresh/);expect(sessionsApi.patch).not.toHaveBeenCalled();
});
test('out-of-order equal-version stage acknowledgment cannot resurrect a discarded candidate',async()=>{
 const initial=meeting(),candidate={id:'candidate',requestId:'stage',requestSignature:'sig',createdAt:initial.createdAt,transcript:'Candidate',segments:[],speakers:[],language:'en',duration:1,baseGuard:{expectedTranscriptRevision:initial.transcriptRevision!,expectedTranscriptVersion:1}},state={schemaVersion:1 as const,activeGenerationId:'g',generations:[],edits:[],candidates:[candidate],candidateRequestReceipts:[]};let finishStage!:(response:Response)=>void;vi.stubGlobal('fetch',vi.fn((url:string)=>url.endsWith('/candidates')?new Promise<Response>(resolve=>finishStage=resolve):Promise.resolve(Response.json({...initial,transcriptEditing:{...state,candidates:[],candidateRequestReceipts:[{requestId:'discard',requestSignature:'sig',candidateId:'candidate',status:'discarded'}]}}))));
 const stage=transcriptEditingApi.stage(initial.id,{requestId:'stage',base:candidate.baseGuard,result:{success:true,finalized:true,text:'Candidate',segments:[],speakers:[],metadata:{language:'en',model:'new'},duration:1,wordCount:1,files:{wav:'',txt:'',srt:''}}});await transcriptEditingApi.discard(initial.id,'candidate','discard');finishStage(Response.json({...initial,transcriptEditing:state}));const response=await stage;expect(response.transcriptEditing!.candidates).toEqual([]);expect(useSessionsStore.getState().viewing!.transcriptEditing!.candidates).toEqual([]);
});

test('an older equal-version notes control cannot replace a later manual notes save or title',async()=>{
 const initial=meeting();let finish!:(response:Response)=>void;
 vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>finish=resolve)));
 const control=automaticNotesApi.control({sessionId:initial.id,jobId:'job',action:'cancel'});
 vi.mocked(sessionsApi.patch).mockResolvedValue({...initial,title:'Renamed',aiNotes:'Manual notes'});
 await useSessionsStore.getState().update(initial.id,{title:'Renamed',aiNotes:'Manual notes'});
 finish(Response.json({...initial,aiNotes:'Old control'}));const filtered=await control;
 useSessionsStore.getState().accept(filtered);
 expect(useSessionsStore.getState().viewing).toMatchObject({title:'Renamed',aiNotes:'Manual notes'});
});
test('independent metadata request owners preserve different fields and reject older same-field responses',async()=>{
 let old!:(saved:Session)=>void;
 vi.mocked(sessionsApi.patch).mockImplementationOnce(()=>new Promise(resolve=>old=resolve)).mockResolvedValue({...meeting(),title:'New title'});
 const pending=useSessionsStore.getState().update('guarded',{title:'Old title'});
 await useSessionsStore.getState().update('guarded',{title:'New title'});
 old({...meeting(),title:'Old title'});await pending;
 expect(useSessionsStore.getState().viewing?.title).toBe('New title');
});
test('guard rejection cannot leave a combined tag patch busy',async()=>{
 await expect(useSessionsStore.getState().update('guarded',{tags:['Tag'],aiNotes:'Draft',expectedTranscriptRevision:'source'})).rejects.toThrow(/Refresh/);
 expect(useSessionsStore.getState().tagsBusy).toBe(false);expect(sessionsApi.patch).not.toHaveBeenCalled();
});

test('a viewing-only cache also keeps the newer accepted source during acceptance',()=>{
 const current={...meeting(3),transcript:'Corrected',aiNotes:'Current notes'};
 useSessionsStore.setState({sessions:[],viewing:current});
 const saved=useSessionsStore.getState().accept(meeting(2));
 expect(saved).toMatchObject({transcript:'Corrected',transcriptVersion:3,aiNotes:'Current notes'});
 expect(useSessionsStore.getState().viewing).toEqual(saved);
});

test('a lower-version poll cannot replace a viewing-only accepted cache',async()=>{
 const current={...meeting(3),transcript:'Corrected'};useSessionsStore.setState({sessions:[],viewing:current});
 vi.mocked(tagsApi.list).mockResolvedValue({sessions:[meeting(2)],tags:[],revision:'r'});
 await useSessionsStore.getState().load(true);
 expect(useSessionsStore.getState().viewing).toMatchObject({transcript:'Corrected',transcriptVersion:3});
});

test('a blocked tag assignment cannot invalidate an admitted notes save',async()=>{
 let finish!:(saved:Session)=>void;vi.mocked(sessionsApi.patch).mockImplementation(()=>new Promise(resolve=>finish=resolve));
 const pending=useSessionsStore.getState().update('guarded',{aiNotes:'Saved notes'});
 useSessionsStore.setState({tagsBusy:true});
 await expect(useSessionsStore.getState().update('guarded',{tags:['Tag'],aiNotes:'Rejected notes'})).rejects.toThrow(/Wait/);
 finish({...meeting(),aiNotes:'Saved notes'});await pending;
 expect(useSessionsStore.getState().viewing?.aiNotes).toBe('Saved notes');
});

test('view navigation uses the equal-version accepted cache including independent metadata',()=>{
 const current={...meeting(),title:'Renamed',transcriptEditing:{schemaVersion:1 as const,activeGenerationId:'g',generations:[],edits:[],candidates:[],candidateRequestReceipts:[]}};
 const old={...current,title:'Old title',transcriptEditing:{...current.transcriptEditing,candidates:[{id:'discarded',requestId:'stage',requestSignature:'sig',createdAt:current.createdAt,baseGuard:{expectedTranscriptRevision:current.transcriptRevision!,expectedTranscriptVersion:1},transcript:'Old candidate',segments:[],speakers:[],language:'en',duration:1}]}};
 useSessionsStore.setState({sessions:[current],viewing:null});useSessionsStore.getState().view(old);
 expect(useSessionsStore.getState().viewing).toBe(current);expect(useSessionsStore.getState().sessions[0]).toBe(current);
});
