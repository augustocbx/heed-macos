import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useRecordingStore } from "@/stores/recording.ts";
import { useUIStore } from "@/stores/ui.ts";
import { detectLocale, type Locale } from "@/lib/i18n.ts";
import styles from "./AppTour.module.css";

const TOUR_KEY = "heed-tour-done";

interface TourStep {
	target: string; // CSS selector for the element to spotlight
	title: { es: string; en: string };
	body: { es: string; en: string };
	position: "bottom" | "top" | "left" | "right";
}

const STEPS: TourStep[] = [
	{
		target: "[data-tour='record']",
		title: {
			es: "Graba cualquier reunion",
			en: "Record any meeting",
		},
		body: {
			es: "Un click y heed captura tu microfono y el audio de tu sistema al mismo tiempo. Zoom, Meet, Teams, Discord, un video de YouTube... lo que sea que suene en tu computadora, heed lo escucha.",
			en: "One click and heed captures your microphone and system audio simultaneously. Zoom, Meet, Teams, Discord, a YouTube video... whatever plays on your computer, heed hears it.",
		},
		position: "bottom",
	},
	{
		target: "[data-tour='model-chip']",
		title: {
			es: "Tu modelo de IA, tu eleccion",
			en: "Your AI model, your choice",
		},
		body: {
			es: "heed detecta tu hardware y te muestra solo los modelos que caben. Llama, Qwen, Gemma... elige el que quieras. Todo corre en tu maquina, nada sale a la nube.",
			en: "heed detects your hardware and shows only the models that fit. Llama, Qwen, Gemma... pick any. Everything runs on your machine, nothing goes to the cloud.",
		},
		position: "bottom",
	},
	{
		target: "[data-tour='speakers-tab']",
		title: {
			es: "Voces separadas automaticamente",
			en: "Voices separated automatically",
		},
		body: {
			es: "heed identifica quien dijo que, incluso cuando hablan al mismo tiempo. Tu voz aparece como \"Me\" y las demas se separan por timbre.",
			en: "heed identifies who said what, even when people talk over each other. Your voice appears as \"Me\" and others are separated by timbre.",
		},
		position: "top",
	},
	{
		target: "[data-tour='speaker-chips']",
		title: {
			es: "Renombra y heed recuerda",
			en: "Rename and heed remembers",
		},
		body: {
			es: "Click en un nombre de speaker para cambiarlo. La proxima vez que esa persona hable, heed la reconoce automaticamente. Tu equipo, tus voces, sin configurar nada.",
			en: "Click a speaker name to change it. Next time that person speaks, heed recognizes them automatically. Your team, your voices, zero configuration.",
		},
		position: "top",
	},
	{
		target: "[data-tour='sessions-tab']",
		title: {
			es: "Todas tus reuniones, siempre accesibles",
			en: "All your meetings, always accessible",
		},
		body: {
			es: "Cada grabacion se guarda automaticamente con titulo inteligente, speakers identificados y la transcripcion completa. Busca, revisa o genera notas con IA cuando quieras. Todo queda en tu maquina.",
			en: "Every recording is saved automatically with a smart title, identified speakers and the full transcript. Search, review or generate AI notes anytime. Everything stays on your machine.",
		},
		position: "bottom",
	},
];

