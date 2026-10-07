import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RecordPage } from "./RecordPage.tsx";

// Mock the recording hook so we don't try to start MediaRecorder, AudioContext, etc.
vi.mock("@/hooks/useRecording.ts", () => ({
	useRecording: () => ({
		start: vi.fn(),
		stop: vi.fn(),
	}),
}));

// Mock templates store
vi.mock("@/stores/templates.ts", () => ({
	useTemplatesStore: () => ({ templates: [], load: vi.fn() }),
}));

describe("RecordPage", () => {
	beforeEach(() => {
		// Reset zustand recording store
		// @ts-ignore
		window.localStorage.clear();
	});

	it("renders both Microphone and System visualizers side by side", () => {
		render(<RecordPage />);
		expect(screen.getByText("Microphone")).toBeInTheDocument();
		expect(screen.getByText("System")).toBeInTheDocument();
	});

	it("renders the timer at 00:00 by default", () => {
		render(<RecordPage />);
		expect(screen.getByText("00:00")).toBeInTheDocument();
	});

	it("renders the record button", () => {
		render(<RecordPage />);
		expect(screen.getByLabelText(/start recording/i)).toBeInTheDocument();
	});

	it("explains the English preview and automatic final language", () => {
		render(<RecordPage />);
		expect(screen.getByText(/Live preview starts in English/)).toBeInTheDocument();
		expect(document.querySelector("select")).toBeNull();
	});

	it("renders exactly 48 visualizer bars total (24 mic + 24 system)", () => {
		const { container } = render(<RecordPage />);
		const bars = container.querySelectorAll(".bar");
		expect(bars.length).toBe(48);
	});
});

it('explains final-only capture without offering a live preview', async()=>{
 const {useRecordingStore}=await import('@/stores/recording');
 useRecordingStore.setState({recording:true,realTimeTranscription:false,segments:[],transcript:''});
 render(<RecordPage/>);
 expect(screen.getByText('Live text is disabled. Audio is being recorded; the transcript and speakers will be prepared after stopping.')).toBeVisible();
 expect(screen.queryByText(/Live preview starts in English/)).toBeNull();
 useRecordingStore.getState().reset();
});
