// Browser regression check using synthetic responses only. No running Heed API is contacted.
import { chromium } from "playwright";
import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import assert from "node:assert/strict";

const base = process.env.HEED_HEADER_QA_URL || "http://127.0.0.1:5175";
const output = process.env.HEED_HEADER_QA_OUTPUT || "/tmp/heed-header-qa";
const before = process.env.HEED_HEADER_QA_PHASE === "before";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext();
let page = await context.newPage();
page.setDefaultTimeout(5000);
let locale = "en", name = "Gemma 4 E4B", healthy = true, loading = false, noModel = false;
const mutations = [];
const readOnlyPosts = new Set(["/api/desktop/control/poll", "/api/library-chat/context"]);
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const model = (id, modelName) => ({ id, name: modelName, vendor: "Fixture", size_mb: 1000,
	vram_mb: 2000, quality: "good", speed: "fast", new: true, gpu_compatible: true,
	recommended_runtime: "gpu", installed: true });
let selectedModel = "gemma";
const catalog = () => ({ gpu_available: true, gpu_name: "Apple GPU", total_vram_mb: 16000,
	free_vram_mb: 12000, pyannote_reserve_mb: 0, safety_margin_mb: 1000, tier: "mid",
	default_model: "gemma", current: noModel ? {} : { id: selectedModel, num_gpu: 0 },
	models: [model("gemma", name), model("qwen", "Qwen fixture")] });
const health = () => ({ ollama: healthy, whisper: healthy, pyannote: healthy,
	whisper_info: { final_model: "parakeet-tdt-v3", live_model: "small", device: "cpu",
		quality: "excellent", speed: "fast", reason: "Synthetic native engine fixture." },
	pyannote_info: { model: "FluidAudio", device: "cpu", profile: "balanced", batch_size: 8,
		reason: "Synthetic diarization fixture." },
	languages: { engine: "parakeet", codes: ["en", "pt"], supports_auto: false } });
const setup = { os: "macos", ollama: { installed: true, running: true },
	ffmpeg: { installed: true, path: "/fixture/ffmpeg" },
	model: { default_id: "gemma", installed: true }, all_ready: true };
async function routeApi(route) {
	const request = route.request();
	const path = new URL(request.url()).pathname;
	if (request.method() !== "GET" && !readOnlyPosts.has(path)) mutations.push({ path, body: request.postData() });
	if (path === "/api/models/select") selectedModel = JSON.parse(request.postData()).id;
	if (path === "/api/setup/start-ollama") healthy = true;
	const responses = {
		"/api/health": health(), "/api/models": catalog(), "/api/setup/check": setup,
		"/api/ui-locale": { locale }, "/api/sessions": [], "/api/speakers": [],
		"/api/tasks": { tasks: [], candidates: [], revision: "fixture" },
		"/api/recording/status": { state: "idle", revision: 0, meetingId: null, segments: [], speakerNames: {} },
		"/api/desktop/permissions": { controllerConnected: true, updatedAt: Date.now(), pending: false,
			error: null, permissions: { microphone: "authorized", screenCapture: true, slackLogs: true, slackAutoRecord: false } },
		"/api/desktop/float": { ok: true }, "/api/models/select": { ok: true, model: "qwen" },
		"/api/setup/start-ollama": { running: true },
	};
	if (path === "/api/health" && loading) {
		await route.abort(); // Keep the neutral initial state in the dedicated header harness below.
		return;
	}
	await route.fulfill({ status: Object.hasOwn(responses, path) ? 200 : 503,
		contentType: "application/json", body: JSON.stringify(responses[path] || { error: "Synthetic QA: unavailable" }) });
}
await page.route(url => url.pathname.startsWith("/api/"), routeApi);
await page.addInitScript(() => {
	localStorage.setItem("heed-tour-done", "1");
	localStorage.setItem("heed-locale", "en");
});

