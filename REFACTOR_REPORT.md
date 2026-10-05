# Heed — refactoring report (`refactor` branch)

> Historical upstream report for Junior. Work took place in `/Users/junrod/heed-refactor` on branch `refactor`, keeping `main` and `feat/v3-parakeet` untouched. Product strategy proposals are in [KILLER_IDEAS.md](KILLER_IDEAS.md).

## Result

The audit found that the architecture already had the right overall shape. Rather than rewrite it, the work incrementally extracted behavior using Strangler Fig and Tidy First, with tests protecting the existing pipeline. The main pre-launch reliability improvement was **process supervision preventing orphaned FFmpeg processes**.

## Changes

| Step | Commit | Change | Practice or reference |
|---|---|---|---|
| RF-1 | `fcf2a88` | Discriminated unions in `@heed/shared`: SSE contracts, recording states, and `assertNever`. `useRecording` adopts typed `subscribeLiveEvents`, replacing four repeated listener/try-catch blocks. | Wlaschin: make illegal states unrepresentable; Total TypeScript discriminated unions. Contract failures become compile errors. |
| RF-2 | `ecba4a1` | One configuration module, `lib/app-config.ts`; removal of duplicate `lib/config.ts`, `lib/input.ts`, and unused storage code; structured `lib/logger.ts`. | Tidy First structural changes and Ousterhout's deep modules. |
| RF-3+4 | `6a2632e` | Extracted `lib/process.ts`, a shared `lib/sse.ts` helper, and `lib/transcription-client.ts`. Added graceful shutdown to reap children. | Strangler Fig, OTP-style supervision, in-band SSE errors, and streaming backpressure. |
| RF-7 | `ab77ae6` | Characterization tests: 15 Python checks for diarization/voice logic, five store tests, and architecture rules with no cycles and shared as a leaf. | Feathers on legacy code and Normand's functional core. |
| RF-6 | `02420c6` | Transcript error boundary with recording controls outside it; React 19 error sinks in `createRoot`. | React error boundaries and streaming behavior. |
| RF-5 | `4399abf` | Atomic selectors in `stores/selectors.ts` using `useShallow`, adopted by `RecordPage`; confirmed audio levels already use DOM refs rather than global state. | TkDodo on Zustand. |

## Reliability improvement: orphan prevention

**The problem:** there were no signal handlers. After a server crash or exit, FFmpeg could remain running and keep the microphone busy.

**The solution:** `lib/process.ts` tracks children and reaps them on SIGINT, SIGTERM, and exit. It attempts process-group termination with a negative PID, falls back to direct termination, and uses SIGKILL after a timeout. Recording stop uses `gracefulStop`: SIGINT allows FFmpeg to flush its WAV, with a timed SIGKILL fallback. An indefinite `await .exited` can no longer hang stopping forever.

**Headless validation:** four unit tests and an end-to-end harness spawned a child, sent SIGTERM to its parent, and confirmed that the child exited:

```text
received SIGTERM — graceful shutdown
shutting down — reaping 1 child process(es)
child alive after SIGTERM: 0 (expect 0 = reaped)
```

## Recorded verification

- `bunx tsc --noEmit` for client and server: passed.
- `bun build server.ts`: bundled successfully, increasing from three to eleven modules.
- Server `bun test`: process supervision 4/4.
- Client `bunx vitest run`: 15/15, including five new store tests.
- `python3 diarize_voice_test.py`: 15/15 pure diarization and voice checks.
- `bunx --package dependency-cruiser depcruise server.ts`: no violations, cycles absent, shared a leaf.
- `doctor.py`: 6/6 on the running stack.

These are results from the original refactoring run, not a current validation report for every later change.

## Deliberate scope decisions

- No large rewrite of `server.ts` or `transcription_server.py`; extract capabilities incrementally after launch, using the new tests.
- No full store normalization at that point: rewriting every consumer would create pre-launch churn. Atomic selectors provided useful benefits without that migration.
- No XState, full event sourcing/CQRS, Vercel AI SDK, TanStack Query for SSE, Turborepo, ts-rest, or Zod-to-Pydantic generation. The rationale is documented in [REFACTOR.md](REFACTOR.md).

## Suggested follow-up order

1. Adopt `lib/sse.ts` in the remaining six SSE endpoints; it was already used by `levels`.
2. Replace direct `fetch(${TRANSCRIPTION_SERVER}...)` calls with the transcription client adapter.
3. Extract recording from `server.ts` into a vertical slice behind `@heed/shared` recording states, with microphone validation available.
4. Move remaining `console.log` calls to the logger.
5. Replace store booleans with the shared discriminated `RecordingPhase`.

The result is a tested set of contracts and seams for incremental development, rather than a cosmetic rewrite.
