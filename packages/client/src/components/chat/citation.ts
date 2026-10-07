import type { ChatEvidence, MeetingMetadataEvidence } from "@heed/shared";

export function isMeetingMetadataCitation(citation: ChatEvidence): citation is MeetingMetadataEvidence {
 return "kind" in citation && citation.kind === "meeting-metadata";
}
