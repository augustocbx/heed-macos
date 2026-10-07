import type { MeetingMetadataCoverage, RetrievalCoverage, RetrievalPartialReason } from "@heed/shared";
import { useLocale } from "@/lib/i18n";
import styles from "./MeetingChat.module.css";
const reasons: Record<RetrievalPartialReason, string> = {
  "index-missing": "Some selected transcripts are not indexed yet.",
  "index-stale": "Some selected transcripts changed and need reindexing.",
  "index-capacity":
    "The index reached its storage or evidence limit. Some selected excerpts are not indexed.",
  "fallback-limit":
    "Fallback examined only a bounded part of the selected transcripts.",
  "query-budget":
    "Lexical lookup stopped before completion. Some matches may be missing.",
  "context-budget":
    "The model context budget limited the supplied input. Ask a narrower question.",
  "generation-limit":
    "Answer generation reached its request limit. Ask a narrower question.",
};
/** A complete lexical lookup cannot prove that an uncited topic is absent. */
export function retrievalEmptyMessage(coverage: RetrievalCoverage): string {
  return coverage.strategy === "lexical" &&
    coverage.indexComplete &&
    coverage.lookupComplete &&
    coverage.matchedEvidence === 0
    ? "No lexical matches found. This does not establish that the topic is absent from the selected transcripts."
    : "No supporting evidence found in the supplied excerpts.";
}
export function MeetingMetadataCoverageView({ coverage }: { coverage: MeetingMetadataCoverage }) {
  const { tr } = useLocale();
  return <>
    <p className={styles.hint}>{tr("Meeting dates: {supplied} of {selected} eligible meetings supplied.", { supplied: coverage.suppliedMeetings, selected: coverage.selectedMeetings })}</p>
    {!coverage.complete && <p className={styles.warning}>{tr("Meeting date coverage is partial. The latest meeting cannot be established across this selection.")}</p>}
  </>;
}
export function RetrievalCoverageView({
  coverage,
}: {
  coverage: RetrievalCoverage;
}) {
  const { tr } = useLocale();
  return (
    <section aria-label={tr("Retrieval coverage")}>
      <p className={styles.hint}>
        {tr(
          "Meetings: {selected} selected · {indexed} indexed · {searched} searched · {retrieved} retrieved · {supplied} supplied · {cited} cited.",
          {
            selected: coverage.selectedMeetings,
            indexed: coverage.indexedMeetings,
            searched: coverage.searchedMeetings,
            retrieved: coverage.retrievedMeetings,
            supplied: coverage.suppliedMeetings,
            cited: coverage.citedMeetings,
          },
        )}
      </p>
      <p className={styles.hint}>
        {tr(
          "Transcript excerpts: {selected} selected · {indexed} indexed · {searched} searched · {matched} matched · {retrieved} retrieved · {supplied} supplied · {cited} cited.",
          {
            selected: coverage.selectedEvidence,
            indexed: coverage.indexedEvidence,
            searched:
              coverage.searchedEvidence === null
                ? tr("unknown")
                : coverage.searchedEvidence,
            matched: coverage.matchedEvidence,
            retrieved: coverage.retrievedEvidence,
            supplied: coverage.suppliedEvidence,
            cited: coverage.citedEvidence,
          },
        )}
      </p>
      <p className={styles.hint}>
        {tr(
          coverage.strategy === "fallback"
            ? "Retrieval strategy: bounded fallback."
            : "Retrieval strategy: lexical lookup.",
        )}
      </p>
      <p className={styles.hint}>
        {tr(
          "Answers use only supplied excerpts and meeting details. Lexical coverage does not establish whole-transcript absence.",
        )}
      </p>
      {[...new Set(coverage.partialReasons)].map((reason) => (
        <p key={reason} className={styles.warning}>
          {tr(
            reasons[reason] ??
              "Retrieval coverage is limited. Ask a narrower question.",
          )}
        </p>
      ))}
    </section>
  );
}
