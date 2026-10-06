import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { ChatThread, Session } from "@heed/shared";
import { MeetingChat } from "./MeetingChat";
import { chatApi } from "@/api/chat";
import { useLocaleStore } from "@/stores/locale";
vi.mock("@/api/chat",()=>({chatApi:{get:vi.fn(),models:vi.fn(),command:vi.fn()}}));
const session={id:"meeting-a",title:"Planning",transcriptRevision:"revision-a",transcriptFinalized:true} as Session;
const citation={id:"evidence-a",sessionId:"meeting-a",sourceRevision:"revision-a",segmentIndex:1,paragraphIndex:null,speaker:"Ana",quote:"Vamos revisar.",start:12,end:14};
const saved:ChatThread={sessionId:session.id,revision:"history-a",turns:[{id:"turn-a",requestId:"request-a",question:"Decision?",model:"local",sourceRevision:"revision-a",status:"completed",createdAt:"now",updatedAt:"now",attempts:1,answer:{claims:[{text:"Review was suggested.",citations:[citation]}],coverage:{complete:true,reviewedChunks:2,totalChunks:2,answerLimited:false}}}]};
beforeEach(()=>{vi.clearAllMocks();useLocaleStore.setState({locale:"en"});vi.mocked(chatApi.get).mockResolvedValue(saved);vi.mocked(chatApi.models).mockResolvedValue({models:["local"]});vi.mocked(chatApi.command).mockResolvedValue(saved);});

test("loads durable answers and navigates exact transcript citations",async()=>{
 const navigate=vi.fn();render(<MeetingChat session={session} onCitation={navigate}/>);
 expect(await screen.findByText("Review was suggested.")).toBeInTheDocument();
 fireEvent.click(screen.getByRole("button",{name:/Ana/}));expect(navigate).toHaveBeenCalledWith(citation);
 expect(screen.getByText("Vamos revisar.")).toBeInTheDocument();
});

test("sends question independently from interface language and reuses request identity after transport failure",async()=>{
 vi.mocked(chatApi.command).mockRejectedValueOnce(new Error("network"));render(<MeetingChat session={session} onCitation={vi.fn()}/>);
 await screen.findByText("Review was suggested.");fireEvent.change(screen.getByLabelText("Local chat model"),{target:{value:"local"}});
 fireEvent.change(screen.getByLabelText("Question about this meeting"),{target:{value:"O orçamento foi aprovado?"}});fireEvent.click(screen.getByRole("button",{name:"Send question"}));
 await screen.findByRole("alert");fireEvent.click(screen.getByRole("button",{name:"Send question"}));await waitFor(()=>expect(chatApi.command).toHaveBeenCalledTimes(2));
 const first=vi.mocked(chatApi.command).mock.calls[0]![1];const second=vi.mocked(chatApi.command).mock.calls[1]![1];expect(first).toEqual(second);expect(first).toMatchObject({question:"O orçamento foi aprovado?",model:"local",expectedSourceRevision:"revision-a"});
});

test("stale and partial answers expose limits and cannot seek replacement source",async()=>{
 vi.mocked(chatApi.get).mockResolvedValue({...saved,turns:[{...saved.turns[0]!,stale:true,answer:{claims:[],coverage:{complete:false,reviewedChunks:2,totalChunks:9,answerLimited:false}}}]});
 render(<MeetingChat session={session} onCitation={vi.fn()}/>);
 expect(await screen.findByText("No supporting evidence found in the reviewed excerpts.")).toBeInTheDocument();expect(screen.getByText(/Reviewed 2 of 9/)).toBeInTheDocument();expect(screen.getByText(/This answer uses an older/)).toBeInTheDocument();
});

test("waiting turns can be cancelled and failed turns can be retried without appending a question",async()=>{
 vi.mocked(chatApi.get).mockResolvedValue({...saved,turns:[{...saved.turns[0]!,status:"waiting",answer:undefined}]});
 const view=render(<MeetingChat session={session} onCitation={vi.fn()}/>);fireEvent.click(await screen.findByRole("button",{name:"Cancel answer"}));await waitFor(()=>expect(chatApi.command).toHaveBeenCalledWith(session.id,{action:"cancel",turnId:"turn-a"}));
 view.unmount();vi.mocked(chatApi.get).mockResolvedValue({...saved,turns:[{...saved.turns[0]!,status:"failed",reason:"model-missing",answer:undefined}]});render(<MeetingChat session={session} onCitation={vi.fn()}/>);fireEvent.click(await screen.findByRole("button",{name:"Retry answer"}));await waitFor(()=>expect(chatApi.command).toHaveBeenCalledWith(session.id,{action:"retry",turnId:"turn-a"}));
});

test("a poll started during a save cannot overwrite the committed turn",async()=>{
 const {act}=await import("@testing-library/react");vi.useFakeTimers();
 let finishCommand:(value:ChatThread)=>void=()=>{};let finishPoll:(value:ChatThread)=>void=()=>{};
 vi.mocked(chatApi.command).mockImplementation(()=>new Promise(resolve=>{finishCommand=resolve;}));vi.mocked(chatApi.get).mockResolvedValueOnce(saved).mockImplementation(()=>new Promise(resolve=>{finishPoll=resolve;}));
 try{
  render(<MeetingChat session={session} onCitation={vi.fn()}/>);await act(async()=>{});
  fireEvent.change(screen.getByLabelText("Local chat model"),{target:{value:"local"}});fireEvent.change(screen.getByLabelText("Question about this meeting"),{target:{value:"New question?"}});fireEvent.click(screen.getByRole("button",{name:"Send question"}));
  await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
  const newer={...saved,revision:"newer",turns:[...saved.turns,{...saved.turns[0]!,id:"turn-b",question:"New question?",status:"waiting" as const,answer:undefined}]};
  await act(async()=>{finishCommand(newer);});expect(screen.getByText("New question?")).toBeInTheDocument();
  await act(async()=>{finishPoll(saved);});expect(screen.getByText("New question?")).toBeInTheDocument();
 }finally{vi.useRealTimers();}
});

test("existing failure messages follow interface locale changes without altering meeting content",async()=>{
 const {act}=await import("@testing-library/react");vi.mocked(chatApi.models).mockRejectedValue(new Error("ollama-unavailable"));render(<MeetingChat session={session} onCitation={vi.fn()}/>);
 expect(await screen.findByRole("alert")).toHaveTextContent("Local chat unavailable.");
 act(()=>useLocaleStore.setState({locale:"fr"}));expect(screen.getByRole("alert")).toHaveTextContent("Discussion locale indisponible.");expect(screen.getByText("Review was suggested.")).toBeInTheDocument();
});
