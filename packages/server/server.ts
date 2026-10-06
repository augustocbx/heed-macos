import {createGoogleDriveController} from './lib/connectors/google-drive-runtime';
import {googleDriveResponse,type GoogleDriveController} from './lib/connectors/google-drive-http';
import {OneDriveAuth} from './lib/connectors/onedrive-auth';
import {OneDriveConnections} from './lib/connectors/onedrive-connections';
import {oneDriveResponse} from './lib/connectors/onedrive-http';
import {createKeychainVault} from './lib/connectors/keychain-vault';
import {SmbConnections} from './lib/smb-connections.ts';
import {smbResponse} from './lib/smb-http.ts';
import {ProviderRegistry} from './lib/provider-registry.ts';
import {PortableLibraryRuntime} from './lib/portable-runtime.ts';
import {libraryResponse} from './lib/portable-http.ts';
import { LibraryChatService, libraryChatResponse } from "./lib/library-chat.ts";
import { MeetingTasksService } from "./lib/meeting-tasks.ts";
import { tasksResponse } from "./lib/tasks-http.ts";
import { generateTaskSuggestions } from "./lib/task-generation.ts";
import { MeetingChatService, CHAT_SYSTEM, chatApiResponse, type ChatGenerationRequest } from "./lib/meeting-chat.ts";
import { MeetingDetectionController } from "./lib/meeting-detection.ts";
import { meetingDetectionRoute } from "./lib/meeting-detection-http.ts";
import { AutomaticNotesService, notesHash, renderNotesTranscript } from "./lib/automatic-notes.ts";
import { automaticNotesSettings, validateNotesSettings } from "./lib/notes-settings.ts";
import { generateLocalNotes, listLocalNotesModels, generateLocalStructured, listLocalChatModels } from "./lib/ollama-notes.ts";
import { configuredUiLocale, supportedUiLocale } from "./lib/ui-locale.ts";
import { finalRecordingResult, recordingFinalizationOptions } from "./lib/final-recording.ts";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync, statSync, rmSync } from "node:fs";
import {randomUUID} from "node:crypto";
import {validateProcessingWave} from "./lib/processing-wave.ts";
import {reserveMediaWork} from "./lib/media-budget.ts";
import { join, resolve, extname } from "node:path";
import { homedir, cpus } from "node:os";
import { downloadFromUrl, normalizeAudio } from "./lib/media.ts";
import { APP_DIR, LIBRARY_DIR, CONFIG_PATH, SESSIONS_DIR, TEMPLATES_DIR, type TrxConfig, ensureAppDirs, loadConfig, saveConfig, micLabel } from "./lib/app-config.ts";
import { TRANSCRIPTION_SERVER, pyPost as postJSON } from "./lib/transcription-client.ts";
import { track, gracefulStop, installShutdownHooks } from "./lib/process.ts";
import { sseResponse } from "./lib/sse.ts";
import { sessionAudioResponse } from "./lib/session-audio.ts";
import { SessionTags, TagError, tagResponse } from "./lib/session-tags.ts";
const sessionTags = new SessionTags(SESSIONS_DIR);
import { RecordingCoordinator } from "./lib/recording-coordinator.ts";
import type { FinalCapture, RecordingSnapshot } from "../shared/types/recording-coordinator.ts";
import { DesktopPermissions, desktopRequestAllowed as permissionRequestAllowed, permissionAction, permissionReport } from "./lib/desktop-permissions.ts";
import { removeChannelCopies } from "./lib/audio-retention.ts";
import {validManagedLimit} from './lib/managed-quota.ts';
import {createAppQuota} from './lib/app-storage.ts';
import {reserveCapture,reserveFinalization,releaseCapture} from './lib/capture-quota.ts';
import { type CaptureMode, nativeCaptureCommand, nativeRecordingCommand, verifyNativeHandshake, isNativeProtocolLine } from "./lib/native-capture.ts";
const desktopPermissions = new DesktopPermissions();
const retainedProcessing = new Map<string, number>();
let captureLimitBytes=0;
let recordingWorkDirectory:string|null=null;
let quotaReachedAt = 0;
let quotaStopResult: any = null;
let recordingFinalizationRunning = false;
let transcriptionRequests = 0;
let manualNotesController: AbortController | null = null;
let manualNotesDone: Promise<void> | null = null;
function audioWorkBusy() {
 return !!(recorderProc || recorderStarting || recorderStopping || recordingFinalizationRunning || transcriptionRequests
  || ["starting", "stopping", "finalizing"].includes(recordingCoordinator.snapshot().state));
}
async function preemptNotes() {
 manualNotesController?.abort();
 await Promise.all([notesService.preempt(), tasksService.preempt(), chatService.preempt(), libraryChatService.preempt(), googleDrive?.preempt(), oneDriveConnections?.preempt(), manualNotesDone]);
}
function cleanupCaptureWork(id:string){if(!/^[a-zA-Z0-9_-]{1,180}$/.test(id))return;const directory=join(APP_DIR,'library','staging',`capture-${id}`);rmSync(directory,{recursive:true,force:true});if(recordingWorkDirectory===directory)recordingWorkDirectory=null;}
function protectAudio(path: string) { retainedProcessing.set(path, Date.now() + 120_000); }
function pruneAudio() {
 sessionTags.recover();
 for (const [path, until] of retainedProcessing) if (until < Date.now()) retainedProcessing.delete(path);
 const usage=managedQuota.snapshot();
 if(usage.usedBytes+usage.reservedBytes>usage.limitBytes){
  try{const preview=managedQuota.preview(usage.limitBytes);if(preview.removals.length)managedQuota.apply(usage.limitBytes,preview.token);}catch(error){console.error('Managed storage cleanup paused:',(error as Error).message);}
 }
 const current=managedQuota.snapshot();return {...current,bytes:current.usedBytes,removed:[],overLimit:current.usedBytes+current.reservedBytes>current.limitBytes};
}

const PORT = Number(process.env.PORT) || 5001;

const STATIC_ROOT = join(import.meta.dir, "..", "client", "dist");
// Recordings stored in the project root
const UPLOAD_DIR = process.env.HEED_RECORDINGS_DIR || join(import.meta.dir, "..", "..", "recordings");
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
// Hard fallback only — actual model is read from ~/.heed-app/config.json (set by hardware
// auto-detection on first launch, or by the user via the model picker modal).
// Opt-in override ONLY (for power users / tests). No silent hardcoded default — the user
// must pick the notes model explicitly (see getCurrentModel + the model picker).
const FALLBACK_MODEL = process.env.HEED_MODEL || null;

// App paths + persistent config (loadConfig/saveConfig/micLabel/TrxConfig) now live in
// ./lib/app-config.ts — single source of truth (the stale lib/config.ts duplicate was deleted).
ensureAppDirs([UPLOAD_DIR]);
let portableRuntime:PortableLibraryRuntime|undefined;
let smbConnections:SmbConnections|undefined;
let oneDriveConnections:OneDriveConnections|undefined;
let googleDrive:GoogleDriveController|undefined;
let googleDriveUnavailable=false;
let googleDriveInitializing=false;
const googleProtectedPaths=()=>{if(googleDriveUnavailable||googleDriveInitializing)return [UPLOAD_DIR,join(LIBRARY_DIR,'media')];try{return googleDrive?.protectedPaths()||[];}catch{googleDriveUnavailable=true;return [UPLOAD_DIR,join(LIBRARY_DIR,'media')];}};
let synchronizationUnavailable=false;
const synchronizationProtectedPaths=()=>{if(synchronizationUnavailable)return [UPLOAD_DIR,join(LIBRARY_DIR,'media')];try{return [...googleProtectedPaths(),...(smbConnections?.protectedLocalPaths()||[]),...(oneDriveConnections?.protectedLocalPaths()||[]),...(portableRuntime?.protectedPaths([...(smbConnections?.protectedRevisionIds()||[]),...(oneDriveConnections?.protectedRevisionIds()||[])])||[])];}catch{synchronizationUnavailable=true;return [UPLOAD_DIR,join(LIBRARY_DIR,'media')];}};
const captureProtectedPaths=()=>[...retainedProcessing.keys(),...((recorderPath && (recorderProc || recorderStarting || recorderStopping || recordingFinalizationRunning))?[recorderPath]:[])];
const managedQuota=createAppQuota({
 recordingsDir:UPLOAD_DIR,
 protectedPaths:()=>[...captureProtectedPaths(),...synchronizationProtectedPaths()],
 onEvicted:paths=>{
  sessionTags.recover();
  for(const session of sessionTags.snapshot().sessions)if(session.files?.wav && paths.includes(session.files.wav)){
   session.files.wav='';(session as any).audioExpired=true;(session as any).audioRemovedAt=new Date().toISOString();sessionTags.save(session);
  }
 },
});

