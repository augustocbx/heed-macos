# SMB settings recovery follow-up

Final QA found that a successful settings write followed by a provider-preference failure and failed settings rollback could leave divergent durable state. Restart could restore the previous provider while treating its unqueued source audio as unprotected.

The controller must journal the previous settings and preferred provider before changing either store. Successful commit or successful rollback clears the intent only after both stores agree. Unresolved intent, mismatched SMB preference, or failed rollback requires recovery: preserve configuration and all finalized audio, stop automatic synchronization and reject cached-provider access before native share calls. Local text and recording status remain usable. Private SMB configuration and protection catalogs must use the shared bounded no-follow reader.

1. Reproduce selection/disable/disconnect and final-commit faults with the actual ProviderRegistry, PortableLibrary and ManagedQuota; verify restart and cached-provider behavior.
2. Add durable controller intent, stable guarded provider factories and permanent recovery protection.
3. Surface recovery through the local API and four interface locales; verify preserved source audio and usable local meeting/recording routes after startup.
4. Run full server/interface tests and build, obtain independent review, push the follow-up PR and require exact-head green CI before merge.

All fixtures are synthetic and isolated. No real share, account or private meeting is accessed.
