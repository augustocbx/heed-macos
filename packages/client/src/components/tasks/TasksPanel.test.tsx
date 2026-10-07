import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,afterEach,expect,test,vi} from 'vitest';
import {TasksPanel} from './TasksPanel';
import {setLocale} from '@/lib/i18n';
import {beginSessionRequest,useSessionsStore} from '@/stores/sessions';
import {useUIStore} from '@/stores/ui';
import type {Session,TasksSnapshot} from '@heed/shared';
const meeting={id:'m',transcriptFinalized:true,transcript:'Fixture'} as Session;
const review={sessionId:'m',sourceRevision:'r',status:'ready',updatedAt:'now',suggestions:Array.from({length:5},(_,i)=>({id:`s${i}`,title:`Task ${i+1}`,description:'Review me',assignee:null,dueDate:i===0?'2026-10-09':null,kind:i===0?'explicit':'inferred',state:'suggested',dateReview:i===1?'next Friday':null,evidence:[{segmentIndex:i,sourceRevision:'r',speaker:'Ana',start:i,end:i+1,quote:`Evidence ${i}`}]}))} as TasksSnapshot['review'];
let snapshot:TasksSnapshot;let commands:any[];let fail=false;
beforeEach(()=>{useSessionsStore.setState({sessions:[],viewing:null});setLocale('en');commands=[];fail=false;snapshot={tasks:[],review:structuredClone(review)};vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
 if(init?.method==='POST'){const body=JSON.parse(String(init.body));commands.push(body);if(fail)return Response.json({error:'Could not save tasks. Please retry.'},{status:503});
 if(body.action==='accept')for(const item of body.items){snapshot.review!.suggestions.find(s=>s.id===item.suggestionId)!.state='accepted';}
 if(body.action==='dismiss')for(const id of body.ids){snapshot.review!.suggestions.find(s=>s.id===id)!.state='dismissed';}
 }
 return Response.json(snapshot);
}));});
afterEach(()=>vi.unstubAllGlobals());
test('selects and edits only two of five while leaving absent dates unset',async()=>{
 render(<TasksPanel session={meeting}/>);await screen.findByDisplayValue('Task 1');
 const boxes=screen.getAllByRole('checkbox',{name:/Select suggestion/});fireEvent.click(boxes[0]);fireEvent.click(boxes[3]);
 fireEvent.change(screen.getByDisplayValue('Task 1'),{target:{value:'Reviewed title'}});
 fireEvent.change(screen.getAllByLabelText('Target date')[0],{target:{value:''}});
 fireEvent.click(screen.getByRole('button',{name:'Add selected tasks'}));
 await waitFor(()=>expect(commands).toHaveLength(1));expect(commands[0].items).toHaveLength(2);
 expect(commands[0].items[0]).toMatchObject({suggestionId:'s0',title:'Reviewed title',dueDate:null});
 expect(commands[0].items[1]).toMatchObject({suggestionId:'s3',dueDate:null});
 expect(screen.getByText('next Friday')).toBeInTheDocument();
});
test('intentionally choosing none and rejecting a suggestion never accepts tasks',async()=>{
 render(<TasksPanel session={meeting}/>);await screen.findByDisplayValue('Task 1');
 expect(screen.getByRole('button',{name:'Add selected tasks'})).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'Select none'}));expect(commands).toHaveLength(0);
 fireEvent.click(screen.getAllByRole('button',{name:'Dismiss suggestion'})[0]);await waitFor(()=>expect(commands[0]).toMatchObject({action:'dismiss',ids:['s0']}));
});
test('failed acceptance preserves editable suggestions and selection for retry',async()=>{
 fail=true;render(<TasksPanel session={meeting}/>);await screen.findByDisplayValue('Task 1');fireEvent.click(screen.getAllByRole('checkbox',{name:/Select suggestion/})[0]);
 fireEvent.change(screen.getByDisplayValue('Task 1'),{target:{value:'Keep my draft'}});fireEvent.click(screen.getByRole('button',{name:'Add selected tasks'}));
 await screen.findByRole('alert');expect(screen.getByDisplayValue('Keep my draft')).toBeInTheDocument();expect(screen.getAllByRole('checkbox',{name:/Select suggestion/})[0]).toBeChecked();
 fail=false;fireEvent.click(screen.getByRole('button',{name:'Add selected tasks'}));await waitFor(()=>expect(commands).toHaveLength(2));expect(commands[1].items[0].title).toBe('Keep my draft');
});
test.each([['en','Tasks','Add selected tasks'],['pt-BR','Tarefas','Adicionar tarefas selecionadas'],['fr','Tâches','Ajouter les tâches sélectionnées'],['de','Aufgaben','Ausgewählte Aufgaben hinzufügen']])('renders task review in %s',async(locale,title,button)=>{
 setLocale(locale as never);render(<TasksPanel session={meeting}/>);expect(screen.getByRole('heading',{name:title})).toBeInTheDocument();await screen.findByRole('button',{name:button});
});
test('completed and undated filters include no-date tasks without overdue labels',async()=>{
 snapshot={tasks:[{id:'t1',revision:'v',title:'Undated action',description:'',assignee:null,dueDate:null,sessionId:'m',sourceRevision:'r',meetingTitle:'Fixture',suggestionId:'s',evidence:[],kind:'explicit',status:'open',completedAt:null,createdAt:'now',updatedAt:'now',sourceState:'meeting-deleted',audioAvailable:false},{id:'t2',revision:'v',title:'Finished action',description:'',assignee:null,dueDate:'2026-10-01',sessionId:'m',sourceRevision:'r',meetingTitle:'Fixture',suggestionId:'s',evidence:[],kind:'explicit',status:'completed',completedAt:'2026-10-05T12:00:00Z',createdAt:'now',updatedAt:'now',sourceState:'meeting-deleted',audioAvailable:false}]};
 render(<TasksPanel/>);await screen.findByText('Undated action');expect(screen.queryByText('Finished action')).not.toBeInTheDocument();expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
 fireEvent.change(screen.getByLabelText('Task status filter'),{target:{value:'completed'}});expect(screen.getByText('Finished action')).toBeInTheDocument();
 fireEvent.change(screen.getByLabelText('Task status filter'),{target:{value:'all'}});fireEvent.change(screen.getByLabelText('Task date filter'),{target:{value:'undated'}});expect(screen.queryByText('Finished action')).not.toBeInTheDocument();expect(screen.getByText('Undated action')).toBeInTheDocument();
});
function acceptedTask(){return {id:'t1',revision:'v',title:'Accepted action',description:'Keep notes',assignee:'Ana',dueDate:'2026-10-09',sessionId:'m',sourceRevision:'r',meetingTitle:'Fixture',suggestionId:'s',evidence:[],kind:'explicit' as const,status:'open' as const,completedAt:null,createdAt:'now',updatedAt:'now',sourceState:'available' as const,audioAvailable:false};}
test('accepted task edits send only editable fields and clear target dates',async()=>{
 snapshot={tasks:[acceptedTask()]};render(<TasksPanel/>);await screen.findByText('Accepted action');fireEvent.click(screen.getByRole('button',{name:'Edit task'}));
 fireEvent.change(screen.getByDisplayValue('Accepted action'),{target:{value:'Reviewed accepted action'}});fireEvent.click(screen.getByRole('button',{name:'Clear date'}));fireEvent.click(screen.getByRole('button',{name:'Save task'}));
 await waitFor(()=>expect(commands).toHaveLength(1));expect(commands[0]).toEqual({action:'update',id:'t1',revision:'v',patch:{title:'Reviewed accepted action',description:'Keep notes',assignee:'Ana',dueDate:null}});
});
test('accepted edit failure keeps the form open for a retry',async()=>{
 snapshot={tasks:[acceptedTask()]};fail=true;render(<TasksPanel/>);await screen.findByText('Accepted action');fireEvent.click(screen.getByRole('button',{name:'Edit task'}));
 fireEvent.change(screen.getByDisplayValue('Accepted action'),{target:{value:'Unsaved edit'}});fireEvent.click(screen.getByRole('button',{name:'Save task'}));await screen.findByRole('alert');expect(screen.getByDisplayValue('Unsaved edit')).toBeInTheDocument();expect(screen.getByRole('button',{name:'Save task'})).toBeInTheDocument();
});
test('polling preserves the draft and original revision when another tab edits a task',async()=>{
 snapshot={tasks:[acceptedTask()]};render(<TasksPanel/>);await screen.findByText('Accepted action');fireEvent.click(screen.getByRole('button',{name:'Edit task'}));fireEvent.change(screen.getByDisplayValue('Accepted action'),{target:{value:'My edit'}});
 snapshot={tasks:[{...acceptedTask(),revision:'v2',title:'Other tab edit'}]};fireEvent(window,new Event('focus'));await screen.findByText('Other tab edit');expect(screen.getByDisplayValue('My edit')).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Save task'}));await waitFor(()=>expect(commands).toHaveLength(1));expect(commands[0].revision).toBe('v');
});
test('meeting task source opens the transcript even when audio is unavailable',async()=>{
 const onShowTranscript=vi.fn();snapshot={tasks:[{...acceptedTask(),evidence:[{segmentIndex:0,sourceRevision:'r',speaker:'Ana',start:null,end:null,quote:'I will follow up.'}]}]};
 render(<TasksPanel session={meeting} onShowTranscript={onShowTranscript}/>);await screen.findByText('Accepted action');fireEvent.click(screen.getByRole('button',{name:'View task source'}));expect(onShowTranscript).toHaveBeenCalledTimes(1);
});

