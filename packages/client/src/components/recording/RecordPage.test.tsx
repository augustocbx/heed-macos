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

	it("defaults the language selector to the browser language", () => {
		render(<RecordPage />);
		const select = document.querySelector("select") as HTMLSelectElement;
		expect(select).toBeInTheDocument();
		expect(select.value).toBe(navigator.language.slice(0, 2));
	});

	it("renders exactly 48 visualizer bars total (24 mic + 24 system)", () => {
		const { container } = render(<RecordPage />);
		const bars = container.querySelectorAll(".bar");
		expect(bars.length).toBe(48);
	});
});