portableRuntime=new PortableLibraryRuntime({root:LIBRARY_DIR,sessions:sessionTags,sessionsDir:SESSIONS_DIR,recordingsDir:UPLOAD_DIR,quota:managedQuota,protectedPaths:captureProtectedPaths});
/** Connectors lease this single catalog owner for their entire provider tick. */
export function getPortableLibrary(){return portableRuntime!.get();}
/** Device preference lives outside the portable schema and managed-meeting quota. */
export const providerRegistry=new ProviderRegistry({path:join(APP_DIR,'provider-preference.json'),getLibrary:getPortableLibrary});
synchronizationUnavailable=providerRegistry.unavailable();
try{smbConnections=new SmbConnections({path:join(LIBRARY_DIR,'catalog','smb-connections.json'),catalogPath:join(LIBRARY_DIR,'catalog','state.json'),sessions:()=>sessionTags.snapshot().sessions,registry:providerRegistry,get library(){return getPortableLibrary();},busy:()=>audioWorkBusy() || !!manualNotesController || notesService.busy || tasksService.busy || chatService.busy || libraryChatService.busy});
 if(!synchronizationUnavailable)smbConnections.start();
}catch{synchronizationUnavailable=true;console.error('Synchronization unavailable. Preserve device preferences and connection configuration for recovery.');}
try{googleDriveInitializing=true;googleDrive=createGoogleDriveController({appDir:APP_DIR,libraryDir:LIBRARY_DIR,registry:providerRegistry,listSessions:()=>sessionTags.snapshot().sessions,audioBusy:()=>audioWorkBusy()||!!manualNotesController||notesService.busy||tasksService.busy||chatService.busy||libraryChatService.busy});}catch{googleDriveUnavailable=true;console.error('Google Drive unavailable. Preserve its connection configuration for recovery.');}finally{googleDriveInitializing=false;}
if(!synchronizationUnavailable&&providerRegistry.preferredId())try{providerRegistry.restore();}catch{console.error('Synchronization preference could not be restored. Check destination access and storage.');}

try{const vault=createKeychainVault(),auth=new OneDriveAuth({path:join(APP_DIR,'onedrive-account.json'),vault,openBrowser:async url=>{if(process.platform!=='darwin')throw new Error('Microsoft authorization requires macOS');const browser=track(Bun.spawn(['/usr/bin/open',url],{stdin:'ignore',stdout:'ignore',stderr:'ignore'}));if(await browser.exited!==0)throw new Error('Could not open Microsoft authorization');}});
 oneDriveConnections=new OneDriveConnections({path:join(LIBRARY_DIR,'catalog','onedrive','connections.json'),catalogPath:join(LIBRARY_DIR,'catalog','state.json'),sessions:()=>sessionTags.snapshot().sessions,auth,vault,library:getPortableLibrary,registry:providerRegistry,busy:()=>audioWorkBusy() || !!manualNotesController || notesService.busy || tasksService.busy || chatService.busy || libraryChatService.busy});
 if(!synchronizationUnavailable)oneDriveConnections.startBackground();
}catch{synchronizationUnavailable=true;console.error('OneDrive synchronization unavailable. Preserve connection configuration for recovery.');}
try{if(!synchronizationUnavailable&&providerRegistry.preferredId())providerRegistry.restore();}catch{synchronizationUnavailable=true;console.error('Synchronization destination is unavailable. Preserve device preferences for recovery.');}

async function handleLibrary(req:Request):Promise<Response>{
 if(!permissionRequestAllowed(req,PORT))return new Response(null,{status:403});
 if(synchronizationUnavailable)return Response.json({error:'Synchronization unavailable. Preserve its configuration for recovery.',code:'unavailable'},{status:503});
 try{return await libraryResponse(req,getPortableLibrary(),()=>portableRuntime!.migrate(req.signal),audioWorkBusy);}catch(error){const message=(error as Error).message;return Response.json({error:message,code:/quota|reservation/i.test(message)?'quota-blocked':'unavailable'},{status:/quota|reservation/i.test(message)?409:503});}
}

