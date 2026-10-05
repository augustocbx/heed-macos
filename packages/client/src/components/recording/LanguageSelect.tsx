import { useEffect, useMemo } from "react";
import { useLocalStorage } from "@/hooks/useLocalStorage.ts";
import { WHISPER_LANGUAGES, pickLanguageDefault } from "@/lib/languages.ts";
import { useHealthStore } from "@/stores/health.ts";
import styles from "./LanguageSelect.module.css";

interface Props {
	value?: string;
	onChange?: (value: string) => void;
}

export function LanguageSelect({ value, onChange }: Props) {
	const [stored, setStored] = useLocalStorage<string>("heed-language", pickLanguageDefault(undefined));
	const langs = useHealthStore((s) => s.health.languages);
	const current = value ?? stored;

	// Filter the full Whisper list down to what the ACTIVE engine actually transcribes.
	// codes=null → all languages (Whisper). Drop "auto" if the engine can't auto-detect
	// (Parakeet assumes English without an explicit language).
	const available = useMemo(() => {
		// Until /health loads, show the full list (safe default).
		if (!langs) return WHISPER_LANGUAGES;
		const allowed = langs.codes ? new Set(langs.codes) : null;
		return WHISPER_LANGUAGES.filter(([code]) => {
			if (code === "auto") return langs.supports_auto;
			return allowed ? allowed.has(code) : true;
		});
	}, [langs]);

	// If the current selection isn't available for this engine, correct it to a default.
	useEffect(() => {
		if (!langs) return;
		const codes = available.map(([c]) => c);
		if (!codes.includes(current)) {
			const def = pickLanguageDefault(codes);
			setStored(def);
			onChange?.(def);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [langs, available]);

	const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		const v = e.target.value;
		setStored(v);
		onChange?.(v);
	};

	// Never show an out-of-list value (avoids a blank control while correcting).
	const safeValue = available.some(([c]) => c === current) ? current : (available[0]?.[0] ?? current);

	return (
		<select className={styles.select} value={safeValue} onChange={handleChange}>
			{available.map(([code, name]) => (
				<option key={code} value={code}>
					{name}
				</option>
			))}
		</select>
	);
}
