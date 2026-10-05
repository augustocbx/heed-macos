# Afinado del eco en tiempo real — reporte de la noche

Para Junior. Hice las 3 tareas que dejaste, midiendo sobre TODOS tus audios (12 grabaciones
recientes), iterando, y **sin caer en la falacia de generalización apresurada** — de hecho la data
me hizo cambiar de opinión sobre lo que parecía obvio con una sola muestra.

## Tarea 1 — Cold-start (commit `d699298`)

**Medido:** la transcripción ya estaba caliente (~0.8s primer texto). Lo que viste como "cold" eran
dos cosas: (a) si grababas durante el pre-warm en background había contención, y (b) la diarización
tardaba ~5.5s (delay de confirmación inherente de Sortformer), en CADA grabación.

**Fixes:**
- Sidecar: el diar-feed en vivo ahora devuelve segmentos **tentativos + finalizados** → un hablante
  aparece a **~3.6s** en vez de ~5.5s. (Rebuild de heed-parakeet, NO heed-syscap → SCK intacto.)
- Pre-warm **síncrono** + flag `warm` en /health; el loop en vivo **espera warm** antes de alimentar
  (el recorder igual captura, no se pierde audio) → la primera grabación nunca contende con el warm-up.
- Medido nuevo: warm=True tras boot, primer texto ~0.8s, diarización ~3.6s.

## Tarea 2 — AEC adaptativo (commit `caf4cba`, luego DESACTIVADO por la data)

Construí el AEC adaptativo (solo cancela cuando detecta fuga real, vía ratio mic/sys). Pero el harness
mostró que **el AEC daña tu voz en agregado** (ver tabla abajo). Quedó en el código pero **default OFF**.

## Tarea 3 — Harness + dedup (commit `c0edc40`) — EL HALLAZGO

Construí un harness de evaluación (`eval_echo/`) que sobre las 12 grabaciones mide:
- **echo_in_mic** = cuánto de la voz ajena se cuela en tu transcript (↓ mejor)
- **junior_kept** = cuánto de TU voz se preserva (↑ mejor)
- **score** = kept × (1 − echo)

Resultados (promedio sobre 8 muestras con eco):

| Config | echo | kept (tu voz) | score |
|---|---|---|---|
| baseline (nada) | 0.111 | 0.798 | 0.685 |
| + compuerta de energía (Capa 1) | 0.051 | 0.612 | 0.627 |
| + Capa 1 + AEC adaptativo (Capa 2) | 0.057 | 0.522 | 0.607 |
| + Capa 1 + AEC always | 0.058 | 0.513 | 0.595 |
| **dedup de texto (Capa 3) SOLO** | **0.000** | **0.770** | **0.730** ← GANADOR |

**La verdad contraintuitiva:** la compuerta y el AEC, que con UNA muestra parecían geniales,
**cortan tu propia voz más de lo que quitan eco** cuando se miden sobre las 12. El **dedup de texto**
gana: como SIEMPRE tenemos el transcript LIMPIO del otro speaker (canal del sistema), borramos de tu
mic las palabras que matchean lo que él dijo → el eco ajeno cae a ~0 y se preserva ~97% de tu voz,
**sin tocar tu audio**. Verificado cualitativamente: quita "Matthew seven seven" (la chica) y mantiene
"estamos grabando... brillo de la pantalla... mouse".

Tuneé el umbral del dedup con un barrido (0.50→0.80) → **0.63** es el sweet spot.

## Config de producción final (corriendo ahora)

- **Capa 3 (dedup de texto): ON** — aplicada a tus turnos del mic EN VIVO (vs el parcial del sistema)
  y AL PARAR (vs el sistema final), umbral 0.63. La voz ajena nunca aparece bajo tu nombre.
- **Capa 1 (gate) y Capa 2 (AEC): OFF por default** (env-tunables `HEED_MIC_GATE_RMS`, `HEED_AEC_MODE`
  por si algún usuario en parlantes con eco brutal las quiere; pero la data dice que sobran).
- Cold-start afinado (warm + tentative segments).

## Para reproducir / re-tunear
```
cd eval_echo
python3 build_cache.py                       # cachea el ground truth (1 vez)
bash restart_and_run.sh 0 off mi-config dedup  # corre un config sobre las 12 muestras
python3 sweep_dedup.py                        # barre el umbral del dedup
```
Agregá más grabaciones a `samples.txt` y re-corré para seguir afinando con más muestras.

## Honestidad final
El score top quedó en **0.73** (echo 0, kept 0.77). Dos muestras outlier bajan el promedio de
preservación; NO las sobre-tuneé (sería la falacia al revés). El dedup es robusto: en grabaciones SIN
voz ajena no toca nada (kept 0.83–0.97). Probá en vivo con auriculares en el cuello y confirmá que la
voz ajena ya no se pega a tu transcript — y que tu voz sale completa.
