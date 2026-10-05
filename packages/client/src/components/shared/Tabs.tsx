import styles from "./Tabs.module.css";

export interface TabDef {
	id: string;
	label: string;
	disabled?: boolean;
	disabledReason?: string;
}

interface Props {
	tabs: TabDef[];
	active: string;
	onChange: (id: string) => void;
}

export function Tabs({ tabs, active, onChange }: Props) {
	return (
		<div className={styles.tabs}>
			{tabs.map((t) => {
				const cls = [styles.tab];
				if (t.id === active) cls.push(styles.tabActive);
				if (t.disabled) cls.push(styles.tabDisabled);
				return (
					<div
						key={t.id}
						className={cls.join(" ")}
						title={t.disabled ? t.disabledReason : undefined}
						onClick={() => !t.disabled && onChange(t.id)}
						data-tour={t.id === "speakers" ? "speakers-tab" : undefined}
					>
						{t.label}
					</div>
				);
			})}
		</div>
	);
}
