export const SPEAKER_COLORS = [
	"var(--speaker-1)",
	"var(--speaker-2)",
	"var(--speaker-3)",
	"var(--speaker-4)",
	"var(--speaker-5)",
	"var(--speaker-6)",
];

export function speakerColor(index: number): string {
	return SPEAKER_COLORS[index % SPEAKER_COLORS.length];
}
