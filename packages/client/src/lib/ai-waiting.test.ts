import { expect, test } from "vitest";
import type { AiWaitingReason } from "@heed/shared";
import { aiWaitingMessage } from "./ai-waiting";
import { tr } from "./i18n";
test("retrieval blocker is explicit and old omitted blockers retain their broad fallback", () => {
  expect(aiWaitingMessage("retrieval")).toBe(
    "Waiting for the local transcript catalog to become ready.",
  );
  expect(aiWaitingMessage()).toBe(
    "Waiting for recording, transcription or local AI resources.",
  );
  for (const reason of [
    "recording",
    "transcription",
    "notes",
    "tasks",
    "chat",
    "queued",
  ] satisfies AiWaitingReason[])
    expect(aiWaitingMessage(reason)).not.toBe(aiWaitingMessage());
  for (const locale of ["pt-BR", "fr", "de"] as const)
    expect(tr(aiWaitingMessage("retrieval"), locale)).not.toBe(
      aiWaitingMessage("retrieval"),
    );
});
