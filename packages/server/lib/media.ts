/**
 * Media handling: download URLs with yt-dlp, normalize audio with ffmpeg.
 * Both ffmpeg and yt-dlp are expected to be installed system-wide.
 */
import { existsSync,lstatSync,readdirSync } from "node:fs";
import { join, basename } from "node:path";

export interface MediaBudget {directory:string;maxBytes:number;signal?:AbortSignal}
function workBytes(directory:string):number {if(!existsSync(directory))return 0;const stat=lstatSync(directory);if(stat.isSymbolicLink())throw new Error("Managed media staging contains an unsupported link");return stat.isDirectory()?readdirSync(directory).reduce((sum,name)=>sum+workBytes(join(directory,name)),0):stat.isFile()?stat.size:0;}
/** Reap bounded external writers on quota pressure, cancellation, and every error path. */
export async function runManagedMedia(proc:Bun.Subprocess<"ignore","pipe","pipe">,budget?:MediaBudget){
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
export async function normalizeAudio(inputPath: string, outputPath: string,budget?:MediaBudget): Promise<string> {
	const proc = Bun.spawn(
		[
			"ffmpeg", "-y",
			"-i", inputPath,
			"-af",
			"silenceremove=stop_periods=-1:stop_duration=1:stop_threshold=-40dB,dynaudnorm,afftdn=nf=-25",
			"-ar", "16000",
			"-ac", "1",
			"-c:a", "pcm_s16le", "-rf64", "auto",
            ...(budget?["-fs",String(budget.maxBytes)]:[]),
			outputPath,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);

	const {stderr,code:exitCode}=await runManagedMedia(proc,budget);

	if (exitCode !== 0) {
		throw new Error(`ffmpeg failed: ${stderr.split("\n").slice(-3).join(" ")}`);
	}

	if (!existsSync(outputPath)) {
		throw new Error(`ffmpeg did not produce output: ${outputPath}`);
	}

	return outputPath;
}
