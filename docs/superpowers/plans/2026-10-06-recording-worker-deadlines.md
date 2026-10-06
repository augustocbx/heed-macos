# Recording worker deadline implementation plan

1. Reproduce an indefinitely blocked real ParakeetEngine stream-finish with a synthetic subprocess and bounded test cleanup. Add stdio deadline, cancellation, lock contention, EOF, foreign-process isolation, and descendant cleanup regressions.
2. Introduce a nonblocking stdio transport with a total monotonic deadline. Integrate it into ParakeetEngine, bound singleton-factory lock admission, use duration-scaled offline limits, and recreate invalidated ASR/diarization singletons safely.
3. Reproduce HTTP headers/body hangs and coordinator finalization failure. Add deadline/AbortSignal options to pyPost and pyGet (including health readiness) while preserving its null-result contract and physical-stop-before-finalization ordering.
4. Verify synthetic worker tests, focused HTTP/lifecycle tests, existing transcription policy tests, Python syntax, and diff hygiene. Add synthetic worker tests to CI. Request independent review before any merge or installation of this followup.

Approval: the parent authorized the named conservative budgets and this narrow slice before production edits. RED was observed against the previous engine/HTTP implementation; final evidence must distinguish focused synthetic checks from real capture/deployment.
