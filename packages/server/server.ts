import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { homedir, cpus } from "node:os";
import { downloadFromUrl, normalizeAudio } from "./lib/media.ts";
import { APP_DIR, CONFIG_PATH, SESSIONS_DIR, TEMPLATES_DIR, type TrxConfig, ensureAppDirs, loadConfig, saveConfig, micLabel } from "./lib/app-config.ts";
import { TRANSCRIPTION_SERVER, pyPost as postJSON } from "./lib/transcription-client.ts";
import { track, gracefulStop, installShutdownHooks } from "./lib/process.ts";
import { sseResponse } from "./lib/sse.ts";
import { sessionAudioResponse } from "./lib/session-audio.ts";
import { DesktopControl } from "./lib/desktop-control.ts";
import { AUDIO_LIMIT_BYTES, enforceAudioRetention, removeChannelCopies } from "./lib/audio-retention.ts";
const desktopControl = new DesktopControl();
const retainedProcessing = new Map<string, number>();
const CAPTURE_LIMIT_BYTES = Math.floor(AUDIO_LIMIT_BYTES / 2) - 10_000_000;
let quotaReachedAt = 0;
let quotaStopResult: any = null;
function protectAudio(path: string) { retainedProcessing.set(path, Date.now() + 120_000); }
function pruneAudio(limit = AUDIO_LIMIT_BYTES) {
 for (const [path, until] of retainedProcessing) if (until < Date.now()) retainedProcessing.delete(path);
 const protectedPaths = [...retainedProcessing.keys()];
 if (recorderPath) protectedPaths.push(recorderPath);
 return enforceAudioRetention(UPLOAD_DIR, SESSIONS_DIR, limit, protectedPaths);
}

const PORT = Number(process.env.PORT) || 5001;

// Code → language name used to instruct Ollama to write the NOTES in the user's chosen
// language. Covers the 28 Parakeet languages + common Whisper ones; an unmapped code just
// falls back to the template's "match the transcript" (no hard-fail).
const LANGUAGE_NAMES: Record<string, string> = {
	en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian",
	pt: "Portuguese", ro: "Romanian", nl: "Dutch", da: "Danish", sv: "Swedish",
	fi: "Finnish", hu: "Hungarian", et: "Estonian", lv: "Latvian", lt: "Lithuanian",
	mt: "Maltese", pl: "Polish", cs: "Czech", sk: "Slovak", sl: "Slovenian",
	hr: "Croatian", bs: "Bosnian", ru: "Russian", uk: "Ukrainian", be: "Belarusian",
	bg: "Bulgarian", sr: "Serbian", el: "Greek", ja: "Japanese", ko: "Korean",
	zh: "Chinese", ar: "Arabic", hi: "Hindi", tr: "Turkish", vi: "Vietnamese",
	id: "Indonesian", th: "Thai", he: "Hebrew", ca: "Catalan", gl: "Galician",
};
const STATIC_ROOT = join(import.meta.dir, "..", "client", "dist");
// Recordings stored in the project root
const UPLOAD_DIR = join(import.meta.dir, "..", "..", "recordings");
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
// Hard fallback only — actual model is read from ~/.heed-app/config.json (set by hardware
// auto-detection on first launch, or by the user via the model picker modal).
// Opt-in override ONLY (for power users / tests). No silent hardcoded default — the user
// must pick the notes model explicitly (see getCurrentModel + the model picker).
const FALLBACK_MODEL = process.env.HEED_MODEL || null;

// App paths + persistent config (loadConfig/saveConfig/micLabel/TrxConfig) now live in
// ./lib/app-config.ts — single source of truth (the stale lib/config.ts duplicate was deleted).
ensureAppDirs([UPLOAD_DIR]);

function getCurrentModel(): string | null {
	// The model the USER explicitly selected, or null if none chosen yet. We deliberately
	// do NOT fall back to a tiny default — notes generation prompts the user to pick a model
	// (setup wizard or in-app picker) instead of silently installing/using a conservative one.
	return loadConfig().ollama_model || FALLBACK_MODEL;
}

function getCurrentNumGpu(): number | undefined {
	return loadConfig().ollama_num_gpu;
}

// NOTE: there is intentionally NO silent auto-seed of the notes model. The user chooses it
// explicitly — via the setup wizard or the in-app model picker. The hardware probe
// (/hardware → handleListModels) only RECOMMENDS a best-fit model in the picker UI; it
// never writes config on its own. This is a deliberate product rule: never install/use a
// conservative model behind the user's back.

// --- Seed default templates on first run ---
const DEFAULT_TEMPLATES = [
	{
		id: "general",
		name: "General Meeting",
		description: "Universal meeting notes — works for any meeting",
		isDefault: true,
		prompt: `You are a meeting notes assistant. Generate structured meeting notes in this exact format:

## Summary
(2-3 sentences capturing the main topic)

## Key Points
- main discussion points

## Action Items
- [ ] task → owner

## Decisions Made
- decisions reached

Be concrete. Use the speakers' actual words when possible. Match the language of the transcript.`,
	},
	{
		id: "1on1",
		name: "1-on-1 Meeting",
		description: "Notes for one-on-one meetings between two people",
		isDefault: true,
		prompt: `You are a 1-on-1 meeting notes assistant. Generate structured notes in this exact format:

## Topics discussed
- main topics

## Updates / Status
- what each person reported

## Blockers
- challenges or blockers mentioned

## Action Items
- [ ] task → owner

## Follow-up for next 1-on-1
- items to revisit

Match the language of the transcript.`,
	},
	{
		id: "standup",
		name: "Daily Standup",
		description: "Notes for team daily standups",
		isDefault: true,
		prompt: `You are a standup notes assistant. Generate notes per person in this format:

## Team Updates

### [Person Name]
- **Yesterday:** what they did
- **Today:** what they will do
- **Blockers:** any blockers (or "none")

## Team Blockers
- shared blockers needing attention

## Action Items
- [ ] task → owner

Match the language of the transcript.`,
	},
	{
		id: "interview",
		name: "Interview",
		description: "Notes for candidate or research interviews",
		isDefault: true,
		prompt: `You are an interview notes assistant. Generate structured notes in this format:

## Candidate / Interviewee
(name and brief context if mentioned)

## Key Questions & Answers
**Q:** question
**A:** answer summary

(repeat for each significant Q&A)

## Strengths Observed
- positive points

## Concerns
- red flags or gaps

## Recommendation
(brief assessment)

Match the language of the transcript.`,
	},
	{
		id: "brainstorm",
		name: "Brainstorm",
		description: "Notes for ideation and brainstorm sessions",
		isDefault: true,
		prompt: `You are a brainstorm notes assistant. Generate notes in this format:

## Goal / Question
(what was being brainstormed)

## Ideas Generated
- group ideas by theme when possible

## Top Ideas
- the strongest ideas to pursue

## Open Questions
- questions left unanswered

## Next Steps
- [ ] what to do with these ideas

Match the language of the transcript.`,
	},
	{
		id: "customer",
		name: "Customer Call",
		description: "Notes for customer or sales calls",
		isDefault: true,
		prompt: `You are a customer call notes assistant. Generate notes in this format:

## Customer Info
(company, role if mentioned)

## Pain Points
- problems they raised

## Needs / Requirements
- what they're looking for

## Objections
- concerns or pushback

## Action Items
- [ ] follow-up task → owner

## Next Steps
(what was agreed for next interaction)

Match the language of the transcript.`,
	},
];

function seedTemplates() {
	for (const t of DEFAULT_TEMPLATES) {
		const filePath = join(TEMPLATES_DIR, `${t.id}.json`);
		if (!existsSync(filePath)) {
			writeFileSync(filePath, JSON.stringify(t, null, 2));
		}
	}
}
seedTemplates();

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".json": "application/json",
};

function serveStatic(path: string): Response | null {
	// Try the requested file
	let filePath = join(STATIC_ROOT, path === "/" ? "index.html" : path);

	// SPA fallback: any non-API, non-file path → index.html
	if (!existsSync(filePath) && !path.startsWith("/api") && !extname(path)) {
		filePath = join(STATIC_ROOT, "index.html");
	}

	if (!existsSync(filePath)) return null;

	const ext = extname(filePath);
	const isHtml = ext === ".html";

	return new Response(readFileSync(filePath), {
		headers: {
			"Content-Type": MIME[ext] || "application/octet-stream",
			// Disable caching of HTML so the user always gets the latest bundle reference
			"Cache-Control": isHtml ? "no-store, max-age=0" : "public, max-age=3600",
		},
	});
}

// --- Transcription (SSE) ---
async function handleTranscribe(req: Request): Promise<Response> {
	let input: string;
	let language = "auto";
	let diarize = true;
	let inputFilePath: string | null = null;

	const contentType = req.headers.get("content-type") || "";

	if (contentType.includes("multipart/form-data")) {
		const formData = await req.formData();
		const file = formData.get("file") as File | null;
		const url = formData.get("url") as string | null;
		language = (formData.get("language") as string) || "auto";
		diarize = formData.get("diarize") !== "false";

		if (file && file.size > 0) {
			const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
			inputFilePath = join(UPLOAD_DIR, `${Date.now()}-${safeName}`);
			const buffer = await file.arrayBuffer();
			writeFileSync(inputFilePath, Buffer.from(buffer));
			input = inputFilePath;
		} else if (url) {
			input = url;
		} else {
			return Response.json({ error: "No file or URL provided" }, { status: 400 });
		}
	} else {
		const body = await req.json();
		input = body.url || body.input;
		language = body.language || "auto";
		diarize = body.diarize || false;
		if (!input) return Response.json({ error: "No input provided" }, { status: 400 });
	}

	// For URLs, first download with yt-dlp then clean audio with ffmpeg
	let wavPath = input;
	const isUrl = /^https?:\/\//i.test(input);

	retainedProcessing.set(wavPath, Infinity);
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			let closed = false;
			const send = (event: string, data: unknown) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
				} catch {
					closed = true;
				}
			};
			try {
				// If URL, download with yt-dlp first
				if (isUrl) {
					send("step", { message: "Downloading media..." });
					const downloaded = await downloadFromUrl(input, UPLOAD_DIR);
					input = downloaded.filePath;
				}

				// Normalize audio (clean noise, mono 16kHz)
				send("step", { message: "Cleaning audio..." });
				if (!input.endsWith(".wav")) {
					wavPath = join(UPLOAD_DIR, `clean-${Date.now()}.wav`);
					await normalizeAudio(input, wavPath);
				} else {
					wavPath = input;
				}

				send("step", { message: "Processing audio..." });

    retainedProcessing.set(wavPath, Infinity);
    if(existsSync(wavPath))pruneAudio(Math.max(0,AUDIO_LIMIT_BYTES-statSync(wavPath).size-10_000_000));
				// Detect dual-channel captures (L=mic, R=system)
				const isDualChannel = /(?:^|\/)dual-capture-/.test(wavPath);

				// Use the STREAMING endpoint: Python emits segments one by one via SSE.
				// We forward each event to the frontend so text appears progressively.
				const streamRes = await fetch(`${TRANSCRIPTION_SERVER}/process-stream`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						wav_path: wavPath,
						language,
						diarize,
						dual_channel: isDualChannel,
					}),
				});

				if (!streamRes.ok || !streamRes.body) {
					const err = await streamRes.text();
					throw new Error(`Transcription server error: ${err}`);
				}

				// Parse SSE from Python and forward to frontend
				const reader = streamRes.body.getReader();
				const dec = new TextDecoder();
				let buf = "";
				let finalText = "";
				let finalFiles: Record<string, string> = { wav: wavPath, srt: "", txt: "" };
				let finalSpeakers: string[] = [];
				let finalSegments: unknown[] = [];
				let finalEmbeddings: Record<string, unknown> = {};
				let finalLanguage = language;
				let finalWhisperModel = "small";

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buf += dec.decode(value, { stream: true });
					const lines = buf.split("\n");
					buf = lines.pop() || "";
					let currentEvent = "";
					for (const line of lines) {
						if (line.startsWith("event: ")) {
							currentEvent = line.slice(7).trim();
						} else if (line.startsWith("data: ")) {
							try {
								const data = JSON.parse(line.slice(6));
								// Forward progressive events to frontend
								switch (currentEvent) {
									case "segment":
										send("segment", data);
										break;
									case "phase":
										send("step", { message: data.phase === "identifying_speakers" ? "Identifying speakers..." : `Transcribing ${data.channel || ""}...` });
										break;
									case "speakers":
										finalSpeakers = data.speakers || [];
										finalSegments = data.segments || [];
										finalEmbeddings = data.embeddings || {};
										send("speakers", data);
										break;
									case "done":
										finalText = data.text || "";
										finalLanguage = data.language || language;
										finalWhisperModel = data.model || finalWhisperModel;
										finalFiles = data.files || { wav: wavPath, srt: data.srt_path || "", txt: data.txt_path || "" };
										break;
									case "complete":
										send("result", {
											success: true,
											text: finalText,
											files: finalFiles,
											metadata: { language: finalLanguage, model: finalWhisperModel },
											speakers: finalSpeakers,
											segments: finalSegments,
											embeddings: finalEmbeddings,
											wordCount: finalText.split(/\s+/).filter(Boolean).length,
											timing: data,
										});
										break;
									case "error":
										send("error", data);
										break;
								}
							} catch {}
						}
					}
				}
			} catch (e) {
				send("error", { message: (e as Error).message });
			} finally {
    removeChannelCopies(wavPath); protectAudio(wavPath);
				controller.close();
			}
		},
	});

	return new Response(stream, {
		headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
	});
}

