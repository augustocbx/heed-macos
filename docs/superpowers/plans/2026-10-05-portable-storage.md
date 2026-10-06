# Portable storage implementation plan

1. Define strict schema/provider contracts; RED tests for hashes, paths, privacy, identities and parent conflicts, then implement validation.
2. Implement private catalog and complete-session adapter with durable identity aliases, immutable revisions and restart-safe import journals. RED tests cover idempotency, quota skips, fault boundaries, concurrent edits and bounded discovery.
3. Add publish confirmation states and requested-audio verification with quota reservations, bounded staging and retained recoverable failure state. Test unavailable/corrupt/canceled transfers and partial listings.
4. Implement verified legacy audio migration preserving source/reference safety; wire the shared quota and playback guard after #27 integration.
5. Expose guarded library API and four-locale settings previews/import/conflict status. Test remote-only AI exclusion and lazy audio behavior.
6. Run full CI-equivalent validation, independent review and fix findings, commit/push PR with explicit physical-device/provider validation limits.
