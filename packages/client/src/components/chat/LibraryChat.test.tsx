import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,expect,test,vi} from 'vitest';
import type {LibraryChatContext,LibraryChatScope,Session} from '@heed/shared';
import {LibraryChat} from './LibraryChat';
import {libraryChatApi} from '@/api/library-chat';
import {chatApi} from '@/api/chat';
import {useLocaleStore} from '@/stores/locale';
import {useSessionsStore} from '@/stores/sessions';
import {useUIStore} from '@/stores/ui';
vi.mock('@/api/library-chat',()=>({libraryChatApi:{context:vi.fn(),command:vi.fn(),source:vi.fn()}}));
vi.mock('@/api/chat',()=>({chatApi:{models:vi.fn()}}));
const evidence={id:'meeting-a:source-a:0:0',sessionId:'meeting-a',sourceRevision:'source-a',segmentIndex:0,paragraphIndex:null,speaker:'Ana',quote:'Revisar o orçamento.',start:12,end:14};
function context(scope:LibraryChatScope):LibraryChatContext{
 const ids=scope.mode==='all'?['meeting-a','meeting-b','secret']:scope.labels.length?scope.match==='all'?['meeting-b']:['meeting-a','meeting-b']:[];
 const snapshot={key:scope.mode==='all'?'all-key':scope.match==='all'?'both-key':'narrow-key',scope,sources:ids.map(sessionId=>({sessionId,title:sessionId==='secret'?'Planning secret':sessionId,tags:['Entrevistas'],sourceRevision:sessionId==='meeting-a'?'source-a':'source-b'}))};
 return {preview:{snapshot,ready:ids.length>0,matchingCount:ids.length,unavailableCount:0,availableLabels:['Entrevistas','Planejamento']},thread:{id:scope.mode==='all'?'all-thread':'label-thread',revision:'thread-one',scope,turns:scope.mode==='all'?[{id:'broad-turn',requestId:'broad',question:'Broad question',model:'local',sourceRevision:'all-key',snapshot,status:'completed',createdAt:'now',updatedAt:'now',attempts:1,answer:{claims:[{text:'BROAD_SECRET_ANSWER',citations:[evidence]}],coverage:{complete:false,reviewedChunks:2,totalChunks:8,answerLimited:false}}}]:[]}};
}
beforeEach(()=>{vi.clearAllMocks();localStorage.clear();useLocaleStore.setState({locale:'en'});useSessionsStore.setState({sessions:[],viewing:null});useUIStore.setState({currentPage:'chat'});vi.mocked(chatApi.models).mockResolvedValue({models:['local']});vi.mocked(libraryChatApi.context).mockImplementation(async(scope)=>context(scope));vi.mocked(libraryChatApi.command).mockImplementation(async(scope)=>context(scope).thread);vi.mocked(libraryChatApi.source).mockResolvedValue({id:'meeting-a',title:'Source meeting',transcriptRevision:'source-a',transcriptFinalized:true,files:{}} as Session);});

