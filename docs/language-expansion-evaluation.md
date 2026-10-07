# French and German transcription evaluation

Issue #22 is a research and decision deliverable. No French/German recognition
option is enabled by this change. Existing English/Portuguese admission, live
preferences, full finalization, transcript review and all four interface locales
remain independent of this evaluation.

## Capability and policy audit

| Path | Upstream capability | Current Heed policy | Proposed FR/DE behavior |
|---|---|---|---|
| MLX multilingual Whisper base/small/medium/large-v3 | Multilingual transcription, language hints and detection | Registered live EN/PT; explicit full-audio manual EN/PT | Candidate for fixed-language preview and manual final passes, gated by measured weight identity |
| Whisper `.en` | English only | PT admission refuses | Refuse FR/DE before model loading; never select another model silently |
| Native Parakeet TDT v3 / FluidAudio | French/German among the published multilingual languages | Existing external EN/PT detector and immutable final-language policy | Candidate for full final passes with an explicit acoustic language decision |
| Native streaming Nemotron path | Separate language-specific streaming variants | Only explicitly selected registered EN/PT live path | Not evaluated here; no inferred FR/DE streaming support |
| Unknown or missing model/variant | Unverified | Explicit unsupported/unavailable state and final-only action | Refuse the selected combination; offer a separate user choice |