async function handleStorage(req:Request):Promise<Response>{
 if(!permissionRequestAllowed(req,PORT))return new Response(null,{status:403});
 const path=new URL(req.url).pathname;
 try{
  if(req.method==='GET' && path==='/api/storage')return Response.json(managedQuota.snapshot());
  if(req.method!=='POST')return new Response(null,{status:405});
  const body=await req.json();if(!validManagedLimit(body.limitBytes))return Response.json({error:'Choose a storage limit between 0.001048576 and 8000 GB using whole bytes.'},{status:400});
  if(path==='/api/storage/preview')return Response.json(managedQuota.preview(body.limitBytes));
  if(path==='/api/storage/settings'){
   if(body.limitBytes<managedQuota.snapshot().limitBytes && audioWorkBusy())return Response.json({error:'Wait for active recording and finalization before lowering the storage limit.'},{status:409});
   return Response.json(managedQuota.apply(body.limitBytes,body.token));
  }
  return new Response(null,{status:404});
 }catch(error){return Response.json({error:(error as Error).message},{status:409});}
}

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
 if(!permissionRequestAllowed(req,PORT))return new Response(null,{status:403});
	let input: string;
	let language = "auto";
	let diarize = true;
	let inputFilePath: string | null = null;
 let uploadFile:File|null=null;
 let recordingFinalize = false;
 let finalModelOverride: string | null = null;

	const contentType = req.headers.get("content-type") || "";

	if (contentType.includes("multipart/form-data")) {
		const formData = await req.formData();
  recordingFinalize = formData.get("recording_finalize") === "true";
  finalModelOverride = formData.get("final_model") as string | null;
		const file = formData.get("file") as File | null;
		const url = formData.get("url") as string | null;
		language = (formData.get("language") as string) || "auto";
		diarize = formData.get("diarize") !== "false";

		if (file && file.size > 0) {
   uploadFile=file;
   input=file.name;
		} else if (url) {
			input = url;
		} else {
			return Response.json({ error: "No file or URL provided" }, { status: 400 });
		}
	} else {
		const body = await req.json();
  recordingFinalize = body.recording_finalize === true;
  finalModelOverride = body.final_model || null;
		input = body.url || body.input;
		language = body.language || "auto";
		diarize = body.diarize || false;
		if (!input) return Response.json({ error: "No input provided" }, { status: 400 });
	}

 if (recordingFinalize) {
  try { recordingFinalizationOptions(language, finalModelOverride); } catch (error) { return Response.json({error:(error as Error).message}, {status:400}); }
  if (recorderProc || recorderStarting || recorderStopping || recordingFinalizationRunning) return Response.json({error:"Wait for the current recording or final transcription to finish"}, {status:409});
 }
 if (!uploadFile && retainedProcessing.get(resolve(input)) === Infinity) {
  return Response.json({error:"This audio is still recording or processing. Wait until it finishes before recovery."}, {status:409});
 }

	// For URLs, first download with yt-dlp then clean audio with ffmpeg
 const isUrl = !uploadFile && /^https?:\/\//i.test(input);
 const directRecovery=!uploadFile && !isUrl && input.endsWith(".wav") && (recordingFinalize || /(?:^|\/)dual-capture-/.test(input));
 const jobId=randomUUID(),workDirectory=join(APP_DIR,'library','staging',`media-${jobId}`);
 let wavPath=directRecovery?resolve(input):join(UPLOAD_DIR,`import-${jobId}.wav`);
 let mediaClaim!:ReturnType<typeof reserveMediaWork>;
 try{
  if(directRecovery)validateProcessingWave(input);
  const knownSize=uploadFile?.size ?? (!isUrl?statSync(input).size:undefined);
  mediaClaim=reserveMediaWork(managedQuota,jobId,wavPath,workDirectory,knownSize);
  mkdirSync(workDirectory,{recursive:true,mode:0o700});
  if(uploadFile){const safeName=uploadFile.name.replace(/[^a-zA-Z0-9._-]/g,'_');inputFilePath=join(workDirectory,safeName);writeFileSync(inputFilePath,Buffer.from(await uploadFile.arrayBuffer()));input=inputFilePath;}
 }catch(error){if(mediaClaim)mediaClaim.release();rmSync(workDirectory,{recursive:true,force:true});return Response.json({error:(error as Error).message},{status:409});}
 if (recordingFinalize) recordingFinalizationRunning = true;
 transcriptionRequests++;
 try { await preemptNotes(); } catch (error) {
  mediaClaim.release();rmSync(workDirectory,{recursive:true,force:true});
  transcriptionRequests--;
  if (recordingFinalize) recordingFinalizationRunning = false;
  return Response.json({error:"Could not release the notes model. Please try again."},{status:503});
 }
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
					const downloaded = await downloadFromUrl(input, workDirectory,{directory:workDirectory,maxBytes:mediaClaim.maxSourceBytes,signal:req.signal});
					input = downloaded.filePath;
				}

				// Normalize audio (clean noise, mono 16kHz)
				send("step", { message: "Cleaning audio..." });
    if(!directRecovery)await normalizeAudio(input,wavPath,{directory:wavPath,maxBytes:mediaClaim.maxSourceBytes,signal:req.signal});

				send("step", { message: "Processing audio..." });

    retainedProcessing.set(wavPath, Infinity);
    pruneAudio();
				// Detect dual-channel captures (L=mic, R=system)
				const isDualChannel = /(?:^|\/)dual-capture-/.test(wavPath);

    if (recordingFinalize) {
     send("step", {message:"Detecting meeting language and retranscribing the complete recording..."});
     const fin = await postJSON("/finalize", {wav_path:wavPath,work_directory:workDirectory, ...recordingFinalizationOptions(language, finalModelOverride), allowed_languages:["en","pt"], dual:isDualChannel, mic_name:micLabel()});
     send("result", finalRecordingResult(fin, wavPath));
     return;
    }

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
      work_directory:workDirectory,
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
    rmSync(workDirectory,{recursive:true,force:true});mediaClaim.release();
    if (recordingFinalize) recordingFinalizationRunning = false;
    transcriptionRequests--;
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
 if (!/^[a-zA-Z0-9_-]{1,180}$/.test(id)) return null;
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
 if (typeof transcript !== "string" || !transcript.trim()) return Response.json({error:"No transcript provided"},{status:400});
 const model = getCurrentModel();
 if (!model) return Response.json({error:"Choose a notes model before generating notes",needsModelSelection:true},{status:409});
 const template = loadTemplate(templateId || "general");
 if (!template?.prompt) return Response.json({error:"The selected notes template is unavailable."},{status:400});
 if (audioWorkBusy() || manualNotesController || chatService.busy || libraryChatService.busy) return Response.json({error:"Wait for the current recording or transcription to finish."},{status:409});
 const abort = new AbortController();
 manualNotesController = abort;
 let finish!: () => void;
 const finished = new Promise<void>(resolve => { finish = resolve; });
 manualNotesDone = finished;
 const cancel = () => abort.abort();
 req.signal.addEventListener("abort", cancel, {once:true});
 const encoder = new TextEncoder();
 let closed = false;
 const stream = new ReadableStream({
  async start(controller) {
   const send = (data: unknown) => { if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); };
   try {
    await Promise.all([notesService.preempt(),tasksService.preempt()]);
    await generateLocalNotes({baseUrl:OLLAMA_HOST,model,templatePrompt:template.prompt,transcript,
     language:language || "en",signal:abort.signal,numGpu:force_cpu ? 0 : getCurrentNumGpu(),
     numThread:Math.max(2,Math.floor(cpus().length / 2)),onToken:token => send({token})});
    send({done:true});
   } catch {
    if (!closed) send({error:abort.signal.aborted ? "Notes generation was interrupted. Please try again." : "Could not generate complete notes. Check the local model and Ollama, then try again."});
   } finally {
    req.signal.removeEventListener("abort",cancel);
    if (!closed) { closed = true; controller.close(); }
    if (manualNotesController === abort) { manualNotesController = null; manualNotesDone = null; }
    finish();
   }
  },
  cancel() { closed = true; abort.abort(); },
 });
 return new Response(stream,{headers:{"Content-Type":"text/event-stream","Cache-Control":"no-cache",Connection:"keep-alive"}});
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
function sessionError(error: unknown): Response {
 const message = error instanceof Error ? error.message : "Could not save the meeting.";
 const status = error instanceof TagError ? error.status : (error as { code?: string })?.code || error instanceof SyntaxError ? 500 : /not found/i.test(message) ? 404 : /changed|replacement|already running/i.test(message) ? 409 : 400;
 return Response.json({error:message},{status});
}
function handleListSessions(): Response { try { return Response.json(notesService.list()); } catch (error) { return sessionError(error); } }
async function handleCreateSession(req: Request): Promise<Response> {
 try {
  const data = notesService.create(await req.json());
  if (data.files?.wav) { retainedProcessing.delete(data.files.wav); removeChannelCopies(data.files.wav); }
  pruneAudio();
  return Response.json(notesService.get(data.id));
 } catch (error) { return sessionError(error); }
}
async function handlePatchSession(req: Request, url: URL): Promise<Response> {
 try {
  const id = url.searchParams.get("id");
  if (!id) return Response.json({error:"No id"},{status:400});
  const patch = await req.json();
  return Response.json(notesService.patch(id,patch));
 } catch (error) { return sessionError(error); }
}
function handleDeleteSession(url: URL): Response {
 try {
  const id = url.searchParams.get("id");
  if (!id) return Response.json({error:"No id"},{status:400});
  portableRuntime?.markDeleted(id);
  notesService.delete(id);
  chatService.remove(id);
  return Response.json({ok:true});
 } catch (error) { return sessionError(error); }
}
async function handleNotesSettings(req: Request): Promise<Response> {
 if (!desktopRequestAllowed(req)) return new Response(null,{status:403});
 if (req.method === "GET") return Response.json(automaticNotesSettings(loadConfig()));
 if (req.method !== "PATCH") return new Response(null,{status:405});
 try {
  const input = await req.json();
  const models = input?.enabled === true ? await listLocalNotesModels(OLLAMA_HOST) : [];
  const settings = validateNotesSettings(input,loadTemplate(input?.templateId),models);
  saveConfig({automatic_notes:settings});
  if (!settings.enabled) await notesService.preempt();
  return Response.json(settings);
 } catch (error) { return sessionError(error); }
}
async function handleNotesModels(req: Request): Promise<Response> {
 if (!desktopRequestAllowed(req)) return new Response(null,{status:403});
 try { return Response.json({models:await listLocalNotesModels(OLLAMA_HOST)}); }
 catch { return Response.json({error:"Could not list local notes models. Start Ollama and try again."},{status:503}); }
}
async function handleNotesJob(req: Request): Promise<Response> {
 if (!desktopRequestAllowed(req)) return new Response(null,{status:403});
 try {
  const {sessionId,jobId,action,replaceExisting,expectedNotes} = await req.json();
  if (typeof sessionId !== "string" || typeof jobId !== "string") return Response.json({error:"Choose a notes job."},{status:400});
  if (action === "cancel") return Response.json(notesService.cancel(sessionId,jobId));
  if (action === "retry") return Response.json(notesService.retry(sessionId,{jobId,replaceExisting:replaceExisting === true,
   expectedNotesHash:typeof expectedNotes === "string" ? notesHash(expectedNotes) : undefined}));
  return Response.json({error:"Choose cancel or retry."},{status:400});
 } catch (error) { return sessionError(error); }
}

