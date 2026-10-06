# iCloud folder implementation plan

1. Build and test a capability/status prototype using supported public macOS APIs, with synthetic upload states and a disposable non-cloud folder.
2. Implement scoped coordinated immutable I/O, hydration, asynchronous observation and private bookmark lifecycle. Reject ambiguous paths/account changes and preserve local pending data.
3. Adapt the shared provider contract and origin-guarded Settings routes. Preview/import complete transcripts under the shared quota; publish commit markers last; retain pending sources until a documented verification boundary.
4. Validate restart, errors, placeholders, concurrent revisions, corruption, bounded queues and all four interface locales using isolated fixtures. Review independently and fix findings.
5. Run complete workflow checks, push all files, verify exact-head CI, stop only owned services, remove the clean worktree and merge. Final issue QA marks only evidenced criteria; real accounts/two-Mac acceptance remain separate.