test('empty scope remains unready and selecting multiple labels previews visible any/all inclusion',async()=>{
 render(<LibraryChat/>);await screen.findByRole('button',{name:'Entrevistas'});expect(screen.getByText('Choose labels or explicitly select All meetings before asking.')).toBeInTheDocument();
 fireEvent.change(screen.getByLabelText('Local chat model'),{target:{value:'local'}});fireEvent.change(screen.getByLabelText('Question across selected meetings'),{target:{value:'Quem conhece Rails?'}});expect(screen.getByRole('button',{name:'Send question'})).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'Entrevistas'}));await screen.findByText('2 eligible meetings');fireEvent.click(screen.getByRole('button',{name:'Planejamento'}));fireEvent.change(screen.getByLabelText('Combine selected labels'),{target:{value:'all'}});await screen.findByText('1 eligible meeting');expect(screen.queryByText('Planning secret')).not.toBeInTheDocument();
 fireEvent.change(screen.getByLabelText('Search labels'),{target:{value:'entre'}});expect(screen.queryByRole('button',{name:'Planejamento'})).not.toBeInTheDocument();expect(screen.getByRole('button',{name:'Entrevistas'})).toHaveAttribute('aria-pressed','true');
});
test('narrowing starts a separate context and sends only the current preview identity',async()=>{
 render(<LibraryChat/>);await screen.findByRole('button',{name:'Entrevistas'});fireEvent.click(screen.getByLabelText('All meetings'));await screen.findByText('BROAD_SECRET_ANSWER');expect(screen.getByText(/Reviewed 2 of 8/)).toBeInTheDocument();
 fireEvent.click(screen.getByLabelText('Selected labels'));fireEvent.click(await screen.findByRole('button',{name:'Entrevistas'}));await screen.findByText('2 eligible meetings');expect(screen.queryByText('BROAD_SECRET_ANSWER')).not.toBeInTheDocument();
 fireEvent.change(screen.getByLabelText('Local chat model'),{target:{value:'local'}});fireEvent.change(screen.getByLabelText('Question across selected meetings'),{target:{value:'Who mentioned Rails?'}});fireEvent.click(screen.getByRole('button',{name:'Send question'}));
 await waitFor(()=>expect(libraryChatApi.command).toHaveBeenCalled());expect(vi.mocked(libraryChatApi.command).mock.calls[0]).toEqual([expect.objectContaining({mode:'labels',labels:['Entrevistas'],match:'any'}),expect.objectContaining({question:'Who mentioned Rails?',expectedSourceRevision:'narrow-key',expectedThreadRevision:'thread-one'})]);
});
test('citation navigation opens its correct meeting and retains text focus without audio',async()=>{
 localStorage.setItem('heed-library-chat-scope',JSON.stringify({mode:'all',labels:[],match:'any'}));render(<LibraryChat/>);await screen.findByText('BROAD_SECRET_ANSWER');fireEvent.click(screen.getByRole('button',{name:/meeting-a.*12s/}));
 await waitFor(()=>expect(useSessionsStore.getState().viewing?.id).toBe('meeting-a'));expect(useUIStore.getState().currentPage).toBe('sessions');expect(useUIStore.getState().chatSourceFocus).toMatchObject({sessionId:'meeting-a',sourceRevision:'source-a',segmentIndex:0});expect(libraryChatApi.source).toHaveBeenCalledWith(expect.objectContaining({mode:'all'}),'all-key',evidence.id);
});
test('meeting time citation opens its scoped meeting without a fake transcript focus',async()=>{
 const previousTimezone=process.env.TZ;process.env.TZ='America/Sao_Paulo';
 const metadata={kind:'meeting-metadata' as const,id:'meeting-a:meeting-metadata:metadata-a',sessionId:'meeting-a',sourceRevision:'metadata-a',recordedAt:'2026-04-15T14:30:00Z'};
 localStorage.setItem('heed-library-chat-scope',JSON.stringify({mode:'all',labels:[],match:'any'}));
 vi.mocked(libraryChatApi.context).mockImplementation(async(scope)=>{const result=context(scope);result.thread.turns[0].answer!.claims=[{text:'The meeting was recorded on April 15.',citations:[metadata]}];return result;});
 try{
  render(<LibraryChat/>);await screen.findByText('The meeting was recorded on April 15.');
  expect(screen.getByText(/Meeting date and time/)).toBeInTheDocument();
  expect(screen.getByText(/11:30/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:/Open meeting/}));
  await waitFor(()=>expect(useSessionsStore.getState().viewing?.id).toBe('meeting-a'));
  expect(useUIStore.getState().chatSourceFocus).toBeNull();
  expect(libraryChatApi.source).toHaveBeenCalledWith(expect.objectContaining({mode:'all'}),'all-key',metadata.id);
 }finally{if(previousTimezone===undefined)delete process.env.TZ;else process.env.TZ=previousTimezone;}
});
test('a meeting time citation cannot open metadata superseded while its source request was pending',async()=>{
 const metadata={kind:'meeting-metadata' as const,id:'meeting-a:meeting-metadata:metadata-a',sessionId:'meeting-a',sourceRevision:'metadata-a',recordedAt:'2026-04-15T14:30:00Z'};
 const old={id:'meeting-a',title:'Planning',createdAt:metadata.recordedAt,duration:60,transcriptVersion:1,transcriptRevision:'source-a',transcriptFinalized:true,files:{}} as Session;
 useSessionsStore.setState({sessions:[old]});
 let finish!:(session:Session)=>void;
 vi.mocked(libraryChatApi.source).mockImplementation(()=>new Promise(resolve=>finish=resolve));
 vi.mocked(libraryChatApi.context).mockImplementation(async scope=>{const result=context(scope);result.thread.turns[0]!.answer!.claims=[{text:'The latest meeting was on April 15.',citations:[metadata]}];return result;});
 localStorage.setItem('heed-library-chat-scope',JSON.stringify({mode:'all',labels:[],match:'any'}));
 render(<LibraryChat/>);await screen.findByText('The latest meeting was on April 15.');fireEvent.click(screen.getByRole('button',{name:'Open meeting'}));
 useSessionsStore.getState().accept({...old,createdAt:'2026-04-16T14:30:00Z',duration:90});
 finish(old);
 await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('The selected meetings or labels changed. Refresh the scope before asking.'));
 expect(useUIStore.getState().currentPage).toBe('chat');
 expect(useSessionsStore.getState().viewing).toBeNull();
});
test('partial meeting date coverage is visible beside transcript retrieval counts',async()=>{
 localStorage.setItem('heed-library-chat-scope',JSON.stringify({mode:'all',labels:[],match:'any'}));
 vi.mocked(libraryChatApi.context).mockImplementation(async(scope)=>{const result=context(scope);result.thread.turns[0].answer!.coverage.metadata={selectedMeetings:12,suppliedMeetings:8,complete:false};return result;});
 render(<LibraryChat/>);await screen.findByText('BROAD_SECRET_ANSWER');
 expect(screen.getByText('Meeting dates: 8 of 12 eligible meetings supplied.')).toBeInTheDocument();
 expect(screen.getByText('Meeting date coverage is partial. The latest meeting cannot be established across this selection.')).toBeInTheDocument();
});
test('historical answers retain quotes but disable source navigation and retry',async()=>{
 localStorage.setItem('heed-library-chat-scope',JSON.stringify({mode:'all',labels:[],match:'any'}));
 vi.mocked(libraryChatApi.context).mockImplementation(async(scope)=>{const result=context({...scope,mode:'all'});result.thread.turns[0].stale=true;return result;});render(<LibraryChat/>);await screen.findByText('BROAD_SECRET_ANSWER');expect(screen.getByText('Historical answer: labels, meetings or transcripts changed.')).toBeInTheDocument();expect(screen.getByRole('button',{name:/meeting-a.*12s/})).toBeDisabled();
});
test('cancel, retry and confirmed clear mutate only the visible scope',async()=>{
 localStorage.setItem('heed-library-chat-scope',JSON.stringify({mode:'all',labels:[],match:'any'}));
 vi.mocked(libraryChatApi.context).mockImplementation(async(scope)=>{const result=context({...scope,mode:'all'});result.thread.turns[0].status='running';return result;});render(<LibraryChat/>);fireEvent.click(await screen.findByRole('button',{name:'Cancel answer'}));await waitFor(()=>expect(libraryChatApi.command).toHaveBeenCalledWith(expect.anything(),{action:'cancel',turnId:'broad-turn'}));
 fireEvent.click(screen.getByRole('button',{name:'Clear chat history'}));expect(screen.getByRole('dialog')).toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:'Clear history'}));await waitFor(()=>expect(libraryChatApi.command).toHaveBeenCalledWith(expect.anything(),{action:'clear',expectedThreadRevision:'thread-one'}));
});