const taskEvidence={segmentIndex:2,sourceRevision:'r',speaker:'Ana',start:4.64,end:7.12,quote:'I will follow up.'};
test('meeting task refuses an audio seek when its live transcript changed after the task snapshot',async()=>{
 const onSeek=vi.fn(),onShowTranscript=vi.fn();
 snapshot={tasks:[{...acceptedTask(),audioAvailable:true,evidence:[taskEvidence]}]};
 render(<TasksPanel session={{...meeting,transcriptRevision:'new-revision'}} onSeek={onSeek} onShowTranscript={onShowTranscript}/>);
 await screen.findByText('Accepted action');fireEvent.click(screen.getByRole('button',{name:'View task source'}));
 expect(onSeek).not.toHaveBeenCalled();
});
test('global task refuses a stale seek after refetching a changed source meeting',async()=>{
 snapshot={tasks:[{...acceptedTask(),audioAvailable:true,evidence:[taskEvidence]}]};
 useUIStore.setState({taskSourceSeek:null,chatSourceFocus:null,currentPage:'tasks'});
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>Response.json(url.includes('/api/sessions')?[{...meeting,transcriptRevision:'new-revision'}]:snapshot)));
 render(<TasksPanel/>);await screen.findByText('Accepted action');fireEvent.click(screen.getByRole('button',{name:'View task source'}));
 await waitFor(()=>expect(useUIStore.getState().currentPage).toBe('sessions'));
 expect(useUIStore.getState().taskSourceSeek).toBeNull();expect(useUIStore.getState().chatSourceFocus).toBeNull();
});
test('global task pins the exact source revision and segment when navigating to available audio',async()=>{
 snapshot={tasks:[{...acceptedTask(),audioAvailable:true,evidence:[taskEvidence]}]};
 useUIStore.setState({taskSourceSeek:null,chatSourceFocus:null,currentPage:'tasks'});
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>Response.json(url.includes('/api/sessions')?[{...meeting,transcriptRevision:'r',files:{wav:'synthetic.wav'},segments:[{speaker:'Ana',text:'Opening.',start:0,end:1},{speaker:'Ana',text:'No actions yet.',start:1,end:4},{speaker:'Ana',text:taskEvidence.quote,start:4.64,end:7.12}]}]:snapshot)));
 render(<TasksPanel/>);await screen.findByText('Accepted action');fireEvent.click(screen.getByRole('button',{name:'View task source'}));
 await waitFor(()=>expect(useUIStore.getState().currentPage).toBe('sessions'));
 expect(useUIStore.getState().taskSourceSeek).toMatchObject({sessionId:'m',seconds:4.64,sourceRevision:'r'});
 expect(useUIStore.getState().chatSourceFocus).toMatchObject({sessionId:'m',sourceRevision:'r',segmentIndex:2,quote:'I will follow up.'});
});

