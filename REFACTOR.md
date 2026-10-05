# Heed v3 — architecture refactoring (`refactor` branch)

> Historical upstream plan. Work took place in an isolated worktree, keeping `main` and `feat/v3-parakeet` untouched. Changes were incremental, with structural and behavioral commits separated following Tidy First. Sources are listed below.

## Assessment

The architecture already has the right overall shape: one-way SSE, child-process supervision, shared types, and Python ports/adapters. For a solo founder launching soon, the main risk is an ambitious rewrite. The plan instead uses Strangler Fig and Sprout/Wrap techniques with characterization tests, preserving the working pipeline.

Two areas merit reliability work before launch: **bounded backpressure** and **process supervision**. An orphaned FFmpeg process holding the microphone can make a real-time transcription app appear broken.

## Audit findings — six critical items

1. `server.ts`: **2,197 lines**, combining more than eight domains: routing, FFmpeg, Ollama, SSE, recording state, configuration, sessions, setup, and recovery.
2. **Global mutable state** in `server.ts`: 14 variables around lines 1108–1391, changed by multiple asynchronous handlers, creating races such as stopping during an in-flight live chunk.
3. **29 `catch {}` blocks** silently swallowing errors, including corrupt configuration becoming an empty object.
4. `useRecording.ts`: **390 lines**, coupling the API, three EventSource instances, animation, and Zustand.
5. `transcription_server.py`: **1,741 lines**, combining HTTP, models, diarization, SSE, and voices.
6. Live state spread across seven variables and two functions, without an explicit lifecycle.

Other high-priority findings: incompatible append/replace/upsert store patterns; an implicit SSE contract without discriminated unions; no error recovery in `_stream_dual`; duplicate `loadConfig()` implementations; no recording state machine; no structured logging; and approximately **0.4% test coverage** across two files.

## Reference sources

- **Vercel Web Interface Guidelines:** https://vercel.com/design/guidelines and the MIT-licensed `vercel-labs/web-interface-guidelines` repository.
- **Vercel AI SDK:** streaming, error handling, backpressure, and stopping streams at https://ai-sdk.dev. The plan does not adopt the SDK; it adopts distinctions such as partial/final results, in-band errors, and abort versus finish.
- **John Ousterhout, _A Philosophy of Software Design_:** deep modules, information hiding, and defining errors out of existence.
- **Martin Fowler, _Refactoring_, second edition; Strangler Fig; SelfTestingCode:** small steps rather than a large rewrite.
- **Michael Feathers, _Working Effectively with Legacy Code_:** seams and characterization tests for code without a safety net.
- **Kent Beck, _Tidy First?_:** separate structural changes from behavioral changes.
- **Eric Normand, _Grokking Simplicity_:** functional core and imperative shell; distinguish actions, calculations, and data.
- **Alistair Cockburn, hexagonal architecture; Scott Wlaschin, _Domain Modeling Made Functional_; Jimmy Bogard, vertical slices:** explicit boundaries and capabilities rather than universal layers.
- **The Grug Brained Developer, Dan Abramov, and Sandi Metz:** avoid premature abstraction; duplication can be cheaper than a wrong abstraction.
- **React 19 documentation, TkDodo on Zustand/React Query, react-error-boundary, Total TypeScript, dependency-cruiser, and Bun workspaces.**

## Execution plan

- **RF-1 — contracts:** discriminated unions in `shared` for SSE events and recording states, plus `assertNever`. Contract errors should fail compilation.
- **RF-2 — structural:** consolidate configuration into one module and add structured logging.
- **RF-3 — structural extraction:** extract behavior-preserving `sse.ts`, `process-supervisor.ts`, `ollama.ts`, and `transcription-client.ts` modules from `server.ts`.
- **RF-4 — reliability behavior:** graceful shutdown reaps FFmpeg and system capture on SIGTERM/SIGINT; add readiness checks, in-band SSE errors, and heartbeats.
- **RF-5 — client:** normalize transcript state with `segmentsById` and `segmentIds`, use atomic selectors, keep audio levels outside global state, and add a discriminated state machine.
- **RF-6 — client:** place an error boundary around the transcript while keeping recording controls outside it; add `onUncaughtError` to `createRoot`.
- **RF-7 — safety net:** characterize pure TypeScript/Python functions and enforce no cycles plus shared-leaf boundaries with dependency-cruiser.

## Deliberately excluded complexity

A large rewrite of either main file; universal hexagonal layers; XState; full event sourcing/CQRS; a generic supervision framework; adopting the Vercel AI SDK; TanStack Query for SSE; React Actions/useOptimistic/`use`; ts-rest; Zod-to-Valibot migration; Turborepo/Nx; Zod-to-Pydantic code generation; URL-as-state/i18n; universal branded types; RSC/Next caching.

## Headless verification

Use `bunx tsc --noEmit` for client/server, `bun test` for pure TypeScript logic, Python self-tests, `doctor.py`, alternate-port boot smoke tests, and `bunx depcruise`. Junior validates live capture and stopping with the physical microphone.