// --- Templates CRUD ---
function loadTemplate(id: string): any | null {
	const filePath = join(TEMPLATES_DIR, `${id}.json`);
	if (!existsSync(filePath)) return null;
	try {
		return JSON.parse(readFileSync(filePath, "utf-8"));
	} catch {
		return null;
	}
}

function handleListTemplates(): Response {
	const files = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".json"));
	const templates = files
		.map((f) => {
			try {
				return JSON.parse(readFileSync(join(TEMPLATES_DIR, f), "utf-8"));
			} catch {
				return null;
			}
		})
		.filter(Boolean)
		.sort((a: any, b: any) => {
			// Defaults first, then alpha
			if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
			return (a.name || "").localeCompare(b.name || "");
		});
	return Response.json(templates);
}

async function handleSaveTemplate(req: Request): Promise<Response> {
	const tpl = await req.json();
	if (!tpl.name || !tpl.prompt) {
		return Response.json({ error: "Template needs name and prompt" }, { status: 400 });
	}
	const id = tpl.id || `custom-${Date.now()}`;
	const data = { id, name: tpl.name, description: tpl.description || "", prompt: tpl.prompt, isDefault: false };
	writeFileSync(join(TEMPLATES_DIR, `${id}.json`), JSON.stringify(data, null, 2));
	return Response.json(data);
}

function handleDeleteTemplate(url: URL): Response {
	const id = url.searchParams.get("id");
	if (!id) return Response.json({ error: "No id" }, { status: 400 });
	const filePath = join(TEMPLATES_DIR, `${id}.json`);
	if (existsSync(filePath)) {
		const tpl = JSON.parse(readFileSync(filePath, "utf-8"));
		if (tpl.isDefault) {
			return Response.json({ error: "Cannot delete default template" }, { status: 400 });
		}
		unlinkSync(filePath);
	}
	return Response.json({ ok: true });
}

