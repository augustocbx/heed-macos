import { useState } from "react";
import { Dialog } from "@/components/layout/Dialog";
import { tr, useLocale } from "@/lib/i18n";
import styles from "./TranscriptEditing.module.css";
export function correctionError(error: unknown): string {
  const status = (
      error as {
        status?: number;
      }
    )?.status,
    message = error instanceof Error ? error.message : "";
  if (status === 413)
    return tr(
      "Correction exceeds the size or history limit. Your draft is kept. Choose smaller changes.",
    );
  return status === 409 && /changed|conflict/i.test(message)
    ? tr(
        "The source changed. Your draft is kept. Copy it or reload the current text.",
      )
    : tr("Could not save the correction. Your draft is kept. Try again.");
}
export function TranscriptSegmentEditor({
  value,
  onSave,
  onCancel,
  label,
  onReload,
}: {
  value: string;
  onSave: (text: string) => Promise<void>;
  onCancel: () => void;
  label: string;
  onReload?: () => Promise<string>;
}) {
  useLocale();
  const [draft, setDraft] = useState(value),
    [baseline, setBaseline] = useState(value),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState("");
  function cancel() {
    if (
      !busy &&
      (draft === baseline ||
        window.confirm(tr("Discard your unsaved transcript draft?")))
    )
      onCancel();
  }
  async function save() {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await onSave(draft);
    } catch (failure) {
      setError(correctionError(failure));
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    if (
      !onReload ||
      (draft !== baseline &&
        !window.confirm(tr("Discard your unsaved transcript draft?")))
    )
      return;
    setBusy(true);
    try {
      const current = await onReload();
      setDraft(current);
      setBaseline(current);
      setError("");
      setStatus("");
    } catch (failure) {
      setError(correctionError(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog label={label} onClose={cancel} className={styles.dialog}>
      <h2>{label}</h2>
      <p className={styles.hint}>
        {tr(
          "Only text changes. Audio, timing and speaker identity are preserved.",
        )}
      </p>
      <label className={styles.field}>
        {tr("Transcript text")}
        <textarea
          autoFocus
          value={draft}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {status && <p role="status">{status}</p>}
      {busy && <p role="status">{tr("Saving correction...")}</p>}
      <div className={styles.actions}>
        <button disabled={busy} onClick={() => void save()}>
          {tr("Save correction")}
        </button>
        <button disabled={busy} onClick={cancel}>
          {tr(error ? "Discard draft" : "Cancel")}
        </button>
        {error && (
          <>
            <button
              disabled={busy}
              onClick={() =>
                void navigator.clipboard
                  .writeText(draft)
                  .then(() => setStatus(tr("Draft copied.")))
                  .catch(() =>
                    setStatus(
                      tr("Could not copy. Select the draft text to copy it."),
                    ),
                  )
              }
            >
              {tr("Copy draft")}
            </button>
            {onReload && (
              <button disabled={busy} onClick={() => void reload()}>
                {tr("Reload current text")}
              </button>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
