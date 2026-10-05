import { useState, useRef, useEffect, useMemo } from "react";
import { useSessionsStore } from "@/stores/sessions.ts";
import { useUIStore } from "@/stores/ui.ts";
import { extractTags, stripTagsFromText } from "@/lib/tags.ts";
import styles from "./SessionDetail.module.css";

interface Props {
	sessionId: string;
	value: string;
	tags: string[];
	className?: string;
}

interface SuggestState {
	items: Array<{ tag: string; isNew: boolean }>;
	activeIdx: number;
	visible: boolean;
	x: number;
	y: number;
}

export function TitleInput({ sessionId, value, tags, className }: Props) {
	const update = useSessionsStore((s) => s.update);
	const allSessions = useSessionsStore((s) => s.sessions);
	const showToast = useUIStore((s) => s.showToast);
	const inputRef = useRef<HTMLInputElement>(null);
	const [text, setText] = useState(value);
	const [suggest, setSuggest] = useState<SuggestState>({ items: [], activeIdx: 0, visible: false, x: 0, y: 0 });

	useEffect(() => { setText(value); }, [value, sessionId]);

	const allKnownTags = useMemo(() => {
		const set = new Set<string>();
		allSessions.forEach((s) => s.tags?.forEach((t) => set.add(t)));
		return set;
	}, [allSessions]);

	const getCurrentTagFragment = (input: HTMLInputElement) => {
		const pos = input.selectionStart || 0;
		const before = input.value.slice(0, pos);
		const m = before.match(/#([\w-]*)$/);
		return m ? { fragment: m[1], start: pos - m[0].length, end: pos } : null;
	};

	const showSuggest = () => {
		const input = inputRef.current;
		if (!input) return;
		const fragment = getCurrentTagFragment(input);
		if (!fragment) {
			setSuggest((s) => ({ ...s, visible: false }));
			return;
		}
		const q = fragment.fragment.toLowerCase();
		const matches = [...allKnownTags].filter((t) => t.startsWith(q)).sort();
		const isExact = matches.includes(q);
		const items = matches.map((t) => ({ tag: t, isNew: false }));
		if (q && !isExact) items.unshift({ tag: q, isNew: true });
		if (items.length === 0) {
			setSuggest((s) => ({ ...s, visible: false }));
			return;
		}
		const rect = input.getBoundingClientRect();
		setSuggest({ items, activeIdx: 0, visible: true, x: rect.left, y: rect.bottom + 4 });
	};

	const acceptSuggest = (tag: string) => {
		const input = inputRef.current;
		if (!input) return;
		const fragment = getCurrentTagFragment(input);
		if (!fragment) return;
		const before = input.value.slice(0, fragment.start);
		const after = input.value.slice(fragment.end);
		const next = `${before}#${tag} ${after}`;
		setText(next);
		setSuggest((s) => ({ ...s, visible: false }));
		setTimeout(() => {
			input.focus();
			const pos = (before + "#" + tag + " ").length;
			input.setSelectionRange(pos, pos);
		}, 0);
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (!suggest.visible) return;
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setSuggest((s) => ({ ...s, activeIdx: Math.min(s.activeIdx + 1, s.items.length - 1) }));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setSuggest((s) => ({ ...s, activeIdx: Math.max(s.activeIdx - 1, 0) }));
		} else if (e.key === "Enter" || e.key === "Tab") {
			e.preventDefault();
			acceptSuggest(suggest.items[suggest.activeIdx].tag);
		} else if (e.key === "Escape") {
			setSuggest((s) => ({ ...s, visible: false }));
		}
	};

	const handleCommit = async () => {
		const raw = text.trim();
		const newTags = extractTags(raw);
		const cleanTitle = stripTagsFromText(raw) || "Untitled meeting";
		const merged = [...new Set([...(tags || []), ...newTags])];
		const added = newTags.filter((t) => !(tags || []).includes(t));
		const trulyNew = added.filter((t) => !allKnownTags.has(t));
		const reused = added.filter((t) => allKnownTags.has(t));

		if (cleanTitle === value && merged.length === (tags || []).length) return;

		await update(sessionId, { title: cleanTitle, tags: merged });
		setText(cleanTitle);

		if (trulyNew.length) showToast(`Created new tag${trulyNew.length > 1 ? "s" : ""}: ${trulyNew.map((t) => "#" + t).join(", ")}`);
		else if (reused.length) showToast(`Added to existing tag${reused.length > 1 ? "s" : ""}: ${reused.map((t) => "#" + t).join(", ")}`);
		else showToast("Title updated");
	};

	return (
		<>
			<input
				ref={inputRef}
				type="text"
				className={className || styles.titleInput}
				placeholder="Untitled meeting (use #tags)"
				autoComplete="off"
				value={text}
				onChange={(e) => { setText(e.target.value); showSuggest(); }}
				onKeyDown={handleKeyDown}
				onBlur={() => { setTimeout(() => setSuggest((s) => ({ ...s, visible: false })), 150); handleCommit(); }}
			/>
			{suggest.visible && (
				<div
					style={{
						position: "fixed",
						top: suggest.y,
						left: suggest.x,
						background: "var(--white)",
						border: "1px solid var(--border-light)",
						borderRadius: "8px",
						boxShadow: "var(--shadow-lg)",
						padding: "4px",
						minWidth: "200px",
						maxHeight: "240px",
						overflowY: "auto",
						zIndex: 200,
						fontFamily: "var(--mono)",
					}}
				>
					{suggest.items.map((item, i) => (
						<div
							key={item.tag}
							style={{
								padding: "6px 12px",
								fontSize: "12px",
								color: i === suggest.activeIdx ? "var(--blue)" : "var(--text)",
								background: i === suggest.activeIdx ? "var(--blue-pale)" : "transparent",
								cursor: "pointer",
								borderRadius: "6px",
								display: "flex",
								alignItems: "center",
								gap: "8px",
							}}
							onMouseDown={(e) => { e.preventDefault(); acceptSuggest(item.tag); }}
						>
							#{item.tag}
							{item.isNew && (
								<span style={{
									fontSize: "9px",
									background: "var(--green)",
									color: "var(--white)",
									padding: "1px 6px",
									borderRadius: "8px",
									marginLeft: "auto",
								}}>new</span>
							)}
						</div>
					))}
				</div>
			)}
		</>
	);
}
