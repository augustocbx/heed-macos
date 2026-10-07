import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { Session } from "@heed/shared";
import { SessionDetail } from "./SessionDetail.tsx";
import { useSessionsStore } from "@/stores/sessions.ts";
import { useTemplatesStore } from "@/stores/templates.ts";
import { useModelsStore } from "@/stores/models.ts";
import { sessionsApi } from "@/api/sessions.ts";
vi.mock("@/api/sessions.ts", () => ({ sessionsApi: { patch: vi.fn() } }));
vi.mock("@/components/speakers/SpeakerView.tsx", () => ({ SpeakerView: ({ speakers, speakerNames, onRename, onMerge }: {
 speakers: string[]; speakerNames: Record<string, string>; onRename: (original: string, name: string) => void; onMerge:(from:string,into:string)=>void;
}) => <div><span data-testid="participante">{speakerNames[speakers[0]] || speakers[0]}</span>
 <button onClick={() => onRename(speakers[0], "Ana")}>Set name</button><button onClick={()=>onMerge(speakers[0],speakers[1])}>Merge speakers</button></div> }));
const session = {
 id: "session", title: "Meeting", createdAt: "2026-10-05T12:00:00Z", duration: 3, language: "pt",
 speakers: ["Speaker 1"], segments: [{ speaker: "Speaker 1", start: 1, end: 3, text: "hello", channel: "sys" }],
 embeddings: { "Speaker 1": [1, 2] }, files: { wav: "", txt: "", srt: "" }, transcript: "hello",
 transcriptRevision:"displayed",transcriptVersion:2, aiNotes: "", summary: "", tags: [], pinned: false,
} as Session;
beforeEach(() => {
 vi.clearAllMocks();
 useSessionsStore.setState({ sessions: [session], viewing: session });
 useTemplatesStore.setState({ load: vi.fn() });
 useModelsStore.setState({ load: vi.fn() });
});

test("edited session speaker name persists and appears when reopened", async () => {
 vi.mocked(sessionsApi.patch).mockImplementation(async (_id, patch) => ({ ...session, ...patch,transcriptRevision:"renamed",transcriptVersion:3 }));
 const view = render(<SessionDetail session={session} onBack={vi.fn()} />);
 fireEvent.click(screen.getByText("Set name"));
 await waitFor(() => expect(useSessionsStore.getState().viewing?.speakers).toEqual(["Ana"]));
 expect(sessionsApi.patch).toHaveBeenCalledWith("session", expect.objectContaining({
  speakers: ["Ana"], segments: [{ ...session.segments[0], speaker: "Ana", auto: false }], embeddings: { Ana: [1, 2] },
 }));
 const saved = useSessionsStore.getState().viewing!;
 view.unmount();
 render(<SessionDetail session={saved} onBack={vi.fn()} />);
 expect(screen.getByTestId("participante")).toHaveTextContent("Ana");
});

test("persistence failure does not display an unsaved name", async () => {
 vi.mocked(sessionsApi.patch).mockRejectedValue(new Error("offline"));
 render(<SessionDetail session={session} onBack={vi.fn()} />);
 fireEvent.click(screen.getByText("Set name"));
 await waitFor(() => expect(screen.getByTestId("participante")).toHaveTextContent("Speaker 1"));
 expect(useSessionsStore.getState().viewing?.speakers).toEqual(["Speaker 1"]);
});

test("rename uses displayed props even when the cache has advanced",async()=>{
 const newer={...session,transcriptRevision:"newer",transcriptVersion:3};
 useSessionsStore.setState({sessions:[newer],viewing:newer});
 vi.mocked(sessionsApi.patch).mockRejectedValue(new Error("Conflict"));
 render(<SessionDetail session={session} onBack={vi.fn()}/>);
 fireEvent.click(screen.getByText("Set name"));
 await waitFor(()=>expect(sessionsApi.patch).toHaveBeenCalledWith(session.id,expect.objectContaining({expectedTranscriptRevision:"displayed",expectedTranscriptVersion:2})));
 expect(useSessionsStore.getState().viewing).toBe(newer);
 await waitFor(()=>expect(screen.getByTestId("participante")).toHaveTextContent("Speaker 1"));
});

test("merge sends the displayed guard and leaves accepted participants intact on conflict",async()=>{
 const displayed={...session,speakers:["Speaker 1","Speaker 2"]};
 const newer={...displayed,transcriptRevision:"newer",transcriptVersion:3};useSessionsStore.setState({sessions:[newer],viewing:newer});
 vi.mocked(sessionsApi.patch).mockRejectedValue(new Error("Conflict"));
 render(<SessionDetail session={displayed} onBack={vi.fn()}/>);fireEvent.click(screen.getByText("Merge speakers"));
 await waitFor(()=>expect(sessionsApi.patch).toHaveBeenCalledWith(session.id,expect.objectContaining({expectedTranscriptRevision:"displayed",expectedTranscriptVersion:2,speakers:["Speaker 2"]})));
 expect(useSessionsStore.getState().viewing).toBe(newer);
});
