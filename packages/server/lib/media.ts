/**
 * Media handling: download URLs with yt-dlp, normalize audio with ffmpeg.
 * Both ffmpeg and yt-dlp are expected to be installed system-wide.
 */
import { existsSync,lstatSync,readdirSync } from "node:fs";
import { join, basename } from "node:path";

import {track} from './process';
const IMPORT_FORMATS="wav,mp3,mov,matroska,webm,flac,ogg,aac,aiff";

export interface MediaBudget {directory:string;maxBytes:number;signal?:AbortSignal}
function workBytes(directory:string):number {if(!existsSync(directory))return 0;const stat=lstatSync(directory);if(stat.isSymbolicLink())throw new Error("Managed media staging contains an unsupported link");return stat.isDirectory()?readdirSync(directory).reduce((sum,name)=>sum+workBytes(join(directory,name)),0):stat.isFile()?stat.size:0;}
/** Reap bounded external writers on quota pressure, cancellation, and every error path. */
export async function runManagedMedia(proc:Bun.Subprocess<"ignore","pipe","pipe">,budget?:MediaBudget){
 track(proc);
 let failure:Error|undefined;const check=()=>{if(failure)return;try{budget?.signal?.throwIfAborted();if(budget&&workBytes(budget.directory)>=budget.maxBytes)throw new Error("Managed meeting quota reached while preparing media; no truncated output was accepted");}catch(error){failure=error instanceof Error?error:new Error("Media preparation canceled");try{proc.kill();}catch{}}};
 check();const timer=budget?setInterval(check,10):undefined;
 try{const [stdout,stderr,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);check();if(failure)throw failure;return {stdout:stdout.trim(),stderr:stderr.trim(),code};}
 finally{if(timer)clearInterval(timer);if(proc.exitCode===null){try{proc.kill();}catch{}await proc.exited;}}
}

export interface DownloadResult {
	filePath: string;
	title: string;
}

/**
 * Downloads any URL supported by yt-dlp (YouTube, TikTok, Twitter, Instagram, etc.)
 * and saves the audio in the given output directory.
 */
export async function downloadFromUrl(url: string, outputDir: string,budget?:MediaBudget): Promise<DownloadResult> {
	const timestamp = Date.now();
	const outputTemplate = join(outputDir, `download-${timestamp}.%(ext)s`);

	const proc = Bun.spawn(
		[
			"yt-dlp",
			"--no-playlist",
			"--format", "bestaudio/best",
            ...(budget?["--max-filesize",String(budget.maxBytes)]:[]),
			"--output", outputTemplate,
			"--print", "after_move:filepath",
			"--no-warnings",
			"--quiet",
			url,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);

	const {stdout,stderr,code:exitCode}=await runManagedMedia(proc,budget);

	if (exitCode !== 0) {
		throw new Error(`yt-dlp failed: ${stderr || stdout}`);
	}

	const filePath = stdout.split("\n").pop()?.trim();
	if (!filePath || !existsSync(filePath)) {
		throw new Error(`yt-dlp did not produce an output file`);
	}

	return {
		filePath,
		title: basename(filePath),
	};
}

/**
 * Normalizes any media file (mp3/mp4/webm/etc.) to a clean WAV
 * suitable for whisper: 16kHz, mono, PCM 16-bit.
 * Applies silence removal, dynamic normalization and noise reduction.
 */
export async function normalizeAudio(inputPath: string, outputPath: string,budget?:MediaBudget,preserveTimeline=false): Promise<string> {
	const proc = Bun.spawn(
		[
			"ffmpeg", "-y",
            ...(preserveTimeline?["-v","error","-protocol_whitelist","file,pipe","-format_whitelist",IMPORT_FORMATS]:[]),
			"-i", inputPath,
            ...(preserveTimeline?["-map","0:a:0","-vn"]:[]),
			"-af",
			preserveTimeline ? "dynaudnorm,afftdn=nf=-25" : "silenceremove=stop_periods=-1:stop_duration=1:stop_threshold=-40dB,dynaudnorm,afftdn=nf=-25",
			"-ar", "16000",
			"-ac", "1",
			"-c:a", "pcm_s16le", "-rf64", "auto",
            ...(budget?["-fs",String(budget.maxBytes)]:[]),
			outputPath,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);

	const normalizationBudget=preserveTimeline&&budget?{...budget,signal:AbortSignal.any([...(budget.signal?[budget.signal]:[]),AbortSignal.timeout(30*60_000)])}:budget;
	const {stderr,code:exitCode}=await runManagedMedia(proc,normalizationBudget);

	if (exitCode !== 0) {
		throw new Error(`ffmpeg failed: ${stderr.split("\n").slice(-3).join(" ")}`);
	}

	if (!existsSync(outputPath)) {
		throw new Error(`ffmpeg did not produce output: ${outputPath}`);
	}

	return outputPath;
}

/** Probe actual media content before ASR. Playlist/network demuxers are never accepted. */
export async function probeImportMedia(path:string,maxBytes:number){
 if(!Bun.which('ffmpeg')||!Bun.which('ffprobe'))throw Error('Install FFmpeg (including FFprobe) in Settings before importing recordings.');
 const proc=Bun.spawn(['ffprobe','-v','error','-protocol_whitelist','file,pipe','-format_whitelist',IMPORT_FORMATS,'-show_entries','format=duration:stream=codec_type,duration','-of','json',path],{stdout:'pipe',stderr:'pipe'});
 const result=await runManagedMedia(proc,{directory:path,maxBytes:maxBytes+1,signal:AbortSignal.timeout(30_000)});
 if(result.code!==0)throw Error('Unsupported or corrupt media. Choose a readable WAV, MP3, M4A, AAC, FLAC, OGG, AIFF, MP4 or WebM file.');
 let value:any;try{value=JSON.parse(result.stdout);}catch{throw Error('Could not inspect this media. Choose a readable audio or video recording.');}
 const audio=value.streams?.find((stream:any)=>stream.codec_type==='audio');if(!audio)throw Error('This video has no supported audio stream. Choose a recording containing audio.');
 const duration=Number(audio.duration??value.format?.duration);if(!Number.isFinite(duration)||duration<=0)throw Error('The media duration is unavailable. Repair the file or choose a complete recording.');
 return {duration,normalizedBytes:Math.ceil(duration*32_000)+4096};
}
