import {useUIStore} from "@/stores/ui";
import {fireEvent,render,screen} from "@testing-library/react";
import {beforeEach,expect,test,vi} from "vitest";
import type {Session} from "@heed/shared";
import {SessionDetail} from "./SessionDetail";
import {useTemplatesStore} from "@/stores/templates";
import {useModelsStore} from "@/stores/models";
import {useLocaleStore} from "@/stores/locale";
vi.mock("@/components/chat/MeetingChat",()=>({MeetingChat:({onCitation}:{onCitation:(value:unknown)=>void})=><button onClick={()=>onCitation({sessionId:"meeting-a",sourceRevision:"revision-a",segmentIndex:null,paragraphIndex:1,start:null,quote:"Second decision."})}>Open cited paragraph</button>}));
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
