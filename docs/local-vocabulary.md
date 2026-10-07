# Local transcription vocabulary

Manage named glossaries in **Settings → Local vocabulary**. Create a glossary, add/edit/remove terms, search its entries, and choose a default glossary. Select the default, another glossary, or no glossary before recording or explicitly retranscribing saved audio. Meeting additions affect that run only. Successful browser admission consumes the additions; a failed admission preserves them visibly for retry. Desktop and automatic recording use the saved default.

Terms preserve Unicode spelling, accents and mixed English/Portuguese terminology. Optional hints supply textual pronunciation/alias context; they are not phoneme instructions or replacement rules. Optional `en`/`pt` scope filters entries to the admitted/detected speech language. Meeting additions use one line per entry: `term | optional hint | optional en or pt`. Blank lines are ignored; duplicate or malformed entries must be corrected before admission.

## Engine behavior

| Existing Heed path | Vocabulary behavior |
| --- | --- |
| MLX Whisper live | `initial_prompt` context independently on each chunk |
| MLX Whisper selected final/full audio | `initial_prompt` context in the first window |
| faster-whisper live/final | The same supported `initial_prompt` interface |
| Native Parakeet final/streaming | Unsupported by the current Heed path; terms are recorded but do not influence recognition |

Whisper recognition is not guaranteed. Its first-window prompt may not carry through the entire long recording. Live chunk assistance does not imply the final native Parakeet pass uses it. Automatic-language legacy file paths exclude scoped entries until they have an explicit language; the effective configuration records exclusions. No post-processing replacement or automatic speaker naming occurs.

[MLX's implementation](https://github.com/ml-explore/mlx-examples/blob/main/whisper/mlx_whisper/transcribe.py) documents first-window context. [FluidAudio's separate vocabulary feature](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/ASR/CustomVocabulary.md) requires an additional CTC encoder for Parakeet TDT 0.6B. Heed does not load that additional model.

## Import/export JSON

Export explicitly downloads `heed-vocabulary.json`. Import **replaces the local glossary library**, after confirmation; existing meeting content remains unchanged. Use this schema:

```json
{
  "schemaVersion": 1,
  "version": 0,
  "defaultGlossaryId": "engineering",
  "glossaries": [
    {
      "id": "engineering",
      "name": "Engineering",
      "version": 1,
      "entries": [
        { "term": "João Pereira", "hint": "John Pereira", "language": "pt" },
        { "term": "Kubernetes" },
        { "term": "API", "language": "en" }
      ]
    }
  ]
}
```

`version` values are local revisions: importing a file advances the current local library version instead of restoring its old revision. Use `null` for no default. IDs contain 1–100 ASCII letters/digits/underscores/hyphens. The library supports 20 glossaries with 100 entries each; a combined run supports 100 entries. Names have a 100 UTF-16-unit limit, terms/hints 120 units, and JSON imports 1 MB. Empty values, malformed Unicode, control characters, unknown fields and duplicate terms are rejected. Duplicate comparison normalizes Unicode/case and surrounding whitespace without modifying stored spelling; identical terms in disjoint language scopes are allowed. Writes use optimistic version checks: reload after another tab changes the library.

The prompt budget is 1,500 UTF-16 units in stored entry order. Run provenance lists used/excluded entries, including language exclusions and entries beyond the budget; no stored term is truncated.

## Local persistence and existing meetings

The library is `vocabulary.json` under the local Heed app directory. A capture freezes the library/glossary version and entries at admission; restart/recovery uses that snapshot even after the library changes. Each final run records its snapshot and effective engine/model/language/interface/prompt/status; live configurations are recorded when received from the admitted worker, including model changes. Accepted recognition generations and explicit retranscription candidates retain provenance locally.

Changing a glossary never rewrites transcripts, notes or speaker names. Saved audio retranscription still creates a draft for review; accepted text changes only after explicit replacement. Text-only correction remains the existing editing workflow.

Vocabulary storage and run metadata are excluded from portable provider meeting records/history, meeting exports, notes generation and chat context. Vocabulary export is the explicit local download action. No integration implicitly exports the vocabulary.

## Evaluation

Run `scripts/qa/evaluate-vocabulary.py --engine mlx --model base --output /private/tmp/heed-vocabulary-evaluation` using an existing interpreter with Heed dependencies. The harness forces Hugging Face/Transformers offline cache access and creates no native worker processes. On macOS run it under `sandbox-exec -p '(version 1) (allow default) (deny network-outbound)'` for operating-system enforcement. The harness reuses the existing engine wrapper and licensed authored EN/PT fixtures, comparing baseline/enabled runs with identical audio hashes/model/decode options. It measures spoken-term recall, unrelated-speech errors, false insertions, silence hallucinations, latency, process RSS and MLX memory. Results and predictions stay in the chosen local output directory; never commit personal audio or transcripts.

Synthetic test results cannot establish consented natural bilingual speech, regional accents, benefit on every term, or compatibility on every supported macOS. The paired public read-speech and synthetic runs on both Macs, their false insertions, and outstanding natural-meeting/macOS 14 acceptance are recorded in [the issue acceptance report](qa/issue-6-local-vocabulary.md).