// --- Ollama summarization (SSE) ---
async function handleSummarize(req: Request): Promise<Response> {
	const { transcript, language, templateId, force_cpu } = await req.json();
	if (!transcript) return Response.json({ error: "No transcript provided" }, { status: 400 });

	// Gate: the user must have explicitly chosen a notes model. If none is selected we
	// signal the client to open the model picker — we never silently pick/install one.
	const model = getCurrentModel();
	if (!model) {
		return Response.json(
			{ needsModelSelection: true, error: "No notes model selected yet. Pick one to generate notes." },
			{ status: 409 },
		);
	}

	// Load template (default to "general" if not specified)
	const template = loadTemplate(templateId || "general") || loadTemplate("general");

	let systemPrompt = template?.prompt;

	// Add language directive: force the NOTES into the language the user picked for the
	// transcript (not just Spanish). "auto" (Whisper auto-detect) is left to the template's
	// "match the language of the transcript", since we don't know it until transcription runs.
	const langName = language && language !== "auto" ? LANGUAGE_NAMES[language] : undefined;
	if (langName) {
		systemPrompt = `Respond ONLY in ${langName}. Write every section and heading in ${langName}.\n\n${systemPrompt}`;
	}

	if (!systemPrompt) {
		systemPrompt = `You are a meeting notes assistant. Generate structured notes with sections: Summary, Key Points, Action Items, Decisions.`;
	}

	// force_cpu comes from the UI when the user explicitly acknowledged the warning
	// and chose "Generate on CPU". Otherwise we use the config value.
	const numGpu = force_cpu ? 0 : (getCurrentNumGpu() ?? undefined);
	// When running on CPU, limit threads to half the available cores so the OS,
	// Chrome, and the rest of the system don't freeze. Without this, Ollama
	// saturates ALL cores and the desktop becomes unresponsive for 30-60 seconds.
	const cpuCores = cpus().length || 4;
	const cpuThreadLimit = Math.max(2, Math.floor(cpuCores / 2));
	const ollamaOptions: Record<string, number> = {};
	if (numGpu !== undefined) ollamaOptions.num_gpu = numGpu;
	if (numGpu === 0) ollamaOptions.num_thread = cpuThreadLimit;
	// Retry logic: if Ollama's runner crashed (OOM, VRAM contention, etc.),
	// wait a beat and retry once. This recovers silently — the user never sees
	// a raw 500 error for a transient Ollama failure.
	const ollamaBody = JSON.stringify({
		model: getCurrentModel(),
		stream: true,
		keep_alive: 0,
		...(Object.keys(ollamaOptions).length > 0 ? { options: ollamaOptions } : {}),
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: `Generate meeting notes from this transcript:\n\n${transcript}` },
		],
	});

	let res = await fetch(`${OLLAMA_HOST}/api/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: ollamaBody,
	});

	// Retry once on failure (runner crash, OOM, etc.)
	if (!res.ok) {
		const errBody = await res.text();
		console.log(`[heed] Ollama failed (${res.status}), retrying in 3s... ${errBody.slice(0, 80)}`);
		await new Promise(r => setTimeout(r, 3000));
		res = await fetch(`${OLLAMA_HOST}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: ollamaBody,
		});
	}

	if (!res.ok) {
		const errText = await res.text();
		return Response.json({ error: `Ollama error: ${errText}` }, { status: 500 });
	}

	// Stream Ollama response as SSE
	const encoder = new TextEncoder();
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();

	const stream = new ReadableStream({
		async start(controller) {
			let buffer = "";
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const json = JSON.parse(line);
						if (json.message?.content) {
							controller.enqueue(encoder.encode(`data: ${JSON.stringify({ token: json.message.content })}\n\n`));
						}
						if (json.done) {
							controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true })}\n\n`));
						}
					} catch {}
				}
			}
			controller.close();
		},
	});

	return new Response(stream, {
		headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
	});
}

// --- Speaker voice memory (proxy to Python server) ---
async function handleSaveVoice(req: Request): Promise<Response> {
	const body = await req.json();
	try {
		const res = await fetch(`${TRANSCRIPTION_SERVER}/voices/save`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		return Response.json(await res.json());
	} catch (e) {
		return Response.json({ error: (e as Error).message }, { status: 500 });
	}
}

async function handleDeleteVoice(req: Request): Promise<Response> {
	const body = await req.json();
	try {
		const res = await fetch(`${TRANSCRIPTION_SERVER}/voices/delete`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		return Response.json(await res.json());
	} catch (e) {
		return Response.json({ error: (e as Error).message }, { status: 500 });
	}
}

async function handleListVoices(): Promise<Response> {
	try {
		const res = await fetch(`${TRANSCRIPTION_SERVER}/voices`);
		return Response.json(await res.json());
	} catch (e) {
		return Response.json({ voices: [] });
	}
}

// The user's own (mic) channel label. Renaming "Me" stores a name here (a fixed label, not a
// voiceprint — the mic is never diarized), so it persists as the default across sessions.
function handleGetUserName(): Response {
	return Response.json({ name: micLabel() });
}

async function handleSetUserName(req: Request): Promise<Response> {
	const body = await req.json() as { name?: string };
	const name = (body.name || "").trim();
	saveConfig({ user_name: name }); // empty string → falls back to "Me"
	return Response.json({ ok: true, name: name || "Me" });
}

// --- Models API: hardware-aware catalog + selection + streaming download ---
interface OllamaTag { name: string; size: number }

async function getInstalledOllamaModels(): Promise<Set<string>> {
	try {
		const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) });
		if (!res.ok) return new Set();
		const data = await res.json() as { models?: OllamaTag[] };
		return new Set((data.models || []).map((m) => m.name));
	} catch {
		return new Set();
	}
}

async function handleListModels(): Promise<Response> {
	try {
		const [hwRes, installed] = await Promise.all([
			fetch(`${TRANSCRIPTION_SERVER}/hardware`),
			getInstalledOllamaModels(),
		]);
		if (!hwRes.ok) return Response.json({ error: "Hardware probe failed" }, { status: 500 });
		const hw = await hwRes.json() as { models?: Array<{ id: string }>; [k: string]: unknown };
		const cfg = loadConfig();
		const models = (hw.models || []).map((m) => ({
			...m,
			installed: installed.has(m.id),
		}));
		return Response.json({
			...hw,
			models,
			current: {
				id: cfg.ollama_model,
				num_gpu: cfg.ollama_num_gpu,
			},
		});
	} catch (e) {
		return Response.json({ error: (e as Error).message }, { status: 500 });
	}
}

async function handleSelectModel(req: Request): Promise<Response> {
	const body = await req.json() as { id?: string; num_gpu?: number };
	if (!body.id) return Response.json({ error: "No model id" }, { status: 400 });

	// Validate the model exists in our catalog and is appropriate for this hardware.
	let hw: { models?: Array<{ id: string; gpu_compatible: boolean; vram_mb: number }>; free_vram_mb?: number };
	try {
		const r = await fetch(`${TRANSCRIPTION_SERVER}/hardware`);
		hw = await r.json();
	} catch (e) {
		return Response.json({ error: "Hardware probe failed" }, { status: 500 });
	}
	const model = hw.models?.find((m) => m.id === body.id);
	if (!model) return Response.json({ error: `Unknown model: ${body.id}` }, { status: 400 });

	// Force CPU mode if user picked a model that won't fit in GPU, even if they didn't specify.
	let numGpu = body.num_gpu;
	if (numGpu === undefined) {
		numGpu = model.gpu_compatible ? undefined : 0;
	}

	saveConfig({ ollama_model: body.id, ollama_num_gpu: numGpu });
	console.log(`[heed] Model switched: ${body.id} (gpu=${numGpu === 0 ? "off" : numGpu === undefined ? "auto" : numGpu})`);
	return Response.json({ ok: true, model: body.id, num_gpu: numGpu });
}

// SSE stream of `ollama pull <id>` progress.
function handleModelPull(url: URL): Response {
	const id = url.searchParams.get("id");
	if (!id) return new Response("Missing id", { status: 400 });

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			let closed = false;
			const send = (data: unknown) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
				} catch {
					closed = true;
				}
			};

			try {
				const res = await fetch(`${OLLAMA_HOST}/api/pull`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: id, stream: true }),
				});
				if (!res.ok || !res.body) {
					send({ error: `Ollama pull failed: ${res.status}` });
					controller.close();
					return;
				}
				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buf = "";
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });
					const lines = buf.split("\n");
					buf = lines.pop() || "";
					for (const line of lines) {
						if (!line.trim()) continue;
						try {
							const evt = JSON.parse(line);
							send(evt);
						} catch {}
					}
				}
				send({ done: true });
			} catch (e) {
				send({ error: (e as Error).message });
			} finally {
				controller.close();
			}
		},
	});
	return new Response(stream, {
		headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
	});
}

// --- Speaker diarization via transcription server ---
// --- First-launch setup wizard ------------------------------------------------
//
// The wizard exists so a non-technical user (e.g. a Mac-using teammate watching
// a Discord launch) can go from "I downloaded heed" to "I'm transcribing my
// first meeting" without ever opening a terminal.
//
// Three things must be present before heed can do its job:
//   1. Ollama running on :11434          (LLM backend for AI Notes)
//   2. ffmpeg in PATH                     (audio capture and conversion)
//   3. The hardware-default LLM pulled    (the model picker default)
//
// All three are detected here. The frontend reads /api/setup/check and decides
// whether to show the wizard. The install endpoints stream stdout via SSE so
// the user sees progress in real time.

type DetectedOS = "linux-debian" | "linux-fedora" | "linux-arch" | "linux-other" | "macos" | "windows" | "unknown";

function detectOS(): DetectedOS {
	if (process.platform === "darwin") return "macos";
	if (process.platform === "win32") return "windows";
	if (process.platform !== "linux") return "unknown";
	try {
		const osRelease = readFileSync("/etc/os-release", "utf-8");
		const idLine = osRelease.split("\n").find((l) => l.startsWith("ID="));
		const idLikeLine = osRelease.split("\n").find((l) => l.startsWith("ID_LIKE="));
		const id = (idLine?.split("=")[1] || "").replace(/"/g, "").toLowerCase();
		const idLike = (idLikeLine?.split("=")[1] || "").replace(/"/g, "").toLowerCase();
		const all = `${id} ${idLike}`;
		if (/debian|ubuntu|mint|pop/.test(all)) return "linux-debian";
		if (/fedora|rhel|centos|rocky|alma/.test(all)) return "linux-fedora";
		if (/arch|manjaro|endeavour|garuda/.test(all)) return "linux-arch";
		return "linux-other";
	} catch {
		return "linux-other";
	}
}

function which(cmd: string): string | null {
	try {
		const r = Bun.spawnSync(["which", cmd]);
		const out = new TextDecoder().decode(r.stdout).trim();
		return out || null;
	} catch {
		return null;
	}
}

async function isOllamaRunning(): Promise<boolean> {
	try {
		const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(2000) });
		return res.ok;
	} catch {
		return false;
	}
}

interface SetupCheckResult {
	os: DetectedOS;
	ollama: { installed: boolean; running: boolean };
	ffmpeg: { installed: boolean; path: string | null };
	model: { default_id: string | null; installed: boolean };
	all_ready: boolean;
}

async function handleSetupCheck(): Promise<Response> {
	const os = detectOS();

	const ollamaPath = which("ollama");
	const ollamaRunning = await isOllamaRunning();

	const ffmpegPath = which("ffmpeg");

	// Default model from current config (auto-seeded by hardware on first launch)
	let defaultModelId: string | null = loadConfig().ollama_model || null;
	if (!defaultModelId) {
		// Config not seeded yet — ask Python directly
		try {
			const r = await fetch(`${TRANSCRIPTION_SERVER}/hardware`, { signal: AbortSignal.timeout(5000) });
			if (r.ok) {
				const hw = await r.json() as { default_model?: string };
				defaultModelId = hw.default_model || null;
			}
		} catch {}
	}

	// Is the default model already pulled to ollama?
	let modelInstalled = false;
	if (defaultModelId && ollamaRunning) {
		try {
			const tags = await getInstalledOllamaModels();
			modelInstalled = tags.has(defaultModelId);
		} catch {}
	}

	const result: SetupCheckResult = {
		os,
		ollama: { installed: !!ollamaPath, running: ollamaRunning },
		ffmpeg: { installed: !!ffmpegPath, path: ffmpegPath },
		model: { default_id: defaultModelId, installed: modelInstalled },
		all_ready: !!ollamaPath && ollamaRunning && !!ffmpegPath && modelInstalled,
	};
	return Response.json(result);
}

// SSE wrapper that spawns a shell command and streams stdout+stderr line by line.
// Used by /api/setup/install-ollama and /api/setup/install-ffmpeg.
function spawnSSEStream(command: string[], shellPipe = false): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			let closed = false;
			const send = (data: unknown) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
				} catch {
					closed = true;
				}
			};

			try {
				// shellPipe=true wraps the command in `bash -c "..."` so pipes work.
				// Used for `curl ... | sh` style installers.
				const finalCmd = shellPipe ? ["bash", "-c", command.join(" ")] : command;
				send({ status: "started", cmd: command.join(" ") });

				const proc = Bun.spawn(finalCmd, {
					stdout: "pipe",
					stderr: "pipe",
				});

				// Pipe both stdout and stderr line by line
				const pumpStream = async (stream: ReadableStream<Uint8Array>, source: "stdout" | "stderr") => {
					const reader = stream.getReader();
					const dec = new TextDecoder();
					let buf = "";
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						buf += dec.decode(value, { stream: true });
						const lines = buf.split("\n");
						buf = lines.pop() || "";
						for (const line of lines) {
							if (line.trim()) send({ source, line });
						}
					}
					if (buf.trim()) send({ source, line: buf });
				};

				await Promise.all([
					pumpStream(proc.stdout as ReadableStream<Uint8Array>, "stdout"),
					pumpStream(proc.stderr as ReadableStream<Uint8Array>, "stderr"),
				]);

				const code = await proc.exited;
				send({ status: "done", code });
			} catch (e) {
				send({ status: "error", error: (e as Error).message });
			} finally {
				controller.close();
			}
		},
	});
	return new Response(stream, {
		headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
	});
}

function handleInstallOllama(): Response {
	// Official installer: same script the Ollama docs recommend.
	// Works on macOS (writes to /usr/local/bin) and Linux (asks for sudo password
	// mid-execution if needed — that part will fail silently in the wizard, in
	// which case we fall back to the copy-the-command path).
	return spawnSSEStream(["curl", "-fsSL", "https://ollama.com/install.sh", "|", "sh"], true);
}

function handleInstallFfmpeg(): Response {
	const os = detectOS();
	let cmd: string[];
	switch (os) {
		case "linux-debian":
			cmd = ["sudo", "apt-get", "install", "-y", "ffmpeg"];
			break;
		case "linux-fedora":
			cmd = ["sudo", "dnf", "install", "-y", "ffmpeg"];
			break;
		case "linux-arch":
			cmd = ["sudo", "pacman", "-S", "--noconfirm", "ffmpeg"];
			break;
		case "macos":
			cmd = ["brew", "install", "ffmpeg"];
			break;
		default:
			return Response.json(
				{ error: `Auto-install of ffmpeg is not supported on ${os}. Install ffmpeg manually.` },
				{ status: 400 },
			);
	}
	return spawnSSEStream(cmd);
}

// Start a locally-installed Ollama that isn't running yet (the common "installed but not up" case).
// Spawns `ollama serve` in the background and polls until the API answers, so the header badge can
// go green without the user touching a terminal. No-op (fast success) if it's already up.
async function handleStartOllama(): Promise<Response> {
	if (await isOllamaRunning()) {
		return Response.json({ running: true, alreadyRunning: true });
	}
	if (!which("ollama")) {
		return Response.json({ running: false, error: "Ollama is not installed" }, { status: 400 });
	}
	try {
		// Detached: outlives this request and keeps serving (same pattern as desktop/main.py).
		Bun.spawn(["ollama", "serve"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
	} catch (e) {
		return Response.json({ running: false, error: (e as Error).message }, { status: 500 });
	}
	// Poll up to ~6s for the API to come up.
	for (let i = 0; i < 12; i++) {
		await new Promise((r) => setTimeout(r, 500));
		if (await isOllamaRunning()) return Response.json({ running: true });
	}
	return Response.json({ running: false, error: "Ollama did not start in time" }, { status: 504 });
}

// Launch the floating desktop panel (Chrome/Chromium --app window that floats over Zoom/Meet).
// Works on macOS and Linux — desktop/main.py finds chrome/chromium and, on Linux, uses wmctrl to
// pin it always-on-top. Detached like handleStartOllama so it outlives this request.
async function handleDesktopFloat(): Promise<Response> {
	const python = which("python3") || which("python");
	if (!python) {
		return Response.json({ ok: false, error: "python3 is not installed" }, { status: 400 });
	}
	const script = join(import.meta.dir, "..", "desktop", "main.py");
	if (!existsSync(script)) {
		return Response.json({ ok: false, error: "desktop panel script not found" }, { status: 500 });
	}
	// --prod: the button only exists in the built app, which serves on the prod port.
	try {
		Bun.spawn([python, script, "--prod"], {
			cwd: join(import.meta.dir, "..", ".."),
			stdout: "ignore",
			stderr: "ignore",
			stdin: "ignore",
		});
	} catch (e) {
		return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
	}
	return Response.json({ ok: true });
}

// --- Sessions CRUD ---
function handleListSessions(): Response {
	const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
	const sessions = files
		.map((f) => {
			try {
				return JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf-8"));
			} catch {
				return null;
			}
		})
		.filter(Boolean)
		.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
	return Response.json(sessions);
}

async function handleCreateSession(req: Request): Promise<Response> {
	const session = await req.json();
	const id = session.id || `session-${Date.now()}`;
	const data = {
		...session,
		id,
		createdAt: session.createdAt || new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	writeFileSync(join(SESSIONS_DIR, `${id}.json`), JSON.stringify(data, null, 2));
 if (data.files?.wav) { retainedProcessing.delete(data.files.wav); removeChannelCopies(data.files.wav); }
 pruneAudio();
 return Response.json(JSON.parse(readFileSync(join(SESSIONS_DIR, `${id}.json`), "utf8")));
}

async function handlePatchSession(req: Request, url: URL): Promise<Response> {
	const id = url.searchParams.get("id");
	if (!id) return Response.json({ error: "No id" }, { status: 400 });
	const filePath = join(SESSIONS_DIR, `${id}.json`);
	if (!existsSync(filePath)) return Response.json({ error: "Not found" }, { status: 404 });

	const existing = JSON.parse(readFileSync(filePath, "utf-8"));
	const patch = await req.json();
	const merged = { ...existing, ...patch, updatedAt: new Date().toISOString() };
	writeFileSync(filePath, JSON.stringify(merged, null, 2));
	return Response.json(merged);
}

function handleDeleteSession(url: URL): Response {
	const id = url.searchParams.get("id");
	if (!id) return Response.json({ error: "No id" }, { status: 400 });
	const filePath = join(SESSIONS_DIR, `${id}.json`);
	if (existsSync(filePath)) unlinkSync(filePath);
	return Response.json({ ok: true });
}

// --- One-line summary via Ollama (for sessions list preview) ---
async function handleSummaryLine(req: Request): Promise<Response> {
	const { transcript } = await req.json();
	if (!transcript || transcript.length < 30) {
		return Response.json({ summary: "" });
	}

	// Auto-title is a nice-to-have — if the user hasn't picked a notes model yet, just
	// skip it silently (the heuristic title is used instead). Never auto-select a model.
	const model = getCurrentModel();
	if (!model) return Response.json({ summary: "" });

	// Truncate transcript to first 1500 chars to keep it fast
	const text = transcript.slice(0, 1500);

	try {
		// Smart titles are tiny (12 words) — always force CPU to avoid fighting
		// pyannote for VRAM and to prevent the GPU-load crash we hit in production.
		const cores = cpus().length || 4;
		const summaryOpts: Record<string, number> = {
			num_gpu: 0,
			num_thread: Math.max(2, Math.floor(cores / 2)),
		};
		const summaryBody = JSON.stringify({
			model: getCurrentModel(),
			stream: false,
			keep_alive: 0,
			...(Object.keys(summaryOpts).length > 0 ? { options: summaryOpts } : {}),
			messages: [
				{
					role: "system",
					content: "You generate ONE single sentence (max 12 words) that captures the main topic of a meeting transcript. Output ONLY the sentence, no quotes, no prefixes, no explanation. Be concrete and specific. IMPORTANT: respond in the SAME language as the transcript — if it's in Spanish, your sentence must be in Spanish. If English, respond in English.",
				},
				{ role: "user", content: text },
			],
		});
		let res = await fetch(`${OLLAMA_HOST}/api/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: summaryBody,
		});
		// Retry once on failure
		if (!res.ok) {
			await new Promise(r => setTimeout(r, 3000));
			res = await fetch(`${OLLAMA_HOST}/api/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: summaryBody,
			});
		}
		if (!res.ok) return Response.json({ summary: "" });
		const data = await res.json() as { message?: { content?: string } };
		const summary = (data.message?.content || "").trim().replace(/^["']|["']$/g, "").split("\n")[0];
		return Response.json({ summary });
	} catch {
		return Response.json({ summary: "" });
	}
}

// --- Audio recording via ffmpeg + PipeWire/PulseAudio ---
// Uses ffmpeg -f pulse which works reliably with PipeWire's PulseAudio layer
let recorderProc: ReturnType<typeof Bun.spawn> | null = null;
let recorderPath: string | null = null;
let recorderStarting = false;
let recorderStartedAt = 0;
let recorderStopping = false;
let recordingLanguage: "pt" | "en" | null = null;
// ScreenCaptureKit system-audio helper (mac). When present + permission granted, it
// replaces BlackHole as the system source — no driver, no output re-routing.
let syscapProc: ReturnType<typeof Bun.spawn> | null = null;

const IS_MAC = process.platform === "darwin";

// Path to the built heed-syscap binary (Apple Silicon, after `swift build`).
function getSyscapBin(): string | null {
	if (!IS_MAC) return null;
	const bin = join(import.meta.dir, "..", "transcription", "native", "heed-parakeet", ".build", "release", "heed-syscap");
	return existsSync(bin) ? bin : null;
}

// Spawn heed-syscap and wait for its one-line stderr handshake.
// Returns { proc, denied }:
//   - proc set     → SCK is capturing (permission granted).
//   - denied=true  → built but the user hasn't granted Screen Recording (TCC -3801). The caller
//                    should NOT start recording; it should ask the user to grant + retry.
//   - both falsy   → not built / not mac → just record mic only.
async function spawnSyscap(): Promise<{ proc: ReturnType<typeof Bun.spawn> | null; denied: boolean }> {
	const bin = getSyscapBin();
	if (!bin) return { proc: null, denied: false };
	try {
		const proc = track(Bun.spawn([bin], { stdout: "pipe", stderr: "pipe" }));
		const handshake = await Promise.race([
			(async () => {
				const reader = (proc.stderr as ReadableStream).getReader();
				const dec = new TextDecoder();
				let buf = "";
				while (!buf.includes("\n")) {
					const { value, done } = await reader.read();
					if (done) break;
					buf += dec.decode(value, { stream: true });
				}
				reader.releaseLock();
				return buf.split("\n")[0];
			})(),
			new Promise<string>((r) => setTimeout(() => r(""), 3000)),
		]);
		let ok = false;
		try { ok = JSON.parse(handshake || "{}").ready === true; } catch {}
		if (ok) {
			console.log("[heed] system audio via ScreenCaptureKit");
			return { proc, denied: false };
		}
		// -3801 / "declined" / "TCC" = the permission hasn't been granted yet.
		const denied = /-3801|declined|TCC/i.test(handshake || "");
		console.log(`[heed] ScreenCaptureKit ${denied ? "permission needed" : "unavailable"} (${(handshake || "no handshake").slice(0, 80)})`);
		try { proc.kill(); } catch {}
		return { proc: null, denied };
	} catch (e) {
		console.log(`[heed] ScreenCaptureKit spawn failed (${(e as Error).message})`);
		return { proc: null, denied: false };
	}
}

function getMonitorSource(): string | null {
	if (IS_MAC) {
		// macOS captures system audio via ScreenCaptureKit (heed-syscap) — no virtual driver.
		// BlackHole support was removed (confusing: needs manual output re-routing and the user
		// hears nothing). If SCK isn't available, system audio is simply unavailable (mic-only).
		return null;
	}
	// Linux: PipeWire/PulseAudio monitor
	try {
		const sinkResult = Bun.spawnSync(["pactl", "get-default-sink"]);
		const defaultSink = new TextDecoder().decode(sinkResult.stdout).trim();
		if (defaultSink) {
			const monitor = `${defaultSink}.monitor`;
			const listResult = Bun.spawnSync(["pactl", "list", "sources", "short"]);
			const output = new TextDecoder().decode(listResult.stdout);
			if (output.includes(monitor)) return monitor;
		}
	} catch {}
	const result = Bun.spawnSync(["pactl", "list", "sources", "short"]);
	const output = new TextDecoder().decode(result.stdout);
	for (const line of output.split("\n")) {
		if (line.includes(".monitor") && !line.includes("SUSPENDED")) return line.split("\t")[1];
	}
	for (const line of output.split("\n")) {
		if (line.includes(".monitor")) return line.split("\t")[1];
	}
	return null;
}

function getMicSource(): string | null {
	if (IS_MAC) {
		// macOS: avfoundation default input device = ":default"
		return ":default";
	}
	// Linux: PipeWire default source
	try {
		const result = Bun.spawnSync(["pactl", "get-default-source"]);
		const defaultSource = new TextDecoder().decode(result.stdout).trim();
		if (defaultSource && !defaultSource.includes(".monitor")) return defaultSource;
	} catch {}
	return "default";
}

// Audio format flag per platform
const AUDIO_FMT = IS_MAC ? "avfoundation" : "pulse";

async function handleSysRecordStart(req: Request): Promise<Response> {
 if (recorderProc || recorderStarting || recorderStopping) return Response.json({error:"Heed is already recording"}, {status:409});
 recorderStarting = true;
 try { return await beginSysRecording(req); } finally { recorderStarting = false; }
}

async function beginSysRecording(req: Request): Promise<Response> {
	let mode = "both";
	try { const body = await req.json(); mode = body.mode || "both"; recordingLanguage = ["pt", "en"].includes(body.language) ? body.language : null; } catch {}

	if (syscapProc) {
		try { syscapProc.kill(); } catch {}
		syscapProc = null;
	}
	// Reset live transcription state for the new recording
	liveTranscribeOffset = 0;
	liveChunkProcessing = false;
	// Pick up the engine-adaptive live cadence (parakeet = fast) before the loop starts.
	await refreshLiveTuning();

	const ts = Date.now();
	quotaReachedAt = 0; quotaStopResult = null;
 pruneAudio();
	recorderStartedAt = ts;
	const mic = getMicSource() || "default";

	// Prefer ScreenCaptureKit for system audio on mac. If the binary is built but Screen
	// Recording hasn't been granted yet, DON'T start a half-recording (mic-only) and let the
	// timer run — return a clear "permission needed" so the UI can ask first and the user
	// retries. This is what makes the record button feel correct: nothing starts until the
	// permission is resolved.
	if (mode === "system" || mode === "both") {
		const r = await spawnSyscap();
		syscapProc = r.proc;
		if (!r.proc && r.denied) {
			// Open the exact Settings pane so granting is one move; recording does NOT start.
			try { Bun.spawn(["open", "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"]); } catch {}
			return Response.json({ permissionNeeded: true, mode }, { status: 200 });
		}
	}
	const usedSyscap = !!syscapProc;
	const monitor = usedSyscap ? null : getMonitorSource();
	// system source exists if SCK is active OR a (Linux) monitor was found.
	const haveSystem = usedSyscap || !!monitor;

	// Naming convention: dual-capture-* signals stereo (L=mic, R=system) → channel-based diarization later.
	const isDual = mode === "both" && haveSystem;
	recorderPath = join(UPLOAD_DIR, `${isDual ? "dual-capture" : "capture"}-${ts}.wav`);

	let args: string[];
	// When SCK feeds the system channel, ffmpeg reads its raw PCM from stdin (pipe:0).
	let stdinStream: ReadableStream | undefined;
	const SCK_IN = ["-f", "s16le", "-ar", "16000", "-ac", "1", "-i", "pipe:0"];

	if (mode === "system") {
		if (usedSyscap) {
			args = ["ffmpeg", "-y", ...SCK_IN, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", recorderPath];
			stdinStream = syscapProc!.stdout as ReadableStream;
		} else {
			if (!monitor) return Response.json({ error: "No system audio monitor found" }, { status: 500 });
			args = ["ffmpeg", "-y", "-f", AUDIO_FMT, "-i", monitor, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", recorderPath];
		}
	} else if (mode === "mic") {
		args = ["ffmpeg", "-y", "-f", AUDIO_FMT, "-i", mic, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", recorderPath];
	} else {
		// both: keep mic and system in SEPARATE physical channels (L=mic, R=system).
		// Downstream we split them and run diarization independently — this is what unlocks
		// real overlap detection when two people speak at the same time.
		const MERGE = ["-filter_complex", "[0:a]aresample=16000,pan=mono|c0=c0[micL];[1:a]aresample=16000,pan=mono|c0=c0[sysR];[micL][sysR]amerge=inputs=2[out]", "-map", "[out]", "-ar", "16000", "-ac", "2", "-c:a", "pcm_s16le"];
		if (usedSyscap) {
			// mic from avfoundation (input 0) + SCK system PCM from stdin (input 1)
			args = ["ffmpeg", "-y", "-f", AUDIO_FMT, "-i", mic, ...SCK_IN, ...MERGE, recorderPath];
			stdinStream = syscapProc!.stdout as ReadableStream;
		} else if (!monitor) {
			// No system source at all → mic only (graceful)
			args = ["ffmpeg", "-y", "-f", AUDIO_FMT, "-i", mic, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", recorderPath];
		} else {
			args = ["ffmpeg", "-y", "-f", AUDIO_FMT, "-i", mic, "-f", AUDIO_FMT, "-i", monitor, ...MERGE, recorderPath];
		}
	}

	// CRITICAL for live transcription: force ffmpeg to flush each packet to disk so the WAV file
	// GROWS continuously. Without this, ffmpeg buffers output in ~256KB (~4s) blocks → the file
	// stays 0 bytes then jumps; the live loop derives "new audio" from the file SIZE, so a
	// non-growing file means it never feeds the streaming model → live never appears until stop.
	// Limite físico de saída; a margem cobre cabeçalho e o último pacote do ffmpeg.
 args.splice(args.length - 1, 0, "-flush_packets", "1", "-fs", String(CAPTURE_LIMIT_BYTES));

	recorderProc = track(Bun.spawn(args, stdinStream ? { stdin: stdinStream, stdout: "pipe", stderr: "pipe" } : { stdout: "pipe", stderr: "pipe" }));

	// Feed the System (green) visualizer. We sample the growing recorder WAV directly instead of
	// spawning a second ffmpeg on the monitor device — this works whether the system channel comes
	// from ScreenCaptureKit (mac default) OR a BlackHole/PipeWire monitor (Linux). Channel layout:
	// dual-capture WAV is stereo (L=mic, R=system) so system is channel 1; system-only WAV is mono.
	if ((mode === "system" || mode === "both") && haveSystem) {
		startLevelMeter(recorderPath, isDual ? 2 : 1, isDual ? 1 : 0);
	}

	return Response.json({ recording: true, mode, path: recorderPath, source: usedSyscap ? "screencapturekit" : (monitor ? "system-monitor" : "mic-only"), monitor: monitor || null, mic });
}

// --- System audio level meter (24-bin RMS of the System channel) ---
// Instead of a second ffmpeg on the monitor device (which doesn't exist under ScreenCaptureKit),
// we periodically sample the TAIL of the growing recorder WAV. The recorder writes with
// -flush_packets 1, so the file grows continuously and the newest ~100ms of PCM is always readable.
// This is source-agnostic: it works for SCK (mac) and BlackHole/PipeWire (Linux) alike.
let levelInterval: ReturnType<typeof setInterval> | null = null;
let sysLevels: number[] = new Array(24).fill(0);

// Find where PCM actually starts (the "data" chunk payload). ffmpeg does NOT always emit a 44-byte
// header — with -flush_packets + encoder metadata it writes extra chunks (measured: PCM at byte 78).
// A hardcoded 44 mis-aligns the interleaved stereo read by half a frame, so the System meter ends up
// reading the MIC channel (green bars track your voice). Parse the real offset from the RIFF chunks.
async function wavDataOffset(file: ReturnType<typeof Bun.file>): Promise<number> {
	const head = new Uint8Array(await file.slice(0, 512).arrayBuffer());
	for (let i = 12; i + 8 <= head.length; i++) {
		if (head[i] === 0x64 && head[i + 1] === 0x61 && head[i + 2] === 0x74 && head[i + 3] === 0x61) {
			return i + 8; // "data" + 4-byte size → PCM starts here
		}
	}
	return 44; // fallback to the canonical header
}

function startLevelMeter(path: string, channels: number, sysChannel: number) {
	const bytesPerFrame = 2 * channels;      // s16le → 2 bytes/sample
	const windowFrames = 1600;               // ~100ms @ 16kHz
	const windowBytes = windowFrames * bytesPerFrame;
	let dataOffset = -1;                      // resolved once the header is on disk

	levelInterval = setInterval(async () => {
		try {
			const file = Bun.file(path);
			const size = file.size;
			if (dataOffset < 0) {
				if (size < 64) return;        // header not fully written yet
				dataOffset = await wavDataOffset(file);
			}
			if (size <= dataOffset + bytesPerFrame) return;
			// Read the newest window, aligned to a real frame boundary (relative to PCM start) so the
			// channel order is correct — otherwise the system meter reads the mic.
			let start = size - windowBytes;
			if (start < dataOffset) start = dataOffset;
			start = dataOffset + Math.floor((start - dataOffset) / bytesPerFrame) * bytesPerFrame;
			const buf = new Uint8Array(await file.slice(start, size).arrayBuffer());
			const view = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
			const nFrames = Math.floor(view.length / channels);
			if (nFrames < 24) return;
			const binSize = Math.floor(nFrames / 24);
			for (let b = 0; b < 24; b++) {
				let sumSq = 0;
				for (let j = 0; j < binSize; j++) {
					const s = view[(b * binSize + j) * channels + sysChannel] || 0;
					sumSq += s * s;
				}
				const rms = Math.sqrt(sumSq / binSize) / 32768;
				sysLevels[b] = Math.round(Math.pow(rms, 0.5) * 255);
			}
		} catch {}
	}, 50);
}

function stopLevelMeter() {
	if (levelInterval) {
		clearInterval(levelInterval);
		levelInterval = null;
	}
	sysLevels = new Array(24).fill(0);
}

function handleSysLevelsSSE(): Response {
	// Adopts the shared SSE helper (lib/sse.ts): one place owns the stream/encoder/headers plumbing
	// and the producer stops cleanly when the client disconnects (sink.closed).
	return sseResponse((sink) => {
		return new Promise<void>((resolve) => {
			const iv = setInterval(() => {
				if (sink.closed) {
					clearInterval(iv);
					resolve();
					return;
				}
				sink.data(sysLevels); // 20fps audio level meter
			}, 50);
		});
	});
}

// --- Live transcription during recording ---
// Every 5 seconds, extracts the latest audio chunk from the growing WAV,
// sends it to faster-whisper, and streams segments to the frontend via SSE.
// The user sees their words appear in real-time while recording.
let liveTranscribeInterval: ReturnType<typeof setInterval> | null = null;
let liveTranscribeOffset = 0; // seconds already processed
let liveChunkProcessing = false; // lock to prevent concurrent whisper calls
// Streaming-mode state (Parakeet): a persistent ASR session in the sidecar; we feed only the
// NEW audio since lastStreamOffset each tick and show the model's append-only partial.
let lastStreamOffset = 0;
let streamStarted = false;
let liveWarmLatched = false; // once the sidecar reports warm, stop polling (server stays warm)
// Live speaker label: the periodic offline-rolling diarization (/diar/live) runs the same engine as
// the post-stop on a rolling window of the sys channel and returns the STABLE, conservatively-named
// speaker talking NOW. Cached here and refreshed ~every DIAR_LIVE_STEP_S. See eval_diar/DIAR_TUNING.md.
let liveSpeakerNow = "Speaker 1";   // display (name or generic) shown for the current sys speaker
let liveSpeakerLabel = "Speaker 1"; // stable session identity — turns are keyed by this so a speaker
                                    // refining from "Speaker 1" to "Learn" updates in place, not split
// Voice-RAG MIC filter: is the current mic audio the OWNER (Junior)? When false, the mic feed is gated
// so external audio the laptop mic picks up (a TV in the room, another person) never enters HIS
// transcript — the case the echo layers can't touch (no system reference for external audio).
let micIsOwner = true;
let micFilterBusy = false;
let lastMicFilterAt = 0;
let recogBusy = false;      // a /diar/live call is in flight (fire-and-forget throttle)
let lastRecogAt = 0;
const DIAR_LIVE_WINDOW_S = 240; // LARGE rolling window (~4min) so the diarizer clusters with near-global
                                // context = post-stop quality (a speaker is ONE cluster, not split). A
                                // 30s window had too little context and split one speaker into many.
const DIAR_LIVE_STEP_S = 2;     // cadence — re-diarize the big window every 2s on the GPU sidecar
                                // (~0.6s/run, no ASR contention). Label settles in ~2-3s; text instant.
const MIC_FILTER_WINDOW_S = 30; // the mic voice-filter only needs the CURRENT voice → small window (cheap)
// Karaoke turn-tracking: split the two append-only partials (mic + sys) into CHRONOLOGICAL turns
// so the live transcript interleaves "Me / Speaker 1 / Me / Speaker 2 …" instead of two blocks.
let liveTurnId = 0;
let liveTurnKey = "";       // "channel|speaker" of the currently-open turn
let micTurnBase = 0;        // char index in the mic partial where the open mic turn starts
let sysTurnBase = 0;        // char index in the sys partial where the open sys turn starts
let lastMicLen = 0;
let lastSysLen = 0;
// The full ordered turn list (server owns it) so the STOP can refine each turn IN PLACE
// (final text + precise diarization speaker) instead of re-transcribing and collapsing the karaoke.
let liveTurns: Array<{ id: number; channel: "mic" | "sys"; speaker: string; base: number; startT: number; endT: number }> = [];

// Engine-adaptive live cadence, fetched from the Python /health on record-start.
// Parakeet (Apple Neural Engine) polls fast with short windows for near-instant words;
// Whisper keeps the safe 3s/2000ms cadence so slow CPUs never starve. Defaults are safe.
let liveTuning = { chunk_s: 3.0, interval_ms: 2000, mode: "chunk" as "chunk" | "full" };
async function refreshLiveTuning() {
	try {
		const r = await fetch(`${TRANSCRIPTION_SERVER}/health`, { signal: AbortSignal.timeout(2000) });
		if (r.ok) {
			const h = await r.json() as { live_tuning?: { chunk_s?: number; interval_ms?: number; mode?: "chunk" | "full" } };
			if (h.live_tuning?.chunk_s && h.live_tuning?.interval_ms) {
				liveTuning = { chunk_s: h.live_tuning.chunk_s, interval_ms: h.live_tuning.interval_ms, mode: h.live_tuning.mode || "chunk" };
				console.log(`[heed] live: mode=${liveTuning.mode} interval=${liveTuning.interval_ms}ms`);
			}
		}
	} catch { /* keep safe defaults */ }
}

// Live "full" mode (Parakeet/MLX): re-transcribe the whole growing audio each tick and emit a
// REPLACE event per channel, so the on-screen text always has full context (accurate) and refines
// as you speak. Bounded to the last LIVE_FULL_WINDOW seconds so very long meetings stay responsive;
// the accurate final pass covers the whole recording regardless.
const LIVE_FULL_WINDOW = 90;
async function processFullLive(
	wavPath: string, isDual: boolean, lang: string,
	send: (event: string, data: unknown) => void,
): Promise<void> {
	if (!existsSync(wavPath)) return;
	const fileSize = Bun.file(wavPath).size;
	const bytesPerSec = isDual ? 64000 : 32000;
	const fileDurationS = (fileSize - 44) / bytesPerSec;
	if (fileDurationS < 1.2) return; // need a little audio before the first pass

	const startTime = Math.max(0, fileDurationS - LIVE_FULL_WINDOW);
	const dur = fileDurationS - startTime;

	// channel filter: mic = c0; (dual also has sys = c1)
	const channels: Array<{ ch: string; filter: string; speaker: string; label: "mic" | "sys" }> = [
		{ ch: "mic", filter: isDual ? "pan=mono|c0=c0," : "", speaker: micLabel(), label: "mic" },
	];
	if (isDual) channels.push({ ch: "sys", filter: "pan=mono|c0=c1,", speaker: "???", label: "sys" });

	for (const c of channels) {
		const outPath = join(UPLOAD_DIR, `live-full-${c.label}-${Date.now()}.wav`);
		Bun.spawnSync([
			"ffmpeg", "-y", "-loglevel", "error", "-i", wavPath,
			"-af", `${c.filter}dynaudnorm=p=0.9:m=10`,
			"-ss", String(startTime), "-t", String(dur),
			"-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", outPath,
		]);
		try {
			if (existsSync(outPath) && Bun.file(outPath).size > 1000) {
				const res = await fetch(`${TRANSCRIPTION_SERVER}/transcribe-live`, {
					method: "POST", headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ wav_path: outPath, language: lang, audio_s: dur }),
				});
				if (res.ok) {
					const tx = await res.json() as { text?: string; quality?: { ok: boolean; reason: string; hint: string } };
					const text = (tx.text || "").trim();
					// Emit even when empty so the client can clear a stale line; client ignores tiny noise.
					send("live", { speaker: c.speaker, channel: c.label, text, start: 0, end: fileDurationS, live: true });
					// Audio-quality hint (heed's differentiator) — only for the MIC channel (the user's
					// own mic is what they can fix). Lets the UI warn instead of silently showing garbage.
					if (c.label === "mic" && tx.quality) {
						send("quality", tx.quality.ok === false ? { ok: false, reason: tx.quality.reason, hint: tx.quality.hint } : { ok: true });
					}
				}
			}
		} finally {
			try { unlinkSync(outPath); } catch {}
		}
	}
}

// Extract a contiguous channel segment [start, start+dur] to a small WAV. channel 0=mic, 1=sys.
function extractChannelSeg(wavPath: string, channelIdx: number, start: number, dur: number): string | null {
	const segPath = join(UPLOAD_DIR, `live-seg-${channelIdx}-${Date.now()}.wav`);
	const filter = channelIdx === 1 ? ["-af", "pan=mono|c0=c1"] : channelIdx === 0 && wavPath.includes("dual-capture-") ? ["-af", "pan=mono|c0=c0"] : [];
	Bun.spawnSync([
		"ffmpeg", "-y", "-loglevel", "error", "-i", wavPath, ...filter,
		"-ss", String(start), "-t", String(dur), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", segPath,
	]);
	return existsSync(segPath) && Bun.file(segPath).size > 1000 ? segPath : null;
}

// postJSON (→ pyPost) and TRANSCRIPTION_SERVER now come from ./lib/transcription-client.ts.

// Live STREAM mode (Parakeet): persistent ASR session(s) in the sidecar. Each tick feeds ONLY the
// NEW contiguous audio. MIC → "Me". On DUAL recordings the SYSTEM channel is ALSO streamed (its own
// ASR session) and diarized live (Sortformer) → the remote party's words appear labeled "Speaker N"
// IN REAL TIME. Speaker labels come from the streaming diarization timeline (dominant speaker).
async function processStreamLive(
	wavPath: string, isDual: boolean, lang: string,
	send: (event: string, data: unknown) => void,
): Promise<void> {
	if (!existsSync(wavPath)) return;
	// Wait for the models to be WARM before the first feed, so the first record never contends with
	// the boot-time pre-warm (the cold-start). The recorder keeps capturing meanwhile, so no audio
	// is lost — live text just starts once warm. Latches true (the server stays warm after boot).
	if (!liveWarmLatched) {
		try {
			const h = await fetch(`${TRANSCRIPTION_SERVER}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.json()).catch(() => null);
			if (h?.warm) liveWarmLatched = true;
			else return; // not warm yet — skip this tick, recorder still capturing
		} catch { return; }
	}
	if (!streamStarted) {
		const ok = await postJSON("/stream/start", { language: lang, channel: "mic" });
		if (!ok) return;
		if (isDual) {
			await postJSON("/stream/start", { language: lang, channel: "sys" });
			await postJSON("/diar/start", {});
		}
		streamStarted = true;
		lastStreamOffset = 0;
	}
	const fileSize = Bun.file(wavPath).size;
	const fileDurationS = (fileSize - 44) / (isDual ? 64000 : 32000);
	const newAudio = fileDurationS - lastStreamOffset;
	// First feed fires at 0.2s so the very first words appear ~twice as fast; steady state stays 0.4s.
	const minNew = lastStreamOffset === 0 ? 0.2 : 0.4;
	if (newAudio < minNew) return;
	const start = lastStreamOffset;
	lastStreamOffset = fileDurationS;

	// Feed the new audio of each channel; gather the full append-only partials + live speakers.
	let micPartial = "";
	let sysPartial = "";
	let sysSpeaker = "Speaker 1";

	// Extract the SYSTEM channel first so it can serve as the AEC reference for the mic feed
	// (cancel the other speaker's voice that leaked into the mic). Kept until both feeds are done.
	const micSeg = extractChannelSeg(wavPath, 0, start, newAudio);
	const sysSeg = isDual ? extractChannelSeg(wavPath, 1, start, newAudio) : null;
	if (micSeg) {
		try {
			const tx = await postJSON("/stream/feed", { wav_path: micSeg, channel: "mic", audio_s: newAudio, ref_wav_path: sysSeg || undefined, mic_is_owner: micIsOwner });
			if (tx) {
				micPartial = (tx.partial || "");
				if (tx.quality) send("quality", tx.quality.ok === false ? { ok: false, reason: tx.quality.reason, hint: tx.quality.hint } : { ok: true });
			}
		} finally { try { unlinkSync(micSeg); } catch {} }
	}
	if (isDual && sysSeg) {
		try {
			const sx = await postJSON("/stream/feed", { wav_path: sysSeg, channel: "sys", audio_s: newAudio });
			sysPartial = (sx?.partial || "");
		} finally { try { unlinkSync(sysSeg); } catch {} }
		// Live speaker = the STABLE, conservatively-named speaker from the periodic offline-rolling
		// diarization below (cached; refreshed ~every 2s). No phantom speakers, never a wrong name.
		sysSpeaker = liveSpeakerNow;
	}
	// Periodic OFFLINE-ROLLING diarization (~every 2s), fire-and-forget: run the SAME engine as the
	// brilliant post-stop on a rolling window of the sys channel; it returns the stable, correctly-
	// named speaker talking NOW. Replaces streaming Sortformer (which over-segmented one speaker into
	// phantom Speaker 2/3) AND the old recognition pass. Proven in eval_diar/ over 3 recordings:
	// 0 phantoms, conservative naming. Bounded cost (window capped) as the recording grows.
	if (isDual && !recogBusy && fileDurationS - lastRecogAt > DIAR_LIVE_STEP_S) {
		recogBusy = true; lastRecogAt = fileDurationS;
		const winStart = Math.max(0, fileDurationS - DIAR_LIVE_WINDOW_S);
		(async () => {
			try {
				const sysWin = extractChannelSeg(wavPath, 1, winStart, fileDurationS - winStart);
				if (sysWin) {
					const d = await postJSON("/diar/live", { wav_path: sysWin, window_s: fileDurationS - winStart });
					if (d?.ok && typeof d.speaker === "string" && d.speaker) {
						liveSpeakerNow = d.speaker;
						if (typeof d.label === "string" && d.label) liveSpeakerLabel = d.label;
					}
					try { unlinkSync(sysWin); } catch {}
				}
			} catch {}
			recogBusy = false;
		})();
	}
	// Voice-RAG MIC FILTER (~every 1s, fire-and-forget): diarize the MIC channel to tell the owner's
	// voice from external audio the mic picks up (a TV in the room, someone else) — the case the echo
	// layers can't touch (no system-channel reference). Caches micIsOwner; when false the mic feed
	// above is gated so the foreign audio never enters the owner's transcript. Auto-learns the owner's
	// voiceprint at stop (/diar/finish). Conservative: a single-voice mic is always kept.
	if (!micFilterBusy && fileDurationS - lastMicFilterAt > DIAR_LIVE_STEP_S) {
		micFilterBusy = true; lastMicFilterAt = fileDurationS;
		const winStart = Math.max(0, fileDurationS - MIC_FILTER_WINDOW_S); // small window: just the current voice
		(async () => {
			try {
				const micWin = extractChannelSeg(wavPath, 0, winStart, fileDurationS - winStart);
				if (micWin) {
					const d = await postJSON("/mic/filter", { wav_path: micWin, window_s: fileDurationS - winStart });
					if (d?.ok && typeof d.keep === "boolean") micIsOwner = d.keep;
					try { unlinkSync(micWin); } catch {}
				}
			} catch {}
			micFilterBusy = false;
		})();
	}

	// --- Karaoke turn assignment ---
	// Pick the channel that gained NEW text this tick (mic wins on overlap — it's prioritized).
	const micDelta = micPartial.length - lastMicLen;
	const sysDelta = sysPartial.length - lastSysLen;
	let active: "mic" | "sys" | null = null;
	if (micDelta > 1) active = "mic";
	else if (sysDelta > 1) active = "sys";

	if (active) {
		const speaker = active === "mic" ? micLabel() : sysSpeaker;          // what's SHOWN (refines live)
		const speakerKey = active === "mic" ? micLabel() : liveSpeakerLabel; // stable identity for turn keying
		const key = `${active}|${speakerKey}`;
		if (key !== liveTurnKey) {
			// Speaker changed → close the current turn and open a NEW chronological turn.
			liveTurnId += 1;
			liveTurnKey = key;
			const turnBase = active === "mic" ? lastMicLen : lastSysLen;
			if (active === "mic") micTurnBase = turnBase; else sysTurnBase = turnBase;
			liveTurns.push({ id: liveTurnId, channel: active, speaker, base: turnBase, startT: start, endT: fileDurationS });
		}
		const last = liveTurns[liveTurns.length - 1];
		if (last) last.endT = fileDurationS;
		const base = active === "mic" ? micTurnBase : sysTurnBase;
		const fullPartial = active === "mic" ? micPartial : sysPartial;
		const text = fullPartial.slice(base).trim();
		// NOTE: no live text-dedup here — it re-processed the whole turn each tick against the
		// growing system transcript, which made stable lines get rewritten (append-only broke).
		// Live echo is handled at the AUDIO level (the relative gate in /stream/feed, stable +
		// no lag); the final transcript is cleaned by the dedup at stop.
		if (text) send("turn", { id: liveTurnId, channel: active, speaker, text });
	}
	lastMicLen = micPartial.length;
	lastSysLen = sysPartial.length;
}