test('current meeting task focuses its source segment and seeks available audio',async()=>{
 const onSeek=vi.fn(),onShowTranscript=vi.fn();
 snapshot={tasks:[{...acceptedTask(),audioAvailable:true,evidence:[taskEvidence]}]};
 render(<TasksPanel session={{...meeting,transcriptRevision:'r'}} onSeek={onSeek} onShowTranscript={onShowTranscript}/>);
 await screen.findByText('Accepted action');fireEvent.click(screen.getByRole('button',{name:'View task source'}));
 expect(onShowTranscript).toHaveBeenCalledWith(taskEvidence);expect(onSeek).toHaveBeenCalledWith(4.64);
});

test('global task with a stale available-audio snapshot does not leave a deferred seek for missing current audio',async()=>{
 snapshot={tasks:[{...acceptedTask(),audioAvailable:true,evidence:[taskEvidence]}]};
 useUIStore.setState({taskSourceSeek:null,chatSourceFocus:null,currentPage:'tasks'});
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>Response.json(url.includes('/api/sessions')?[{...meeting,transcriptRevision:'r',files:{}}]:snapshot)));
 render(<TasksPanel/>);await screen.findByText('Accepted action');fireEvent.click(screen.getByRole('button',{name:'View task source'}));
 await waitFor(()=>expect(useUIStore.getState().currentPage).toBe('sessions'));
 expect(useUIStore.getState().taskSourceSeek).toBeNull();
});
test('task evidence from a different revision cannot focus or seek the current transcript',async()=>{
 const onSeek=vi.fn(),onShowTranscript=vi.fn();
 snapshot={tasks:[{...acceptedTask(),audioAvailable:true,evidence:[{...taskEvidence,sourceRevision:'different-revision'}]}]};
 render(<TasksPanel session={{...meeting,transcriptRevision:'r'}} onSeek={onSeek} onShowTranscript={onShowTranscript}/>);
 await screen.findByText('Accepted action');fireEvent.click(screen.getByRole('button',{name:'View task source'}));
 expect(onSeek).not.toHaveBeenCalled();expect(onShowTranscript).toHaveBeenCalledWith(undefined);
});

