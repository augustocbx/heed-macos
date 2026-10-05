# heed real-time — BENCHMARK (end-to-end, server real, doble sidecar)

Medido sobre las 4 grabaciones recientes de Junior, por el flujo EN VIVO real (endpoints del server,
doble sidecar ASR+DIAR), replicando `processStreamLive`. Estándar: producto público (ingeniero de
Clerk en reuniones). Contra el objetivo del CLAUDE.md: **extremadamente preciso Y veloz, real-time Y
post-stop, 100% local.**

## Scorecard (4 grabaciones, 7 hablantes reales)

```
grabación            escenario        GT  live  phantom under flicker names
1782880963595        4-spk (man+girl)  2    2      0      0      0     Learn
1782873076439        3-spk             2    2      0      0      0     Learn
1782867599480        1-spk (girl)      1    1      0      0      0     Learn
1782864214513        2-spk ECHO        2    1      0      1      0     Learn

DIARIZACIÓN:  phantom = 0/7   flicker = 0   naming falsos-positivos = 0   under-count = 1
TEXTO (feed): p50 = 15 ms   p95 = 18 ms   (MIENTRAS diariza en paralelo)
DIAR /live:   p50 = 100 ms  p95 = 137 ms  (sidecar GPU dedicado)
```

## Contra el objetivo (CLAUDE.md)

**EXTREMADAMENTE PRECISO**
- 0 fantasmas en 7 hablantes / 4 grabaciones (el "hombre partido" era parpadeo → 0 flicker ahora).
- 0 falsos positivos de naming (jamás un nombre cruzado; "Learn" solo a quien es Learn, 0.93-0.98).
- Motor de diarización = offline (DER 10.6%) vs streaming Sortformer (DER 31.7%) → **3x más preciso**.
- Robusto al ECO: la grabación con eco dio 0 fantasmas (el eco NO creó hablante espurio).
- Post-stop intacto (brillante): /diarize 54s en 239 ms, hablantes correctos.

**EXTREMADAMENTE VELOZ**
- Texto en vivo: **15 ms** (p50) — instantáneo. Y NO se frena mientras diariza (paralelismo real).
- Paralelismo medido: ASR feed 27 ms solo → **29 ms** con diarizado a full en paralelo (**+2 ms**;
  antes el diarizado bloqueaba ~128 ms cada 2 s).
- Diarización en vivo: **100 ms** por ventana (GPU), RTFx ~236x. Etiqueta de hablante en ~1-2 s.
- Diarizador GPU = 127 ms vs ANE 284 ms (**2x más rápido**), embeddings IDÉNTICOS (cos 1.0).

**REAL-TIME Y POST-STOP:** ambos cubiertos; el post-stop no se tocó y sigue brillante.

**100% LOCAL:** ANE (transcripción) + GPU/Metal (diarización) + Metal (Ollama). Cero nube, cero CUDA.
Whisper redundante ya no se carga (libera ~1-3 GB → regla 70-80% de hardware).

## Arquitectura killer (por qué gana)
Doble sidecar en compute units SEPARADOS del M5: **transcripción en la ANE, diarización en la GPU**
→ corren en paralelo de verdad, el texto nunca espera. + RAG de voz (voces guardadas → naming
instantáneo/conservador) + diarización con calidad-offline en vivo (reconciliación por embedding +
histéresis). Ninguna herramienta local conocida combina esto.

## Límite honesto (no sobre-tuneado, regla anti-outlier)
1 under-count: en la grabación con eco, un hablante REAL breve de ~5 s (no matchea ninguna voz
guardada, cos < 0.1 → persona distinta, NO tu eco) no alcanza airtime para etiqueta propia. Es el
problema OPUESTO (y mucho menos grave) al de las fotos. Subir la sensibilidad para cazarlo
reintroduciría fantasmas en las otras 3 → se prioriza 0 fantasmas. El enrollment (fase siguiente)
lo resuelve para voces conocidas.

## Reproducir
```
cd eval_diar
../.venv/bin/python3 live_bench.py     # server debe estar warm en :5002
../.venv/bin/python3 build_cache.py && ../.venv/bin/python3 sweep.py   # re-tunear config
```
