# Local meeting chat

Open a saved meeting and choose **Chat**. Select an installed local chat model, type a question, and use **Send question**. English and Portuguese questions and transcripts work independently of the English, Brazilian Portuguese, French, or German interface preference. Chat cannot publish tasks or invoke external tools.

Only locally installed Ollama completion models advertising at least an 8192-token context are eligible. Models are never downloaded or started automatically. The local transport rejects cloud model names/metadata and redirects. The application explicitly requests an 8192-token context and a bounded output. Oversized input or length-limited output fails visibly; it is not saved as a completed answer. Structured responses use Ollama's documented [JSON output format](https://docs.ollama.com/api/generate).

Questions, answers, model choices and exact quoted citations persist under `HEED_APP_DIR/chat` (by default `~/.heed-app/chat`). **Cancel answer** interrupts a running or waiting request. **Retry answer** preserves its question and lets the selected model replace the prior model. **Clear chat history** asks for intentional deletion of the local saved conversation. Restart marks interrupted requests failed and retryable.

Every displayed factual claim includes a source citation. Open **Transcript evidence** to inspect the exact source words, then select the source button to navigate to the transcript and seek available audio. Text-only sources remain navigable. Transcript edits, speaker changes and retranscription mark old answers stale; retained old quotes do not seek replacement segments. Expiring audio preserves history and text. Deleting a meeting deletes its owned chat.

The engine scans bounded transcript chunks instead of silently supplying only the first paragraphs. It reviews up to 80 chunks; larger inputs are sampled across the full recording, with explicit partial coverage. The response shows reviewed and total chunk counts. An empty full-coverage response says that evidence was not found in the meeting; a partial response limits that claim to reviewed excerpts. Answers display at most 40 supported statements and disclose when that limit is reached. Asking narrower questions can improve focus, but does not remove the 80-chunk coverage cap. Follow-ups use bounded recent same-revision conversation context; prior answers never become primary evidence.

Recording and final transcription take priority. Starting those operations cancels active chat and waits for local-model cancellation/unload before proceeding. Automatic and manual notes generation share mutual resource checks with chat.

## Validation and limits

Synthetic server, real isolated HTTP, and interface tests cover durable history, repeated requests, cancel/retry/clear, restart, source edits/deletion, persistence failure, local-only and compatible-model guards, hostile origins, invalid citations, long-transcript end evidence, partial coverage, polling races and four-locale interface copy. HTTP tests use a separate `HEED_APP_DIR` and fake loopback Ollama; they never capture audio or use personal meetings.

Citation validation guarantees that a reference resolves to supplied source evidence. It does not prove semantic entailment of arbitrary model-generated prose. Check the quoted transcript before relying on a decision or deadline. Real-model relevance, bilingual semantic quality, M1/M4 resource behavior and physical audio playback require acceptance on both specified Macs. Native compile/self-tests with a macOS 14 deployment target do not validate every supported OS release.
