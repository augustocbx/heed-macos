import type { Session } from "@heed/shared";
export const correctionMeeting = (): Session => ({
  id: "meeting",
  title: "Public meeting",
  createdAt: "2026-10-06",
  duration: 4,
  language: "pt",
  transcript: "Joao API\nAPI",
  segments: [
    { speaker: "Ana", start: 0, end: 2, text: "Joao API", channel: "mic" },
    { speaker: "Bruno", start: 2, end: 4, text: "API", channel: "sys" },
  ],
  speakers: ["Ana", "Bruno"],
  aiNotes: "Earlier notes",
  summary: "",
  tags: [],
  pinned: false,
  transcriptFinalized: true,
  transcriptRevision: "a".repeat(64),
  transcriptVersion: 1,
});
