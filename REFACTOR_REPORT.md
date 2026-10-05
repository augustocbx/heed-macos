# heed — Reporte de refactor (rama `refactor`)

> Para Junior, cuando despiertes. Todo en el worktree `/Users/junrod/heed-refactor`, rama
> `refactor`. `main`/`feat/v3-parakeet` INTACTOS. Cada commit deja el código verde (tsc + tests).
> Las ideas killer para destruir competencia están en `KILLER_IDEAS.md` (documento aparte).

## TL;DR (la verdad primero)

Hice un research profundo con fuentes top oficiales y actualizadas, una auditoría arquitectónica
con evidencia (file:line), y ejecuté un refactor **incremental y verde** — NO un rewrite. La
conclusión más importante, que te debo con honestidad: **tu arquitectura ya tiene la forma
correcta**. El riesgo #1 para vos (fundador solo, lanzando en días) no es "mala arquitectura", es
**la trampa del rewrite elegante** — la forma en que mueren los proyectos solo antes de lanzar
(Netscape, documentado por Joel Spolsky/Fowler). Por eso NO reescribí nada de cero. Estrangulé los
God files con Strangler Fig + Tidy First, con red de seguridad de tests, dejando el pipeline idéntico.

Lo que SÍ tiene impacto real de confiabilidad antes de lanzar — y lo implementé y probé headless —
es **supervisión de procesos (anti-ffmpeg-huérfano)**. Eso es lo que de verdad rompe un
transcriptor en tiempo real en una laptop sin ventilador.

## Qué hice (7 commits, todos verdes)

| # | Commit | Qué | Práctica / fuente |
|---|--------|-----|-------------------|
| RF-1 | `fcf2a88` | Uniones discriminadas en `@heed/shared`: contrato de eventos SSE + máquina de estados de grabación + `assertNever`. Adoptado en `useRecording` con un `subscribeLiveEvents` tipado (mata 4 bloques `addEventListener`+try/catch). | "Make illegal states unrepresentable" (Wlaschin); discriminated unions (totaltypescript). Contrato roto = error de compilación, no falla silenciosa. |
| RF-2 | `ecba4a1` | Config en UN módulo (`lib/app-config.ts`); **borré código muerto** (`lib/config.ts` duplicado, `lib/input.ts`, `lib/storage/*`); logger estructurado (`lib/logger.ts`). | Tidy First (Beck): estructural, sin cambio de comportamiento. Deep modules (Ousterhout). |
| RF-3+4 | `6a2632e` | Extraje `lib/process.ts` (supervisor de procesos), `lib/sse.ts` (helper SSE único, antes copiado en 7+ endpoints), `lib/transcription-client.ts` (único adapter al sidecar Python). **Graceful shutdown anti-huérfano.** | Strangler Fig (Fowler); supervisión estilo OTP (Erlang); SSE in-band errors + backpressure (Vercel AI SDK, research de streaming). |
| RF-7 | `ab77ae6` | Characterization tests de las funciones PURAS: 15 checks Python (diarización + voz) + 5 tests del store + reglas de arquitectura (dependency-cruiser: 0 ciclos, shared es leaf). | Feathers ("legacy = código sin tests"); functional core (Normand). |
| RF-6 | `02420c6` | Error boundary alrededor del transcript con los controles AFUERA (nunca perder una grabación) + sinks de error de React 19 en `createRoot`. | react.dev error boundaries; research de React/streaming. |
| RF-5 | `4399abf` | Selectores atómicos del store (`stores/selectors.ts`, `useShallow`); adoptados en `RecordPage` (antes suscribía al store entero). Verifiqué que los niveles de audio YA están fuera del estado global (refs al DOM). | TkDodo (Zustand). |

## La pieza de confiabilidad que importa: anti-ffmpeg-huérfano (probado)

**El problema real** (de la auditoría): no había NINGÚN handler de señales. Si el server crasheaba o
salías, ffmpeg seguía corriendo **agarrando el micrófono** → "la app está rota" / el mic queda
ocupado. Es el bug #1 que se siente como app rota en este tipo de apps.

**La solución** (`lib/process.ts`): cada hijo (recorder, captura de sistema, level meter) se
`track()`-ea; un hook único en SIGINT/SIGTERM/exit los reapea (kill del GRUPO por PID negativo →
fallback a kill directo → SIGKILL tras timeout). El stop ahora usa `gracefulStop` (SIGINT para que
ffmpeg flushee limpio → SIGKILL de respaldo) así un ffmpeg colgado no puede trabar el stop para
siempre (antes hacía `await .exited` sin timeout = potencial cuelgue eterno).

**Probado headless** (sin mic): 4 unit tests + un harness end-to-end que spawnea un hijo, le manda
SIGTERM al padre, y verifica que el hijo muere (vivo→reapeado, 1→0). Output real:
```
received SIGTERM — graceful shutdown
shutting down — reaping 1 child process(es)
child alive after SIGTERM: 0 (expect 0 = reaped)
```

## Verificación (todo headless, reproducible)

- `bunx tsc --noEmit` (client + server): limpio.
- `bun build server.ts`: bundlea (3→11 módulos, sin errores).
- `bun test` (server): supervisor 4/4.
- `bunx vitest run` (client): 15/15 (incluye los 5 nuevos del store).
- `python3 diarize_voice_test.py`: 15/15 (diarización + voz puras).
- `bunx --package dependency-cruiser depcruise server.ts`: 0 violaciones (sin ciclos, shared leaf).
- `doctor.py`: 6/6 (en el stack que ya corre).

## Decisiones honestas de alcance (lo que NO hice, a propósito)

Estas son TRAMPAS de sobreingeniería para un fundador solo que lanza en días (lo dicen todas las
fuentes: Grug Brained Developer, Sandi Metz, el propio Fowler):

- **NO** big-bang rewrite de server.ts (2197 líneas) ni de transcription_server.py. Se estrangulan
  por capacidad, post-lanzamiento, con la red de tests ya puesta.
- **NO** normalización completa del store (`segmentsById`+`segmentIds`): reescribe TODOS los
  consumidores = churn justo antes de lanzar. Diferida (los selectores atómicos ya dan el 80% del
  beneficio sin tocar consumidores).
- **NO** XState, **NO** event-sourcing/CQRS completo, **NO** Vercel AI SDK, **NO** TanStack Query
  para el stream SSE, **NO** Turborepo, **NO** ts-rest, **NO** codegen Zod→Pydantic. Cada uno
  agrega complejidad/peso sin pagar antes del lanzamiento. (Razonadas en `REFACTOR.md`.)

## Cómo seguir (post-lanzamiento, orden sugerido)

1. Adoptar `lib/sse.ts` en los 6 endpoints SSE restantes (ya está en `levels`).
2. Adoptar `tx.*` (transcription-client) en los call sites directos `fetch(${TRANSCRIPTION_SERVER}...)`.
3. Estrangular el loop de grabación de `server.ts` a un `recording/`-slice (vertical slice, Bogard)
   detrás de la máquina de estados de `@heed/shared` — con el mic disponible para validar.
4. Migrar los `console.log` restantes al `logger`.
5. Reemplazar los booleanos del store por la `RecordingPhase` discriminada de `@heed/shared`.

Todo esto es seguro PORQUE el refactor de esta noche dejó las costuras (seams), los tipos y los
tests para hacerlo sin miedo. Esa es la verdadera entrega: no "código más lindo", sino **una base
sobre la que se puede construir rápido y sin romper** — que es justo lo que habilita las ideas
killer del otro documento.