// --- One-line summary via Ollama (for sessions list preview) ---
async function handleSummaryLine(req: Request): Promise<Response> {
 const {transcript} = await req.json();
 const model = getCurrentModel();
 if (typeof transcript !== "string" || transcript.length < 30 || !model || audioWorkBusy() || manualNotesController || chatService.busy || libraryChatService.busy) return Response.json({summary:""});
 const abort = new AbortController();
 manualNotesController = abort;
 let finish!: () => void;
 manualNotesDone = new Promise<void>(resolve => { finish = resolve; });
 try {
  await Promise.all([notesService.preempt(),tasksService.preempt()]);
  const text = await generateLocalNotes({baseUrl:OLLAMA_HOST,model,transcript:transcript.slice(0,1500),language:"meeting",signal:abort.signal,
   templatePrompt:"Write one sentence of at most 12 words describing the main meeting topic. Output only the sentence in the same language as the transcript.",numGpu:0,numThread:Math.max(2,Math.floor(cpus().length / 2))});
  return Response.json({summary:text.trim().split("\n")[0]});
 } catch { return Response.json({summary:""}); }
 finally { if (manualNotesController === abort) {manualNotesController=null;manualNotesDone=null;} finish(); }
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
//   - unavailable → explicit error; macOS never falls back to partial capture.
async function spawnSyscap(mode: CaptureMode): Promise<{ proc: ReturnType<typeof Bun.spawn> | null; denied: boolean; error?: string }> {
	const bin = getSyscapBin();
	if (!bin) return { proc: null, denied: false, error: "Native capture is missing. Run the Heed installer again." };
	try {
		const proc = track(Bun.spawn(nativeCaptureCommand(bin, mode), { stdout: "pipe", stderr: "pipe" }));
		let firstLine!: (line: string) => void;
		const first = new Promise<string>((resolve) => { firstLine = resolve; });
		// Keep draining diagnostics after readiness, including lines sharing its chunk.
		void (async () => {
			const reader = (proc.stderr as ReadableStream).getReader();
			const decoder = new TextDecoder();
			let pending = "", seenHandshake = false;
			const consume = (line: string) => {
				if (!seenHandshake && isNativeProtocolLine(line)) { seenHandshake = true; firstLine(line); return; }
				console.log(`[heed-native] ${line.slice(0, 4096)}`);
				try {
					const diagnostic = JSON.parse(line);
					if (diagnostic.error && syscapProc === proc && recorderProc) {
						void gracefulStop(recorderProc, 1500, "SIGINT");
						try { proc.kill(); } catch {}
					}
				} catch {}
			};
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					pending += decoder.decode(value, { stream: true });
					let newline: number;
					while ((newline = pending.indexOf("\n")) >= 0) { consume(pending.slice(0, newline)); pending = pending.slice(newline + 1); }
					if (pending.length > 16384) { consume(pending); pending = ""; }
				}
				if (pending) consume(pending);
			} catch (error) { console.log(`[heed-native] diagnostic stream: ${String(error)}`); }
			finally { if (!seenHandshake) firstLine(""); reader.releaseLock(); }
		})();
		const handshake = await Promise.race([first, new Promise<string>((resolve) => setTimeout(() => resolve(""), 15000))]);
		const result = verifyNativeHandshake(handshake, mode);
		if (result.ready) {
			console.log(`[heed] native capture ready: ${handshake}`);
			return { proc, denied: false };
		}
		// -3801 / "declined" / "TCC" = the permission hasn't been granted yet.
		const denied = result.permissionNeeded;
		console.log(`[heed] ScreenCaptureKit ${denied ? "permission needed" : "unavailable"} (${(handshake || "no handshake").slice(0, 80)})`);
		try { proc.kill(); } catch {}
		return { proc: null, denied, error: result.error };
	} catch (e) {
		console.log(`[heed] ScreenCaptureKit spawn failed (${(e as Error).message})`);
		return { proc: null, denied: false, error: `Native capture failed: ${(e as Error).message}` };
	}
}

