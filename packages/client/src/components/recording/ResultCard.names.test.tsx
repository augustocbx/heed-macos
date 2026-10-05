import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { ResultCard } from "./ResultCard.tsx";
import { useRecordingStore } from "@/stores/recording.ts";
import { useTemplatesStore } from "@/stores/templates.ts";
import { useModelsStore } from "@/stores/models.ts";
vi.mock("@/components/speakers/SpeakerView.tsx", () => ({ SpeakerView: ({ speakerNames, onRename }: {
 speakerNames: Record<string, string>; onRename: (original: string, name: string) => void;
}) => <div><span data-testid="nome">{speakerNames["Speaker 1"] || "Speaker 1"}</span>
 <button onClick={() => onRename("Speaker 1", "Ana")}>Definir nome</button></div> }));
beforeEach(() => {
 useRecordingStore.getState().reset();
 useTemplatesStore.setState({ load: vi.fn() });
 useModelsStore.setState({ load: vi.fn() });
});

test("nome editado na tela não volta ao padrão quando chega outro trecho ao vivo", () => {
 useRecordingStore.getState().upsertLiveTurn({ id: 1, speaker: "Speaker 1", text: "olá", channel: "sys", start: 1, end: 2 });
 render(<ResultCard />);
 fireEvent.click(screen.getByText("Definir nome"));
 expect(screen.getByTestId("nome")).toHaveTextContent("Ana");
 act(() => useRecordingStore.getState().upsertLiveTurn({ id: 1, speaker: "Speaker 1", text: "olá novamente", channel: "sys", start: 1, end: 3 }));
 expect(screen.getByTestId("nome")).toHaveTextContent("Ana");
});