The [NVIDIA model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
lists 25 languages including FR/DE. Heed's adapter constant currently lists 28
token-filter languages; that enum is not evidence that all corresponding
languages were trained or accepted. This study concerns EN/PT/FR/DE only.
[FluidAudio's batch documentation](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/ASR/GettingStarted.md)
distinguishes multilingual v3 from English v2; Heed also has different native
flat-text and timestamped decoding paths. We measure the existing timestamped
v3 path rather than assume upstream headline throughput applies locally.
[MLX Whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper)
is an Apple Silicon adapter; its model capabilities are distinct from the
product's stricter registered EN/PT policy.

## Evaluation design

The deterministic human cohort selects the first four test rows for each of
`fr_fr`, `de_de`, `en_us`, and `pt_br` from Google's
[FLEURS dataset](https://huggingface.co/datasets/google/fleurs), CC-BY-4.0.
No sample is selected by its recognition result. Audio is converted to mono
PCM16 at 16 kHz, preserving duration. A three-second silent control and a
four-language concatenation are added. The latter joins different human
speakers with half-second gaps; it is not natural within-speaker code switching.
The sample is too small to represent regional-accent diversity.

The cohort has 18 files, 8,089,016 bytes and manifest SHA-256
`d5964062662453ae879242f5f91a6aa0ca89bfbd3987e96a365e91a6566eb0ce`.
Original downloaded audio, public transcript references, converted files,
predictions and machine measurements remain outside Git. The public source
configuration/split/row and actual content hashes accompany each fixture.

`scripts/qa/language_research.py` reuses the existing engine adapters,
`live_language_metrics.error_metrics`, native worker lifecycle and process
measurement/ownership helpers. Each selected engine runs in a fresh process
with outbound networking denied and existing cached weights only. It records
actual weight/native/evaluator/cohort/source hashes, actual timestamps, per-case
latency and aggregate owned-process RSS/CPU. Shared memory can be counted twice;
RSS is not a total GPU-residency measurement. First-call timing includes lazy
MLX loading; later calls are warm. Native constructor startup precedes per-call
latency. Reports must not compare these as identical cold-start measures.

Two repeats run every fixture through multilingual Whisper base, native v3
timestamped transcription and the existing tiny Whisper language model. The
tiny model is evaluated with a research decision function without changing
`meeting_language.py`. The current EN/PT-only decision is recorded alongside
the proposed decision to expose the restricted-detector limitation. This is
raw adapter research, not a deployed full meeting or live-chunk quality test.

The attempted `small` condition refused on M4 Pro before inference because its
weights were not cached. The comparable rerun explicitly selects base/native/
detection on both Macs. No fallback engine or implicit model download occurs.
This missing-model check remains evidence of an unavailable condition, never a
measured small-model result.

## Detection, metadata and mixed speech contract

The proposed policy samples non-silent start/middle/end windows and retains
probability mass for **all** detector languages. It must not renormalize only
EN/PT probabilities into misleading confidence for FR/DE speech. A supported
winning language with mean posterior at least 0.80 may be proposed; no speech,
lower confidence, unsupported winners or mixed ambiguity require an explicit
language choice. This threshold is a research proposal, not a calibrated
probability of correct recognition. A detector/model failure is an error, not
an English fallback. Existing product EN/PT detection is unchanged.

Future saved run metadata must include requested language, effective language,
actual model/engine and weight identity, detection source (`manual`/`acoustic`),
confidence, sample count and outcome (`accepted`/`uncertain`/`no-speech`/
`unsupported`/`failed`). It must survive review, accepted-source replacement and
recognition history independently of UI locale. UI language must never select
the acoustic language. Missing historical detection metadata remains unknown.

Fixed-language recognition does not promise multilingual diarization or
speaker identity. Mixed audio requires lexical/manual language review; a forced
language field cannot prove preservation. No automatic translation or accent
conversion is proposed. If the utterance mixture cannot be retained reliably,
show the limitation and require a deliberate full-audio model/language choice;
do not silently translate or manufacture per-speaker language support.

## Resource and compatibility boundaries

M1 Air has 16 GiB; M4 Pro has 48 GiB. Shared GPU/CPU memory and existing Heed or
other application residency matter more than bare download size. Preview and
final work must continue obeying existing capture-priority and managed-work
admission; adding a detector or larger model must not run concurrent mandatory
passes. Existing registered `.en` or unknown models must remain unsupported.
Download figures are the pinned cached artifact bytes, not upstream repository
totals that may contain duplicate weight formats.

Heed's native package and menu compile for macOS 14. The installed native build
uses FluidAudio 0.15.3; current upstream additions and their OS requirements do
not retroactively validate that build. MLX requires Apple Silicon. Current
macOS 27.0.1 measurements do not establish macOS 14 runtime acceptance, Intel
behavior, every supported OS release or permission/capture acceptance.

## Decision and implementation plan

**NO-GO for exposing FR/DE recognition in the product at this stage.** Direct
multilingual model support is insufficient to expand the coordinator's language
contract. The comparable results below support a narrow offline capability finding;
live-chunk, natural mixed speech, regional accents, metadata integration and
minimum-OS acceptance remain separate gates.

The future implementation should extend the existing flow in this order:

1. Define engine/weight/language capability gates in the existing registered
   descriptors, including `.en`, missing-model and native variant rejection.
2. Extend the existing detector with all-language probability accounting,
   explicit uncertainty/failure and manual override. Keep EN/PT regressions and
   no-speech behavior; never default an unavailable detector to a chosen language.
3. Carry the complete detection/model run receipt through existing final
   conversion, coordinator manifest, sessions, candidates and accepted history.
   Add restart/failure, speaker-name and timestamp-preservation regressions.
4. Evaluate actual full finalization and live chunks with human FR/DE accents,
   domain names/terms, silence, ambiguity and natural language switching on both
   Macs. Measure model-download/startup/latency/memory and manual lexical
   preservation. Keep existing EN/PT acceptable throughout.
5. Only after the applicable quality/resource/minimum-OS gates pass, add explicit
   options and unsupported explanations in the four existing UI/native locales.

```sh
PATH=/opt/homebrew/bin:$PATH /existing/heed/.venv/bin/python3 scripts/qa/language_research.py \
  --python /existing/heed/.venv/bin/python3 \
  --native-binary /existing/heed/packages/transcription/native/heed-parakeet/.build/release/heed-parakeet \
  --manifest /private/tmp/licensed-language-cohort/manifest.json \
  --models base parakeet-v3 detection --repeats 2 \
  --output /private/tmp/heed-language-research-evidence
```

`--validate-only` verifies source integrity/PCM/timing without loading models.
All output and cohort files must remain outside the checkout.

## Measured results (October 7, 2026)

The Air is `MacBookAir10,1` (M1, 16 GiB); the Pro is `Mac16,7` (M4 Pro,
48 GiB). Both run macOS 27.0.1. Each completed 108 calls: 18 fixtures,
two repeats, and three selected paths. Worker retirement checks passed.

| Audio group | Whisper base WER, both Macs | Native v3 WER, Air / Pro | Base median seconds, Air / Pro | Native median seconds, Air / Pro |
|---|---:|---:|---:|---:|
| French | 33.33% | 4.44% / 4.44% | 0.292 / 0.115 | 0.189 / 0.088 |
| German | 17.20% | 6.45% / 6.45% | 0.270 / 0.111 | 0.192 / 0.088 |
| English | 10.23% | 7.95% / 7.95% | 0.222 / 0.086 | 0.137 / 0.074 |
| Brazilian Portuguese | 23.91% | 7.61% / 7.61% | 0.277 / 0.108 | 0.173 / 0.081 |
| Four-language concatenation | 284.95% | 12.90% / 9.68% | 1.652 / 0.626 | 1.604 / 0.791 |

WER aggregates edit counts across the known references; insertions can exceed
100%. Silence produced no text in either engine on either repeat. All 72
transcription results per Mac had finite timestamps within the fixture bounds.
These checks establish bounds, not perceptual alignment or speaker identity.

Sampled owned-process peak RSS was 512.1 / 509.2 MiB for base and
673.2 / 678.5 MiB for native (Air / Pro). The identical pinned base artifact
contains 143,724,466 bytes. Post-run native cache inventories matched on both
Macs: unified English assets 614,705,352 bytes (19 files), v3 assets
483,257,242 bytes (23 files). The corresponding tree hashes are
`fdd82b633253ce6c36946dd93afc717fde10b0ec98a40775af5cceeb62dca1e2` and
`0e2b16cf287025a94590a9ef75c6942aff8fc198c457e2a8ed7ec62ad581df60`.
The inventory is cached asset identity, not a trace proving every file was
loaded during each inference. These are artifact bytes, not network transfer
measurements, and native ASR may load shared English and multilingual resources.

Detection outcomes were identical across hosts. Three French samples were
proposed as French (confidence 0.980–0.994); one failed the existing RMS
speech gate. All German and Portuguese samples were proposed correctly
(0.977–0.995 and 0.988–0.999). Two English samples were proposed correctly
(0.985–0.988), while two failed the RMS gate. The concatenation required an
explicit choice (0.408); silence had no speech. The current EN/PT-only
decision instead labeled non-silent FR/DE examples as English after restricted
renormalization, and the mixed example as Portuguese (0.890). Low-energy
speech and the uncalibrated confidence threshold need further work before
automatic admission can expand safely.

Reports retain the identical cohort hash above, model revisions/weight hashes,
production adapter source hashes and native binary identity. The measured
evaluator SHA-256 was
`57e5e700e94d4f2b1ddfea1db2d0b54e9c2b708714722651ab3a70e87b94db36`.
Subsequent review strengthened error/deadline retirement auditing and made
detection use the resolved Hugging Face snapshot path rather than reconstruct
a default cache path. These changes have separate failed-worker, timeout and
cache-path regressions; they do not retroactively change the measured source
identity. Evidence is retained outside Git in `issue22-air-comparable`,
`issue22-pro-comparable` and `native-cache-{air,pro}.json` under the private
temporary QA root.

## Acceptance review

| Issue criterion | Evidence and boundary |
|---|---|
| FR/DE quality, latency, memory and model size on both Macs | Comparable licensed cohort, measured table and pinned artifact inventories above; small scope and cache-only download boundary disclosed |
| Compatibility and detection confidence/fallback | Capability matrix and explicit-choice/no-speech/failed contract; no restricted EN/PT confidence reuse |
| Unsupported combinations explained before processing | NO-GO keeps FR/DE unavailable in product; evaluator refuses missing selected weights, with no fallback or download |
| Proposed saved metadata independent of UI locale | Receipt fields specified above; production metadata expansion remains part of the future plan |
| Code switching without diarization claims | Mixed-concatenation error results and explicit limitation; no natural-speaker or diarization claim |
| EN/PT regression, names and timestamps | Same public EN/PT files on both Macs and all timestamp bounds; existing `final-recording.test.ts`, `transcript-editing-http.test.ts` and `automatic-notes-http.test.ts` retain saved/manual speaker names through finalization and source edits, independently of this evaluator |
| M1 resource and minimum-OS/native limits | Measured RSS/artifact sizes and macOS 14 versus tested 27.0.1 boundary above |
| Decision and implementation plan | NO-GO plus ordered extension of existing infrastructure; no FR/DE options added |

Natural code switching, diverse accents/domain speech, listening-based timing,
live preview, full production finalization, actual speaker attribution,
four-locale physical recording and macOS 14 execution remain future validation
gates. This research deliverable does not claim those product gates passed.
