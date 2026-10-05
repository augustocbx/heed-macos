import { useEffect, useMemo, useState } from "react";
import type { Session } from "@heed/shared";
import { useSessionsStore } from "@/stores/sessions.ts";
import { useUIStore } from "@/stores/ui.ts";
import { SessionItem } from "./SessionItem.tsx";
import { ActionMenu } from "./ActionMenu.tsx";
import { SessionDetail } from "./SessionDetail.tsx";
import styles from "./SessionsPage.module.css";

export function SessionsPage() {
	const { sessions, load, viewing, view, update, remove } = useSessionsStore();
	const showToast = useUIStore((s) => s.showToast);

	const [search, setSearch] = useState("");
	const [activeTagFilter, setActiveTagFilter] = useState<string | null>(null);
	const [menuState, setMenuState] = useState<{ x: number; y: number; session: Session } | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<Session | null>(null);
	const [deleting, setDeleting] = useState(false);

	useEffect(() => {
		load();
	}, [load]);

	const allTags = useMemo(() => {
		const tags = new Set<string>();
		sessions.forEach((s) => s.tags?.forEach((t) => tags.add(t)));
		return [...tags].sort();
	}, [sessions]);

	const filtered = useMemo(() => {
		let result = sessions;
		if (activeTagFilter) {
			result = result.filter((s) => s.tags?.includes(activeTagFilter));
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
		return <SessionDetail session={viewing} onBack={() => view(null)} />;
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
			showToast("Session deleted");
			setDeleteTarget(null);
		} catch {
			showToast("Failed to delete session");
		} finally {
			setDeleting(false);
		}
	};

	return (
		<div>
			<div className={styles.header}>
				<input
					type="search"
					placeholder="Search sessions..."
					value={search}
					onChange={(e) => setSearch(e.target.value)}
				/>
			</div>

			{allTags.length > 0 && (
				<div className={styles.tagBar}>
					{allTags.map((t) => (
						<button
							key={t}
							className={`${styles.tagFilter} ${activeTagFilter === t ? styles.tagFilterActive : ""}`}
							onClick={() => setActiveTagFilter(activeTagFilter === t ? null : t)}
						>
							#{t}
						</button>
					))}
					{activeTagFilter && (
						<span className={styles.tagClear} onClick={() => setActiveTagFilter(null)}>
							clear filter ×
						</span>
					)}
				</div>
			)}

			{filtered.length === 0 ? (
				<div className={styles.empty}>
					{sessions.length === 0
						? "No sessions yet. Record something to get started."
						: "No sessions match your search."}
				</div>
			) : (
				filtered.map((s) => (
					<SessionItem
						key={s.id}
						session={s}
						onOpen={() => view(s)}
						onDelete={() => openDeletePanel(s)}
						onMenu={(e, sess) => {
							const rect = (e.target as HTMLElement).getBoundingClientRect();
							setMenuState({ x: rect.right, y: rect.bottom + 4, session: sess });
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
						showToast(menuState.session.pinned ? "Unpinned" : "Pinned");
					}}
					onDelete={() => openDeletePanel(menuState.session)}
				/>
			)}

			{deleteTarget && (
				<div className={styles.confirmOverlay} onClick={() => !deleting && setDeleteTarget(null)}>
					<div className={styles.confirmPanel} onClick={(e) => e.stopPropagation()}>
						<div className={styles.confirmTitle}>Delete session?</div>
						<div className={styles.confirmBody}>
							"{deleteTarget.title || "Untitled"}" will be permanently removed. This cannot be undone.
						</div>
						<div className={styles.confirmActions}>
							<button
								className={styles.confirmCancel}
								onClick={() => setDeleteTarget(null)}
								disabled={deleting}
							>
								Cancel
							</button>
							<button
								className={styles.confirmDelete}
								onClick={confirmDelete}
								disabled={deleting}
							>
								{deleting ? "Deleting..." : "Delete"}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
