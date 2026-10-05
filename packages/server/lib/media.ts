/**
 * Media handling: download URLs with yt-dlp, normalize audio with ffmpeg.
 * Both ffmpeg and yt-dlp are expected to be installed system-wide.
 */
import { existsSync } from "node:fs";
import { join, basename } from "node:path";

export interface DownloadResult {
	filePath: string;
	title: string;
}

/**
 * Downloads any URL supported by yt-dlp (YouTube, TikTok, Twitter, Instagram, etc.)
 * and saves the audio in the given output directory.
 */
export async function downloadFromUrl(url: string, outputDir: string): Promise<DownloadResult> {
	const timestamp = Date.now();
	const outputTemplate = join(outputDir, `download-${timestamp}.%(ext)s`);

	const proc = Bun.spawn(
		[
			"yt-dlp",
			"--no-playlist",
			"--extract-audio",
			"--audio-format", "mp3",
			"--audio-quality", "0",
			"--output", outputTemplate,
			"--print", "after_move:filepath",
			"--no-warnings",
			"--quiet",
			url,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);

	const stdout = (await new Response(proc.stdout).text()).trim();
	const stderr = (await new Response(proc.stderr).text()).trim();
	const exitCode = await proc.exited;

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
export async function normalizeAudio(inputPath: string, outputPath: string): Promise<string> {
	const proc = Bun.spawn(
		[
			"ffmpeg", "-y",
			"-i", inputPath,
			"-af",
			"silenceremove=stop_periods=-1:stop_duration=1:stop_threshold=-40dB,dynaudnorm,afftdn=nf=-25",
			"-ar", "16000",
			"-ac", "1",
			"-c:a", "pcm_s16le",
			outputPath,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);

	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		throw new Error(`ffmpeg failed: ${stderr.split("\n").slice(-3).join(" ")}`);
	}

	if (!existsSync(outputPath)) {
		throw new Error(`ffmpeg did not produce output: ${outputPath}`);
	}

	return outputPath;
}