function handleLiveTranscribe(reqUrl?: URL): Response {
	if (!recorderProc || !recorderPath) {
		// Return an SSE stream that immediately closes instead of a JSON error.
		// This prevents EventSource from seeing a non-SSE response and erroring.
		const encoder = new TextEncoder();
		return new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode("event: error\ndata: {\"message\":\"Not recording\"}\n\n"));
					controller.close();
				},
			}),
			{ headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } },
		);
	}

	const wavPath = recorderPath;
	const isDual = wavPath.includes("dual-capture-");
	// Fixed 3s chunks. NOTE: VAD-variable boundaries were tried and REVERTED — adding a
	// silencedetect ffmpeg spawn per tick during active recording (on top of the recorder +
	// level-meter ffmpeg) starved the pipeline and spiked live latency to 8-15s. Fixed length
	// keeps it reliable (~0.3s/chunk). The accurate final pass re-transcribes with full context.
	const LIVE_CHUNK = liveTuning.chunk_s; // engine-adaptive (parakeet 2s, whisper 3s)
	let interval = liveTuning.interval_ms; // engine-adaptive (parakeet 800ms, whisper 2000ms)
	const lang = reqUrl?.searchParams.get("lang") || "es";
	// DON'T reset offset here — if EventSource reconnects, we continue from
	// where we left off instead of re-processing the same first chunk forever.
	// Offset is only reset in stopLiveTranscribe() when recording actually stops.

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		start(controller) {
			let closed = false;
			const send = (event: string, data: unknown) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
				} catch {
					closed = true;
				}
			};

			// Send a heartbeat immediately so the client knows the connection is alive
			send("heartbeat", { ts: Date.now() });

			const processChunk = async () => {
				if (closed || !recorderProc) {
					if (liveTranscribeInterval) clearInterval(liveTranscribeInterval);
					return;
				}
				// Lock: skip if previous chunk is still processing
				if (liveChunkProcessing) return;
				liveChunkProcessing = true;

				// STREAM mode (Parakeet): feed ONLY the new audio to the sidecar's streaming
				// session; show the model's append-only partial (confirmed prefix never changes).
				if (liveTuning.mode === "stream") {
					try {
						await processStreamLive(wavPath, isDual, lang, send);
					} catch (e) {
						console.log(`[heed] live stream error: ${(e as Error).message}`);
					} finally {
						liveChunkProcessing = false;
					}
					return;
				}

				// FULL mode (Parakeet/MLX): re-transcribe the whole growing audio, REPLACE on screen.
				if (liveTuning.mode === "full") {
					try {
						await processFullLive(wavPath, isDual, lang, send);
					} catch (e) {
						console.log(`[heed] live full error: ${(e as Error).message}`);
					} finally {
						liveChunkProcessing = false;
					}
					return;
				}

				// Check if the file has enough new data
				if (!existsSync(wavPath)) {
					console.log("[heed] live: WAV not found yet");
					return;
				}
				const fileSize = Bun.file(wavPath).size;
				const bytesPerSec = isDual ? 64000 : 32000;
				const fileDurationS = (fileSize - 44) / bytesPerSec;
				console.log(`[heed] live: file=${fileSize}b duration=${fileDurationS.toFixed(1)}s offset=${liveTranscribeOffset.toFixed(1)}s`);
				if (fileDurationS < liveTranscribeOffset + 2) {
					liveChunkProcessing = false;
					return;
				}

				const startTime = Math.max(0, liveTranscribeOffset);
				const chunkDur = LIVE_CHUNK;
				// Advance offset NOW so the next tick doesn't re-process the same chunk
				liveTranscribeOffset = startTime + chunkDur;
				const chunkPath = join(UPLOAD_DIR, `live-chunk-${Date.now()}.wav`);

				try {
					// Extract chunk with volume normalization.
					// Whisper can miss very quiet mic audio without gain normalization;
					// dynaudnorm boosts low-volume speech to a safer range.
					const channelFilter = isDual ? "pan=mono|c0=c0," : "";
					Bun.spawnSync([
						"ffmpeg", "-y", "-loglevel", "error",
						"-i", wavPath,
						"-af", `${channelFilter}dynaudnorm=p=0.9:m=10`,
						"-ss", String(startTime),
						"-t", String(chunkDur),
						"-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
						chunkPath,
					]);

					if (!existsSync(chunkPath) || Bun.file(chunkPath).size < 1000) {
						console.log(`[heed] live: chunk extraction failed or too small`);
						return;
					}
					console.log(`[heed] live: chunk extracted ${Bun.file(chunkPath).size}b, sending to whisper...`);

					// Send to whisper and track how long it takes
					const whisperStart = Date.now();
					const txRes = await fetch(`${TRANSCRIPTION_SERVER}/transcribe-live`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ wav_path: chunkPath, language: lang, audio_s: chunkDur }),
					});
					const whisperMs = Date.now() - whisperStart;

					// Adaptive interval: if whisper is slow (RAM pressure), back off
					// to avoid queueing up chunks that pile on even more pressure.
					if (false /* RuntimeGovernor drives cadence now */ && liveTranscribeInterval) {
						clearInterval(liveTranscribeInterval);
						interval = Math.min(interval + 3000, 15000);
						liveTranscribeInterval = setInterval(processChunk, interval);
						console.log(`[heed] live: whisper took ${whisperMs}ms, backing off to ${interval}ms interval`);
					}

					console.log(`[heed] live: whisper responded in ${whisperMs}ms, status=${txRes.status}`);
					if (txRes.ok) {
						const tx = await txRes.json() as { text?: string; srt_path?: string; gov?: { interval_ms?: number; live_model?: string; changed?: boolean; reason?: string } };
						const gov = tx.gov;
							if (gov?.interval_ms && gov.interval_ms !== interval && liveTranscribeInterval) {
								clearInterval(liveTranscribeInterval);
								interval = gov.interval_ms;
								liveTranscribeInterval = setInterval(processChunk, interval);
							}
							if (gov?.changed) console.log(`[heed] live governor: ${gov.reason} (interval=${interval}ms)`);
							const text = (tx.text || "").trim();
						console.log(`[heed] live: whisper text="${text.slice(0, 50)}" (${text.length} chars)`);
						if (text && text.length > 3) {
							send("segment", {
								speaker: micLabel(),
								start: Math.round(startTime * 100) / 100,
								end: Math.round(Math.min(startTime + chunkDur, fileDurationS) * 100) / 100,
								text,
								channel: "mic",
								live: true,
							});
						}
					}

					// System channel live transcription (speakers labeled "???" until pyannote
					// runs after recording stops and reveals real names)
					if (isDual) {
						const sysChunkPath = join(UPLOAD_DIR, `live-chunk-sys-${Date.now()}.wav`);
						Bun.spawnSync([
							"ffmpeg", "-y", "-loglevel", "error",
							"-i", wavPath,
							"-af", "pan=mono|c0=c1,dynaudnorm=p=0.9:m=10",
							"-ss", String(startTime),
							"-t", String(chunkDur),
							"-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
							sysChunkPath,
						]);
						if (existsSync(sysChunkPath) && Bun.file(sysChunkPath).size > 1000) {
							const sysRes = await fetch(`${TRANSCRIPTION_SERVER}/transcribe-live`, {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({ wav_path: sysChunkPath, language: lang }),
							});
							if (sysRes.ok) {
								const sysTx = await sysRes.json() as { text?: string };
								const sysText = (sysTx.text || "").trim();
								if (sysText && sysText.length > 3) {
									send("segment", {
										speaker: "???",
										start: Math.round(startTime * 100) / 100,
										end: Math.round(Math.min(startTime + chunkDur, fileDurationS) * 100) / 100,
										text: sysText,
										channel: "sys",
										live: true,
									});
								}
							}
							try { unlinkSync(sysChunkPath); } catch {}
						}
					}

					// Cleanup chunk file
					try { unlinkSync(chunkPath); } catch {}
				} catch (e) {
					const errMsg = (e as Error).message;
					console.log(`[heed] live chunk error: ${errMsg}`);
					if (errMsg.includes("Unable to connect") || errMsg.includes("ECONNREFUSED")) {
						console.log("[heed] live: Python unreachable, stopping");
						if (liveTranscribeInterval) clearInterval(liveTranscribeInterval);
						send("error", { message: "Transcription server unavailable" });
					}
				} finally {
					liveChunkProcessing = false;
				}
			};

			// First chunk after 1 second (was 3s) so words start appearing fast, then every interval
			const firstTimeout = setTimeout(() => {
				processChunk();
				liveTranscribeInterval = setInterval(processChunk, interval);
			}, 300);

			// Cleanup when connection drops
			const checkClosed = setInterval(() => {
				if (!recorderProc) {
					clearInterval(checkClosed);
					if (liveTranscribeInterval) clearInterval(liveTranscribeInterval);
					clearTimeout(firstTimeout);
					send("stopped", {});
					try { controller.close(); } catch {}
				}
			}, 1000);
		},
	});

	return new Response(stream, {
		headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
	});
}

