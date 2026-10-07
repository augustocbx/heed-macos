import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RecordPage } from "./RecordPage.tsx";
import {useRecordingStore} from '@/stores/recording';
import {useLocaleStore} from '@/stores/locale';
import {tr} from '@/lib/i18n';

const controls=vi.hoisted(()=>({start:vi.fn(),stop:vi.fn(),recordFinalOnly:vi.fn(),liveStartError:null as string|null,starting:false}));

// Mock the recording hook so we don't try to start MediaRecorder, AudioContext, etc.
vi.mock("@/hooks/useRecording.ts", () => ({
	useRecording: () => controls,
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
        useLocaleStore.getState().sync('en');useRecordingStore.getState().reset();controls.liveStartError=null;vi.clearAllMocks();
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

	it("explains configured preview and automatic final language", () => {
		render(<RecordPage />);
		expect(screen.getByText(/Live speech language is configured in Settings/)).toBeInTheDocument();
		expect(document.querySelector("select")).toBeNull();
	});

	it("renders exactly 48 visualizer bars total (24 mic + 24 system)", () => {
		const { container } = render(<RecordPage />);
		const bars = container.querySelectorAll(".bar");
		expect(bars.length).toBe(48);
	});

 it('offers only the explicit final-only action after admission refuses the live model',()=>{
  controls.liveStartError='live-language-unsupported';render(<RecordPage/>);
  expect(controls.recordFinalOnly).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'Record final-only (keeps real-time off)'}));
  expect(controls.recordFinalOnly).toHaveBeenCalledOnce();
  expect(screen.getByText('Recording final-only turns real-time transcription off for future recordings. Turn it back on in Settings.')).toBeVisible();
 });
 it.each(['en','pt-BR','fr','de'] as const)('shows provisional PT with actual runtime model and initial model in %s',locale=>{
  useLocaleStore.getState().sync(locale);
  useRecordingStore.setState({recording:true,realTimeTranscription:true,liveSpeechLanguage:'pt',liveModel:'tiny',liveOptions:{engine:'mlx',initialModel:'base'} as never});
  render(<RecordPage/>);
  expect(screen.getByRole('status')).toHaveTextContent(tr('Provisional live text: {language} • {engine} / {model}',locale,{language:tr('Brazilian Portuguese'),engine:'mlx',model:'tiny'}));
  expect(screen.getByRole('status')).toHaveTextContent(tr('Initial model: {model}',locale,{model:'base'}));
 });
});

it('explains final-only capture without offering a live preview', async()=>{
 useLocaleStore.getState().sync('en');controls.liveStartError=null;
 const {useRecordingStore}=await import('@/stores/recording');
 useRecordingStore.setState({recording:true,realTimeTranscription:false,segments:[],transcript:''});
 render(<RecordPage/>);
 expect(screen.getByText('Live text is disabled. Audio is being recorded; the transcript and speakers will be prepared after stopping.')).toBeVisible();
 expect(screen.queryByText(/Live speech language is configured in Settings/)).toBeNull();
 useRecordingStore.getState().reset();
});