test('clearing history discards a failed send receipt before sending the same question again',async()=>{
 localStorage.setItem('heed-library-chat-scope',JSON.stringify({mode:'all',labels:[],match:'any'}));let sends=0;
 vi.mocked(libraryChatApi.command).mockImplementation(async(scope,command)=>{if(command.action==='send'&&++sends===1)throw new Error('network');return {...context(scope).thread,revision:'after-clear',turns:[]};});
 render(<LibraryChat/>);await screen.findByText('BROAD_SECRET_ANSWER');fireEvent.change(screen.getByLabelText('Local chat model'),{target:{value:'local'}});fireEvent.change(screen.getByLabelText('Question across selected meetings'),{target:{value:'Who mentioned Rails?'}});fireEvent.click(screen.getByRole('button',{name:'Send question'}));await screen.findByRole('alert');
 fireEvent.click(screen.getByRole('button',{name:'Clear chat history'}));fireEvent.click(screen.getByRole('button',{name:'Clear history'}));await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());fireEvent.click(screen.getByRole('button',{name:'Send question'}));await waitFor(()=>expect(libraryChatApi.command).toHaveBeenCalledTimes(3));
 const first=vi.mocked(libraryChatApi.command).mock.calls[0]![1];const last=vi.mocked(libraryChatApi.command).mock.calls[2]![1];expect(last).toMatchObject({expectedThreadRevision:'after-clear'});expect((last as {requestId:string}).requestId).not.toBe((first as {requestId:string}).requestId);
});


