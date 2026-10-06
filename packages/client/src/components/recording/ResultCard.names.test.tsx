import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { ResultCard } from "./ResultCard.tsx";
import { useRecordingStore } from "@/stores/recording.ts";
import { useTemplatesStore } from "@/stores/templates.ts";
import { useModelsStore } from "@/stores/models.ts";
import { recordingApi } from "@/api/recording";
vi.mock("@/components/speakers/SpeakerView.tsx", () => ({ SpeakerView: ({ speakerNames, onRename }: {
 speakerNames: Record<string, string>; onRename: (original: string, name: string) => void;
}) => <div><span data-testid="name">{speakerNames["Speaker 1"] || "Speaker 1"}</span>
 <button onClick={() => onRename("Speaker 1", "Ana")}>Set name</button></div> }));
beforeEach(() => {
 vi.restoreAllMocks();
 useRecordingStore.getState().reset();
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
