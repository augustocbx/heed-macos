import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import styles from "./SpeakerMergeMenu.module.css";

interface Props {
	x: number;
	y: number;
	currentSpeaker: string;
	speakers: string[];
	speakerNames: Record<string, string>;
	onClose: () => void;
	onMerge: (from: string, into: string) => void;
}

export function SpeakerMergeMenu({ x, y, currentSpeaker, speakers, speakerNames, onClose, onMerge }: Props) {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const close = (e: MouseEvent) => {
			if (!ref.current?.contains(e.target as Node)) onClose();
		};
		setTimeout(() => document.addEventListener("click", close), 0);
		return () => document.removeEventListener("click", close);
	}, [onClose]);

	const others = speakers.filter((s) => s !== currentSpeaker);
	if (others.length === 0) return null;

	const currentName = speakerNames[currentSpeaker] || currentSpeaker;

	return createPortal(
		<div ref={ref} className={styles.menu} style={{ top: y, left: x }}>
			<div className={styles.header}>Merge "{currentName}" into:</div>
			<div className={styles.divider} />
			{others.map((s) => (
				<div key={s} className={styles.item} onClick={() => onMerge(currentSpeaker, s)}>
					{speakerNames[s] || s}
				</div>
			))}
		</div>,
		document.body,
	);
}
