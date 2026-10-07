import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelsResponse, SetupCheckResult } from "@heed/shared";
import { healthApi } from "@/api/health";
import { modelsApi } from "@/api/models";
import { setupApi } from "@/api/setup";
import { desktopApi } from "@/api/desktop";
import { useModelsStore } from "@/stores/models";
import { useUIStore } from "@/stores/ui";
import { useLocaleStore } from "@/stores/locale";
import { Nav } from "./Nav";

vi.mock("@/api/health", () => ({ healthApi: { check: vi.fn(), diagnostics: vi.fn() } }));
vi.mock("@/api/models", () => ({ modelsApi: { list: vi.fn(), select: vi.fn(), pullStream: vi.fn() } }));
vi.mock("@/api/setup", () => ({ setupApi: { check: vi.fn(), startOllama: vi.fn(), installOllama: vi.fn() } }));
vi.mock("@/api/desktop", () => ({ desktopApi: { float: vi.fn() } }));

const catalog: ModelsResponse = {
	gpu_available: true, gpu_name: "Apple GPU", total_vram_mb: 16000, free_vram_mb: 12000,
	pyannote_reserve_mb: 0, safety_margin_mb: 1000, tier: "mid", default_model: "gemma",
	current: { id: "gemma", num_gpu: 0 },
	models: ["gemma", "qwen"].map((id) => ({
		id, name: id === "gemma" ? "A very long model name with its complete version and quantization" : "Qwen",
		vendor: "Fixture", size_mb: 1000, vram_mb: 2000, quality: "good", speed: "fast",
		new: true, gpu_compatible: true, recommended_runtime: "gpu", installed: true,
	})),
};
const setup: SetupCheckResult = {
	os: "macos", ollama: { installed: true, running: true }, ffmpeg: { installed: true, path: "/fixture/ffmpeg" },
	model: { default_id: "gemma", installed: true }, all_ready: true,
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("VITE_HEED_VERSION", "0.8.2");
	vi.stubEnv("DEV", false);
	useLocaleStore.getState().sync("en");
	useUIStore.setState({ currentPage: "record" });
	useModelsStore.setState({ data: null, pickerOpen: false, error: null, loading: false });
	vi.mocked(healthApi.diagnostics).mockResolvedValue([
		{ service: "api", port: 48100, state: "ready" },
		{ service: "ui", port: 48101, state: "ready" },
		{ service: "transcription", port: 48102, state: "ready" },
	]);
	vi.mocked(healthApi.check).mockResolvedValue({ ollama: true, whisper: true, pyannote: true });
	vi.mocked(modelsApi.list).mockResolvedValue(catalog);
	vi.mocked(modelsApi.select).mockResolvedValue({ ok: true, model: "qwen" });
	vi.mocked(setupApi.check).mockResolvedValue(setup);
	vi.mocked(desktopApi.float).mockResolvedValue({ ok: true });
});

afterEach(() => vi.unstubAllEnvs());

