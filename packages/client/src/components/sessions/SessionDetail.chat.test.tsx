import {StrictMode} from 'react';
import {useUIStore} from "@/stores/ui";
import {act,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {beforeEach,expect,test,vi} from "vitest";
import type {Session} from "@heed/shared";
import {SessionDetail} from "./SessionDetail";
import {useTemplatesStore} from "@/stores/templates";
import {useModelsStore} from "@/stores/models";
import {useLocaleStore} from "@/stores/locale";
vi.mock("@/components/chat/MeetingChat",()=>({MeetingChat:({onCitation}:{onCitation:(value:unknown)=>void})=><button onClick={()=>onCitation({sessionId:"meeting-a",sourceRevision:"revision-a",segmentIndex:null,paragraphIndex:1,start:18,quote:"Second decision."})}>Open cited paragraph</button>}));
beforeEach(()=>{useLocaleStore.setState({locale:"en"});useTemplatesStore.setState({load:vi.fn()});useModelsStore.setState({load:vi.fn()});});
test("chat citations navigate the text-only final transcript without audio",()=>{
 const session={id:"meeting-a",title:"Meeting",createdAt:"2026-10-05T12:00:00Z",duration:0,language:"en",transcript:"First decision.\n\nSecond decision.",segments:[],speakers:[],tags:[],aiNotes:"",pinned:false,summary:"",transcriptFinalized:true,transcriptRevision:"revision-a"} as Session;
 render(<SessionDetail session={session} onBack={vi.fn()}/>);fireEvent.click(screen.getByText("Chat"));fireEvent.click(screen.getByText("Open cited paragraph"));
 expect(screen.getByText("Second decision.")).toHaveAttribute("aria-current","true");expect(screen.getByText("First decision.")).not.toHaveAttribute("aria-current","true");
});

test("library citation opens the matching text paragraph without requiring audio",()=>{
 const session={id:"meeting-a",title:"Meeting",createdAt:"2026-10-05T12:00:00Z",duration:0,language:"en",transcript:"First decision.\n\nSecond decision.",segments:[],speakers:[],tags:[],aiNotes:"",pinned:false,summary:"",transcriptFinalized:true,transcriptRevision:"revision-a"} as Session;
 useUIStore.setState({chatSourceFocus:{id:"source",sessionId:"meeting-a",sourceRevision:"revision-a",segmentIndex:null,paragraphIndex:1,start:null,end:null,speaker:"",quote:"Second decision."}});
 render(<SessionDetail session={session} onBack={vi.fn()}/>);
 expect(screen.getByText("Second decision.")).toHaveAttribute("aria-current","true");expect(useUIStore.getState().chatSourceFocus).toBeNull();
});

test('a queued library audio seek rejects a replaced transcript revision',()=>{
 const play=vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue(undefined);
 const session={id:'meeting-a',title:'Meeting',createdAt:'2026-10-05',duration:30,language:'en',transcript:'New source.',segments:[],speakers:[],tags:[],aiNotes:'',pinned:false,summary:'',files:{wav:'synthetic.wav'},transcriptFinalized:true,transcriptRevision:'new-revision'} as Session;
 useUIStore.setState({chatSourceFocus:null,taskSourceSeek:{sessionId:'meeting-a',seconds:12,sourceRevision:'old-revision'}});
 try{render(<SessionDetail session={session} onBack={vi.fn()}/>);const audio=screen.getByLabelText('Meeting audio') as HTMLAudioElement;Object.defineProperty(audio,'duration',{value:30});fireEvent.loadedMetadata(audio);expect(audio.currentTime).toBe(0);expect(play).not.toHaveBeenCalled();}finally{play.mockRestore();}
});

const audioSession={id:'meeting-a',title:'Meeting',createdAt:'2026-10-05',duration:30,language:'en',transcript:'Current source.',segments:[],speakers:[],tags:[],aiNotes:'',pinned:false,summary:'',files:{wav:'synthetic.wav'},transcriptFinalized:true,transcriptRevision:'revision-a'} as Session;
test('failed audio clears the pending source seek instead of replaying it on a later metadata event',()=>{
 const play=vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue(undefined);
 useUIStore.setState({chatSourceFocus:null,taskSourceSeek:{sessionId:'meeting-a',seconds:12,sourceRevision:'revision-a'}});
 try{render(<SessionDetail session={audioSession} onBack={vi.fn()}/>);const audio=screen.getByLabelText('Meeting audio') as HTMLAudioElement;fireEvent.error(audio);expect(useUIStore.getState().taskSourceSeek).toBeNull();Object.defineProperty(audio,'duration',{value:30});fireEvent.loadedMetadata(audio);expect(play).not.toHaveBeenCalled();}finally{play.mockRestore();}
});
test('unmounting a source meeting cancels its unconsumed seek before another visit',async()=>{
 useUIStore.setState({chatSourceFocus:null,taskSourceSeek:{sessionId:'meeting-a',seconds:12,sourceRevision:'revision-a'}});
 const view=render(<SessionDetail session={audioSession} onBack={vi.fn()}/>);view.unmount();await waitFor(()=>expect(useUIStore.getState().taskSourceSeek).toBeNull());
});
test('missing audio cancels a source seek while retaining transcript navigation',()=>{
 useUIStore.setState({chatSourceFocus:null,taskSourceSeek:{sessionId:'meeting-a',seconds:12,sourceRevision:'revision-a'}});
 render(<SessionDetail session={{...audioSession,files:{}}} onBack={vi.fn()}/>);expect(screen.getByText('Current source.')).toBeInTheDocument();expect(useUIStore.getState().taskSourceSeek).toBeNull();
});

test('development StrictMode keeps a current citation seek until its first metadata event',()=>{
 const play=vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue(undefined);
 useUIStore.setState({chatSourceFocus:{id:'source',sessionId:'meeting-a',sourceRevision:'revision-a',segmentIndex:null,paragraphIndex:0,start:12,end:14,speaker:'',quote:'Current source.'},taskSourceSeek:null});
 try{render(<StrictMode><SessionDetail session={audioSession} onBack={vi.fn()}/></StrictMode>);const audio=screen.getByLabelText('Meeting audio') as HTMLAudioElement;Object.defineProperty(audio,'duration',{value:30});fireEvent.loadedMetadata(audio);expect(audio.currentTime).toBe(12);expect(play).toHaveBeenCalledTimes(1);expect(useUIStore.getState().taskSourceSeek).toBeNull();}finally{play.mockRestore();}
});

test('an old view cleanup does not cancel a newly requested seek on a rapid revisit',async()=>{
 useUIStore.setState({chatSourceFocus:null,taskSourceSeek:{sessionId:'meeting-a',seconds:12,sourceRevision:'revision-a'}});
 const old=render(<SessionDetail session={audioSession} onBack={vi.fn()}/>);old.unmount();
 const next={sessionId:'meeting-a',seconds:18,sourceRevision:'revision-a'};useUIStore.setState({taskSourceSeek:next});
 render(<SessionDetail session={audioSession} onBack={vi.fn()}/>);await act(async()=>{});expect(useUIStore.getState().taskSourceSeek).toBe(next);
});

test('a newer direct citation supersedes an older deferred source seek',()=>{
 const play=vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue(undefined);
 useUIStore.setState({chatSourceFocus:null,taskSourceSeek:{sessionId:'meeting-a',seconds:12,sourceRevision:'revision-a'}});
 try{render(<SessionDetail session={audioSession} onBack={vi.fn()}/>);fireEvent.click(screen.getByText('Chat'));fireEvent.click(screen.getByText('Open cited paragraph'));const audio=screen.getByLabelText('Meeting audio') as HTMLAudioElement;Object.defineProperty(audio,'duration',{value:30});fireEvent.loadedMetadata(audio);expect(audio.currentTime).toBe(18);expect(useUIStore.getState().taskSourceSeek).toBeNull();}finally{play.mockRestore();}
});
