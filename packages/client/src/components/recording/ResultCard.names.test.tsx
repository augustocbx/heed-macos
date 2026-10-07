import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { ResultCard } from "./ResultCard.tsx";
import { useRecordingStore } from "@/stores/recording.ts";
import { useTemplatesStore } from "@/stores/templates.ts";
import { useModelsStore } from "@/stores/models.ts";
import type { Session } from "@heed/shared";
import { useSessionsStore } from "@/stores/sessions";
import { sessionsApi } from "@/api/sessions";
import { recordingApi } from "@/api/recording";
vi.mock("@/components/speakers/SpeakerView.tsx", () => ({ SpeakerView: ({ speakerNames, segments, onRename, onMerge }: {
 segments: {text:string}[]; speakerNames: Record<string, string>; onRename: (original: string, name: string) => void; onMerge:(from:string,into:string)=>void;
}) => <div><span data-testid="source">{segments.map(s=>s.text).join(" ")}</span><span data-testid="name">{speakerNames["Speaker 1"] || "Speaker 1"}</span>
 <button onClick={() => onRename("Speaker 1", "Ana")}>Set name</button><button onClick={()=>onMerge("Speaker 1","Speaker 2")}>Merge speakers</button></div> }));
beforeEach(() => {
 vi.restoreAllMocks();
 useRecordingStore.getState().reset();
 useSessionsStore.setState({sessions:[],viewing:null});
 useTemplatesStore.setState({ load: vi.fn() });
 useModelsStore.setState({ load: vi.fn() });
});

test("live participant edits are committed to the backend before another tab reconnects",async()=>{
 useRecordingStore.setState({recording:true,coordinatorMeetingId:"active",coordinatorRevision:12});
 useRecordingStore.getState().upsertLiveTurn({id:1,speaker:"Speaker 1",text:"hello",channel:"sys",start:1,end:2});
 const rename=vi.spyOn(recordingApi,"rename").mockResolvedValue({meetingId:"active",state:"recording",revision:13,startedAt:1,path:"test.wav",seconds:2,mode:"both",segments:useRecordingStore.getState().segments,speakerNames:{"Speaker 1":"Ana"},session:null,error:null,maintenance:false});
 render(<ResultCard/>);await act(async()=>{fireEvent.click(screen.getByText("Set name"));});
 expect(rename).toHaveBeenCalledWith("active",12,{"Speaker 1":"Ana"});
 expect(screen.getByTestId("name")).toHaveTextContent("Ana");
});

test("edited speaker name does not revert when another live segment arrives", () => {
 useRecordingStore.getState().upsertLiveTurn({ id: 1, speaker: "Speaker 1", text: "hello", channel: "sys", start: 1, end: 2 });
 render(<ResultCard />);
 fireEvent.click(screen.getByText("Set name"));
 expect(screen.getByTestId("name")).toHaveTextContent("Ana");
 act(() => useRecordingStore.getState().upsertLiveTurn({ id: 1, speaker: "Speaker 1", text: "hello again", channel: "sys", start: 1, end: 3 }));
 expect(screen.getByTestId("name")).toHaveTextContent("Ana");
});

test("speaker edits are held across the final save acknowledgement", () => {
 useRecordingStore.setState({finalSavePending:true});
 render(<ResultCard />);
 fireEvent.click(screen.getByText("Set name"));
 expect(screen.getByTestId("name")).toHaveTextContent("Speaker 1");
});

const saved = {id:"saved",title:"Meeting",createdAt:"2026-10-06T12:00:00Z",duration:2,language:"en",summary:"",pinned:false, transcript:"Accepted text",transcriptRevision:"accepted",transcriptVersion:4,transcriptFinalized:true,
 segments:[{speaker:"Speaker 1",text:"Accepted text",start:0,end:2,channel:"sys"}],speakers:["Speaker 1"],embeddings:{},aiNotes:"",tags:[]} as Session;
test("finalized display and copy use the accepted saved source",async()=>{
 useSessionsStore.setState({sessions:[saved]});
 useRecordingStore.setState({currentSessionId:saved.id,transcript:"Old recording",segments:[{...saved.segments[0],text:"Old recording"}],speakers:saved.speakers});
 const copy=vi.fn();Object.defineProperty(navigator,"clipboard",{value:{writeText:copy},configurable:true});
 render(<ResultCard/>);
 expect(screen.getByTestId("source")).toHaveTextContent("Accepted text");
 fireEvent.click(screen.getByText("Copy plain text"));expect(copy).toHaveBeenCalledWith("Accepted text");
 fireEvent.click(screen.getByText("Copy"));expect(copy).toHaveBeenCalledWith("Speaker 1: Accepted text");
});
test("saved rename carries the displayed source guard and rolls back on conflict",async()=>{
 useSessionsStore.setState({sessions:[saved]});useRecordingStore.setState({currentSessionId:saved.id});
 const patch=vi.spyOn(sessionsApi,"patch").mockRejectedValue(new Error("Conflict"));
 render(<ResultCard/>);await act(async()=>{fireEvent.click(screen.getByText("Set name"));});
 expect(patch).toHaveBeenCalledWith(saved.id,expect.objectContaining({expectedTranscriptRevision:"accepted",expectedTranscriptVersion:4,speakers:["Ana"],segments:[{...saved.segments[0],speaker:"Ana",auto:false}]}));
 expect(screen.getByTestId("name")).toHaveTextContent("Speaker 1");
 expect(useSessionsStore.getState().sessions[0]).toBe(saved);
});
test("a saved recording without its server source token blocks rename",async()=>{
 useRecordingStore.setState({currentSessionId:"missing"});const patch=vi.spyOn(sessionsApi,"patch");
 render(<ResultCard/>);await act(async()=>{fireEvent.click(screen.getByText("Set name"));});
 expect(patch).not.toHaveBeenCalled();expect(screen.getByTestId("name")).toHaveTextContent("Speaker 1");
});

test("saved merge uses accepted segments and guard without changing the recording buffer on conflict",async()=>{
 const accepted={...saved,speakers:["Speaker 1","Speaker 2"],segments:[...saved.segments,{...saved.segments[0],speaker:"Speaker 2",text:"Other participant"}]};
 const recordingSegments=[{...saved.segments[0],text:"Old buffer"}];
 useSessionsStore.setState({sessions:[accepted]});useRecordingStore.setState({currentSessionId:saved.id,segments:recordingSegments,speakers:["Speaker 1"]});
 const patch=vi.spyOn(sessionsApi,"patch").mockRejectedValue(new Error("Conflict"));
 render(<ResultCard/>);await act(async()=>{fireEvent.click(screen.getByText("Merge speakers"));});
 expect(patch).toHaveBeenCalledWith(saved.id,expect.objectContaining({expectedTranscriptRevision:"accepted",expectedTranscriptVersion:4,speakers:["Speaker 2"],segments:accepted.segments.map(segment=>({...segment,speaker:"Speaker 2"}))}));
 expect(useRecordingStore.getState().segments).toEqual(recordingSegments);expect(useSessionsStore.getState().sessions[0]).toBe(accepted);
});