function stopLiveTranscribe() {
	if (liveTranscribeInterval) {
		clearInterval(liveTranscribeInterval);
		liveTranscribeInterval = null;
	}
	liveTranscribeOffset = 0;
	liveChunkProcessing = false;
	lastStreamOffset = 0;
	streamStarted = false;
	liveTurnId = 0;
	liveTurnKey = "";
	micTurnBase = 0;
	sysTurnBase = 0;
	lastMicLen = 0;
	lastSysLen = 0;
	liveTurns = [];
	liveSpeakerNow = "Speaker 1";
	liveSpeakerLabel = "Speaker 1";
	micIsOwner = true;
	micFilterBusy = false;
	lastMicFilterAt = 0;
	recogBusy = false;
	lastRecogAt = 0;
	// Any in-flight whisper call will still complete but its result will be
	// dropped because processChunk checks `!recorderProc` at the top.
}

async function handleSysRecordStop(req: Request): Promise<Response> {
 if (!recorderProc && quotaStopResult) { const result=quotaStopResult; quotaStopResult=null; return Response.json(result); }
 if (recorderStopping) return Response.json({error:"Recording is already stopping"},{status:409});
 recorderStopping=true;
 const path=recorderPath; if(path) { retainedProcessing.set(path, Infinity); pruneAudio(Math.max(0,AUDIO_LIMIT_BYTES - (existsSync(path)?statSync(path).size:0) - 10_000_000)); }
 try { return await finishSysRecording(req); } finally {recorderStopping=false; if(path){removeChannelCopies(path);protectAudio(path);} }
}
async function finishSysRecording(req: Request): Promise<Response> {
	// Language for the post-stop re-transcription. Passing the real code (not "auto") stops Parakeet
	// from flipping to English on Spanish-with-tech-terms speech.
	let stopLang = "auto";
	try { const b = await req.json(); if (b?.language) stopLang = String(b.language); } catch {}
	const offset = liveTranscribeOffset; // save before reset
	const wasStreaming = streamStarted;
	const streamOffset = lastStreamOffset;
	const turns = liveTurns.map((t) => ({ ...t })); // capture before stopLiveTranscribe resets it
	stopLiveTranscribe();
	if (!recorderProc || !recorderPath) return Response.json({ error: "Not recording" }, { status: 400 });

	// Stop SCK first so ffmpeg gets EOF on its stdin pipe and flushes cleanly, then SIGINT ffmpeg.
	if (syscapProc) {
		try { syscapProc.kill(); } catch {}
		syscapProc = null;
	}
	// SIGINT lets ffmpeg flush the WAV cleanly; gracefulStop adds a SIGKILL fallback so a hung
	// ffmpeg can't wedge the stop forever (previously this awaited .exited with no timeout).
	await gracefulStop(recorderProc, 1500, "SIGINT");
	await new Promise(r => setTimeout(r, 500));

	const path = recorderPath;
	recorderProc = null;
	recorderPath = null;

	stopLevelMeter();

	if (!existsSync(path)) return Response.json({ error: "Recording file not created" }, { status: 500 });

	// AUTHORITATIVE post-stop: re-transcribe the whole recording with REAL timestamps, diarize the
	// system channel, acoustically strip the mic's echo (no-headphones), and name known voices — all
	// in one /finalize call. Replaces the old "refine the live karaoke turns in place" path, which had
	// no timestamps and inherited the live segmentation/echo. The live turns still power the instant
	// on-screen karaoke; this rebuilds the saved transcript coherently.
	let streamText = "";
	let refinedTurns: Array<{ id: number; speaker: string; channel: "mic" | "sys"; text: string; start: number; end: number; auto?: boolean }> = [];
	let speakerEmbeddings: Record<string, number[]> = {};
	let autoNamed: Record<string, { name: string; score: number }> = {};
	if (wasStreaming) {
		try {
			const isDual = path.includes("dual-capture-");
			// Close the live streaming/diar sessions so the sidecar resets cleanly for the next recording.
			try { await postJSON("/stream/finish", { channel: "mic" }); } catch {}
			if (isDual) {
				try { await postJSON("/stream/finish", { channel: "sys" }); } catch {}
				try { await postJSON("/diar/finish", {}); } catch {}
			}

			const fin = await postJSON("/finalize", { wav_path: path, language: stopLang, dual: isDual });
			const finTurns: Array<{ start: number; end: number; speaker: string; text: string; channel?: "mic" | "sys" }> = fin?.turns || [];
			speakerEmbeddings = fin?.embeddings || {};
			autoNamed = fin?.auto_named || {};
			refinedTurns = finTurns
				.filter((t) => (t.text || "").trim())
				.map((t, i) => ({
					id: i,
					speaker: t.speaker,
					channel: t.channel === "mic" ? "mic" : "sys",
					text: t.text.trim(),
					start: t.start,
					end: t.end,
					auto: !!(autoNamed && autoNamed[t.speaker]),
				}));
			streamText = refinedTurns.map((t) => t.text).join(" ");
		} catch {}
	}

	return Response.json({ path, liveOffset: offset, streaming: wasStreaming, streamText, turns: refinedTurns, embeddings: speakerEmbeddings, autoNamed });
}

