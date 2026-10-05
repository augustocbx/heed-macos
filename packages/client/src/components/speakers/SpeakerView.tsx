import { useState, useMemo, useEffect, useRef } from "react";
import type { Segment } from "@heed/shared";
import { speakerColor } from "@/lib/colors.ts";
import { useUIStore } from "@/stores/ui.ts";
import { voicesApi, userNameApi } from "@/api/voices.ts";
import { SpeakerMergeMenu } from "./SpeakerMergeMenu.tsx";
import styles from "./SpeakerView.module.css";

/** Reveals text with a smooth typing effect that survives live "full" mode (the whole
 * transcript is replaced each tick). On every text change we keep the longest common PREFIX
 * already on screen and only (re)type the part that actually changed — so it never re-types
 * from zero and never snaps abruptly. If the live text grows faster than 1 char/tick, it
 * catches up in proportional steps so the display never falls far behind speech. */
function TypewriterText({ text, speed = 22 }: { text: string; speed?: number }) {
	const [charCount, setCharCount] = useState(0);
	const prevText = useRef("");

	useEffect(() => {
		const prev = prevText.current;
		prevText.current = text;
		// Longest common prefix between what was there and the new text.
		let cp = 0;
		while (cp < prev.length && cp < text.length && prev[cp] === text[cp]) cp++;
		// Keep everything up to the divergence; re-type only from there.
		setCharCount((c) => Math.min(c, cp));
	}, [text]);

	useEffect(() => {
		if (charCount >= text.length) return;
		const gap = text.length - charCount;
		const step = Math.max(1, Math.floor(gap / 8)); // catch up smoothly when far behind
		const timer = setTimeout(() => setCharCount((c) => Math.min(c + step, text.length)), speed);
		return () => clearTimeout(timer);
	}, [charCount, text, speed]);

	return <>{text.slice(0, Math.min(charCount, text.length))}</>;
}

interface Props {
	segments: Segment[];
	speakers: string[];
	embeddings?: Record<string, number[]>;
	speakerNames: Record<string, string>;
	onRename: (original: string, newName: string) => void;
	onMerge: (from: string, into: string) => void;
	emptyMessage?: string;
	animateEmpty?: boolean;
}

export function SpeakerView({
	segments,
	speakers,
	embeddings,
	speakerNames,
	onRename,
	onMerge,
	emptyMessage = "Listening...",
	animateEmpty = true,
}: Props) {
	const showToast = useUIStore((s) => s.showToast);
	const [mergeMenu, setMergeMenu] = useState<{ x: number; y: number; speaker: string } | null>(null);

	// Auto-scroll: keep the transcript pinned to the bottom as it grows, UNLESS the user scrolled
	// up to read (then we don't fight them; scrolling back to the bottom re-enables auto-follow).
	const containerRef = useRef<HTMLDivElement>(null);
	const stickToBottom = useRef(true);
	const onScroll = () => {
		const el = containerRef.current;
		if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
	};
	useEffect(() => {
		const el = containerRef.current;
		if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
	}, [segments]);

	const colorMap = useMemo(() => {
		const map: Record<string, string> = {};
		speakers.forEach((s, i) => { map[s] = speakerColor(i); });
		return map;
	}, [speakers]);

	// Speakers auto-recognized from a saved voice (show a subtle badge so a wrong match is easy to
	// fix), and speakers that are the user's own mic channel (renaming them sets the mic name, not a voice).
	const autoSpeakers = useMemo(() => new Set(segments.filter((s) => s.auto).map((s) => s.speaker)), [segments]);
	const micSpeakers = useMemo(() => new Set(segments.filter((s) => s.channel === "mic").map((s) => s.speaker)), [segments]);

	if (!segments?.length) {
		return (
			<div className={styles.placeholder}>
				<span
					className={`${styles.placeholderDot} ${animateEmpty ? styles.placeholderDotPulse : styles.placeholderDotStatic}`}
				/>
				{emptyMessage}
			</div>
		);
	}

	const handleRename = async (speaker: string) => {
		const current = speakerNames[speaker] || speaker;
		const newName = window.prompt(`Rename "${current}" to:`, current);
		if (!newName?.trim()) return;
		const finalName = newName.trim();
		if (finalName === current) return;

		// If the new name collides with another existing speaker (raw label or display name),
		// perform a MERGE instead of a rename. This matches user intent — typing the same
		// name as an existing speaker should fold them together, not duplicate the label.
		const target = speakers.find((s) => s !== speaker && (s === finalName || speakerNames[s] === finalName));
		if (target) {
			onMerge(speaker, target);
			showToast(`Merged into ${finalName}`);
			return;
		}

		onRename(speaker, finalName);

		// The mic channel is the user, not a diarized voice — renaming "Me" sets the persistent
		// mic label (no embedding to save).
		if (micSpeakers.has(speaker)) {
			try {
				await userNameApi.set(finalName);
				showToast(`Your name: ${finalName}`);
			} catch {}
			return;
		}

		// Otherwise save/refresh the voiceprint so this person is auto-recognized next time.
		const emb = embeddings?.[speaker] || embeddings?.[current];
		if (emb) {
			try {
				await voicesApi.save(finalName, emb);
				showToast(`Saved voice: ${finalName}`);
			} catch {}
		}
	};

	let lastSpeaker = "";
	return (
		<div className={styles.container} ref={containerRef} onScroll={onScroll}>
			<div className={styles.hint}>Click to rename · Right-click to merge with another speaker</div>
			<div className={styles.chips} data-tour="speaker-chips">
				{speakers.map((s) => (
					<div
						key={s}
						className={styles.chip}
						title="Click to rename · Right-click to merge"
						onClick={() => handleRename(s)}
						onContextMenu={(e) => {
							e.preventDefault();
							setMergeMenu({ x: e.clientX, y: e.clientY, speaker: s });
						}}
					>
						<span className={styles.chipDot} style={{ background: colorMap[s] }} />
						<span>{speakerNames[s] || s}</span>
						{autoSpeakers.has(s) && (
							<span className={styles.autoBadge} title="Voz reconocida automáticamente — clic para corregir">auto</span>
						)}
					</div>
				))}
			</div>
			{segments.map((seg, i) => {
				const showHeader = seg.speaker !== lastSpeaker;
				lastSpeaker = seg.speaker;
				const displayName = speakerNames[seg.speaker] || seg.speaker;
				const color = colorMap[seg.speaker] || "#94A3B8";
				const isLast = i === segments.length - 1;
				return (
					<div key={i}>
						{showHeader && (
							<div className={styles.speakerHeader} style={{ color }}>
								{displayName}
								{seg.auto && <span className={styles.autoBadge} title="Voz reconocida automáticamente — clic en el chip para corregir">auto</span>}
							</div>
						)}
						<div className={`${styles.speakerLine} ${isLast ? styles.speakerLineTyping : ""}`}>
							{isLast ? <TypewriterText text={seg.text} speed={25} /> : seg.text}
							{isLast && <span className={styles.cursor} />}
						</div>
					</div>
				);
			})}

			{mergeMenu && (
				<SpeakerMergeMenu
					x={mergeMenu.x}
					y={mergeMenu.y}
					currentSpeaker={mergeMenu.speaker}
					speakers={speakers}
					speakerNames={speakerNames}
					onClose={() => setMergeMenu(null)}
					onMerge={(from, into) => {
						onMerge(from, into);
						setMergeMenu(null);
					}}
				/>
			)}
		</div>
	);
}
