import { beforeEach, expect, test, vi } from "vitest";
import { useRecordingStore } from "@/stores/recording.ts";
import { sessionsApi } from "@/api/sessions.ts";
import { createRecordingSession } from "./recordingSession.ts";
import { applySpeakerNames } from "./speakerNames.ts";
vi.mock("@/api/sessions.ts", () => ({ sessionsApi: { create: vi.fn(), patch: vi.fn() } }));
beforeEach(() => { vi.clearAllMocks(); useRecordingStore.getState().reset(); });
const segment = { speaker: "Speaker 1", start: 1.25, end: 3.5, text: "olá", channel: "sys" as const, auto: true };

test("salva nome manual nos dados da sessão sem perder sincronização ou embedding", async () => {
 useRecordingStore.getState().renameSpeaker("Speaker 1", "Ana");
 vi.mocked(sessionsApi.create).mockResolvedValue({ id: "sessão" } as never);
 await createRecordingSession({ segments: [segment], speakers: ["Speaker 1"], embeddings: { "Speaker 1": [1, 2] } });
 expect(sessionsApi.create).toHaveBeenCalledWith({
  segments: [{ ...segment, speaker: "Ana", auto: false }], speakers: ["Ana"], embeddings: { Ana: [1, 2] },
 });
 expect(sessionsApi.patch).not.toHaveBeenCalled();
});

test("salva edição ocorrida enquanto a sessão estava sendo criada", async () => {
 let resolve!: (value: never) => void;
 vi.mocked(sessionsApi.create).mockImplementation(() => new Promise(r => { resolve = r; }));
 vi.mocked(sessionsApi.patch).mockResolvedValue({ id: "sessão" } as never);
 const pending = createRecordingSession({ segments: [segment], speakers: ["Speaker 1"] });
 useRecordingStore.getState().renameSpeaker("Speaker 1", "Ana");
 resolve({ id: "sessão" } as never);
 await pending;
 expect(sessionsApi.patch).toHaveBeenCalledWith("sessão", expect.objectContaining({ speakers: ["Ana"] }));
});

test("renomear sessão produz dados persistíveis e mantém demais participantes", () => {
 const other = { ...segment, speaker: "Speaker 2", start: 4, end: 6 };
 const saved = applySpeakerNames([segment, other], ["Speaker 1", "Speaker 2"], { "Speaker 1": [1], "Speaker 2": [2] }, { "Speaker 1": "Ana" });
 expect(saved.segments).toEqual([{ ...segment, speaker: "Ana", auto: false }, other]);
 expect(saved.speakers).toEqual(["Ana", "Speaker 2"]);
 expect(saved.embeddings).toEqual({ Ana: [1], "Speaker 2": [2] });
});

test("índices renumerados usam tempo da voz, não o número antigo", async () => {
 const { reconcileSpeakerNames } = await import("./speakerNames.ts");
 const previous = [{ ...segment, start: 1, end: 4 }];
 const final = [{ ...segment, speaker: "Speaker 2", start: 1, end: 4 }, { ...segment, speaker: "Speaker 1", start: 8, end: 10 }];
 expect(reconcileSpeakerNames(previous, final, { "Speaker 1": "Ana" })).toEqual({ "Speaker 2": "Ana" });
});

test("sobreposição ambígua não transfere nome para outro participante", async () => {
 const { reconcileSpeakerNames } = await import("./speakerNames.ts");
 expect(reconcileSpeakerNames([{ ...segment, start: 0, end: 4 }], [
  { ...segment, start: 0, end: 2 }, { ...segment, speaker: "Speaker 2", start: 2, end: 4 },
 ], { "Speaker 1": "Ana" })).toEqual({});
});

test("novo nome automático mantém escolha manual para o mesmo turno", () => {
 const state = useRecordingStore.getState();
 state.upsertLiveTurn({ id: 1, speaker: "Speaker 1", channel: "sys", text: "olá", start: 1, end: 2 });
 state.renameSpeaker("Speaker 1", "Ana");
 state.upsertLiveTurn({ id: 1, speaker: "Nome automático", channel: "sys", text: "olá de novo", start: 1, end: 3 });
 expect(useRecordingStore.getState().speakerNames["Nome automático"]).toBe("Ana");
 expect(useRecordingStore.getState().segments[0]).toMatchObject({ start: 1, end: 3 });
});

test("diarização que funde duas vozes não escolhe arbitrariamente um dos nomes manuais", async () => {
 const { reconcileSpeakerNames } = await import("./speakerNames.ts");
 const previous = [
  { ...segment, speaker: "Speaker 1", start: 0, end: 2 },
  { ...segment, speaker: "Speaker 2", start: 3, end: 5 },
 ];
 const final = [
  { ...segment, speaker: "Speaker 3", start: 0, end: 2 },
  { ...segment, speaker: "Speaker 3", start: 3, end: 5 },
 ];
 expect(reconcileSpeakerNames(previous, final, { "Speaker 1": "Ana", "Speaker 2": "Bruno" })).toEqual({});
});
