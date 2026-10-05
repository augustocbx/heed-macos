import type { Session } from "@heed/shared";
import { fmtDate, fmtDuration } from "@/lib/format.ts";
import styles from "./SessionItem.module.css";

interface Props {
	session: Session;
	onOpen: () => void;
	onMenu: (e: React.MouseEvent, session: Session) => void;
	onTagClick: (tag: string) => void;
	onDelete: () => void;
}

export function SessionItem({ session, onOpen, onMenu, onTagClick, onDelete }: Props) {
	const speakers = session.speakers?.length || 0;
	const meta = [
		speakers > 0 ? `${speakers} speaker${speakers > 1 ? "s" : ""}` : null,
		session.duration ? fmtDuration(session.duration) : null,
		fmtDate(session.createdAt),
	].filter(Boolean).join(" · ");

	return (
		<div className={styles.item} onClick={onOpen}>
			<div className={styles.info}>
				<div className={styles.title}>
					{session.pinned && <span className={styles.pin}>📌</span>}
					{session.title || "Untitled"}
					{session.tags && session.tags.length > 0 && (
						<span className={styles.tags}>
							{session.tags.map((t) => (
								<span
									key={t}
									className={styles.tag}
									onClick={(e) => { e.stopPropagation(); onTagClick(t); }}
								>
									#{t}
								</span>
							))}
						</span>
					)}
				</div>
				{session.summary && session.summary !== session.title && (
					<div className={styles.summary}>{session.summary}</div>
				)}
				<div className={styles.meta}>{meta}</div>
			</div>
			<div className={styles.actions}>
				<button
					className={`${styles.actionBtn} ${styles.actionBtnDanger}`}
					onClick={(e) => { e.stopPropagation(); onDelete(); }}
					aria-label="Delete session"
				>
					Delete
				</button>
				<button
					className={styles.actionBtn}
					onClick={(e) => { e.stopPropagation(); onMenu(e, session); }}
					aria-label="More options"
				>
					⋯
				</button>
			</div>
		</div>
	);
}
