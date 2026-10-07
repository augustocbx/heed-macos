import {VocabularySelection} from '../recording/VocabularySelection';
import { tr, useLocale } from "@/lib/i18n";
import { useEffect, useRef, useState } from "react";
import type { CandidateInput, Session } from "@heed/shared";
import { useSessionsStore } from "@/stores/sessions";
import { useRecordingStore } from "@/stores/recording";
import { useUIStore } from "@/stores/ui";
import { transcriptEditingApi } from "@/api/transcript-editing";
import {
  createRetranscriptionCandidate,
  type FinalTranscriptionModel,
  type MeetingLanguage,
} from "@/lib/sessionTranscription";
import {
  TranscriptCandidatePanel,
  TranscriptComparison,
} from "./TranscriptCandidatePanel";
import styles from "./RetranscribeDialog.module.css";

export function RetranscribeDialog({
  session,
  onClose,
  onBusy,
}: {
  session: Session;
  onClose: () => void;
  onBusy: (busy: boolean) => void;
}) {
  useLocale();
  const opening = useRef(session).current;
  const current =
    useSessionsStore((state) =>
      state.sessions.find((saved) => saved.id === opening.id),
    ) ?? opening;
  const recordingBusy = useRecordingStore(
    (state) => state.recording || state.processing,
  );
  const candidates = current.transcriptEditing?.candidates || [];
  const [selected, setSelected] = useState(candidates[0]?.id ?? "");
  const candidate =
    candidates.find((draft) => draft.id === selected) ?? candidates[0];
  const [vocabulary,setVocabulary]=useState<import("@heed/shared").VocabularySelection>({});
  const [vocabularyValid,setVocabularyValid]=useState(true);
  const [model, setModel] = useState<FinalTranscriptionModel>("parakeet-v3");
  const [language, setLanguage] = useState<MeetingLanguage>("auto");
  const [busy, setBusy] = useState(false),
    [saving, setSaving] = useState(false);
  const [step, setStep] = useState(""),
    [progress, setProgress] = useState<number | null>(null),
    [error, setError] = useState("");
  const [unsaved, setUnsaved] = useState<{
    id: string;
    input: CandidateInput;
  } | null>(null);
  const dialogRef = useRef<HTMLElement>(null),
    selectRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    selectRef.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  const close = () => {
    if (busy || saving) return;
    if (
      unsaved &&
      !window.confirm(
        tr(
          "Discard the unsaved result? Any draft already saved remains available in this meeting.",
        ),
      )
    )
      return;
    onClose();
  };
  const saveDraft = async (id: string, input: CandidateInput) => {
    setUnsaved({ id, input });
    const saved = await transcriptEditingApi.stage(id, input);
    setUnsaved(null);
    setSelected(
      saved.transcriptEditing?.candidates.find(
        (draft) => draft.requestId === input.requestId,
      )?.id || "",
    );
    useUIStore.getState().showToast(tr("Transcript draft saved for review"));
    return saved;
  };
  const retry = async () => {
    if (!unsaved || saving) return;
    setSaving(true);
    setError("");
    try {
      await saveDraft(unsaved.id, unsaved.input);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const start = async () => {
    const state = useRecordingStore.getState();
    if (
      busy ||
      saving ||
      unsaved ||
      candidates.length >= 2 ||
      !current.files?.wav || !vocabularyValid
    )
      return;
    if (state.recording || state.processing) {
      setError(
        tr("Wait for the current recording or transcription to finish."),
      );
      return;
    }
    setBusy(true);
    onBusy(true);
    setError("");
    setProgress(null);
    setStep(tr("Preparing transcription…"));
    useRecordingStore.setState({ processing: true });
    try {
      await createRetranscriptionCandidate(
        current,
        model,
        language,
        { onStep: setStep, onProgress: setProgress },
        saveDraft,
        vocabulary,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      useRecordingStore.setState({ processing: false });
      setBusy(false);
      onBusy(false);
    }
  };
  return (
    <div className={styles.overlay}>
      <section
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="retranscribe-heading"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            close();
          }
          if (event.key === "Tab") {
            const items = Array.from(
              dialogRef.current?.querySelectorAll<HTMLElement>("*") ?? [],
            ).filter(
              (item) => item.tabIndex >= 0 && !item.hasAttribute("disabled"),
            );
            if (!items?.length) {
              event.preventDefault();
              return;
            }
            const first = items[0],
              last = items[items.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <h2 id="retranscribe-heading">{tr("Transcribe saved audio")}</h2>
        <p>{current.title}</p>
        <p>
          {tr(
            "The complete recording will be transcribed again. Your accepted transcript changes only after you review and replace it.",
          )}
        </p>
        <label>
          {tr("Transcription model")}
          <select
            ref={selectRef}
            value={model}
            disabled={busy || saving}
            onChange={(e) =>
              setModel(e.target.value as FinalTranscriptionModel)
            }
          >
            <option value="parakeet-v3">
              {tr("Parakeet v3 · native and fast")}
            </option>
            <option value="base">{tr("Whisper base · lighter")}</option>
            <option value="small">{tr("Whisper small")}</option>
            <option value="medium">{tr("Whisper medium")}</option>
            <option value="large-v3">
              {tr("Whisper large-v3 · highest Whisper accuracy")}
            </option>
          </select>
        </label>
        <label>
          {tr("Meeting language")}
          <select
            value={language}
            disabled={busy || saving}
            onChange={(e) => setLanguage(e.target.value as MeetingLanguage)}
          >
            <option value="auto">{tr("Detect English or Portuguese")}</option>
            <option value="en">{tr("English")}</option>
            <option value="pt">{tr("Portuguese (Brazil)")}</option>
          </select>
        </label>
        <VocabularySelection finalModel={model} value={vocabulary} onChange={setVocabulary} onValidityChange={setVocabularyValid} disabled={busy||saving}/>
        <p className={styles.hint}>
          {tr(
            "Models may need to download on first use. Larger models use more memory and take longer.",
          )}
        </p>
        {!current.files?.wav && (
          <p>
            {tr(
              "Saved audio is unavailable. You can still review pending drafts.",
            )}
          </p>
        )}
        {candidates.length >= 2 && (
          <p>{tr("Discard a pending draft before creating another.")}</p>
        )}
        {busy && (
          <div role="status">
            <p>{tr(step)}</p>
            {progress !== null && (
              <progress
                max="100"
                value={progress}
                aria-label={tr("Transcription progress")}
              />
            )}
          </div>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {tr(error)}
          </p>
        )}
        <button
          type="button"
          disabled={
            busy ||
            saving ||
            recordingBusy ||
            !!unsaved ||
            candidates.length >= 2 ||
            !current.files?.wav || !vocabularyValid
          }
          onClick={() => void start()}
        >
          {busy ? tr("Transcribing…") : tr("Start transcription")}
        </button>
        {unsaved && !busy ? (
          <>
            <p>
              {tr(
                "The new transcript could not be saved. Retry saving it before replacement.",
              )}
            </p>
            <TranscriptComparison
              session={current}
              draft={{
                transcript: unsaved.input.result.text,
                segments: unsaved.input.result.segments,
                speakers: unsaved.input.result.speakers,
                duration: unsaved.input.result.duration!,
                language: unsaved.input.result.metadata.language,
                transcriptionModel: unsaved.input.result.metadata.model,
              }}
            />
            <button
              type="button"
              disabled={busy || saving}
              onClick={() => void retry()}
            >
              {tr("Retry saving draft")}
            </button>
          </>
        ) : candidate ? (
          <>
            <h3>{tr("New transcript drafts")}</h3>
            <div className={styles.actions}>
              {candidates.map((draft, index) => (
                <button
                  key={draft.id}
                  type="button"
                  aria-pressed={draft.id === candidate.id}
                  disabled={busy || saving}
                  onClick={() => setSelected(draft.id)}
                >
                  {tr("Draft {number}", undefined, { number: index + 1 })}
                </button>
              ))}
            </div>
            {!busy && (
              <TranscriptCandidatePanel
                key={`${current.id}:${candidate.id}`}
                session={current}
                candidate={candidate}
                onBusy={setSaving}
              />
            )}
          </>
        ) : (
          <p>{tr("No pending transcript drafts.")}</p>
        )}
        <div className={styles.actions}>
          <button type="button" disabled={busy || saving} onClick={close}>
            {tr("Close")}
          </button>
        </div>
      </section>
    </div>
  );
}
