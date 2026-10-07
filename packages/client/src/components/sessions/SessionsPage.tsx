import { tr, useLocale } from "@/lib/i18n.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { tagKey, uniqueTags, type Session } from "@heed/shared";
import { useSessionsStore } from "@/stores/sessions.ts";
import { useUIStore } from "@/stores/ui.ts";
import { SessionItem } from "./SessionItem.tsx";
import { ActionMenu } from "./ActionMenu.tsx";
import { SessionDetail } from "./SessionDetail.tsx";
import { MeetingExportDialog } from './MeetingExportDialog';
import styles from "./SessionsPage.module.css";

export function SessionsPage() {
	useLocale();
	const { sessions, load, loadTags, lastTagChange, viewing, view, update, remove } = useSessionsStore();
	const showToast = useUIStore((s) => s.showToast);

	const [search, setSearch] = useState("");
	const [activeTagFilter, setActiveTagFilter] = useState<string | null>(null);
	const [menuState, setMenuState] = useState<{ x: number; y: number; session: Session; trigger: HTMLElement } | null>(null);
 const [exportState, setExportState] = useState<{ sessionId: string; trigger: HTMLElement } | null>(null);
 const headingRef = useRef<HTMLHeadingElement>(null);
	const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
	const [deleting, setDeleting] = useState(false);

	useEffect(() => {
		load();
	}, [load]);

  useEffect(() => {
    const refresh = () => { void loadTags(); };
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visible); };
  }, [loadTags]);

  const allTags = useMemo(() => uniqueTags(sessions.flatMap(s => s.tags ?? [])).sort(), [sessions]);
  const consumedTagChange = useRef<typeof lastTagChange>(null);
  useEffect(() => {
    const change = consumedTagChange.current !== lastTagChange ? lastTagChange : null;
    consumedTagChange.current = lastTagChange;
    setActiveTagFilter(current => {
      let next = current;
      if (current && change?.action === "rename" && tagKey(current) === tagKey(change.tag)) next = change.name;
      if (current && change?.action === "delete" && tagKey(current) === tagKey(change.tag)) next = null;
      return next && allTags.some(tag => tagKey(tag) === tagKey(next!)) ? next : null;
    });
  }, [allTags, lastTagChange]);

	const filtered = useMemo(() => {
		let result = sessions;
		if (activeTagFilter) {
			result = result.filter((s) => s.tags?.some(tag => tagKey(tag) === tagKey(activeTagFilter)));
		}
		const q = search.toLowerCase().trim();
		if (q) {
			result = result.filter((s) =>
				(s.title || "").toLowerCase().includes(q) ||
				(s.summary || "").toLowerCase().includes(q) ||
				(s.transcript || "").toLowerCase().includes(q) ||
				(s.aiNotes || "").toLowerCase().includes(q) ||
				(s.tags || []).some((t) => t.toLowerCase().includes(q)),
			);
		}
		// Pinned first, then newest
		return [...result].sort((a, b) => {
			if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
			return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
		});
	}, [sessions, search, activeTagFilter]);

	if (viewing) {
		return <SessionDetail session={viewing} onBack={() => view(null)} onTagClick={tag => { setActiveTagFilter(tag); view(null); }} />;
	}

	const openDeletePanel = (session: Session) => {
		setMenuState(null);
		setDeleteTarget(session);
	};

	const confirmDelete = async () => {
		if (!deleteTarget || deleting) return;
		setDeleting(true);
		try {
			await remove(deleteTarget.id);
			showToast(tr("Meeting deleted"));
			setDeleteTarget(null);
		} catch {
			showToast(tr("Failed to delete meeting"));
		} finally {
			setDeleting(false);
		}
	};

	return (
		<div>
   <h2 className={styles.focusHeading} tabIndex={-1} ref={headingRef}>{tr('Meetings')}</h2>
			<div className={styles.header}>
				<input
					type="search"
					placeholder={tr("Search meetings...")}
					value={search}
					onChange={(e) => setSearch(e.target.value)}
				/>
			</div>

			{allTags.length > 0 && (
				<div className={styles.tagBar}>
					{allTags.map((t) => (
						<button
							key={t}
							className={`${styles.tagFilter} ${activeTagFilter !== null && tagKey(activeTagFilter) === tagKey(t) ? styles.tagFilterActive : ""}`}
							onClick={() => setActiveTagFilter(activeTagFilter !== null && tagKey(activeTagFilter) === tagKey(t) ? null : t)}
						>
							#{t}
						</button>
					))}
					{activeTagFilter && (
						<button type="button" className={styles.tagClear} onClick={() => setActiveTagFilter(null)}>
							{tr("clear filter ×")}</button>
					)}
				</div>
			)}

			{filtered.length === 0 ? (
				<div className={styles.empty}>
					{sessions.length === 0
						? tr("No meetings yet. Record something to get started.")
						: tr("No meetings match your search.")}
				</div>
			) : (
				filtered.map((s) => (
					<SessionItem
						key={s.id}
						session={s}
						onOpen={() => view(s)}
						onDelete={() => openDeletePanel(s)}
						onMenu={(e, sess) => {
							const trigger = e.currentTarget as HTMLElement;
       const rect = trigger.getBoundingClientRect();
							setMenuState({ x: rect.right, y: rect.bottom + 4, session: sess, trigger });
						}}
						onTagClick={(t) => setActiveTagFilter(t)}
					/>
				))
			)}

			{menuState && (
				<ActionMenu
					x={menuState.x}
					y={menuState.y}
					session={menuState.session}
					onClose={() => setMenuState(null)}
					onTogglePin={async () => {
						await update(menuState.session.id, { pinned: !menuState.session.pinned });
						showToast(menuState.session.pinned ? tr("Unpinned") : tr("Pinned"));
					}}
					onDelete={() => openDeletePanel(menuState.session)}
     onExport={session => setExportState({ sessionId: session.id, trigger: menuState.trigger })}
				/>
			)}
   {exportState && <MeetingExportDialog sessionId={exportState.sessionId} onClose={() => {
    const trigger = exportState.trigger; setExportState(null);
    queueMicrotask(() => (trigger.isConnected ? trigger : headingRef.current)?.focus());
   }} />}

			{deleteTarget && (
				<div className={styles.confirmOverlay} onClick={() => !deleting && setDeleteTarget(null)}>
					<div className={styles.confirmPanel} onClick={(e) => e.stopPropagation()}>
						<div className={styles.confirmTitle}>{tr("Delete meeting?")}</div>
						<div className={styles.confirmBody}>
							{tr('"{title}" will be permanently removed. This cannot be undone.', undefined, {title:deleteTarget.title || tr("Untitled")})}
						</div>
						<div className={styles.confirmActions}>
							<button
								className={styles.confirmCancel}
								onClick={() => setDeleteTarget(null)}
								disabled={deleting}
							>
								{tr("Cancel")}</button>
							<button
								className={styles.confirmDelete}
								onClick={confirmDelete}
								disabled={deleting}
							>
								{deleting ? tr("Deleting...") : tr("Delete")}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