// --- Meeting auto-detector ---
// Watches PipeWire clients for meeting apps (zoom, meet, teams, discord, etc.)
// Streams notifications via SSE to the frontend.
const MEETING_APPS = [
	{ pattern: /zoom/i, name: "Zoom" },
	{ pattern: /meet|chrome.*meet/i, name: "Google Meet" },
	{ pattern: /teams|MSTeams/i, name: "Microsoft Teams" },
	{ pattern: /discord/i, name: "Discord" },
	{ pattern: /webex/i, name: "Webex" },
	{ pattern: /skype/i, name: "Skype" },
	{ pattern: /jitsi/i, name: "Jitsi" },
	{ pattern: /slack.*call/i, name: "Slack Call" },
];

function detectMeetingApps(): { app: string; raw: string }[] {
	try {
		const result = Bun.spawnSync(["pactl", "list", "clients"]);
		const output = new TextDecoder().decode(result.stdout);
		const clients = output.split("Client #").slice(1);

		const detected: { app: string; raw: string }[] = [];
		for (const client of clients) {
			const nameMatch = client.match(/application\.name\s*=\s*"([^"]+)"/);
			const procMatch = client.match(/application\.process\.binary\s*=\s*"([^"]+)"/);
			const name = nameMatch?.[1] || "";
			const proc = procMatch?.[1] || "";
			const combined = `${name} ${proc}`;

			for (const app of MEETING_APPS) {
				if (app.pattern.test(combined)) {
					detected.push({ app: app.name, raw: name });
					break;
				}
			}
		}
		return detected;
	} catch {
		return [];
	}
}