describe("header navigation", () => {
	it("keeps the build version visible across pages even when services are offline", async () => {
		vi.mocked(healthApi.check).mockRejectedValue(new Error("Offline"));
		await act(async () => { render(<Nav />); });
		const header = screen.getByRole("banner");
		expect(within(header).getByRole("note", { name: "Installed version: 0.8.2" })).toHaveTextContent("v0.8.2");
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: "Settings" }));
		expect(within(header).getByText("v0.8.2")).toBeVisible();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it.each([
		["en", "Development build"], ["pt-BR", "Versão de desenvolvimento"],
		["fr", "Version de développement"], ["de", "Entwicklungsversion"],
	] as const)("identifies development builds in %s", async (locale, label) => {
		vi.stubEnv("DEV", true);
		useLocaleStore.getState().sync(locale);
		await act(async () => { render(<Nav />); });
		expect(within(screen.getByRole("banner")).getByText(`v0.8.2 · ${label}`)).toBeVisible();
		expect(within(screen.getByRole("banner")).getByRole("note")).toHaveAccessibleName(expect.stringContaining(label));
	});

	it.each([undefined, "", "latest"])("does not invent a version when build metadata is %s", async (version) => {
		vi.stubEnv("VITE_HEED_VERSION", version);
		await act(async () => { render(<Nav />); });
		expect(within(screen.getByRole("banner")).getByText("Version unavailable")).toBeVisible();
	});

	it.each([
		["en", ["Record", "Meetings", "Tasks", "Meeting chat", "Settings"]],
		["pt-BR", ["Gravar", "Reuniões", "Tarefas", "Conversa sobre a reunião", "Configurações"]],
		["fr", ["Enregistrer", "Réunions", "Tâches", "Discussion sur la réunion", "Paramètres"]],
		["de", ["Aufnehmen", "Besprechungen", "Aufgaben", "Besprechungschat", "Einstellungen"]],
	] as const)("exposes every destination and current page in %s", async (locale, labels) => {
		useLocaleStore.getState().sync(locale);
		render(<Nav />);
		const user = userEvent.setup();
		for (const label of labels) {
			const button = screen.getByRole("button", { name: label });
			button.focus();
			await user.keyboard("{Enter}");
			expect(button).toHaveAttribute("aria-current", "page");
		}
		expect(useUIStore.getState().currentPage).toBe("settings");
		expect(modelsApi.select).not.toHaveBeenCalled();
		expect(modelsApi.pullStream).not.toHaveBeenCalled();
	});

	it("closes the page disclosure with Escape and returns focus to its trigger", async () => {
		render(<Nav />);
		const user = userEvent.setup();
		const trigger = screen.getByRole("button", { name: /Pages/ });
		await user.click(trigger);
		expect(trigger).toHaveAttribute("aria-expanded", "true");
		screen.getByRole("button", { name: "Settings" }).focus();
		await user.keyboard("{Escape}");
		expect(trigger).toHaveAttribute("aria-expanded", "false");
		expect(trigger).toHaveFocus();
	});

	it("shows loading before health resolves and makes a full model name and Float available in details", async () => {
		let resolveHealth!: (value: { ollama: boolean; whisper: boolean; pyannote: boolean }) => void;
		vi.mocked(healthApi.check).mockReturnValue(new Promise((resolve) => { resolveHealth = resolve; }));
		render(<Nav />);
		expect(screen.getByRole("button", { name: /System.*Checking/ })).toBeInTheDocument();
		await act(async () => resolveHealth({ ollama: true, whisper: true, pyannote: true }));
		const user = userEvent.setup();
		await user.click(screen.getByRole("button", { name: /System.*Ready/ }));
		const details = screen.getByRole("dialog", { name: "System details" });
		expect(within(details).getByText(catalog.models[0].name)).toBeInTheDocument();
		await user.click(within(details).getByRole("button", { name: "Open floating panel" }));
		expect(desktopApi.float).toHaveBeenCalledOnce();
		expect(modelsApi.select).not.toHaveBeenCalled();
	});

	it.each([
		["ollama", "AI notes engine", "Start Ollama"],
		["whisper", "Transcription engine", "npx create-heed fallback"],
		["pyannote", "Speaker diarization", "npx create-heed doctor"],
	])("keeps %s failures and their existing QuickFix reachable by keyboard", async (key, title, action) => {
		vi.mocked(healthApi.check).mockResolvedValue({ ollama: true, whisper: true, pyannote: true, [key]: false });
		render(<Nav />);
		const user = userEvent.setup();
		await user.click(await screen.findByRole("button", { name: /System.*Needs attention/ }));
		const details = screen.getByRole("dialog", { name: "System details" });
		expect(within(details).getByText("Unavailable")).toBeInTheDocument();
		const fix = within(details).getByRole("button", { name: `Troubleshoot: ${title}` });
		fix.focus();
		await user.keyboard("{Enter}");
		const quickFix = screen.getByRole("dialog", { name: title });
		expect(within(quickFix).getByText(action)).toBeInTheDocument();
		expect(setupApi.startOllama).not.toHaveBeenCalled();
		expect(setupApi.installOllama).not.toHaveBeenCalled();
	});

	it("allows keyboard selection of an installed model only after explicit activation", async () => {
		render(<Nav />);
		const user = userEvent.setup();
		await user.click(await screen.findByRole("button", { name: /System.*Ready/ }));
		await user.click(screen.getByRole("button", { name: "Change model" }));
		const picker = screen.getByRole("dialog", { name: "Pick your AI model" });
		expect(modelsApi.select).not.toHaveBeenCalled();
		const select = within(picker).getByRole("button", { name: "Use model: Qwen" });
		select.focus();
		await user.keyboard("{Enter}");
		await waitFor(() => expect(modelsApi.select).toHaveBeenCalledWith("qwen"));
		expect(await screen.findByRole("dialog", { name: "System details" })).toBeInTheDocument();
	});

	it("shows Float failures inside the open system dialog", async () => {
		vi.mocked(desktopApi.float).mockRejectedValue(new Error("Offline"));
		render(<Nav />);
		const user = userEvent.setup();
		await user.click(await screen.findByRole("button", { name: /System.*Ready/ }));
		const details = screen.getByRole("dialog", { name: "System details" });
		await user.click(within(details).getByRole("button", { name: "Open floating panel" }));
		expect(await within(details).findByRole("alert")).toHaveTextContent("Could not open floating panel");
	});

	it("shows model switch failures inside the picker", async () => {
		vi.mocked(modelsApi.select).mockRejectedValue(new Error("Model is unavailable"));
		render(<Nav />);
		const user = userEvent.setup();
		await user.click(await screen.findByRole("button", { name: /System.*Ready/ }));
		await user.click(screen.getByRole("button", { name: "Change model" }));
		const picker = screen.getByRole("dialog", { name: "Pick your AI model" });
		await user.click(within(picker).getByRole("button", { name: "Use model: Qwen" }));
		expect(await within(picker).findByRole("alert")).toHaveTextContent("Model is unavailable");
	});

	it("keeps catalog failures and an explicit retry in the active picker", async () => {
		vi.mocked(modelsApi.list).mockRejectedValue(new Error("Catalog is offline"));
		render(<Nav />);
		const user = userEvent.setup();
		await user.click(await screen.findByRole("button", { name: /System.*Needs attention/ }));
		await user.click(screen.getByRole("button", { name: "Change model" }));
		const picker = screen.getByRole("dialog", { name: "Pick your AI model" });
		expect(await within(picker).findByRole("alert")).toHaveTextContent("Catalog is offline");
		expect(within(picker).queryByText("Loading catalog...")).toBeNull();
		vi.mocked(modelsApi.list).mockResolvedValue(catalog);
		await user.click(within(picker).getByRole("button", { name: "Retry loading" }));
		expect(await within(picker).findByRole("button", { name: "Use model: Qwen" })).toBeInTheDocument();
		expect(modelsApi.select).not.toHaveBeenCalled();
	});

	it("shows a failed repair inside QuickFix without closing its action", async () => {
		vi.mocked(healthApi.check).mockResolvedValue({ ollama: false, whisper: true, pyannote: true });
		vi.mocked(setupApi.startOllama).mockResolvedValue({ running: false, error: "Start failed" });
		render(<Nav />);
		const user = userEvent.setup();
		await user.click(await screen.findByRole("button", { name: /System.*Needs attention/ }));
		await user.click(screen.getByRole("button", { name: "Troubleshoot: AI notes engine" }));
		const fix = screen.getByRole("dialog", { name: "AI notes engine" });
		await user.click(within(fix).getByRole("button", { name: "Start Ollama" }));
		expect(await within(fix).findByRole("alert")).toHaveTextContent("Start failed");
		expect(within(fix).getByRole("button", { name: "Start Ollama" })).toBeEnabled();
	});
});