export function AppTour() {
	const [step, setStep] = useState(-1);
	const [rect, setRect] = useState<DOMRect | null>(null);
	const locale = detectLocale();
	const hadMockData = useRef(false);

	// Mock segments to simulate a real session for steps 3-4
	const MOCK_SEGMENTS = [
		{ speaker: "Me", start: 0, end: 5, text: "So the quarterly numbers look really strong this time.", channel: "mic" as const },
		{ speaker: "Speaker 1", start: 5, end: 12, text: "Agreed. The new campaign drove a 40% increase in conversions.", channel: "sys" as const },
		{ speaker: "Me", start: 12, end: 18, text: "Nice. Let's keep that momentum going into next quarter.", channel: "mic" as const },
	];

	const injectMockData = useCallback(() => {
		if (useRecordingStore.getState().segments.length > 0) return; // already has real data
		hadMockData.current = true;
		useRecordingStore.setState({
			segments: MOCK_SEGMENTS,
			speakers: ["Me", "Speaker 1"],
			transcript: MOCK_SEGMENTS.map((s) => s.text).join("\n"),
		});
	}, []);

	const clearMockData = useCallback(() => {
		if (!hadMockData.current) return;
		hadMockData.current = false;
		useRecordingStore.getState().reset();
	}, []);

	// Check if tour was already completed
	useEffect(() => {
		if (localStorage.getItem(TOUR_KEY) === "1") return;
		const id = setTimeout(() => setStep(0), 1500);
		return () => clearTimeout(id);
	}, []);

	// Inject/clear mock data + find target element
	useEffect(() => {
		if (step < 0 || step >= STEPS.length) return;

		// Steps 2-3 (speakers tab, speaker chips) need mock data visible
		if (step === 2 || step === 3) {
			injectMockData();
			// Small delay for React to render the mock segments
			const id = setTimeout(() => {
				const el = document.querySelector(STEPS[step].target);
				if (el) {
					setRect(el.getBoundingClientRect());
					el.scrollIntoView({ behavior: "smooth", block: "nearest" });
				} else {
					setRect(null);
				}
			}, 100);
			return () => clearTimeout(id);
		}

		const el = document.querySelector(STEPS[step].target);
		if (el) {
			setRect(el.getBoundingClientRect());
			el.scrollIntoView({ behavior: "smooth", block: "nearest" });
		} else {
			setRect(null);
		}
	}, [step, injectMockData]);

	const finish = useCallback(() => {
		localStorage.setItem(TOUR_KEY, "1");
		clearMockData();
		setStep(-1);
	}, [clearMockData]);

	const next = useCallback(() => {
		if (step >= STEPS.length - 1) {
			finish();
		} else {
			// Clean mock data when leaving speaker steps
			if (step === 3) clearMockData();
			setStep((s) => s + 1);
		}
	}, [step, finish, clearMockData]);

	const prev = useCallback(() => {
		if (step > 0) setStep((s) => s - 1);
	}, [step]);

	if (step < 0 || step >= STEPS.length) return null;

	const current = STEPS[step];
	const title = current.title[locale] || current.title.en;
	const body = current.body[locale] || current.body.en;

	// Tooltip position: centered if no target found, otherwise relative to spotlight
	const tooltipStyle: React.CSSProperties = {};
	if (!rect) {
		// Target element not in DOM — center the tooltip on screen
		tooltipStyle.top = "50%";
		tooltipStyle.left = "50%";
		tooltipStyle.transform = "translate(-50%, -50%)";
	} else {
		const gap = 16;
		switch (current.position) {
			case "bottom":
				tooltipStyle.top = rect.bottom + gap;
				tooltipStyle.left = Math.max(16, Math.min(rect.left + rect.width / 2 - 180, window.innerWidth - 392));
				break;
			case "top":
				tooltipStyle.bottom = window.innerHeight - rect.top + gap;
				tooltipStyle.left = Math.max(16, Math.min(rect.left + rect.width / 2 - 180, window.innerWidth - 392));
				break;
			case "left":
				tooltipStyle.top = rect.top;
				tooltipStyle.right = window.innerWidth - rect.left + gap;
				break;
			case "right":
				tooltipStyle.top = rect.top;
				tooltipStyle.left = rect.right + gap;
				break;
		}
	}

	return createPortal(
		<div className={styles.overlay} onClick={next}>
			{/* Spotlight cutout */}
			{rect && (
				<div
					className={styles.spotlight}
					style={{
						top: rect.top - 8,
						left: rect.left - 8,
						width: rect.width + 16,
						height: rect.height + 16,
					}}
					onClick={(e) => e.stopPropagation()}
				/>
			)}

			{/* Tooltip */}
			<div
				className={styles.tooltip}
				style={tooltipStyle}
				onClick={(e) => e.stopPropagation()}
			>
				<div className={styles.stepCount}>
					{step + 1} / {STEPS.length}
				</div>
				<h3 className={styles.title}>{title}</h3>
				<p className={styles.body}>{body}</p>
				<div className={styles.actions}>
					{step > 0 && (
						<button className={styles.btnGhost} onClick={prev}>
							{locale === "es" ? "Atras" : "Back"}
						</button>
					)}
					<button className={styles.btnPrimary} onClick={next}>
						{step === STEPS.length - 1
							? (locale === "es" ? "Empezar" : "Get started")
							: (locale === "es" ? "Siguiente" : "Next")}
					</button>
					<button className={styles.btnSkip} onClick={finish}>
						{locale === "es" ? "Saltar" : "Skip"}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