// Mount the real header and App layout without recording/setup effects for the exhaustive matrix.
// The full app is checked separately for real page navigation below.
const headerDocument = route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type;
window.__vite_plugin_react_preamble_installed__ = true;
import '/src/styles/globals.css';
window.headerQAReady = true;
</script></head><body></body></html>` });
await page.route(url => url.searchParams.has("header-qa"), headerDocument);
async function mountHeader() {
	selectedModel = "gemma";
	await page.goto(`${base}/?header-qa=1`);
	await page.waitForFunction(() => window.headerQAReady);
	await page.evaluate(async ({ locale, loading }) => {
		const { createElement } = (await import("/node_modules/.vite/deps/react.js")).default;
		const { createRoot } = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
		const { Nav } = await import("/src/components/layout/Nav.tsx");
		const { useLocaleStore } = await import("/src/stores/locale.ts");
		const { useHealthStore } = await import("/src/stores/health.ts");
		const { useUIStore } = await import("/src/stores/ui.ts");
		const { default: styles } = await import("/src/App.module.css");
		useLocaleStore.getState().sync(locale);
		useUIStore.setState({ currentPage: "tasks" });
		if (loading) useHealthStore.setState({ check: () => new Promise(() => {}) });
		// Mount synthetic main content beside the real header; no meeting data is read.

		const root = document.createElement("div");
		root.style.cssText = "min-height:100vh;display:flex;flex-direction:column";
		document.body.append(root);
		createRoot(root).render(createElement("div", null, createElement(Nav),
			createElement("main", { className: styles.main }, createElement("h1", null, "Tasks"),
				createElement("p", null, "Synthetic header QA — no meeting data."))));
	}, { locale, loading });
	await page.waitForTimeout(100);
}

try {
	if (before) {
		for (const [label, width] of [["desktop", 1280], ["narrow", 390]]) {
			await page.setViewportSize({ width, height: 900 });
			await mountHeader();
			await page.screenshot({ path: `${output}/before-${label}.png` });
		}
		console.log("Captured synthetic before screenshots.");
	} else {

		const labels = {
			en: ["Record", "Meetings", "Tasks", "Meeting chat", "Settings"],
			"pt-BR": ["Gravar", "Reuniões", "Tarefas", "Conversa sobre a reunião", "Configurações"],
			fr: ["Enregistrer", "Réunions", "Tâches", "Discussion sur la réunion", "Paramètres"],
			de: ["Aufnehmen", "Besprechungen", "Aufgaben", "Besprechungschat", "Einstellungen"],
		};
		const rows = [];
		const zoomRows = [];
		async function fit() {
			const metrics = await page.evaluate(() => {
				const header = document.querySelector("header");
				const main = document.querySelector("main");
				const dialogs = [...document.querySelectorAll("dialog[open]")];
				const overflow = [header, ...dialogs, ...header.querySelectorAll("button")].filter(el => {
					const r = el.getBoundingClientRect();
					return r.width > 0 && (r.left < -1 || r.right > innerWidth + 1 || el.scrollWidth > el.clientWidth + 1);
				}).map(el => ({ text: el.textContent.trim(), clientWidth: el.clientWidth, scrollWidth: el.scrollWidth, rect: el.getBoundingClientRect().toJSON() }));
				return { width: innerWidth, overflow, documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
					obscured: main.getBoundingClientRect().top < header.getBoundingClientRect().bottom - 1 };
			});
			assert.equal(metrics.documentOverflow, false, JSON.stringify(metrics));
			assert.equal(metrics.obscured, false, JSON.stringify(metrics));
			assert.deepEqual(metrics.overflow, [], JSON.stringify(metrics));
			return metrics.width;
		}
		if (!process.env.HEED_HEADER_QA_TEXT_ONLY) {
		for (locale of Object.keys(labels)) {
			for (const state of ["healthy", "error", "loading"]) {
				healthy = state !== "error"; loading = state === "loading";
				await mountHeader();
				for (const modelState of ["normal", "long", "none"]) {
					name = modelState === "long" ? "VeryLongUnbrokenModelIdentifier".repeat(8) : "Gemma 4 E4B";
					noModel = modelState === "none";
					await page.evaluate(async data => {
						const { useModelsStore } = await import("/src/stores/models.ts");
						useModelsStore.setState({ data, loading: false, error: null });
					}, catalog());
					for (const width of [320, 390, 640, 768, 1024, 1280, 1440, 1920]) {
						await page.setViewportSize({ width, height: 900 });
						await page.waitForTimeout(20);
						await fit();
						const menu = page.locator("header button[aria-controls='heed-pages']");
						if (await menu.isVisible()) await menu.click();
						for (const label of labels[locale]) assert(await page.getByRole("button", { name: label, exact: true }).isVisible(), `${locale}: ${label}`);
						await fit();
						if (await menu.isVisible()) {
							await page.keyboard.press("Escape");
							assert.equal(await menu.getAttribute("aria-expanded"), "false");
							assert(await menu.evaluate(el => el === document.activeElement));
						}
						const system = page.locator("header button[aria-haspopup='dialog']");
						await system.focus(); await page.keyboard.press("Enter");
						await fit();
						assert(await page.locator("dialog[open]").isVisible());
						if (!noModel) assert((await page.locator("dialog[open]").textContent()).includes(name));
						await page.keyboard.press("Escape");
						assert.equal(await page.locator("dialog[open]").count(), 0);
						assert(await system.evaluate(el => el === document.activeElement), "System focus must return");
						rows.push({ locale, state, modelState, width });
					}
				}
			}
		}
		assert.deepEqual(mutations, [], "Layout/menu checks must never send mutation requests");
		assert.deepEqual(errors, [], "Header harness must not throw runtime errors");
		await writeFile(`${output}/matrix.json`, JSON.stringify(rows, null, 2));
		console.log(`Passed ${rows.length} header layout combinations.`);
		// Full application: keyboard navigation, actual settings access and representative screenshots.
		locale = "en"; healthy = true; loading = false; noModel = false; name = "Gemma 4 E4B";
		for (const [label, width] of [["desktop", 1280], ["narrow", 390]]) {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(base);
			await page.waitForSelector("header");
			for (const destination of labels.en) {
				const menu = page.locator("header button[aria-controls='heed-pages']");
				if (await menu.isVisible()) await menu.click();
				const button = page.getByRole("button", { name: destination, exact: true });
				await button.focus(); await page.keyboard.press("Enter");
				assert.equal(await page.locator("header button[aria-current=page]").textContent(), destination);
				await fit();
			}
			assert(await page.getByText("Permissions on this Mac", { exact: true }).isVisible());
			const tasksMenu = page.locator("header button[aria-controls='heed-pages']");
			if (await tasksMenu.isVisible()) await tasksMenu.click();
			await page.getByRole("button", { name: "Tasks", exact: true }).click();
			await fit();
			await page.screenshot({ path: `${output}/after-${label}.png` });
			if (label === "narrow") {
				await tasksMenu.click();
				await page.screenshot({ path: `${output}/after-narrow-menu.png` });
				await page.keyboard.press("Escape");
			}
		}
		console.log("Passed keyboard navigation to all five full-app pages and Settings at desktop/narrow widths.");
		// Native modal behavior: focus containment and return through nested picker/QuickFix.
		await mountHeader();
		const system = page.locator("header button[aria-haspopup='dialog']");
		await system.click();
		const change = page.getByRole("button", { name: "Change model", exact: true });
		await change.click();
		await fit();
		assert.equal(await page.locator("dialog[open]").count(), 2);
		for (let i = 0; i < 12; i++) {
			await page.keyboard.press("Tab");
			assert(await page.getByRole("dialog", { name: "Pick your AI model" }).evaluate(el => (el.contains(document.activeElement) || document.activeElement === document.body)), "Picker does not focus an inert background control");
		}
		await page.keyboard.press("Escape");
		assert(await change.evaluate(el => el === document.activeElement), "Picker focus return");
		await change.click();
		await page.getByRole("button", { name: "Use model: Qwen fixture", exact: true }).focus();
		await page.keyboard.press("Enter");
		await page.waitForFunction(() => document.querySelectorAll("dialog[open]").length === 1);
		assert.deepEqual(mutations.map(x => x.path), ["/api/models/select"]);
		assert.deepEqual(JSON.parse(mutations[0].body), { id: "qwen" });
		assert((await page.getByRole("dialog", { name: "System details" }).textContent()).includes("Qwen fixture"), "Selected model appears in System details");
		await page.getByRole("button", { name: "Open floating panel" }).click();
		assert.deepEqual(mutations.map(x => x.path), ["/api/models/select", "/api/desktop/float"]);
		await page.keyboard.press("Escape");
		healthy = false;
		await mountHeader();
		await system.click();
		await page.screenshot({ path: `${output}/after-system-error.png` });
		for (const title of ["AI notes engine", "Transcription engine", "Speaker diarization"]) {
			const trigger = page.getByRole("button", { name: `Troubleshoot: ${title}`, exact: true });
			await trigger.focus(); await page.keyboard.press("Enter");
			await fit();
			assert(await page.getByRole("dialog", { name: title, exact: true }).isVisible());
			await page.keyboard.press("Tab");
			assert(await page.getByRole("dialog", { name: title, exact: true }).evaluate(el => el.contains(document.activeElement)));
			await page.keyboard.press("Escape");
			assert(await trigger.evaluate(el => el === document.activeElement), "QuickFix focus return");
		}
		await page.getByRole("button", { name: "Troubleshoot: AI notes engine", exact: true }).click();
		await page.getByRole("button", { name: "Start Ollama", exact: true }).click();
		await page.waitForFunction(() => document.querySelectorAll("dialog[open]").length === 1);
		await page.keyboard.press("Escape");
		assert.deepEqual(mutations.map(x => x.path), ["/api/models/select", "/api/desktop/float", "/api/setup/start-ollama"]);
		await writeFile(`${output}/explicit-actions.json`, JSON.stringify(mutations, null, 2));
		console.log("Passed native dialog keyboard/focus behavior, explicit model selection, Float and all QuickFix targets.");
		// Actual Chrome host zoom in disposable profiles. Verify CSS viewport and DPR, not CSS transform/pinch zoom.
		healthy = true;
		for (const zoom of [1.25, 1.5, 2]) {
			const profile = await mkdtemp("/tmp/heed-header-zoom-");
			await mkdir(`${profile}/Default`);
			await writeFile(`${profile}/Default/Preferences`, JSON.stringify({ partition: { per_host_zoom_levels: {
				x: { [new URL(base).hostname]: { zoom_level: Math.log(zoom) / Math.log(1.2), last_modified: "0" } },
			} } }));
			const zoomContext = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: true, viewport: { width: 1280, height: 900 } });
			try {
				page = await zoomContext.newPage();
				await page.route(url => url.pathname.startsWith("/api/"), routeApi);
				await page.route(url => url.searchParams.has("header-qa"), headerDocument);
				for (locale of Object.keys(labels)) {
					await mountHeader();
					for (const physicalWidth of [640, 1280]) {
						await page.setViewportSize({ width: physicalWidth, height: 900 });
						const metrics = await page.evaluate(() => ({ width: innerWidth, dpr: devicePixelRatio }));
						assert(Math.abs(metrics.width - physicalWidth / zoom) < 2, "Actual CSS zoom width");
						assert.equal(metrics.dpr, zoom, "Actual browser zoom DPR");
						await fit();
						const menu = page.locator("header button[aria-controls='heed-pages']");
						if (await menu.isVisible()) await menu.click();
						for (const label of labels[locale]) assert(await page.getByRole("button", { name: label, exact: true }).isVisible());
						await fit();
						if (await menu.isVisible()) await page.keyboard.press("Escape");
						await page.locator("header button[aria-haspopup='dialog']").click();
						await fit(); await page.keyboard.press("Escape");
						zoomRows.push({ locale, zoom, physicalWidth, ...metrics });
					}
				}
			} finally { await zoomContext.close(); await rm(profile, { recursive: true }); }
		}
		}
		page = await context.newPage();
		await page.route(url => url.pathname.startsWith("/api/"), routeApi);
		await page.route(url => url.searchParams.has("header-qa"), headerDocument);
		for (locale of Object.keys(labels)) {
			await mountHeader();
			await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
			for (const width of [320, 390, 640, 768, 1024, 1280]) {
				await page.setViewportSize({ width, height: 900 });
				await fit();
				const menu = page.locator("header button[aria-controls='heed-pages']");
				if (await menu.isVisible()) await menu.click();
				await fit();
				if (await menu.isVisible()) await page.keyboard.press("Escape");
				await page.locator("header button[aria-haspopup='dialog']").click();
				await fit(); await page.keyboard.press("Escape");
			}
		}
		console.log("Passed 24 additional layout checks with 200% root text size.");
		if (!process.env.HEED_HEADER_QA_TEXT_ONLY) await writeFile(`${output}/zoom.json`, JSON.stringify(zoomRows, null, 2));
		if (zoomRows.length) console.log(`Passed ${zoomRows.length} actual Chrome zoom checks at 125%, 150% and 200%.`);
		assert.deepEqual(errors, [], "No browser runtime errors");

	}
} finally {
	await browser.close();
}