function handleDetectorStream(): Response {
	const encoder = new TextEncoder();
	let lastApps = new Set<string>();

	const stream = new ReadableStream({
		start(controller) {
			let closed = false;
			const send = (data: unknown) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
				} catch {
					closed = true;
				}
			};

			const tick = () => {
				if (closed) return;
				const detected = detectMeetingApps();
				const currentApps = new Set(detected.map((d) => d.app));

				// New apps detected
				for (const d of detected) {
					if (!lastApps.has(d.app)) {
						send({ event: "meeting_started", app: d.app });
					}
				}
				// Apps that ended
				for (const app of lastApps) {
					if (!currentApps.has(app)) {
						send({ event: "meeting_ended", app });
					}
				}
				lastApps = currentApps;
			};

			// Initial tick
			tick();
			const iv = setInterval(tick, 3000);

			// Heartbeat to keep connection alive
			const heartbeat = setInterval(() => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`: ping\n\n`));
				} catch {
					closed = true;
				}
			}, 15000);

			// Cleanup on cancel
			(controller as any)._cleanup = () => {
				closed = true;
				clearInterval(iv);
				clearInterval(heartbeat);
			};
		},
		cancel() {
			// noop — handled by closed flag
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}

// --- Auto-recovery for orphaned recordings ---
// When heed crashes mid-recording, ffmpeg has already written the WAV to disk.
// On next startup, we scan the uploads dir for WAVs that don't belong to any
// session and surface them to the frontend as recoverable.
interface OrphanedRecording {
	path: string;
	filename: string;
	size_mb: number;
	created: string; // ISO date
	duration_estimate_s: number; // estimated from file size (16kHz 16-bit mono ≈ 32KB/s, stereo ≈ 64KB/s)
	is_dual: boolean;
}

function handleListOrphaned(): Response {
	if (!existsSync(UPLOAD_DIR)) return Response.json({ recordings: [] });

	// Collect all WAV files in uploads
	const wavFiles = readdirSync(UPLOAD_DIR)
		.filter((f) => f.endsWith(".wav") && (f.startsWith("capture-") || f.startsWith("dual-capture-")))
		.filter((f) => {
			// Exclude sub-files created by the Python split (mic/sys channels)
			return !f.includes("-mic.wav") && !f.includes("-sys.wav");
		});

	// Collect all WAV paths referenced by existing sessions
	const sessionPaths = new Set<string>();
	if (existsSync(SESSIONS_DIR)) {
		for (const sf of readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"))) {
			try {
				const session = JSON.parse(readFileSync(join(SESSIONS_DIR, sf), "utf-8"));
				if (session.files?.wav) sessionPaths.add(session.files.wav);
			} catch {}
		}
	}

	// An orphan = WAV exists but no session references it
	const orphans: OrphanedRecording[] = [];
	for (const f of wavFiles) {
		const fullPath = join(UPLOAD_DIR, f);
		if (sessionPaths.has(fullPath)) continue;

		const stat = Bun.file(fullPath);
		const sizeBytes = stat.size;
		const isDual = f.startsWith("dual-capture-");
		// Estimate duration: 16kHz × 16-bit × channels = bytes/sec
		const bytesPerSec = isDual ? 64000 : 32000; // stereo vs mono
		const durationS = Math.round(sizeBytes / bytesPerSec);

		// Extract timestamp from filename: capture-{ts}.wav or dual-capture-{ts}.wav
		const tsMatch = f.match(/(\d+)\.wav$/);
		const ts = tsMatch ? parseInt(tsMatch[1]) : Date.now();

		orphans.push({
			path: fullPath,
			filename: f,
			size_mb: Math.round(sizeBytes / 1024 / 1024 * 10) / 10,
			created: new Date(ts).toISOString(),
			duration_estimate_s: durationS,
			is_dual: isDual,
		});
	}

	// Sort newest first
	orphans.sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());
	return Response.json({ recordings: orphans });
}

