import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,afterEach,expect,test,vi} from 'vitest';
import {TasksPanel} from './TasksPanel';
import {setLocale} from '@/lib/i18n';
import type {Session,TasksSnapshot} from '@heed/shared';
const meeting={id:'m',transcriptFinalized:true,transcript:'Fixture'} as Session;
const review={sessionId:'m',sourceRevision:'r',status:'ready',updatedAt:'now',suggestions:Array.from({length:5},(_,i)=>({id:`s${i}`,title:`Task ${i+1}`,description:'Review me',assignee:null,dueDate:i===0?'2026-10-09':null,kind:i===0?'explicit':'inferred',state:'suggested',dateReview:i===1?'next Friday':null,evidence:[{segmentIndex:i,sourceRevision:'r',speaker:'Ana',start:i,end:i+1,quote:`Evidence ${i}`}]}))} as TasksSnapshot['review'];
let snapshot:TasksSnapshot;let commands:any[];let fail=false;
beforeEach(()=>{setLocale('en');commands=[];fail=false;snapshot={tasks:[],review:structuredClone(review)};vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
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
