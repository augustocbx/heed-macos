# Diarización en vivo "post-stop en vivo" — tuning con las 3 grabaciones

Harness que prueba la hipótesis: correr el motor OFFLINE (`performCompleteDiarization`, el del
post-stop, DER 10.6%) sobre una ventana rolling cada pocos segundos + reconciliación por embedding +
naming conservador → tiene la precisión del post-stop pero en vivo. Medido sobre las 3 grabaciones
recientes de Junior, NO una (sin generalización apresurada). Ground truth = el post-stop REAL
(diarize full + filtro de spurious ≥3s Y ≥12%).

## Resultado con el config ganador
```
W=30 STEP=2 MERGE=0.55 RECON=0.55 CONSOLIDATE=0.5 NAME(thr=0.62 margin=0.08 mindur=4) filtro(3s,12%)

grabación (sys)            GT  live  phantom  churn   naming
342s (3→2 tras filtro)      2    2      0      2/85   Learn 0.925 (resto genérico) ✓
86s  (1 hablante)           1    1      0      0/19   Learn 0.957 ✓
53s  (2 hablantes)          2    1      0      0/27   Learn 0.968 ✓ (pierde 1 hablante de 5s)

TOTAL phantom: 0   (objetivo: 0)
```

## Qué se logró vs el bug de las imágenes
- **Fantasmas (un hablante partido en Speaker 1/2/3): ELIMINADOS.** 0/3 grabaciones. Antes: rampante.
- **Naming cruzado (hombre → "Learn"): resuelto por diseño.** Umbral 0.5→0.62 + margen top1-top2 0.08
  + duración mínima 4s. El hombre matcheaba a ~0.52 → ahora queda genérico. En la de 342s (3
  hablantes) SOLO el que es Learn recibió el nombre (0.925); los otros quedaron `Speaker N`.
- **Churn (parpadeo): casi nulo** (0-2 cambios de etiqueta en 19-85 ticks).

## Por qué funciona (claves del diseño)
1. **Motor offline en ventana** (no Sortformer streaming): clustering global → un hablante = un
   cluster. Medido: sobre ventana de 30s NO sobre-parte (a diferencia de streaming).
2. **Reconciliación por embedding** (registro de sesión): los IDs del sidecar se renumeran/acumulan
   entre corridas → inútiles; la identidad se lleva por cosine del voiceprint 256-dim. Same voice
   ≈0.7+, different ≈0.0 → separación enorme.
3. **Consolidación del registro** (fusiona splits accidentales) + **airtime REAL** por tick activo +
   el mismo filtro de spurious del post-stop (≥3s Y ≥12%) → mata blips.
4. **Naming conservador** con umbral+margen+duración sobre el embedding ACUMULADO del hablante.

## Límite honesto (no sobre-tuneado)
La 53s pierde un hablante secundario de 5s (14.8% del habla, cos 0.051 = persona distinta real). La
ventana rolling tiene menos contexto que el post-stop full → lo absorbe. Es el problema OPUESTO (y
mucho menos grave) al de las imágenes. La fase de **enrollment** (voces conocidas nombradas desde su
1ª palabra) y ventanas/step afinables por hardware lo mejoran después. NO se fuerza el config a este
outlier para no reintroducir fantasmas en las otras 2.

## Config a portar a producción
`transcription_server.py` (endpoint `/diar/live` + registro de sesión) usa exactamente
`eval_diar/reconcile.py`: `merge_within_window(0.55)` → `Registry(recon=0.55).update` →
`consolidate(0.5)` → `name_speakers(thr=0.62, margin=0.08, mindur=4)`; airtime real + filtro (3s,12%).
Ventana 30s, cadencia 2s (afinable por hardware en la fase de escalado).

## Reproducir
```
cd eval_diar
python3 exp_window.py <rec.wav> 30 3     # ¿la ventana sobre-parte? (viabilidad)
python3 simulate.py --all                # score sobre las 3 (config por env: W, STEP, RECON, ...)
```
