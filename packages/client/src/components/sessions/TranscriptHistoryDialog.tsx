import { useRef, useState } from "react";
import type {
  Session,
  TranscriptCommand,
  TranscriptEdit,
  TranscriptTarget,
} from "@heed/shared";
import { Dialog } from "@/components/layout/Dialog";
import { transcriptEditingApi } from "@/api/transcript-editing";
import { guardForSession } from "@/lib/acceptedSession";
import { tr, useLocale } from "@/lib/i18n";
import { correctionError } from "./TranscriptSegmentEditor";
import styles from "./TranscriptEditing.module.css";
const sameTarget = (a: TranscriptTarget, b: TranscriptTarget) =>
  a.kind === b.kind &&
  (a.kind === "document" || (b.kind === "segment" && a.index === b.index));
function compatible(session: Session, edit: TranscriptEdit): boolean {
  const state = session.transcriptEditing;
  if (!state || edit.generationId !== state.activeGenerationId) return false;
  const index = state.edits.findIndex((action) => action.id === edit.id);
  return (
    edit.changes.every(
      (change) =>
        change.after ===
        (change.target.kind === "document"
          ? session.transcript
          : session.segments[change.target.index]?.text),
    ) &&
    !state.edits
      .slice(index + 1)
      .some(
        (action) =>
          action.generationId === edit.generationId &&
          action.changes.some((later) =>
            edit.changes.some((earlier) =>
              sameTarget(later.target, earlier.target),
            ),
          ),
      )
  );
}
export function TranscriptHistoryDialog({
  session,
  onClose,
  onSaved,
}: {
  session: Session;
  onClose: () => void;
  onSaved: (session: Session) => void;
}) {
  useLocale();
  const state = session.transcriptEditing;
  const [generationId, setGenerationId] = useState(state?.generations[0]?.id),
    [editId, setEditId] = useState(state?.edits[0]?.id),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = useRef<TranscriptCommand | null>(null);
  const generation = state?.generations.find(
      (value) => value.id === generationId,
    ),
    edit = state?.edits.find((value) => value.id === editId);
  async function revert() {
    if (!edit || !compatible(session, edit)) return;
    setBusy(true);
    setError("");
    try {
      const guard = guardForSession(session);
      if (
        !pending.current ||
        pending.current.action !== "revert" ||
        pending.current.editId !== edit.id ||
        pending.current.expectedTranscriptVersion !==
          guard.expectedTranscriptVersion
      )
        pending.current = {
          ...guard,
          requestId: crypto.randomUUID(),
          action: "revert",
          editId: edit.id,
        };
      onSaved(await transcriptEditingApi.command(session.id, pending.current));
    } catch (failure) {
      setError(correctionError(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      label={tr("Transcript recovery history")}
      onClose={() => {
        if (!busy) onClose();
      }}
      className={styles.dialog}
    >
      <h2>{tr("Transcript recovery history")}</h2>
      <p className={styles.hint}>
        {tr(
          "History is read-only. Revert changes text only; copied older text does not restore old timing or speakers.",
        )}
      </p>
      {!state ? (
        <p>
          {tr(
            "The current source will be preserved when you make your first correction.",
          )}
        </p>
      ) : (
        <>
          <label className={styles.field}>
            {tr("Recognition generation")}
            <select
              value={generationId}
              disabled={busy}
              onChange={(event) => setGenerationId(event.target.value)}
            >
              {state.generations.map((value, index) => (
                <option value={value.id} key={value.id}>
                  {tr("Generation {number}", undefined, { number: index + 1 })}{" "}
                  · {value.createdAt}
                </option>
              ))}
            </select>
          </label>
          {generation && (
            <>
              <p>
                {tr(
                  generation.origin === "legacy-preserved"
                    ? "Source preserved when editing was enabled"
                    : "Original recognized source",
                )}
              </p>
              <pre className={styles.text}>
                {generation.transcript || tr("Empty transcript text")}
              </pre>
              <button
                onClick={() =>
                  void navigator.clipboard
                    .writeText(generation.transcript)
                    .catch(() =>
                      setError(
                        tr("Could not copy. Select the draft text to copy it."),
                      ),
                    )
                }
              >
                {tr("Copy recovery text")}
              </button>
            </>
          )}
          {!!state.edits.length && (
            <>
              <label className={styles.field}>
                {tr("Accepted edit")}
                <select
                  value={editId}
                  disabled={busy}
                  onChange={(event) => {
                    setEditId(event.target.value);
                    setError("");
                    pending.current = null;
                  }}
                >
                  {state.edits.map((value, index) => (
                    <option value={value.id} key={value.id}>
                      {tr("Edit {number}", undefined, { number: index + 1 })} ·{" "}
                      {value.createdAt}
                    </option>
                  ))}
                </select>
              </label>
              {edit && (
                <>
                  <div className={styles.changes}>
                    {edit.changes.map((change, index) => (
                      <div key={index} className={styles.change}>
                        <strong>{tr("Before")}</strong>
                        <pre className={styles.text}>
                          {change.before || tr("Empty transcript text")}
                        </pre>
                        <strong>{tr("After")}</strong>
                        <pre className={styles.text}>
                          {change.after || tr("Empty transcript text")}
                        </pre>
                      </div>
                    ))}
                  </div>
                  <button
                    disabled={busy || !compatible(session, edit)}
                    onClick={() => void revert()}
                  >
                    {tr("Revert this edit")}
                  </button>
                  {!compatible(session, edit) && (
                    <p>
                      {tr(
                        "Recovery text only: later edits or a new recognition generation prevent safe revert.",
                      )}
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {busy && <p role="status">{tr("Saving correction...")}</p>}
      <div className={styles.actions}>
        <button disabled={busy} onClick={onClose}>
          {tr("Close")}
        </button>
      </div>
    </Dialog>
  );
}
