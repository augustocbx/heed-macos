# Label-scoped meeting chat

Open **Meeting chat** and select one or more labels. Multiple labels default to **Match any selected label**; **Match all selected labels** requires every chosen label. **All meetings** is a separate explicit option. Empty or unmatched labels never fall back to the full library.

Inspect the included meeting list before sending. Only saved final nonempty transcripts are eligible; drafts and missing transcripts are counted separately. Imported complete local sessions participate through the same session store. There is no cloud transcript fetch or provider special case in chat.

Each selection has separate durable history. Every question pins labels, matching rule, included meeting IDs/titles/tags and transcript revisions. Source changes mark old answers historical and invalidate waiting/running answers. Follow-ups receive only history with an identical source snapshot. Excluded source transcripts, summaries and other conversations never enter generation. Citation reads also enforce the current source snapshot before opening a meeting; old quoted evidence remains readable without navigating into replacement transcripts. Audio seeking is revision guarded and text navigation remains available without retained audio.

The existing installed local model transport rejects cloud models and remote endpoints. General chat, individual chat, tasks and notes share resource guards; recording and final ASR preempt chat before capture/transcription begins. Users can cancel, retry matching snapshots with a different installed model, refresh, or clear only the current selection's history. Source changes require a new question rather than silently re-grounding an old retry.

Evidence scanning is limited to 80 chunks sampled across the eligible corpus, with reviewed/total counts and an explicit partial warning. Answers are capped at 40 supported statements. A large corpus may contain unreviewed meetings or topics. Citation IDs prove exact provenance; real-model entailment, completeness, bilingual accuracy and contradiction handling still require semantic review. No external knowledge or tool calls are supplied.

All automated fixtures use synthetic sources, secret exclusion markers, fake loopback Ollama and isolated app/recording directories. Physical playback, local model quality and end-to-end behavior on the MacBook Air M1 and MacBook Pro M4 Pro remain manual acceptance. macOS 14-targeted compilation does not demonstrate every supported OS release.
