import type { Session, TranscriptGuard } from "@heed/shared";

export const acceptedSourceKeys = [
 "transcript", "segments", "speakers", "language", "transcriptFinalized", "transcriptionModel", "duration",
 "embeddings", "transcriptionDiagnostics", "transcriptRevision", "transcriptVersion", "transcriptEditing",
] as const;
export const acceptedDerivedKeys = ["aiNotes", "summary", "notesMetadata", "notesJobs"] as const;
export function sessionVersion(session: Session): number { return session.transcriptVersion ?? 0; }

/** Capture the displayed server token; never reconstruct hashes from edited client data. */
export function guardForSession(session: Session): TranscriptGuard {
 const version = sessionVersion(session);
 if (typeof session.transcriptRevision !== "string" || !session.transcriptRevision || !Number.isSafeInteger(version) || version < 0)
  throw new Error("The transcript source is unavailable. Refresh before saving.");
 return { expectedTranscriptRevision: session.transcriptRevision, expectedTranscriptVersion: version };
}

/** Request owners merge metadata separately; accepted state is monotonic by local version. */
export function mergeAcceptedSession(current: Session, incoming: Session): Session {
 if (current.id !== incoming.id) throw new Error("Cannot merge different meetings");
 if (sessionVersion(incoming) >= sessionVersion(current)) return incoming;
 const saved = { ...incoming };
 for (const key of [...acceptedSourceKeys, ...acceptedDerivedKeys]) Object.assign(saved, { [key]: current[key] });
 return saved;
}
