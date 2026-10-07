import { useRef, useState } from "react";
import type {
  Session,
  TranscriptCandidate,
  TranscriptCommand,
} from "@heed/shared";
import { transcriptEditingApi } from "@/api/transcript-editing";
import { guardForSession } from "@/lib/acceptedSession";
import { tr, useLocale } from "@/lib/i18n";
import { fmtTime } from "@/lib/format";
import { useUIStore } from "@/stores/ui";
import styles from "./TranscriptCandidatePanel.module.css";

type Draft = Pick<
  TranscriptCandidate,
  | "transcript"
  | "segments"
  | "speakers"
  | "duration"
  | "language"
  | "transcriptionModel"
>;
export function TranscriptComparison({
  session,
  draft,
}: {
  session: Session;
  draft: Draft;
}) {
  useLocale();
  const changed = Array.from(
    { length: Math.max(session.segments.length, draft.segments.length) },
    (_, index) => session.segments[index]?.text !== draft.segments[index]?.text,
  ).filter(Boolean).length;
  return (
    <>
      <p>
        {draft.transcriptionModel || tr("Model not recorded")} ·{" "}
        {draft.language}
      </p>
      <p>
        {tr("Accepted: {count} segments", undefined, {
          count: session.segments.length,
        })}{" "}
        ·{" "}
        {tr("New: {count} segments", undefined, {
          count: draft.segments.length,
        })}
      </p>
      <p>
        {tr("Segments with different text by position: {count}", undefined, {
          count: changed,
        })}
      </p>
      <div className={styles.comparison}>
        <section>
          <h3>{tr("Accepted transcript")}</h3>
          <p>
            {session.transcriptionModel || tr("Model not recorded")} ·{" "}
            {session.language} · {session.duration}s
          </p>
          <pre tabIndex={0} aria-label={tr("Accepted transcript")}>
            {session.transcript}
          </pre>
          <ul>
            {session.segments.map((segment, index) => (
              <li key={index}>
                {segment.speaker} · {fmtTime(Math.floor(segment.start))}–
                {fmtTime(Math.floor(segment.end))}
                {segment.channel ? ` · ${segment.channel}` : ""}
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3>{tr("New transcript draft")}</h3>
          <p>{draft.duration}s</p>
          <pre tabIndex={0} aria-label={tr("New transcript draft")}>
            {draft.transcript}
          </pre>
          <ul>
            {draft.segments.map((segment, index) => (
              <li key={index}>
                {segment.speaker} · {fmtTime(Math.floor(segment.start))}–
                {fmtTime(Math.floor(segment.end))}
                {segment.channel ? ` · ${segment.channel}` : ""}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
export function TranscriptCandidatePanel({
  session,
  candidate,
  onBusy,
}: {
  session: Session;
  candidate: TranscriptCandidate;
  onBusy: (busy: boolean) => void;
}) {
  useLocale();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const operations = useRef<{ accept?: TranscriptCommand; discard?: string }>(
    {},
  );
  const stale =
    candidate.baseGuard.expectedTranscriptRevision !==
      session.transcriptRevision ||
    candidate.baseGuard.expectedTranscriptVersion !== session.transcriptVersion;
  const decide = async (action: "accept" | "discard") => {
    if (busy || (action === "accept" && stale)) return;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      if (action === "accept") {
        operations.current.accept ??= {
          action: "accept-candidate",
          candidateId: candidate.id,
          requestId: crypto.randomUUID(),
          ...guardForSession(session),
        };
        await transcriptEditingApi.command(
          session.id,
          operations.current.accept,
        );
        useUIStore.getState().showToast(tr("Transcript updated"));
      } else {
        operations.current.discard ??= crypto.randomUUID();
        await transcriptEditingApi.discard(
          session.id,
          candidate.id,
          operations.current.discard,
        );
        useUIStore.getState().showToast(tr("Transcript draft discarded"));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };
  return (
    <section aria-label={tr("New transcript draft")}>
      <TranscriptComparison session={session} draft={candidate} />
      <p>
        {tr(
          "Replacement updates text, speakers, timing, model and language. Saved audio is kept.",
        )}
      </p>
      {stale && (
        <p role="status">
          {tr(
            "This draft is stale because the transcript or speakers changed. Discard it and transcribe again.",
          )}
        </p>
      )}
      {error && <p role="alert">{tr(error)}</p>}
      {busy && <p role="status">{tr("Saving transcript decision…")}</p>}
      <div className={styles.actions}>
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide("discard")}
        >
          {tr("Discard draft")}
        </button>
        <button
          type="button"
          disabled={busy || stale}
          onClick={() => void decide("accept")}
        >
          {tr("Replace accepted transcript")}
        </button>
      </div>
    </section>
  );
}
