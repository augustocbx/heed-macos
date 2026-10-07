import { useEffect, useRef, useState } from "react";
import type {
  ReplaceInput,
  ReplacementPreview,
  Session,
  TranscriptCommand,
} from "@heed/shared";
import { Dialog } from "@/components/layout/Dialog";
import { transcriptEditingApi } from "@/api/transcript-editing";
import { guardForSession } from "@/lib/acceptedSession";
import { tr, useLocale } from "@/lib/i18n";
import { correctionError } from "./TranscriptSegmentEditor";
import styles from "./TranscriptEditing.module.css";
export function TranscriptReplaceDialog({
  session,
  onClose,
  onSaved,
}: {
  session: Session;
  onClose: () => void;
  onSaved: (session: Session) => void;
}) {
  useLocale();
  const [input, setInput] = useState<ReplaceInput>({
      query: "",
      replacement: "",
      caseSensitive: true,
      wholeWord: false,
    }),
    [preview, setPreview] = useState<ReplacementPreview | null>(null),
    [approved, setApproved] = useState(false),
    [busy, setBusy] = useState<"preview" | "save" | null>(null),
    [error, setError] = useState("");
  const sequence = useRef(0),
    pending = useRef<TranscriptCommand | null>(null),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      ++sequence.current;
    };
  }, []);
  useEffect(() => {
    ++sequence.current;
    setPreview(null);
    setApproved(false);
    pending.current = null;
    setBusy((current) => (current === "save" ? current : null));
  }, [session.id, session.transcriptRevision, session.transcriptVersion]);
  function change(patch: Partial<ReplaceInput>) {
    ++sequence.current;
    setInput((current) => ({ ...current, ...patch }));
    setPreview(null);
    setApproved(false);
    setError("");
    pending.current = null;
    setBusy(null);
  }
  async function inspect() {
    const order = ++sequence.current;
    setBusy("preview");
    setError("");
    setPreview(null);
    setApproved(false);
    pending.current = null;
    try {
      const result = await transcriptEditingApi.preview(
        session.id,
        input,
        guardForSession(session),
      );
      if (alive.current && order === sequence.current) setPreview(result);
    } catch (failure) {
      if (alive.current && order === sequence.current)
        setError(correctionError(failure));
    } finally {
      if (alive.current && order === sequence.current) setBusy(null);
    }
  }
  async function apply() {
    if (!preview || !approved || !preview.changes.length) return;
    setBusy("save");
    setError("");
    pending.current ??= {
      ...preview.guard,
      requestId: crypto.randomUUID(),
      action: "replace",
      input: { ...input },
      expectedPreviewKey: preview.key,
    };
    try {
      const saved = await transcriptEditingApi.command(
        session.id,
        pending.current,
      );
      if (alive.current) onSaved(saved);
    } catch (failure) {
      if (alive.current) setError(correctionError(failure));
    } finally {
      if (alive.current) setBusy(null);
    }
  }
  function close() {
    if (busy !== "save") {
      ++sequence.current;
      onClose();
    }
  }
  return (
    <Dialog
      label={tr("Find and replace transcript text")}
      onClose={close}
      className={styles.dialog}
    >
      <h2>{tr("Find and replace transcript text")}</h2>
      <p className={styles.hint}>
        {tr(
          "Literal matching stays within each segment. Accents and entered Unicode remain meaningful.",
        )}
      </p>
      <fieldset disabled={busy === "save"}>
        <label className={styles.field}>
          {tr("Find text")}
          <textarea
            autoFocus
            value={input.query}
            onChange={(event) => change({ query: event.target.value })}
          />
        </label>
        <label className={styles.field}>
          {tr("Replace with")}
          <textarea
            value={input.replacement}
            onChange={(event) => change({ replacement: event.target.value })}
          />
        </label>
        <div className={styles.options}>
          <label>
            <input
              type="checkbox"
              checked={input.caseSensitive}
              onChange={(event) =>
                change({ caseSensitive: event.target.checked })
              }
            />
            {tr("Match case")}
          </label>
          <label>
            <input
              type="checkbox"
              checked={input.wholeWord}
              onChange={(event) => change({ wholeWord: event.target.checked })}
            />
            {tr("Whole words")}
          </label>
        </div>
      </fieldset>
      <button disabled={!input.query || !!busy} onClick={() => void inspect()}>
        {tr("Preview replacement")}
      </button>
      {preview && (
        <section aria-label={tr("Replacement preview")}>
          <p>
            {tr("{matches} matches in {targets} targets", undefined, {
              matches: preview.matchCount,
              targets: preview.changes.length,
            })}
          </p>
          {!preview.changes.length ? (
            <p>{tr("No text changes.")}</p>
          ) : (
            <>
              <div className={styles.changes}>
                {preview.changes.map((change, index) => (
                  <div key={index} className={styles.change}>
                    <p>
                      {change.target.kind === "document"
                        ? tr("Whole transcript")
                        : tr("Segment {number}", undefined, {
                            number: change.target.index + 1,
                          })}
                    </p>
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
              <label>
                <input
                  type="checkbox"
                  checked={approved}
                  disabled={busy === "save"}
                  onChange={(event) => setApproved(event.target.checked)}
                />
                {tr("I reviewed this replacement")}
              </label>
              <div className={styles.actions}>
                <button
                  disabled={!approved || !!busy}
                  onClick={() => void apply()}
                >
                  {tr("Apply replacement")}
                </button>
              </div>
            </>
          )}
        </section>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {busy && (
        <p role="status">
          {tr(
            busy === "save"
              ? "Saving correction..."
              : "Preparing replacement preview...",
          )}
        </p>
      )}
      <div className={styles.actions}>
        <button disabled={busy === "save"} onClick={close}>
          {tr("Cancel")}
        </button>
      </div>
    </Dialog>
  );
}
