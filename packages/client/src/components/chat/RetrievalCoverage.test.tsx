import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import type { RetrievalCoverage } from "@heed/shared";
import {
  RetrievalCoverageView,
  retrievalEmptyMessage,
} from "./RetrievalCoverage";
import { setLocale, tr } from "@/lib/i18n";
const coverage: RetrievalCoverage = {
  version: 1,
  strategy: "fallback",
  selectedMeetings: 7,
  selectedEvidence: 70,
  indexedMeetings: 5,
  indexedEvidence: 50,
  searchedMeetings: 4,
  searchedEvidence: null,
  matchingRowsVisited: 8,
  matchedEvidence: 3,
  retrievedEvidence: 6,
  retrievedMeetings: 2,
  suppliedEvidence: 4,
  suppliedMeetings: 1,
  citedEvidence: 2,
  citedMeetings: 1,
  indexComplete: false,
  lookupComplete: false,
  generationComplete: false,
  partialReasons: [
    "index-missing",
    "index-stale",
    "index-capacity",
    "fallback-limit",
    "query-budget",
    "context-budget",
    "generation-limit",
    "fallback-limit",
  ],
};
beforeEach(() => setLocale("en"));
test("specific partial reasons are deduplicated and no search total is inferred", () => {
  render(<RetrievalCoverageView coverage={coverage} />);
  expect(
    screen.getByText(
      "Transcript excerpts: 70 selected · 50 indexed · unknown searched · 3 matched · 6 retrieved · 4 supplied · 2 cited.",
    ),
  ).toBeVisible();
  for (const text of [
    "Some selected transcripts are not indexed yet.",
    "Some selected transcripts changed and need reindexing.",
    "The index reached its storage or evidence limit. Some selected excerpts are not indexed.",
    "Fallback examined only a bounded part of the selected transcripts.",
    "Lexical lookup stopped before completion. Some matches may be missing.",
    "The model context budget limited the supplied input. Ask a narrower question.",
    "Answer generation reached its request limit. Ask a narrower question.",
  ])
    expect(screen.getAllByText(text)).toHaveLength(1);
  expect(screen.queryByRole("button")).toBeNull();
});
test.each(["en", "pt-BR", "fr", "de"] as const)(
  "%s locale translates counts and unknown without changing numeric units",
  (locale) => {
    setLocale(locale);
    render(
      <RetrievalCoverageView coverage={{ ...coverage, partialReasons: [] }} />,
    );
    expect(
      screen.getByRole("region", { name: tr("Retrieval coverage", locale) }),
    ).toBeVisible();
    expect(
      screen.getByText(
        tr(
          "Transcript excerpts: {selected} selected · {indexed} indexed · {searched} searched · {matched} matched · {retrieved} retrieved · {supplied} supplied · {cited} cited.",
          locale,
          {
            selected: 70,
            indexed: 50,
            searched: tr("unknown", locale),
            matched: 3,
            retrieved: 6,
            supplied: 4,
            cited: 2,
          },
        ),
      ),
    ).toBeVisible();
  },
);
test("zero is displayed exactly and an incomplete lookup cannot claim no lexical matches", () => {
  render(
    <RetrievalCoverageView coverage={{ ...coverage, searchedEvidence: 0 }} />,
  );
  expect(screen.getByText(/50 indexed · 0 searched/)).toBeVisible();
  expect(
    retrievalEmptyMessage({
      ...coverage,
      strategy: "lexical",
      matchedEvidence: 0,
    }),
  ).toBe("No supporting evidence found in the supplied excerpts.");
});