function handleDiscardOrphaned(url: URL): Response {
	const path = url.searchParams.get("path");
	if (!path) return Response.json({ error: "No path" }, { status: 400 });
	// Safety: only allow deleting files inside UPLOAD_DIR
	if (!path.startsWith(UPLOAD_DIR)) return Response.json({ error: "Invalid path" }, { status: 400 });
	try {
		if (existsSync(path)) unlinkSync(path);
		// Also clean up any split files
		const base = path.replace(/\.wav$/, "");
		for (const suffix of ["-mic.wav", "-sys.wav", "-mic.wav.srt", "-sys.wav.srt", "-mic.txt", "-sys.txt"]) {
			const f = base + suffix;
			if (existsSync(f)) unlinkSync(f);
		}
		return Response.json({ ok: true });
	} catch (e) {
		return Response.json({ error: (e as Error).message }, { status: 500 });
	}
}

// --- Health check ---
async function handleHealth(): Promise<Response> {
	let ollamaOk = false;
	let txServer: any = { ready: false };
	try {
		const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) });
		ollamaOk = res.ok;
	} catch {}
	try {
		const res = await fetch(`${TRANSCRIPTION_SERVER}/health`, { signal: AbortSignal.timeout(3000) });
		txServer = await res.json();
	} catch {}
	return Response.json({
		ollama: ollamaOk,
		whisper: txServer.whisper || false,
		pyannote: txServer.pyannote || false,
		whisper_info: txServer.whisper_info || null,
		pyannote_info: txServer.pyannote_info || null,
		languages: txServer.languages || null,  // engine-aware language support (Parakeet=28, Whisper=all)
	});
}

// Desktop controls are local-only and use the existing browser recording lifecycle.
function desktopRequestAllowed(req: Request): boolean {
 const url = new URL(req.url);
 if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return false;
 const origin = req.headers.get("origin");
 if (!origin) return true;
 try { const u = new URL(origin); return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && ["5170", String(PORT)].includes(u.port); } catch { return false; }
}
function desktopRecordingStatus() {
 if (recorderProc && recorderProc.exitCode !== null && !recorderStopping && !quotaReachedAt && !(recorderPath && existsSync(recorderPath) && statSync(recorderPath).size >= CAPTURE_LIMIT_BYTES - 1_000_000)) {
  recorderProc = null; recorderPath = null;
  if (syscapProc) { try { syscapProc.kill(); } catch {} syscapProc = null; }
  stopLevelMeter();
  desktopControl.error = "Audio capture stopped unexpectedly. Check microphone permission and recover the audio in the interface.";
 }
 const state = desktopControl.status();
 return {...state, recording: !!recorderProc, seconds: recorderProc ? Math.floor((Date.now()-recorderStartedAt)/1000) : state.seconds, ready: state.ready, language:recordingLanguage, processing:state.processing || recorderStopping, starting:recorderStarting, storage:{limitBytes:AUDIO_LIMIT_BYTES, bytes:pruneAudio().bytes}, quotaStopped:!!quotaStopResult};
}
async function handleDesktopControl(req:Request, pathname:string): Promise<Response> {
 if (!desktopRequestAllowed(req)) return Response.json({error:"Desktop control is available only on localhost"}, {status:403});
 try {
  if (req.method === "GET" && pathname.endsWith("/status")) {
   const status = desktopRecordingStatus();
   try { const health = await fetch(`${TRANSCRIPTION_SERVER}/health`, {signal:AbortSignal.timeout(1500)}); const data=await health.json(); status.ready = data.whisper === true; } catch {status.ready=false;}
   return Response.json(status);
  }
  const body = await req.json();
  if (pathname.endsWith("/commands") && req.method === "POST") {
   if (!["start", "stop"].includes(body.action) || !["pt", "en"].includes(body.language)) return Response.json({error:"Choose start/stop and pt/en"}, {status:400});
   const state = desktopRecordingStatus();
   if (recorderStarting) return Response.json({error:"Recording is starting"}, {status:409});
   const language = body.action === "stop" && recordingLanguage ? recordingLanguage : body.language;
   const id = desktopControl.enqueue(body.action, language, state);
   if (body.action === "start") recordingLanguage = language;
   return Response.json({ok:true,id});
  }
  if (typeof body.client !== "string" || body.client.length > 100) return Response.json({error:"Missing browser id"}, {status:400});
  if (pathname.endsWith("/poll") && req.method === "POST") {
   desktopControl.heartbeat(body.client, {recording:body.recording === true,processing:body.processing === true,seconds:Number(body.seconds)||0,ready:body.ready === true,commandId:typeof body.commandId === "string" ? body.commandId : undefined});
   const state = desktopRecordingStatus();
   return Response.json({command:desktopControl.claim(body.client),status:state});
  }
  if (pathname.endsWith("/complete") && req.method === "POST") {
   desktopControl.complete(body.id, body.client, typeof body.error === "string" ? body.error : null);
   return Response.json({ok:true});
  }
  return Response.json({error:"Unknown desktop control endpoint"},{status:404});
 } catch (e) { return Response.json({error:(e as Error).message},{status:409}); }
}

// --- Router ---
// Libera áudios antigos durante a captura; nunca remove a reunião em andamento.
let retentionBusy=false;
setInterval(async () => {
 if(retentionBusy)return;retentionBusy=true;
 try {
  pruneAudio(recorderProc ? AUDIO_LIMIT_BYTES - 2_000_000 : AUDIO_LIMIT_BYTES);
  if(recorderProc && recorderPath && !recorderStopping) {
   const size=existsSync(recorderPath)?statSync(recorderPath).size:0;
   if(size >= CAPTURE_LIMIT_BYTES - 1_000_000) {
    if(!quotaReachedAt) {
     quotaReachedAt=Date.now();
     // Interrompe somente a escrita; mantém o caminho para a finalização normal.
     if(syscapProc){try{syscapProc.kill();}catch{}syscapProc=null;}
     await gracefulStop(recorderProc,1500,"SIGINT");
    }
    if(desktopControl.status().clientConnected && !desktopControl.pending) {
     try{desktopControl.enqueue('stop',recordingLanguage === 'en'?'en':'pt',{recording:true,processing:false});}catch{}
    }
    // Sem navegador, salva o áudio e uma sessão recuperável no servidor.
    if(!desktopControl.status().clientConnected || Date.now()-quotaReachedAt>30_000) {
     desktopControl.cancelPending();
     const duration=Math.floor((Date.now()-recorderStartedAt)/1000);
     const response=await handleSysRecordStop(new Request('http://localhost/api/sysrecord/stop',{method:'POST',body:JSON.stringify({language:recordingLanguage})}));
     if(response.ok){
      quotaStopResult=await response.json();
      if(!desktopControl.status().clientConnected) {
       await handleCreateSession(new Request('http://localhost/api/sessions',{method:'POST',body:JSON.stringify({title:'Gravação encerrada — limite de 2 GB',duration,language:recordingLanguage,transcript:quotaStopResult.streamText||'',segments:quotaStopResult.turns||[],files:{wav:quotaStopResult.path,srt:'',txt:''},tags:[],speakers:[],aiNotes:'',summary:''})}));
      }
     }
    }
   }
  }
 }catch(error){console.error('[heed] retenção de áudio:',error);}
 finally{retentionBusy=false;}
},1000);

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: PORT,
	idleTimeout: 255, // max allowed — pyannote + whisper can take a while
	async fetch(req) {
		const url = new URL(req.url);
		const method = req.method;

		if (method === "POST" && url.pathname === "/api/transcribe") return handleTranscribe(req);
		// /api/finalize removed — post-stop now uses /api/transcribe (process-stream)
		if (method === "POST" && url.pathname === "/api/summarize") return handleSummarize(req);
		if (method === "POST" && url.pathname === "/api/summary-line") return handleSummaryLine(req);
		// /api/diarize removed — finalize handles speaker identification now
        const audioRoute = /^\/api\/sessions\/([^/]+)\/audio$/.exec(url.pathname);
        if (audioRoute && (method === "GET" || method === "HEAD")) {
            if (!desktopRequestAllowed(req)) return new Response(null, {status:403});
            let sessionId: string;
            try { sessionId = decodeURIComponent(audioRoute[1]!); } catch { return new Response(null, {status:403}); }
            return sessionAudioResponse(req, sessionId, SESSIONS_DIR, UPLOAD_DIR);
        }
		if (method === "GET" && url.pathname === "/api/sessions") return handleListSessions();
		if (method === "POST" && url.pathname === "/api/sessions") return handleCreateSession(req);
		if (method === "PATCH" && url.pathname === "/api/sessions") return handlePatchSession(req, url);
		if (method === "DELETE" && url.pathname === "/api/sessions") return handleDeleteSession(url);
		if (method === "GET" && url.pathname === "/api/templates") return handleListTemplates();
		if (method === "POST" && url.pathname === "/api/templates") return handleSaveTemplate(req);
		if (method === "DELETE" && url.pathname === "/api/templates") return handleDeleteTemplate(url);
		if (method === "GET" && url.pathname === "/api/voices") return handleListVoices();
		if (method === "POST" && url.pathname === "/api/voices/save") return handleSaveVoice(req);
		if (method === "POST" && url.pathname === "/api/voices/delete") return handleDeleteVoice(req);
		if (method === "GET" && url.pathname === "/api/user-name") return handleGetUserName();
		if (method === "POST" && url.pathname === "/api/user-name") return handleSetUserName(req);
		if (method === "GET" && url.pathname === "/api/models") return handleListModels();
		if (method === "POST" && url.pathname === "/api/models/select") return handleSelectModel(req);
		if (method === "GET" && url.pathname === "/api/models/pull") return handleModelPull(url);
		if (method === "GET" && url.pathname === "/api/setup/check") return handleSetupCheck();
		if (method === "GET" && url.pathname === "/api/setup/install-ollama") return handleInstallOllama();
		if (method === "GET" && url.pathname === "/api/setup/install-ffmpeg") return handleInstallFfmpeg();
		if (method === "POST" && url.pathname === "/api/setup/start-ollama") return handleStartOllama();
		if (url.pathname.startsWith("/api/desktop/control/")) return handleDesktopControl(req, url.pathname);
		if (method === "POST" && url.pathname === "/api/desktop/float") return handleDesktopFloat();
		if (method === "GET" && url.pathname === "/api/meeting-detector") return handleDetectorStream();
		// /api/download and /api/recording removed — unused legacy endpoints
		if (method === "POST" && url.pathname === "/api/sysrecord/start") return handleSysRecordStart(req);
		if (method === "POST" && url.pathname === "/api/sysrecord/stop") return handleSysRecordStop(req);
		if (method === "GET" && url.pathname === "/api/sysrecord/levels") return handleSysLevelsSSE();
		if (method === "GET" && url.pathname === "/api/sysrecord/live") return handleLiveTranscribe(url);
		if (method === "GET" && url.pathname === "/api/health") return handleHealth();
		if (method === "GET" && url.pathname === "/api/recovery/list") return handleListOrphaned();
		if (method === "DELETE" && url.pathname === "/api/recovery/discard") return handleDiscardOrphaned(url);

		return serveStatic(url.pathname) || new Response("Not Found", { status: 404 });
	},
});

// Never leave an orphaned ffmpeg/syscap holding the mic: on SIGINT/SIGTERM/exit, gracefully reap
// every tracked child (the recorder, the system-audio capture, the level meter). Previously there
// was NO signal handler — a server crash/exit left ffmpeg running and the mic "stuck busy".
installShutdownHooks(() => { stopLiveTranscribe(); });

console.log(`
  ┌──────────────────────────────────┐
  │                                  │
  │   heed app running on :${PORT}     │
  │   http://localhost:${PORT}          │
  │                                  │
  └──────────────────────────────────┘
`);
