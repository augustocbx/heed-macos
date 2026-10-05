# heed v3 — Refactor de arquitectura (rama `refactor`)

> Worktree aislado. `main`/`feat/v3-parakeet` intactos. Todo verde e incremental (Tidy First:
> commits estructurales separados de los de comportamiento). Investigación basada en fuentes top
> oficiales y actualizadas (citas abajo). El norte: ingeniería de élite SIN matar el lanzamiento.

## Meta-veredicto (la verdad, aunque incomode)

La arquitectura ya tiene la **forma correcta** (SSE unidireccional + supervisión de procesos hijos +
tipos compartidos + puertos/adaptadores en Python). El riesgo #1 para un fundador solo que lanza en
días NO es "mala arquitectura" — es la **trampa del rewrite elegante**. Todos los autores que envían
software (Fowler, Beck, Bogard, Ousterhout, el Grug-Brained Developer) dicen lo mismo: **lanza
primero, estrangula los God files incrementalmente después**. Por eso este refactor NO reescribe
nada de cero: estrangula con Strangler Fig + Sprout/Wrap, con red de seguridad de characterization
tests, manteniendo el pipeline funcionando idéntico.

Dos áreas SÍ merecen ingeniería real antes de lanzar, porque son lo que **de verdad rompe** un
transcriptor en tiempo real en una laptop sin ventilador: **backpressure** (buffer acotado) y
**supervisión de procesos** (ffmpeg huérfano = "la app está rota").

## Hallazgos del audit (evidencia, file:line) — los 6 CRÍTICOS

1. `server.ts` = **2197 líneas**, God file con 8+ dominios (routing HTTP + ffmpeg + Ollama + SSE +
   estado de grabación + config + sesiones + wizard + recovery).
2. **Estado mutable global** en server.ts (14 vars, líneas ~1108–1391) mutado por varios handlers
   async → carreras (parar mientras un chunk live está in-flight).
3. **29 `catch {}`** que tragan errores en silencio (config corrupta → `{}` silencioso, etc.).
4. `useRecording.ts` = **390 líneas**, mega-hook acoplando API + 3 EventSource + animación + Zustand.
5. `transcription_server.py` = **1741 líneas**, monolito HTTP + modelos + diarización + SSE + voces.
6. Máquina de estados del live dispersa en 7 vars + 2 funciones, sin ciclo de vida explícito.

ALTOS: store con 3 patrones de mutación incompatibles (append/replace/upsert); contrato SSE implícito
sin uniones discriminadas; `_stream_dual` sin recuperación de error; **dos `loadConfig()` duplicados**
(server.ts inline + lib/config.ts); lifecycle de grabación sin state machine; sin logging estructurado;
**cobertura de tests ~0.4%** (2 archivos).

## Fuentes top consultadas (oficiales / autores de referencia)

- **Vercel Web Interface Guidelines** — https://vercel.com/design/guidelines (repo MIT
  vercel-labs/web-interface-guidelines; instalable como *agent command* para Claude Code).
- **Vercel AI SDK** — streaming/error-handling/backpressure/stopping-streams (ai-sdk.dev). NO adoptar
  el SDK (heed no llama LLM); robar la disciplina: `partial` vs `final`, errores in-band, abort≠finish.
- **Ousterhout, *A Philosophy of Software Design*** — módulos profundos, ocultar información,
  "define errors out of existence". (No es dogma de archivos chiquitos.)
- **Fowler, *Refactoring* 2ª ed + Strangler Fig + SelfTestingCode** — pasos chicos, big-bang falla.
- **Feathers, *Working Effectively with Legacy Code*** — seams + characterization tests (autor clave
  ahora: ambos God files = legacy por falta de tests).
- **Kent Beck, *Tidy First?*** — nunca mezclar cambios estructurales y de comportamiento (commits
  separados) = sustituto del code review para un dev solo.
- **Eric Normand, *Grokking Simplicity*** — functional core / imperative shell (acciones vs cálculos
  vs datos): los bugs de tiempo real viven en las "acciones".
- **Cockburn (Hexagonal)**, **Wlaschin (*Domain Modeling Made Functional*** — make illegal states
  unrepresentable), **Bogard (Vertical Slice** — cortar por capacidad, no por capa).
- **Grug Brained Developer / Abramov / Sandi Metz** — vacuna anti-sobreingeniería: "la duplicación es
  más barata que la abstracción equivocada"; no factorizar antes de tiempo.
- **React 19 oficial + TkDodo (Zustand/React Query) + react-error-boundary + totaltypescript**
  (uniones discriminadas) + **dependency-cruiser** (no-circular) + **Bun workspaces**.

## Plan de ejecución (lo que SÍ se hace, todo verde)

- **RF-1 (cero riesgo):** uniones discriminadas en `shared` — eventos SSE + state machine de
  grabación + `assertNever`. Hace los errores de contrato fallar en compile-time.
- **RF-2 (estructural):** consolidar config en UNA fuente (matar el dup), logger estructurado.
- **RF-3 (estructural, Strangler):** extraer de server.ts módulos behavior-preserving: `sse.ts`
  (3 implementaciones → 1), `process-supervisor.ts`, `ollama.ts`, `transcription-client.ts`.
- **RF-4 (comportamiento, alto valor, testeable headless):** graceful shutdown (SIGTERM/SIGINT mata
  ffmpeg/syscap por negative-PID → cero huérfanos), readiness checks, errores SSE in-band + heartbeat.
- **RF-5 (cliente):** normalizar el store del transcript (`segmentsById`+`segmentIds`) + selectores
  atómicos; sacar niveles de audio del estado global; state machine discriminada.
- **RF-6 (cliente):** error boundary alrededor del transcript con los controles AFUERA (nunca perder
  una grabación) + `onUncaughtError` en createRoot.
- **RF-7 (red de seguridad):** characterization tests de las funciones PURAS (TS + Python) +
  dependency-cruiser (no-circular, shared-leaf).

## TRAMPAS que se EVITAN explícitamente (sobreingeniería para un fundador solo que lanza en días)

Big-bang rewrite de cualquier God file · Hexagonal/capas en todo · XState · event-sourcing/CQRS
completo · framework de supervisión genérico · adoptar el Vercel AI SDK · TanStack Query para el
stream SSE · React 19 Actions/useOptimistic/`use` · ts-rest · migrar Zod→Valibot · Turborepo/Nx ·
codegen Zod→Pydantic · URL-as-state/i18n · branded types universales · RSC/Next caching.

## Cómo verifico sin mic (headless)

`bunx tsc --noEmit` (client+server) · `bun test` (funciones puras TS) · pytest/`python -m` self-tests
(funciones puras Python) · `doctor.py` 6/6 · smoke boot en puertos alternos · `bunx depcruise`.
La UX live+stop con mic real la prueba Junior.