test('a pending task-source read cannot restore discarded equal-version candidates',async()=>{
 useUIStore.setState({currentPage:'tasks'});
 const state={schemaVersion:1,activeGenerationId:'g',generations:[],edits:[],candidateRequestReceipts:[],candidates:[{id:'old',requestId:'stage',requestSignature:'signature',createdAt:'2026-10-06T12:00:00Z',baseGuard:{expectedTranscriptRevision:'r',expectedTranscriptVersion:1},transcript:'Candidate',segments:[],speakers:[],language:'en',duration:1}]} as Session['transcriptEditing'];
 const initial={...meeting,transcriptRevision:'r',transcriptVersion:1,transcriptEditing:state};
 useSessionsStore.setState({sessions:[initial],viewing:null});snapshot={tasks:[{...acceptedTask(),evidence:[taskEvidence]}]};
 let finish!:(response:Response)=>void;
 vi.stubGlobal('fetch',vi.fn((url:string)=>url==='/api/sessions'?new Promise<Response>(resolve=>finish=resolve):Promise.resolve(Response.json(snapshot))));
 render(<TasksPanel/>);await screen.findByText('Accepted action');fireEvent.click(screen.getByRole('button',{name:'View task source'}));
 await waitFor(()=>expect(finish).toBeTypeOf('function'));
 const discarded={...initial,transcriptEditing:{...state!,candidates:[]}};
 useSessionsStore.getState().accept(discarded,beginSessionRequest(initial.id));
 finish(Response.json([initial]));await waitFor(()=>expect(useUIStore.getState().currentPage).toBe('sessions'));
 expect(useSessionsStore.getState().viewing?.transcriptEditing?.candidates).toEqual([]);
});
