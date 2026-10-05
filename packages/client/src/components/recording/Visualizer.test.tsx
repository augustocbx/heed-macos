import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { useRef } from "react";
import { Visualizer } from "./Visualizer.tsx";

function TestHarness() {
	const micBars = useRef<HTMLDivElement[]>([]);
	const systemBars = useRef<HTMLDivElement[]>([]);
	return (
		<div>
			<Visualizer ref={micBars} barCount={24} variant="mic" label="Microphone" />
			<Visualizer ref={systemBars} barCount={24} variant="system" label="System" />
		</div>
	);
}

describe("Visualizer", () => {
	it("renders the correct number of bars per instance", () => {
		const ref = { current: [] as HTMLDivElement[] };
		const { container } = render(
			<Visualizer ref={ref} barCount={24} variant="mic" label="Mic" />,
		);
		const bars = container.querySelectorAll(".bar");
		expect(bars.length).toBe(24);
	});

	it("renders the label", () => {
		const ref = { current: [] as HTMLDivElement[] };
		render(<Visualizer ref={ref} barCount={8} variant="mic" label="Microphone" />);
		expect(screen.getByText("Microphone")).toBeInTheDocument();
	});

	it("renders TWO independent visualizers when used in parallel (mic + system)", () => {
		render(<TestHarness />);
		expect(screen.getByText("Microphone")).toBeInTheDocument();
		expect(screen.getByText("System")).toBeInTheDocument();
	});

	it("each visualizer has its own bars (no ref collision)", () => {
		const { container } = render(<TestHarness />);
		const groups = container.querySelectorAll(".group");
		expect(groups.length).toBe(2);
		// Each group should have 24 bars
		groups.forEach((group) => {
			const bars = group.querySelectorAll(".bar");
			expect(bars.length).toBe(24);
		});
	});

	it("system variant uses the system bar styling", () => {
		const ref = { current: [] as HTMLDivElement[] };
		const { container } = render(
			<Visualizer ref={ref} barCount={4} variant="system" label="System" />,
		);
		const bars = container.querySelectorAll(".barSystem");
		expect(bars.length).toBe(4);
	});
});
