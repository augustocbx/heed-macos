# Google settings recovery follow-up

Refs #28 and #18. Implement in an isolated worktree with synthetic data only.

A selected-folder auth write currently precedes registry/protection completion. Journal prior folder/generation and active credential identity, full source-protection state and provider preference/current IDs before settings effects. Restore only auth folder/generation while preserving auth-required and retirement changes. A different/retired credential cannot be restored. Complete rollback restores the old provider factory generation and exact old protection, including an ordinarily evictable readonly source. Unresolved or ambiguous recovery retains the intent, protects every finalized local WAV and rejects cached providers before HTTP across restart. Clear the intent only after a coherent successful change or complete rollback; a clear failure after a coherent change fails closed without beginning an unsafe rollback.

- [x] Add failing real auth/manager/PortableLibrary/ProviderRegistry/ManagedQuota regressions for registry failure, rollback double fault, restart, cached-provider zero HTTP and credential invalidation.
- [x] Add bounded durable intent and exact protection/auth selection snapshots; transactional connect/select/create/enable/disconnect; recovery UI and server guards.
- [ ] Verify isolated application restart/local text/recording/quota behavior, all supported locale keys and full CI.
- [ ] Independent review, rebase SMB follow-up, commit/push Refs #28 #18 PR, exact-head CI and clean service/worktree handoff.
