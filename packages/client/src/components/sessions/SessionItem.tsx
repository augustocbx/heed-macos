import { tr, useLocale } from "@/lib/i18n.ts";
import type { Session } from "@heed/shared";
import { fmtDate, fmtDuration } from "@/lib/format.ts";
import { sessionLanguageLabel, sessionModelLabels } from "@/lib/sessionMetadata";
import { TagEditor } from "./TagEditor";
import styles from "./SessionItem.module.css";

interface Props {
	session: Session;
	onOpen: () => void;
	onMenu: (e: React.MouseEvent, session: Session) => void;
	onTagClick: (tag: string) => void;
	onDelete: () => void;
}

export function SessionItem({ session, onOpen, onMenu, onTagClick, onDelete }: Props) {
	useLocale();
	const speakers = session.speakers?.length || 0;
	const meta = [
		speakers > 0 ? tr(speakers===1 ? "{count} speaker" : "{count} speakers", undefined, {count:speakers}) : null,
		session.duration ? fmtDuration(session.duration) : null,
		fmtDate(session.createdAt),
  sessionLanguageLabel(session.language) || null,
  sessionModelLabels(session) || null,
	].filter(Boolean).join(" · ");

	return (
		<div className={styles.item} onClick={onOpen}>
			<div className={styles.info}>
				<div className={styles.title}>
					{session.pinned && <span className={styles.pin}>📌</span>}
					{session.title || tr("Untitled")}

				</div>
				{session.summary && session.summary !== session.title && (
					<div className={styles.summary}>{session.summary}</div>
				)}
				<div className={styles.meta}>{meta}</div>
        <TagEditor session={session} onTagClick={onTagClick} />
			</div>
			<div className={styles.actions}>
				<button
					className={`${styles.actionBtn} ${styles.actionBtnDanger}`}
					onClick={(e) => { e.stopPropagation(); onDelete(); }}
					aria-label={tr("Delete meeting")}
				>
					{tr("Delete")}</button>
				<button
					className={styles.actionBtn}
					onClick={(e) => { e.stopPropagation(); onMenu(e, session); }}
					aria-label={tr("More options")}
				>
					⋯
				</button>
			</div>
		</div>
	);
}