test('waiting answers identify changing blockers while preserving evidence and scope',async()=>{
 localStorage.setItem('heed-library-chat-scope',JSON.stringify({mode:'all',labels:[],match:'any'}));
 const result=context({mode:'all',labels:[],match:'any'});
 const waiting={...result.thread.turns[0]!,id:'waiting-turn',question:'New question',status:'waiting' as const,answer:undefined,waitingReason:'notes' as const};
 vi.mocked(libraryChatApi.context).mockResolvedValue({...result,thread:{...result.thread,turns:[...result.thread.turns,waiting]}});
 render(<LibraryChat/>);
 expect(await screen.findByText('Waiting for notes generation to finish.')).toBeInTheDocument();
 vi.mocked(libraryChatApi.context).mockResolvedValue({...result,thread:{...result.thread,turns:[...result.thread.turns,{...waiting,waitingReason:'chat' as const}]}});
 fireEvent.click(screen.getByRole('button',{name:'Refresh chat'}));
 expect(await screen.findByText('Waiting for another chat answer to finish.')).toBeInTheDocument();
 expect(screen.queryByText('Waiting for notes generation to finish.')).not.toBeInTheDocument();
 expect(screen.getByText('BROAD_SECRET_ANSWER')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Cancel answer'}));
 await waitFor(()=>expect(libraryChatApi.command).toHaveBeenCalledWith(result.thread.scope,{action:'cancel',turnId:'waiting-turn'}));
});

test('a held citation source response cannot restore discarded candidates or an old title',async()=>{
 const candidate={id:'discarded',requestId:'stage',requestSignature:'sig',createdAt:'2026-10-06T12:00:00Z',baseGuard:{expectedTranscriptRevision:'source-a',expectedTranscriptVersion:1},transcript:'Candidate',segments:[],speakers:[],language:'en',duration:1};
 const old={id:'meeting-a',title:'Old title',createdAt:candidate.createdAt,duration:1,language:'en',transcript:'Current',segments:[],speakers:[],tags:[],pinned:false,aiNotes:'',summary:'',transcriptVersion:1,transcriptRevision:'source-a',transcriptEditing:{schemaVersion:1 as const,activeGenerationId:'g',generations:[],edits:[],candidates:[candidate],candidateRequestReceipts:[]}};
 useSessionsStore.setState({sessions:[old]});let finish!:(session:Session)=>void;
 vi.mocked(libraryChatApi.source).mockImplementation(()=>new Promise(resolve=>finish=resolve));
 localStorage.setItem('heed-library-chat-scope',JSON.stringify({mode:'all',labels:[],match:'any'}));
 render(<LibraryChat/>);await screen.findByText('BROAD_SECRET_ANSWER');fireEvent.click(screen.getByRole('button',{name:/meeting-a.*12s/}));
 const current={...old,title:'Renamed',transcriptEditing:{...old.transcriptEditing,candidates:[]}};
 const accepted=useSessionsStore.getState().accept(current);
 useSessionsStore.setState({sessions:[{...accepted,title:"Renamed"}]});finish(old);
 await waitFor(()=>expect(useUIStore.getState().currentPage).toBe('sessions'));
 expect(useSessionsStore.getState().viewing).toBe(useSessionsStore.getState().sessions[0]);
 expect(useSessionsStore.getState().viewing).toMatchObject({title:'Renamed',transcriptEditing:{candidates:[]}});
});

test('a newer citation source synchronizes accepted cache while retaining independently saved metadata',async()=>{
 const old={id:'meeting-a',title:'Renamed',createdAt:'2026-10-06T12:00:00Z',duration:1,language:'en',transcript:'Current',segments:[],speakers:[],tags:['Current tag'],pinned:true,aiNotes:'',summary:'',transcriptVersion:2,transcriptRevision:'source-a'};
 useSessionsStore.setState({sessions:[old]});let finish!:(session:Session)=>void;
 vi.mocked(libraryChatApi.source).mockImplementation(()=>new Promise(resolve=>finish=resolve));
 localStorage.setItem('heed-library-chat-scope',JSON.stringify({mode:'all',labels:[],match:'any'}));
 render(<LibraryChat/>);await screen.findByText('BROAD_SECRET_ANSWER');fireEvent.click(screen.getByRole('button',{name:/meeting-a.*12s/}));
 finish({...old,title:'Old response title',tags:[],pinned:false,transcriptVersion:3});
 await waitFor(()=>expect(useUIStore.getState().currentPage).toBe('sessions'));
 expect(useSessionsStore.getState().sessions[0]).toMatchObject({transcriptVersion:3,title:'Renamed',tags:['Current tag'],pinned:true});
 useSessionsStore.getState().accept(old);
 expect(useSessionsStore.getState().viewing?.transcriptVersion).toBe(3);
});

test("library retrieval coverage distinguishes stage counts and never infers unknown search totals", async () => {
  localStorage.setItem(
    "heed-library-chat-scope",
    JSON.stringify({ mode: "all", labels: [], match: "any" }),
  );
  const retrieval = {
    version: 1 as const,
    strategy: "lexical" as const,
    selectedMeetings: 3,
    selectedEvidence: 30,
    indexedMeetings: 2,
    indexedEvidence: 20,
    searchedMeetings: 2,
    searchedEvidence: null,
    matchingRowsVisited: 4,
    matchedEvidence: 2,
    retrievedMeetings: 2,
    retrievedEvidence: 6,
    suppliedMeetings: 1,
    suppliedEvidence: 3,
    citedMeetings: 1,
    citedEvidence: 1,
    indexComplete: false,
    lookupComplete: false,
    generationComplete: false,
    partialReasons: [
      "query-budget",
      "context-budget",
    ] as import("@heed/shared").RetrievalPartialReason[],
  };
  vi.mocked(libraryChatApi.context).mockImplementation(async (scope) => {
    const result = context(scope);
    result.thread.turns[0]!.answer!.coverage.retrieval = retrieval;
    return result;
  });
  render(<LibraryChat />);
  expect(
    await screen.findByText(
      "Meetings: 3 selected · 2 indexed · 2 searched · 2 retrieved · 1 supplied · 1 cited.",
    ),
  ).toBeVisible();
  expect(
    screen.getByText(
      "Transcript excerpts: 30 selected · 20 indexed · unknown searched · 2 matched · 6 retrieved · 3 supplied · 1 cited.",
    ),
  ).toBeVisible();
  expect(
    screen.getByText(
      "Lexical lookup stopped before completion. Some matches may be missing.",
    ),
  ).toBeVisible();
  expect(
    screen.queryByText(/Evidence was sampled across the selected meetings/),
  ).toBeNull();
  const source = screen.getByRole("button", { name: /meeting-a.*12s/ });
  source.focus();
  expect(source).toHaveFocus();
  fireEvent.click(source);
  await waitFor(() =>
    expect(useUIStore.getState().currentPage).toBe("sessions"),
  );
});
test("a complete library lexical zero hit is not a whole-scope absence claim", async () => {
  localStorage.setItem(
    "heed-library-chat-scope",
    JSON.stringify({ mode: "all", labels: [], match: "any" }),
  );
  vi.mocked(libraryChatApi.context).mockImplementation(async (scope) => {
    const result = context(scope);
    const answer = result.thread.turns[0]!.answer!;
    answer.claims = [];
    answer.coverage = {
      complete: true,
      reviewedChunks: 0,
      totalChunks: 0,
      answerLimited: false,
      retrieval: {
        ...{
          version: 1 as const,
          strategy: "lexical" as const,
          selectedMeetings: 3,
          selectedEvidence: 30,
          indexedMeetings: 2,
          indexedEvidence: 20,
          searchedMeetings: 2,
          searchedEvidence: 20,
          matchingRowsVisited: 4,
          matchedEvidence: 2,
          retrievedMeetings: 2,
          retrievedEvidence: 6,
          suppliedMeetings: 1,
          suppliedEvidence: 3,
          citedMeetings: 1,
          citedEvidence: 1,
          indexComplete: false,
          lookupComplete: false,
          generationComplete: false,
          partialReasons: [],
        },
        indexedMeetings: 3,
      indexedEvidence: 30,
      searchedMeetings: 3,
      searchedEvidence: 30,
      matchingRowsVisited: 0,
      retrievedMeetings: 0,
      suppliedMeetings: 0,
      citedMeetings: 0,
      indexComplete: true,
        lookupComplete: true,
        matchedEvidence: 0,
        retrievedEvidence: 0,
        suppliedEvidence: 0,
        citedEvidence: 0,
      },
    };
    return result;
  });
  render(<LibraryChat />);
  expect(
    await screen.findByText(
      "No lexical matches found. This does not establish that the topic is absent from the selected transcripts.",
    ),
  ).toBeVisible();
  expect(screen.queryByText("Not found in the selected meetings.")).toBeNull();
});

test("catalog readiness preserves selected scope and can be cancelled; unavailable lookup is actionable", async () => {
  localStorage.setItem(
    "heed-library-chat-scope",
    JSON.stringify({ mode: "all", labels: [], match: "any" }),
  );
  const result = context({ mode: "all", labels: [], match: "any" });
  vi.mocked(libraryChatApi.context).mockResolvedValue({
    ...result,
    thread: {
      ...result.thread,
      turns: [
        {
          ...result.thread.turns[0]!,
          status: "waiting",
          waitingReason: "retrieval",
          answer: undefined,
        },
      ],
    },
  });
  const view = render(<LibraryChat />);
  expect(
    await screen.findByText(
      "Waiting for the local transcript catalog to become ready.",
    ),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Cancel answer" }));
  await waitFor(() =>
    expect(libraryChatApi.command).toHaveBeenCalledWith(result.thread.scope, {
      action: "cancel",
      turnId: "broad-turn",
    }),
  );
  view.unmount();
  vi.mocked(libraryChatApi.context).mockRejectedValue(
    new Error("retrieval-unavailable"),
  );
  render(<LibraryChat />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Local transcript retrieval is unavailable. Refresh chat and retry.",
  );
  expect(screen.getByRole("button", { name: "Refresh chat" })).toBeEnabled();
  expect(screen.getByLabelText("All meetings")).toBeChecked();
});