function getMonitorSource(): string | null {
	if (IS_MAC) {
		// macOS captures system audio via ScreenCaptureKit (heed-syscap) — no virtual driver.
		// BlackHole support was removed (confusing: needs manual output re-routing and the user
		// hears nothing). Native capture failures are reported explicitly before recording.
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
 if (!desktopRequestAllowed(req)) return new Response(null, {status:403});
 try {
  const body = await req.json();
  const state = hydratedRecordingSnapshot(await recordingCoordinator.start(controlRequestId(body), body.mode ?? "both"));
  if (state.state === "recording") meetingDetection.manualOverride();
  return Response.json({...state, snapshot:state, recording:state.state === "recording", path:state.path, language:"en"});
 } catch (error) { return recordingControlError(error); }
}

function captureMetadataPaths(id:string){return [join(SESSIONS_DIR,`${id}.json`),join(APP_DIR,'recording-manifest.json'),join(APP_DIR,'recording-recovery',`${id}.json`)];}

async function beginSysRecording(mode: CaptureMode, attachPath: (path: string) => void): Promise<Response> {
 recordingLanguage = "en";

	if (syscapProc) {
		try { syscapProc.kill(); } catch {}
		syscapProc = null;
	}
	// Reset live transcription state for the new recording
	liveTranscribeOffset = 0;
	liveChunkProcessing = false;
	// Pick up the engine-adaptive live cadence (parakeet = fast) before the loop starts.
	recordingLiveModel = undefined;
	await refreshLiveTuning();

	const ts = Date.now();
	quotaReachedAt = 0; quotaStopResult = null;
 pruneAudio();
	recorderStartedAt = 0;
	const mic = getMicSource() || "default";

 const proposedDual = mode === "both" && (IS_MAC || !!getMonitorSource());
 recorderPath = join(UPLOAD_DIR, `${proposedDual ? "dual-capture" : "capture"}-${ts}.wav`);
 recordingWorkDirectory=join(APP_DIR,'library','staging',`capture-${recordingCoordinator.snapshot().meetingId!}`);
 mkdirSync(recordingWorkDirectory,{recursive:true,mode:0o700});
 captureLimitBytes=reserveCapture(managedQuota,recordingCoordinator.snapshot().meetingId!,recorderPath,recordingWorkDirectory,captureMetadataPaths(recordingCoordinator.snapshot().meetingId!)).maxCaptureBytes;
 attachPath(recorderPath);
 retainedProcessing.set(recorderPath, Infinity);

	// macOS captures both sources in one native PCM clock. Never silently fall back
	// to the old AVFoundation/second-input path if a source cannot be captured.
	if (IS_MAC) {
		const r = await spawnSyscap(mode);
		syscapProc = r.proc;
		if (!r.proc) {
			recorderStartedAt = 0;
			return Response.json({ recording: false, permissionNeeded: r.denied, error: r.error, mode }, { status: r.denied ? 200 : 503 });
		}
	}
	const usedSyscap = !!syscapProc;
	const monitor = usedSyscap ? null : getMonitorSource();
	// system source exists if SCK is active OR a (Linux) monitor was found.
	const haveSystem = (usedSyscap && mode !== "mic") || !!monitor;

	// Naming convention: dual-capture-* signals stereo (L=mic, R=system) → channel-based diarization later.
	const isDual = mode === "both" && haveSystem;


	let args: string[];
	// When SCK feeds the system channel, ffmpeg reads its raw PCM from stdin (pipe:0).
	let stdinStream: ReadableStream | undefined;

	if (usedSyscap) {
		args = nativeRecordingCommand(mode, recorderPath);
		stdinStream = syscapProc!.stdout as ReadableStream;
	} else if (mode === "system") {
		if (!monitor) return Response.json({ error: "No system audio monitor found" }, { status: 500 });
		args = ["ffmpeg", "-y", "-f", AUDIO_FMT, "-i", monitor, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", recorderPath];
	} else if (mode === "mic" || !monitor) {
		args = ["ffmpeg", "-y", "-f", AUDIO_FMT, "-i", mic, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", recorderPath];
	} else {
		const MERGE = ["-filter_complex", "[0:a]aresample=16000,pan=mono|c0=c0[micL];[1:a]aresample=16000,pan=mono|c0=c0[sysR];[micL][sysR]amerge=inputs=2[out]", "-map", "[out]", "-ar", "16000", "-ac", "2", "-c:a", "pcm_s16le"];
		args = ["ffmpeg", "-y", "-f", AUDIO_FMT, "-i", mic, "-f", AUDIO_FMT, "-i", monitor, ...MERGE, recorderPath];
	}

	// CRITICAL for live transcription: force ffmpeg to flush each packet to disk so the WAV file
	// GROWS continuously. Without this, ffmpeg buffers output in ~256KB (~4s) blocks → the file
	// stays 0 bytes then jumps; the live loop derives "new audio" from the file SIZE, so a
	// non-growing file means it never feeds the streaming model → live never appears until stop.
	// Physical output limit; the margin covers the header and the final FFmpeg packet.
 args.splice(args.length - 1, 0, "-flush_packets", "1", "-rf64", "auto", "-fs", String(captureLimitBytes));

	recorderStartedAt = Date.now();
	recorderProc = track(Bun.spawn(args, stdinStream ? { stdin: stdinStream, stdout: "pipe", stderr: "pipe" } : { stdout: "pipe", stderr: "pipe" }));

 const writer = recorderProc;
 const helper = syscapProc;
 if (helper) void helper.exited.then(async () => {
  if (syscapProc !== helper || recorderProc !== writer || recorderStopping || quotaReachedAt) return;
  recorderStopping = true;
  try {
   await gracefulStop(writer,1500,"SIGINT");
   recorderProc = null; syscapProc = null;
   stopLiveTranscribe(); stopLevelMeter();
   recordingCoordinator.captureFailed("Native audio capture stopped unexpectedly. Retained audio is available for recovery.");
  } finally { recorderStopping = false; }
 });
 void new Response(writer.stderr).text().then(text => { if (text) console.log(`[heed-capture] ${text.slice(-4096)}`); });
 void writer.exited.then(() => {
  if (recorderProc !== writer || recorderStopping || quotaReachedAt) return;
  if (recorderPath && existsSync(recorderPath) && statSync(recorderPath).size >= captureLimitBytes - Math.min(1_000_000,Math.floor(captureLimitBytes/20))) {
   quotaReachedAt = Date.now();
   const state = recordingCoordinator.snapshot();
   if (state.meetingId) void recordingCoordinator.stop(`quota-${state.meetingId}`,state.meetingId)
    .then(result => {quotaStopResult=result.session;}).catch(error=>console.error("Quota finalization failed:",error));
   return;
  }
  recorderProc = null;
  if (syscapProc) { try { syscapProc.kill(); } catch {} syscapProc = null; }
  stopLiveTranscribe(); stopLevelMeter();
  recordingCoordinator.captureFailed("Audio capture stopped unexpectedly. Retained audio is available for recovery.");
 });
 const readyUntil = Date.now() + 5000;
 while (!existsSync(recorderPath) || statSync(recorderPath).size < 44) {
  if (writer.exitCode !== null || Date.now() >= readyUntil) {
   throw new Error("Audio writer did not become ready. Check capture permissions and retry.");
  }
  await Bun.sleep(25);
 }
 if (writer.exitCode !== null || recorderProc !== writer || (helper && helper.exitCode !== null)) {
  throw new Error("Audio capture ended before recording became ready. Retained audio is available for recovery.");
 }
 startLiveTranscribe();

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
let recordingLiveModel: string | undefined;
let liveTuning = { chunk_s: 3.0, interval_ms: 2000, mode: "chunk" as "chunk" | "full" | "stream" };
async function refreshLiveTuning() {
	try {
		const r = await fetch(`${TRANSCRIPTION_SERVER}/health`, { signal: AbortSignal.timeout(2000) });
		if (r.ok) {
			const h = await r.json() as { live_tuning?: { chunk_s?: number; interval_ms?: number; mode?: "chunk" | "full" | "stream"; model?: string }; whisper_info?: {live_model?: string} };
			recordingLiveModel = h.live_tuning?.model || h.whisper_info?.live_model;
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
		const outPath = join(recordingWorkDirectory || UPLOAD_DIR, `live-full-${c.label}-${Date.now()}.wav`);
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
                    signal: liveAbort.signal,
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
	const segPath = join(recordingWorkDirectory || UPLOAD_DIR, `live-seg-${channelIdx}-${Date.now()}.wav`);
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
		const ok = await postLiveJSON("/stream/start", { language: lang, channel: "mic" });
		if (!ok) return;
		if (isDual) {
			await postLiveJSON("/stream/start", { language: lang, channel: "sys" });
			await postLiveJSON("/diar/start", {});
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
			const tx = await postLiveJSON("/stream/feed", { wav_path: micSeg, channel: "mic", audio_s: newAudio, ref_wav_path: sysSeg || undefined, mic_is_owner: micIsOwner });
			if (tx) {
				micPartial = (tx.partial || "");
				if (tx.quality) send("quality", tx.quality.ok === false ? { ok: false, reason: tx.quality.reason, hint: tx.quality.hint } : { ok: true });
			}
		} finally { try { unlinkSync(micSeg); } catch {} }
	}
	if (isDual && sysSeg) {
		try {
			const sx = await postLiveJSON("/stream/feed", { wav_path: sysSeg, channel: "sys", audio_s: newAudio });
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
					const d = await postLiveJSON("/diar/live", { wav_path: sysWin, window_s: fileDurationS - winStart });
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
					const d = await postLiveJSON("/mic/filter", { wav_path: micWin, window_s: fileDurationS - winStart });
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
		if (text) send("turn", { id: liveTurnId, channel: active, speaker, text, start: last?.startT ?? start, end: last?.endT ?? fileDurationS });
	}
	lastMicLen = micPartial.length;
	lastSysLen = sysPartial.length;
}

let liveFirstTimeout: ReturnType<typeof setTimeout> | null = null;
let liveAbort = new AbortController();
let liveWorker: Promise<void> | null = null;
const liveListeners = new Set<(event: string, data: unknown) => void>();
async function postLiveJSON(path: string, body: unknown): Promise<any> {
 try {
  const response = await fetch(`${TRANSCRIPTION_SERVER}${path}`, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body), signal:liveAbort.signal});
  return response.ok ? await response.json() : null;
 } catch { return null; }
}
function startLiveTranscribe() {
 if (!recorderProc || !recorderPath || liveTranscribeInterval || liveFirstTimeout) return;
 liveAbort = new AbortController();
 const wavPath = recorderPath;
 const isDual = wavPath.includes("dual-capture-");
 const LIVE_CHUNK = liveTuning.chunk_s;
 let interval = liveTuning.interval_ms;
 const lang = "en";
 const send = (event: string, data: unknown) => {
  if (!recorderProc || recorderPath !== wavPath || liveAbort.signal.aborted) return;
  recordingCoordinator.live(event, data);
  for (const listener of liveListeners) listener(event, data);
 };
			const processChunk = async () => {
				if (!recorderProc || recorderPath !== wavPath || liveAbort.signal.aborted) {
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
                    liveChunkProcessing = false;
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
				const chunkPath = join(recordingWorkDirectory || UPLOAD_DIR, `live-chunk-${Date.now()}.wav`);

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
                        signal: liveAbort.signal,
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
						const sysChunkPath = join(recordingWorkDirectory || UPLOAD_DIR, `live-chunk-sys-${Date.now()}.wav`);
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
                                signal: liveAbort.signal,
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

 const tick = () => { if (!liveChunkProcessing) liveWorker = processChunk().finally(() => { liveWorker = null; }); };
 liveFirstTimeout = setTimeout(() => { liveFirstTimeout = null; tick(); liveTranscribeInterval = setInterval(tick, interval); },300);
}
function handleLiveTranscribe(): Response {
 return sseResponse(async (sink, signal) => {
  sink.send("snapshot", hydratedRecordingSnapshot());
  const listener = (event:string, data:unknown) => sink.send(event,data);
  liveListeners.add(listener);
  const unsubscribe = recordingCoordinator.subscribe(state => sink.send("snapshot",hydratedRecordingSnapshot(state)));
  await new Promise<void>(resolve => signal.addEventListener("abort",()=>resolve(),{once:true}));
  liveListeners.delete(listener); unsubscribe();
 }, {heartbeatMs:1000});
}

function stopLiveTranscribe() {
 liveAbort.abort();
 if (liveFirstTimeout) { clearTimeout(liveFirstTimeout); liveFirstTimeout = null; }
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

function controlRequestId(body: any): string {
 if (body?.requestId === undefined) return crypto.randomUUID();
 if (typeof body.requestId !== "string" || !body.requestId.trim() || body.requestId.length > 128) throw new Error("Choose a valid recording request ID");
 return body.requestId;
}
function recordingControlError(error: unknown): Response {
 return Response.json({error:error instanceof Error ? error.message : String(error)}, {status:409});
}
async function handleSysRecordStop(req: Request): Promise<Response> {
 if (!desktopRequestAllowed(req)) return new Response(null,{status:403});
 try {
  const body = await req.json();
  const previous = recordingCoordinator.snapshot();
  const manualStop = previous.meetingId === body.meetingId && ["starting","recording"].includes(previous.state);
  const state = hydratedRecordingSnapshot(await recordingCoordinator.stop(controlRequestId(body),body.meetingId));
  if (manualStop) meetingDetection.manualOverride();
  const session = state.session;
  return Response.json({...state, snapshot:state, finalized:state.state === "completed", path:session?.files?.wav || state.path,
   duration:session?.duration, language:session?.language, model:session?.transcriptionModel, liveModel:session?.liveModel,
   turns:session?.segments ?? [], streamText:session?.transcript ?? "", embeddings:session?.embeddings, session});
 } catch (error) { return recordingControlError(error); }
}
async function stopCapture(onCaptureStopped: () => void): Promise<FinalCapture> {
 recorderStopping = true;
 const path = recorderPath;
 try {
  if (!recorderProc || !path) throw new Error("Not recording");
  const wasStreaming = streamStarted;
  stopLiveTranscribe();
  if (syscapProc) { await gracefulStop(syscapProc,1500,"SIGTERM"); syscapProc = null; }
  await gracefulStop(recorderProc,1500,"SIGINT");
  recorderProc = null; recorderPath = null; stopLevelMeter();
  onCaptureStopped();
  if (liveWorker) await liveWorker;
  if (wasStreaming) {
   try { await postJSON("/stream/finish",{channel:"mic"}); } catch {}
   if (path.includes("dual-capture-")) {
    try { await postJSON("/stream/finish",{channel:"sys"}); await postJSON("/diar/finish",{}); } catch {}
   }
  }
  return await finalizeCapture(path);
 } finally { recorderStopping = false; }
}
async function finalizeCapture(path: string): Promise<FinalCapture> {
 if (!existsSync(path)) throw new Error("Recording file not created");
 const fin = await postJSON("/finalize",{wav_path:path,work_directory:recordingWorkDirectory,language:"auto",allowed_languages:["en","pt"],dual:path.includes("dual-capture-"),mic_name:micLabel()});
 const result = finalRecordingResult(fin,path);
 // Final ASR must return the actual WAV duration instead of wall-clock capture time.
 if (result.duration === undefined) {
  const probe = Bun.spawnSync(["ffprobe","-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1",path]);
  const measured = Number(new TextDecoder().decode(probe.stdout).trim());
  if (probe.exitCode !== 0 || !Number.isFinite(measured) || measured <= 0) throw new Error("Could not measure the retained recording duration");
  result.duration = measured;
 }
 recordingLanguage = result.metadata.language;
 return {path,duration:result.duration,language:result.metadata.language,model:result.metadata.model,liveModel:recordingLiveModel || recordingCoordinator.snapshot().liveModel,turns:result.segments,embeddings:result.embeddings};
}

// Compatibility stream reports authoritative capabilities; app/process presence is not a call.
function handleDetectorStream(req: Request): Response {
 if (!desktopRequestAllowed(req)) return new Response(null,{status:403});
 return sseResponse(async (sink, signal) => {
  const send = () => sink.data({event:"status",detection:meetingDetection.status()});
  send(); const timer = setInterval(send,2000);
  try { await new Promise<void>(resolve => signal.addEventListener("abort",()=>resolve(),{once:true})); }
  finally { clearInterval(timer); }
 }, {heartbeatMs:15000});
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
 recoveryMeetingId?:string;
 speakerNames?:Record<string,string>;
 segments?:RecordingSnapshot["segments"];
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

 // Archived failed checkpoints retain manual names after leaving active recovery.
 const archived = new Map<string,RecordingSnapshot>();
 const recoveryDirectory=join(APP_DIR,"recording-recovery");
 if (existsSync(recoveryDirectory)) for (const file of readdirSync(recoveryDirectory).filter(file=>file.endsWith(".json"))) {
  try {
   const record=JSON.parse(readFileSync(join(recoveryDirectory,file),"utf8"));
   const snapshot=record?.snapshot as RecordingSnapshot;
   if (record?.version===1 && snapshot?.state === "failed" && typeof snapshot.path === "string" && typeof snapshot.meetingId === "string" && Array.isArray(snapshot.segments) && snapshot.speakerNames && typeof snapshot.speakerNames === "object") archived.set(snapshot.path,snapshot);
  } catch { /* Invalid recovery metadata never prevents listing retained audio. */ }
 }
	// An orphan = WAV exists but no session references it
	const orphans: OrphanedRecording[] = [];
	for (const f of wavFiles) {
		const fullPath = join(UPLOAD_DIR, f);
		if (sessionPaths.has(fullPath) || fullPath === recorderPath || retainedProcessing.get(fullPath) === Infinity) continue;

		const stat = Bun.file(fullPath);
		const sizeBytes = stat.size;
		const isDual = f.startsWith("dual-capture-");
		// Estimate duration: 16kHz × 16-bit × channels = bytes/sec
		const bytesPerSec = isDual ? 64000 : 32000; // stereo vs mono
		const durationS = Math.round(sizeBytes / bytesPerSec);

		// Extract timestamp from filename: capture-{ts}.wav or dual-capture-{ts}.wav
		const tsMatch = f.match(/(\d+)\.wav$/);
		const ts = tsMatch ? parseInt(tsMatch[1]) : Date.now();

  const checkpoint=archived.get(fullPath);
		orphans.push({
   ...(checkpoint?{recoveryMeetingId:checkpoint.meetingId!,speakerNames:checkpoint.speakerNames,segments:checkpoint.segments}:{}),
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
 if (resolve(path) === recorderPath || retainedProcessing.get(resolve(path)) === Infinity) return Response.json({error:"Audio is still recording or processing"}, {status:409});
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

// Every desktop/browser client observes the same backend-owned lifecycle.
function desktopRequestAllowed(req: Request): boolean { return permissionRequestAllowed(req,PORT); }
/** Completed manifests are recovery checkpoints; the meeting store owns later edits/deletion. */
function hydratedRecordingSnapshot(snapshot: RecordingSnapshot = recordingCoordinator.snapshot()): RecordingSnapshot {
 if (snapshot.state !== "completed") return snapshot;
 const session = snapshot.session ? notesService.get(snapshot.session.id) : null;
 return {...snapshot,session,segments:session?.segments ?? [],speakerNames:{},path:session?.files?.wav || null,
  seconds:session?.duration ?? 0,liveModel:session?.liveModel,finalCapture:undefined};
}
function desktopRecordingStatus() {
 const state = hydratedRecordingSnapshot();
 return {...state, snapshot:state, seconds:Math.floor(state.seconds), recording:!!recorderProc && recorderProc.exitCode === null,
  processing:["stopping","finalizing"].includes(state.state) || recordingFinalizationRunning,
  starting:state.state === "starting", pending:false, clientConnected:true, ready:!state.maintenance,
  smbCommand:smbConnections?.desktopCommand()||null,meetingDetection:meetingDetection.status(),language:recordingLanguage,uiLocale:configuredUiLocale(loadConfig()),storage:{...managedQuota.snapshot(),bytes:managedQuota.snapshot().usedBytes},quotaStopped:!!quotaStopResult};
}
async function handleRecordingControl(req: Request, pathname: string): Promise<Response> {
 if (!desktopRequestAllowed(req)) return new Response(null,{status:403});
 try {
  if (req.method === "GET" && pathname === "/api/recording/status") return Response.json(hydratedRecordingSnapshot());
  if (req.method !== "POST") return new Response(null,{status:405});
  const body = await req.json();
  if (pathname === "/api/recording/speakers") return Response.json(recordingCoordinator.rename(body.meetingId,body.expectedRevision,body.speakerNames));
  if (pathname === "/api/recording/retry") return Response.json(hydratedRecordingSnapshot(await recordingCoordinator.retry(controlRequestId(body),body.meetingId)));
  if (pathname === "/api/recording/abandon") {
   const previous=recordingCoordinator.snapshot();
   const state=await recordingCoordinator.abandon(controlRequestId(body),body.meetingId);
   cleanupCaptureWork(body.meetingId);
   releaseCapture(managedQuota,body.meetingId);
   if (previous.path && state.state === "idle") {
    retainedProcessing.delete(previous.path);
    if (!recorderProc && recorderPath === previous.path) recorderPath=null;
   }
   return Response.json(hydratedRecordingSnapshot(state));
  }
  if (pathname === "/api/recording/maintenance") {
   if (typeof body.acquire !== "boolean" || typeof body.owner !== "string" || !body.owner.trim() || body.owner.length > 128) return Response.json({error:"Choose a valid maintenance owner"},{status:400});
   return Response.json(hydratedRecordingSnapshot(recordingCoordinator.setMaintenance(body.acquire,body.owner)));
  }
  return Response.json({error:"Unknown recording control endpoint"},{status:404});
 } catch (error) { return recordingControlError(error); }
}
async function handleDesktopControl(req: Request, pathname: string): Promise<Response> {
 if (!desktopRequestAllowed(req)) return Response.json({error:"Desktop control is available only on localhost"},{status:403});
 try {
  if (req.method === "GET" && pathname.endsWith("/status")) {
   const status = desktopRecordingStatus();
   try { const health = await fetch(`${TRANSCRIPTION_SERVER}/health`,{signal:AbortSignal.timeout(1500)}); const data=await health.json(); status.ready = !status.maintenance && data.whisper === true; } catch {status.ready=false;}
   return Response.json({...status,permissionRequest:desktopPermissions.request()});
  }
  const body = await req.json();
  if (pathname.endsWith("/commands")) {
   if (!["start","stop"].includes(body.action)) return Response.json({error:"Choose start or stop"},{status:400});
   const id = controlRequestId(body);
   const previous = recordingCoordinator.snapshot();
   const manualStop = body.action === "stop" && previous.meetingId === body.meetingId && ["starting","recording"].includes(previous.state);
   const state = body.action === "start" ? await recordingCoordinator.start(id,body.mode ?? "both") : await recordingCoordinator.stop(id,body.meetingId);
   if (manualStop || (body.action === "start" && state.state === "recording")) meetingDetection.manualOverride();
   return Response.json({ok:true,id,status:desktopRecordingStatus(),snapshot:hydratedRecordingSnapshot(state)});
  }
  if (pathname.endsWith("/poll")) return Response.json({command:null,status:desktopRecordingStatus()});
  if (pathname.endsWith("/complete")) return Response.json({ok:true,status:desktopRecordingStatus()});
  return Response.json({error:"Unknown desktop control endpoint"},{status:404});
 } catch (error) { return recordingControlError(error); }
}

async function handleUiLocale(req:Request):Promise<Response> {
 if (!desktopRequestAllowed(req)) return Response.json({error:"Interface preferences are available only on localhost"},{status:403});
 if (req.method === "GET") return Response.json({locale:configuredUiLocale(loadConfig())});
 try {
  const body=await req.json();
  if (!supportedUiLocale(body.locale)) return Response.json({error:"Choose en, pt-BR, fr or de"},{status:400});
  saveConfig({ui_locale:body.locale});
  return Response.json({locale:body.locale});
 } catch {return Response.json({error:"Could not save interface language"},{status:400});}
}

async function handleDesktopPermissions(req: Request, pathname: string): Promise<Response> {
 if (!desktopRequestAllowed(req)) return Response.json({error:"Permissions are available only on localhost."}, {status:403});
 if (req.method === "GET" && pathname === "/api/desktop/permissions") return Response.json(desktopPermissions.status());
 if (req.method !== "POST") return Response.json({error:"Method not allowed."}, {status:405});
 let body: unknown;
 try { body = await req.json(); } catch { return Response.json({error:"Invalid JSON body."}, {status:400}); }
 if (pathname === "/api/desktop/permissions/report") {
  const report = permissionReport(body);
  if (!report) return Response.json({error:"Invalid permission report."}, {status:400});
  desktopPermissions.report(report);
  return Response.json({ok:true});
 }
 if (pathname !== "/api/desktop/permissions") return Response.json({error:"Unknown permissions endpoint."}, {status:404});
 const action = permissionAction(body);
 if (!action) return Response.json({error:"Choose microphone, screenCapture, slackLogs, or accessibility."}, {status:400});
 try { return Response.json({ok:true,id:desktopPermissions.enqueue(action)}); }
 catch (error) { return Response.json({error:(error as Error).message}, {status:409}); }
}

// --- Router ---
// Prune old audio during capture; never remove the ongoing meeting.
let retentionBusy=false;
setInterval(async () => {
 if(retentionBusy)return;retentionBusy=true;
 try {
  pruneAudio();
  if(recorderProc && recorderPath && !recorderStopping) {
   const size=existsSync(recorderPath)?statSync(recorderPath).size:0;
   if(size >= captureLimitBytes - Math.min(1_000_000,Math.floor(captureLimitBytes/20))) {
    if(!quotaReachedAt) {
     quotaReachedAt=Date.now();
     // Stop writing only; keep the path for normal finalization.
     if(syscapProc){try{syscapProc.kill();}catch{}syscapProc=null;}
     await gracefulStop(recorderProc,1500,"SIGINT");
    }
    const state = recordingCoordinator.snapshot();
    if (state.meetingId && state.state === "recording") {
     await recordingCoordinator.stop(`quota-${state.meetingId}`,state.meetingId);
     quotaStopResult = recordingCoordinator.snapshot().session;
    }
   }
  }
 }catch(error){console.error('[heed] audio retention:',error);}
 finally{retentionBusy=false;}
},1000);

const notesService: AutomaticNotesService = new AutomaticNotesService({
 sessionsDir:SESSIONS_DIR,
 sessionStore:sessionTags,
 getSettings:() => automaticNotesSettings(loadConfig()),
 loadTemplate:id => loadTemplate(id) || undefined,
 isBusy:() => audioWorkBusy() || !!manualNotesController || tasksService.busy || chatService.busy || libraryChatService.busy,
 generate:({session,job,signal,onProgress}) => generateLocalNotes({baseUrl:OLLAMA_HOST,model:job.model,templatePrompt:job.templatePrompt,
  transcript:renderNotesTranscript(session),language:job.language,signal,onProgress,numGpu:getCurrentNumGpu(),numThread:Math.max(2,Math.floor(cpus().length / 2))}),
});
const tasksService: MeetingTasksService = new MeetingTasksService({
 path:join(APP_DIR,"tasks.json"),
 listSessions:() => notesService.list(),
 getSession:id => notesService.get(id),
 isBusy:() => audioWorkBusy() || !!manualNotesController || notesService.busy || chatService.busy || libraryChatService.busy,
 generate:(session,signal) => generateTaskSuggestions(session,signal,{baseUrl:OLLAMA_HOST,model:getCurrentModel() || "",numGpu:getCurrentNumGpu(),numThread:Math.max(2,Math.floor(cpus().length / 2))}),
});
notesService.recover();
const chatService: MeetingChatService = new MeetingChatService({
 directory:join(APP_DIR,"chat"), getSession:id=>notesService.get(id),
 isBusy:()=>audioWorkBusy() || !!manualNotesController || notesService.busy || tasksService.busy || libraryChatService.busy,
 generate:generateChatEvidence,
});
function generateChatEvidence(input:ChatGenerationRequest) {
 return generateLocalStructured({baseUrl:OLLAMA_HOST,model:input.model,system:CHAT_SYSTEM,requireCompletion:true,contextTokens:8192,maxInputBytes:5500,
  data:{question:input.question,history:input.history.slice(-2).map(turn=>({question:turn.question.slice(0,100),answer:turn.answer?.claims.slice(0,2).map(claim=>claim.text).join("\n").slice(0,200)})),evidence:input.evidence},signal:input.signal,
  numGpu:getCurrentNumGpu(),numThread:Math.max(2,Math.floor(cpus().length / 2))});
}
const libraryChatService: LibraryChatService = new LibraryChatService({
 directory:join(APP_DIR,"library-chat"),listSessions:()=>notesService.list(),
 isBusy:()=>audioWorkBusy() || !!manualNotesController || notesService.busy || tasksService.busy || chatService.busy,
 generate:generateChatEvidence,
});
const tasksTimer = setInterval(() => { void tasksService.tick().catch(error => console.error("Task suggestion queue failed:", error)); },1000);
tasksTimer.unref();
const notesTimer = setInterval(() => { void (async()=>{await notesService.tick();await chatService.tick();await libraryChatService.tick();})().catch(()=>console.error("Local AI queue failed")); },1000);
notesTimer.unref();

const recordingCoordinator = new RecordingCoordinator({
 manifestPath:join(APP_DIR,"recording-manifest.json"),
 adapter:{
  async start(mode, _meetingId, attachPath) {
   if (transcriptionRequests || recordingFinalizationRunning) throw new Error("Wait for the current transcription to finish");
   recorderStarting = true;
   try {
    await preemptNotes();
    const response = await beginSysRecording(mode,attachPath);
    const result = await response.json();
    if (!response.ok || !result.recording) throw new Error(result.error || "Capture permissions are required");
    return {path:result.path,liveModel:recordingLiveModel};
   } catch (error) {
    if (syscapProc) { try { syscapProc.kill(); } catch {} syscapProc = null; }
    if (recorderProc) { await gracefulStop(recorderProc,1500,"SIGINT"); recorderProc = null; }
    stopLiveTranscribe(); stopLevelMeter();
    if(!recorderPath || !existsSync(recorderPath))releaseCapture(managedQuota,_meetingId);
    throw error;
   } finally { recorderStarting = false; }
  },
  stop:stopCapture,
  async finalize(path) {
   await preemptNotes();
   recordingWorkDirectory=join(APP_DIR,'library','staging',`capture-${recordingCoordinator.snapshot().meetingId!}`);
   mkdirSync(recordingWorkDirectory,{recursive:true,mode:0o700});
   const id=recordingCoordinator.snapshot().meetingId!;
   validateProcessingWave(path);
   reserveFinalization(managedQuota,id,path,recordingWorkDirectory,captureMetadataPaths(id));
   return finalizeCapture(path);
  },
  save(session) {
   const saved = notesService.create(session);
   if (saved.files?.wav) { retainedProcessing.delete(saved.files.wav); removeChannelCopies(saved.files.wav); cleanupCaptureWork(saved.id); releaseCapture(managedQuota,saved.id); }
   return saved;
  },
 },
});
const retained = recordingCoordinator.snapshot();
if (retained.path && retained.state !== "completed") retainedProcessing.set(retained.path,Infinity);

let detectionModelReady = false;
const meetingDetection = new MeetingDetectionController({
 recording:recordingCoordinator, journalPath:join(APP_DIR,"meeting-detection.json"),
 isReady:() => {
  const permissions = desktopPermissions.status();
  return detectionModelReady && !transcriptionRequests && !recordingFinalizationRunning && permissions.controllerConnected
   && permissions.permissions?.microphone === "authorized" && permissions.permissions.screenCapture === true;
 },
});
recordingCoordinator.subscribe(() => meetingDetection.recordingChanged());
let detectionTickBusy = false;
const detectionTimer = setInterval(async () => {
 if (detectionTickBusy) return;
 detectionTickBusy = true;
 try {
  const detection = meetingDetection.status();
  const needsModel = detection.sources.some(source => detection.enabled[source.app] && source.state === "active");
  if (needsModel) {
   try { const response = await fetch(`${TRANSCRIPTION_SERVER}/health`,{signal:AbortSignal.timeout(1500)}); const health = await response.json(); detectionModelReady = response.ok && health.whisper === true; }
   catch { detectionModelReady = false; }
  } else detectionModelReady = false;
  await meetingDetection.tick();
 } catch (error) { console.error("Meeting detection controller failed:",error); }
 finally { detectionTickBusy = false; }
},1000);
detectionTimer.unref();

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: PORT,
	idleTimeout: 255, // max allowed — pyannote + whisper can take a while
	async fetch(req, httpServer) {
		const url = new URL(req.url);
		const method = req.method;
  const chatResponse=await chatApiResponse(req,chatService,()=>listLocalChatModels(OLLAMA_HOST),desktopRequestAllowed(req));
  if(chatResponse)return chatResponse;
  const libraryChatResult=await libraryChatResponse(req,libraryChatService,desktopRequestAllowed(req));
  if(libraryChatResult)return libraryChatResult;

  if (url.pathname === "/api/tasks") return tasksResponse(req,tasksService,PORT);
  if (url.pathname === "/api/notes/settings") return handleNotesSettings(req);
  if (method === "GET" && url.pathname === "/api/notes/models") return handleNotesModels(req);
  if (method === "POST" && url.pathname === "/api/notes/jobs") return handleNotesJob(req);
  if ((method === "POST" || method === "PATCH" || method === "DELETE") && ["/api/sessions", "/api/summarize", "/api/summary-line"].includes(url.pathname)
   && !desktopRequestAllowed(req)) return new Response(null,{status:403});
  if ((method === "GET" || method === "POST") && url.pathname === "/api/ui-locale") return handleUiLocale(req);
		if (method === "POST" && url.pathname === "/api/transcribe") { httpServer.timeout(req, 0); return handleTranscribe(req); }
		// Stop and recording recovery use the authoritative full-audio /finalize sidecar pass.
		if (method === "POST" && url.pathname === "/api/summarize") return handleSummarize(req);
		if (method === "POST" && url.pathname === "/api/summary-line") return handleSummaryLine(req);
		// /api/diarize removed — finalize handles speaker identification now
        const audioRoute = /^\/api\/sessions\/([^/]+)\/audio$/.exec(url.pathname);
        if (audioRoute && (method === "GET" || method === "HEAD")) {
            if (!desktopRequestAllowed(req)) return new Response(null, {status:403});
            let sessionId: string;
            try { sessionId = decodeURIComponent(audioRoute[1]!); } catch { return new Response(null, {status:403}); }
            return sessionAudioResponse(req, sessionId, SESSIONS_DIR, [UPLOAD_DIR,join(LIBRARY_DIR,"media")]);
        }
		if ((method === "GET" || method === "POST") && url.pathname === "/api/tags") {
      if (!desktopRequestAllowed(req)) return new Response(null, { status: 403 });
      return tagResponse(req, sessionTags, session => notesService.normalize(session));
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
		if (url.pathname === "/api/desktop/permissions" || url.pathname.startsWith("/api/desktop/permissions/")) return handleDesktopPermissions(req, url.pathname);
		if (url.pathname.startsWith("/api/recording/")) { httpServer.timeout(req,0); return handleRecordingControl(req,url.pathname); }
		if (url.pathname.startsWith("/api/meeting-detection/")) return meetingDetectionRoute(req,meetingDetection,PORT);
		if (url.pathname.startsWith("/api/desktop/control/")) { httpServer.timeout(req,0); return handleDesktopControl(req, url.pathname); }
		if(url.pathname==='/api/google-drive'){httpServer.timeout(req,0);if(!permissionRequestAllowed(req,PORT))return new Response(null,{status:403});return synchronizationUnavailable||googleDriveUnavailable||!googleDrive?Response.json({error:'Google Drive unavailable. Preserve its configuration for recovery.',code:'unavailable'},{status:503,headers:{'Cache-Control':'no-store'}}):googleDriveResponse(req,googleDrive,PORT);}
		if(url.pathname==='/api/connectors/onedrive'){httpServer.timeout(req,0);if(!desktopRequestAllowed(req))return new Response(null,{status:403});return synchronizationUnavailable||!oneDriveConnections||oneDriveConnections.unavailable()?Response.json({error:'OneDrive synchronization unavailable. Preserve its configuration for recovery.'},{status:503}):oneDriveResponse(req,oneDriveConnections);}
		if(url.pathname==='/api/smb'){httpServer.timeout(req,0);if(!desktopRequestAllowed(req))return new Response(null,{status:403});return synchronizationUnavailable||!smbConnections?Response.json({error:'Synchronization unavailable. Preserve its configuration for recovery.'},{status:503}):smbResponse(req,smbConnections);}
		if (url.pathname==='/api/library'){httpServer.timeout(req,0);return handleLibrary(req);}
		if (url.pathname==='/api/storage' || url.pathname.startsWith('/api/storage/')) return handleStorage(req);
		if (method === "POST" && url.pathname === "/api/desktop/float") return handleDesktopFloat();
		if (method === "GET" && url.pathname === "/api/meeting-detector") return handleDetectorStream(req);
		// /api/download and /api/recording removed — unused legacy endpoints
		if (method === "POST" && url.pathname === "/api/sysrecord/start") return handleSysRecordStart(req);
		if (method === "POST" && url.pathname === "/api/sysrecord/stop") { httpServer.timeout(req, 0); return handleSysRecordStop(req); }
		if (method === "GET" && url.pathname === "/api/sysrecord/levels") return desktopRequestAllowed(req) ? handleSysLevelsSSE() : new Response(null,{status:403});
		if (method === "GET" && url.pathname === "/api/sysrecord/live") return desktopRequestAllowed(req) ? handleLiveTranscribe() : new Response(null,{status:403});
		if (method === "GET" && url.pathname === "/api/health") return handleHealth();
		if (method === "GET" && url.pathname === "/api/recovery/list") return handleListOrphaned();
		if (method === "DELETE" && url.pathname === "/api/recovery/discard") return handleDiscardOrphaned(url);

		return serveStatic(url.pathname) || new Response("Not Found", { status: 404 });
	},
});

// Never leave an orphaned ffmpeg/syscap holding the mic: on SIGINT/SIGTERM/exit, gracefully reap
// every tracked child (the recorder, the system-audio capture, the level meter). Previously there
// was NO signal handler — a server crash/exit left ffmpeg running and the mic "stuck busy".
installShutdownHooks(async () => { oneDriveConnections?.close();smbConnections?.close();await googleDrive?.preempt();clearInterval(notesTimer); clearInterval(tasksTimer); manualNotesController?.abort(); void notesService.preempt(); void tasksService.preempt(); void chatService.preempt(); void libraryChatService.preempt(); stopLiveTranscribe(); });

console.log(`
  ┌──────────────────────────────────┐
  │                                  │
  │   heed app running on :${PORT}     │
  │   http://localhost:${PORT}          │
  │                                  │
  └──────────────────────────────────┘
`);
