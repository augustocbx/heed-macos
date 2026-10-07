# Issue 7 transcript correction evidence

## Independently reviewed server workflow

The protected HTTP/storage workflow at `26e67b8` passed two independently reproduced tests and 52 assertions. It covers two-client EN/PT proper-name corrections, literal replacement preview/confirmation, speaker rename followed by a compatible inverse, unchanged times/channel/attribution, durable request retry, service/disk restart, candidate stage/discard/restage/explicit acceptance, v2 transfer to a second store and unknown v1 notes provenance. Exact retained media bytes and the canonical evidence source are checked. An injected atomic writer failure preserves exact persisted bytes and a held notes worker; a successful retry supersedes that worker only after durable persistence, and its late output is rejected.

The convenience meeting adapter delegates to the actual notes mutation boundary; the workflow is not a spawned full application server. Restart reconstructs services against persisted state. Its zero-filled media fixture proves byte/path preservation, not valid WAV playback or physical capture. These limits do not substitute for the separate production UI/playback/runtime gates.

Legacy HTTP fixtures at `f95de727` were migrated to full source guards and explicit candidate acceptance, with no production guard relaxation. Four independently reproduced files passed 20 tests/189 assertions. Existing tag/restart/preemption/note-provenance assertions remain. Portable recovery review additionally verifies received artifact byte identity, branch source-identity replay, unknown versus verified provenance, malformed semantic duplicates and bounded repeated-hash replay without dropping journal actions.

## Remaining runtime and handoff gates

Client request-ordering review is resolving delayed navigation/notes-control response races. Saved correction/history and retranscription comparison interfaces are being completed against the reviewed API contracts. Full server/client regression, production UI on both Macs, narrow/keyboard/four-locale checks, actual synthetic WAV seek/edit separation, refresh/conflict/candidate recovery, independent whole-branch review and exact-head CI remain required before merge.

No installed application, personal recording or private transcript has been changed for this work. Physical device permissions and human meeting recognition quality are not inferred from server or UI fixtures. The controller records actual completed runtime evidence and applicable remaining limits here before handoff; this foundation report does not assert issue completion.
