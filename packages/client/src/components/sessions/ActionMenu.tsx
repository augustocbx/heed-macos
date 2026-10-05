import { useEffect, useRef, useState } from "react";
import type { Session } from "@heed/shared";
import { useUIStore } from "@/stores/ui.ts";
import { fmtDate, fmtDuration } from "@/lib/format.ts";
import { stripMarkdown } from "@/lib/markdown.ts";
import styles from "./ActionMenu.module.css";

type Category = "transcript" | "speakers" | "notes";
type ExportAction = "copy-text" | "copy-md" | "export-md" | "export-txt";

interface Props {
	x: number;
	y: number;
	session: Session;
	onClose: () => void;
	onTogglePin: () => void;
	onDelete: () => void;
}

function getContent(session: Session, category: Category): { text: string; md: string } {
	if (category === "transcript") {
		return { text: session.transcript || "", md: session.transcript || "" };
	}
	if (category === "speakers") {
		if (!session.segments?.length) return { text: "", md: "" };
		let text = "";
		let md = "";
		let last = "";
		for (const seg of session.segments) {
			if (seg.speaker !== last) {
				text += `\n${seg.speaker}:\n`;
				md += `\n**${seg.speaker}:**\n`;
				last = seg.speaker;
			}
			text += `  ${seg.text}\n`;
			md += `${seg.text}\n`;
		}
		return { text: text.trim(), md: md.trim() };
	}
	if (category === "notes") {
		return { text: stripMarkdown(session.aiNotes || ""), md: session.aiNotes || "" };
	}
	return { text: "", md: "" };
}

function downloadFile(content: string, filename: string, mime: string) {
	const blob = new Blob([content], { type: mime });
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = filename;
	a.click();
	URL.revokeObjectURL(a.href);
}

export function ActionMenu({ x, y, session, onClose, onTogglePin, onDelete }: Props) {
	const ref = useRef<HTMLDivElement>(null);
	const showToast = useUIStore((s) => s.showToast);
	const [hoveredCategory, setHoveredCategory] = useState<Category | null>(null);

	useEffect(() => {
		const close = (e: MouseEvent) => {
			if (!ref.current?.contains(e.target as Node)) onClose();
		};
		setTimeout(() => document.addEventListener("click", close), 0);
		return () => document.removeEventListener("click", close);
	}, [onClose]);

	const hasSpeakers = session.segments?.length > 0;
	const hasNotes = !!session.aiNotes;

	const handleExport = (cat: Category, action: ExportAction) => {
		const { text, md } = getContent(session, cat);
		const filename = `${session.title || "session"}-${cat}`.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
		switch (action) {
			case "copy-text":
				navigator.clipboard.writeText(text);
				showToast("Copied as text");
				break;
			case "copy-md":
				navigator.clipboard.writeText(md);
				showToast("Copied as markdown");
				break;
			case "export-md":
				downloadFile(md, `${filename}.md`, "text/markdown");
				break;
			case "export-txt":
				downloadFile(text, `${filename}.txt`, "text/plain");
				break;
		}
		onClose();
	};

	const copyEverything = () => {
		const date = fmtDate(session.createdAt);
		const duration = session.duration ? fmtDuration(session.duration) : "unknown";
		const lang = session.language || "auto";
		const speakerCount = session.speakers?.length || 0;

		let out = `=== ${session.title || "Meeting"} — ${date} ===\n`;
		out += `Duration: ${duration} · Language: ${lang} · Speakers: ${speakerCount}\n\n`;
		out += `## TRANSCRIPT\n\n${session.transcript || "(empty)"}\n\n`;

		if (session.segments?.length) {
			out += `## SPEAKERS\n\n`;
			let last = "";
			for (const seg of session.segments) {
				if (seg.speaker !== last) {
					out += `\n${seg.speaker}:\n`;
					last = seg.speaker;
				}
				out += `  ${seg.text}\n`;
			}
			out += "\n";
		}

		if (session.aiNotes) out += `## AI NOTES\n\n${stripMarkdown(session.aiNotes)}\n`;

		navigator.clipboard.writeText(out);
		showToast("Copied everything");
		onClose();
	};

	const renderCategoryItem = (cat: Category, label: string, enabled: boolean, disabledReason?: string) => {
		const cls = [styles.item];
		if (!enabled) cls.push(styles.itemDisabled);
		return (
			<div
				className={cls.join(" ")}
				title={enabled ? undefined : disabledReason}
				onMouseEnter={() => enabled && setHoveredCategory(cat)}
				onMouseLeave={() => setHoveredCategory(null)}
			>
				<span>{label}</span>
				<span className={styles.arrow}>▶</span>
				{enabled && hoveredCategory === cat && (
					<div className={styles.submenu}>
						<div className={styles.item} onClick={() => handleExport(cat, "copy-text")}>Copy as text</div>
						<div className={styles.item} onClick={() => handleExport(cat, "copy-md")}>Copy as markdown</div>
						<div className={styles.item} onClick={() => handleExport(cat, "export-md")}>Export as .md</div>
						<div className={styles.item} onClick={() => handleExport(cat, "export-txt")}>Export as .txt</div>
					</div>
				)}
			</div>
		);
	};

	return (
		<div ref={ref} className={styles.menu} style={{ top: y, right: window.innerWidth - x }}>
			{renderCategoryItem("transcript", "Transcript", true)}
			{renderCategoryItem("speakers", "Speakers", hasSpeakers, "No speakers detected")}
			{renderCategoryItem("notes", "AI Notes", hasNotes, "Generate AI notes first")}
			<div className={styles.divider} />
			<div className={styles.item} onClick={copyEverything}>Copy everything</div>
			<div className={styles.divider} />
			<div className={styles.item} onClick={() => { onTogglePin(); onClose(); }}>
				{session.pinned ? "Unpin" : "Pin"}
			</div>
			<div className={`${styles.item} ${styles.itemDanger}`} onClick={() => { onDelete(); onClose(); }}>
				Delete
			</div>
		</div>
	);
}
