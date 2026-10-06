# Implementation plan — issue 16

1. Add failing tests for structured local transport, completed output, local-only guards and cancellation; extract reusable transport while retaining notes behavior.
2. Add shared evidence/chat types and canonical evidence/chunk helpers; test bilingual, legacy text and long-transcript boundaries.
3. Add failing durable-chat service tests: question request deduplication, citation validation, history/restart, retry/cancel/clear/deletion, source freshness and full/partial coverage. Implement service with injectable session/model transport and atomic ledger writes.
4. Wire guarded local API routes and chat/model scheduler participation; preempt generation before recording/final ASR.
5. Add interface tests and chat tab/model/actions/citation navigation, preserving all locale dictionaries and existing notes/speaker flows.
6. Run existing CI commands and independent QA, resolve findings, commit/push an English PR referencing #16. Preserve synthetic artifacts outside commits. Root performs final exact-head review and worktree cleanup.
