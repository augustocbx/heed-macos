import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { Session } from "@heed/shared";
import { SessionDetail } from "./SessionDetail.tsx";
import { useSessionsStore } from "@/stores/sessions.ts";
import { useTemplatesStore } from "@/stores/templates.ts";
import { useModelsStore } from "@/stores/models.ts";
import { sessionsApi } from "@/api/sessions.ts";
vi.mock("@/api/sessions.ts", () => ({ sessionsApi: { patch: vi.fn() } }));
vi.mock("@/components/speakers/SpeakerView.tsx", () => ({ SpeakerView: ({ speakers, speakerNames, onRename }: {
 speakers: string[]; speakerNames: Record<string, string>; onRename: (original: string, name: string) => void;
}) => <div><span data-testid="participante">{speakerNames[speakers[0]] || speakers[0]}</span>
 <button onClick={() => onRename(speakers[0], "Ana")}>Definir nome</button></div> }));
const session = {
 id: "sessão", title: "Reunião", createdAt: "2026-10-05T12:00:00Z", duration: 3, language: "pt",
 speakers: ["Speaker 1"], segments: [{ speaker: "Speaker 1", start: 1, end: 3, text: "olá", channel: "sys" }],
 embeddings: { "Speaker 1": [1, 2] }, files: { wav: "", txt: "", srt: "" }, transcript: "olá",
 aiNotes: "", summary: "", tags: [], pinned: false,
} as Session;
beforeEach(() => {
 vi.clearAllMocks();
 useSessionsStore.setState({ sessions: [session], viewing: session });
 useTemplatesStore.setState({ load: vi.fn() });
 useModelsStore.setState({ load: vi.fn() });
});

test("nome editado em sessão é persistido e aparece ao reabrir", async () => {
 vi.mocked(sessionsApi.patch).mockImplementation(async (_id, patch) => ({ ...session, ...patch }));
 const view = render(<SessionDetail session={session} onBack={vi.fn()} />);
 fireEvent.click(screen.getByText("Definir nome"));
 await waitFor(() => expect(useSessionsStore.getState().viewing?.speakers).toEqual(["Ana"]));
 expect(sessionsApi.patch).toHaveBeenCalledWith("sessão", expect.objectContaining({
  speakers: ["Ana"], segments: [{ ...session.segments[0], speaker: "Ana", auto: false }], embeddings: { Ana: [1, 2] },
 }));
 const saved = useSessionsStore.getState().viewing!;
 view.unmount();
 render(<SessionDetail session={saved} onBack={vi.fn()} />);
 expect(screen.getByTestId("participante")).toHaveTextContent("Ana");
});

test("falha ao persistir não deixa a tela indicando um nome que não foi salvo", async () => {
 vi.mocked(sessionsApi.patch).mockRejectedValue(new Error("offline"));
 render(<SessionDetail session={session} onBack={vi.fn()} />);
 fireEvent.click(screen.getByText("Definir nome"));
 await waitFor(() => expect(screen.getByTestId("participante")).toHaveTextContent("Speaker 1"));
 expect(useSessionsStore.getState().viewing?.speakers).toEqual(["Speaker 1"]);
});
