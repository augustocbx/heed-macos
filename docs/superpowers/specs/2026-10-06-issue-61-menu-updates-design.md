# Menu-driven release updates — issue 61

## Intent and scope

Users can discover a newer stable Heed release and install it from the macOS menu without Git commands. Checks remain asynchronous, never install automatically, and distinguish a failed check from an up-to-date installation. Updates preserve meeting data, settings, models and private connection state, refuse active processing, and report their outcome after the menu app replaces itself.

The owner approved the native-menu integration with the release installer from issue 60, startup and daily checks, integrity verification, concurrency protection, expanded processing guards, four interface languages and actual menu-driven upgrade validation. The owner additionally requires guidance when an upgrade invalidates macOS permissions or requires renewed authorization.

Supported installation targets remain Apple Silicon Macs running macOS 14 or later. The current release format is an ad-hoc-signed archive, not a notarized package. This design reuses that distribution contract and documents its existing limitations.

## Existing contracts and required corrections

At baseline commit `965831b945770e1955d4e1fc886ceb8a5778ef1d`, release `v0.1.0` is published. Issue 60 was merged in PR 74; issue 58 remains open.

- `scripts/release/build-release.sh` publishes manifest schema 1 with repository, version, tag, commit, minimum macOS, architectures and asset URLs, byte sizes and SHA-256 digests.
- `scripts/release/install.sh` stages a release beside the current runtime, switches the `current` link, replaces the menu app and verifies service version and commit. It retains the previous runtime and attempts rollback on failure.
- `packages/desktop/guard-lifecycle.py` acquires an owner-token backend maintenance guard. It is mandatory for an update; a cached menu status is insufficient.
- The current backend maintenance guard covers audio work but excludes other processing. Queued notes, tasks, chat and synchronization must also honor maintenance.
- Maintenance currently disappears after a backend restart. Update maintenance must remain effective until verification or safe recovery finishes.
- The menu replacement terminates the initiating app. Installation coordination and status must survive that replacement.
- There is no installation-wide update lock. Service bootstrap locking alone does not prevent concurrent installers.
- The installed bootstrap hardcodes service ports and relies on global process matches. Readiness and startup used by updates must honor the configured service contract and verify checkout ownership.

Coordinate identity, configuration and safe restart changes with issue 58. Reuse its implementation if integrated before this branch; otherwise include only the lifecycle and configuration changes necessary to make issue 61 safe. Never use the owner-forbidden port ranges 3000–3999, 5000–5999, 7000–7999 or 8000–8999 for issue validation. The target Heed defaults from issue 58 are API 48100, interface 48101 and transcription 48102; Ollama remains separately managed on 11434.

## Components

### Native update client and menu

A focused Swift update client manages background check tasks, scheduling and decoded updater state. Existing recording controls remain responsive. Process execution, network I/O and file hashing stay off the main thread; UI changes return to the main thread.

The menu displays the installed app version from its bundle and release metadata, independent of an arbitrary local service response. A development checkout can display its version with a development indicator; an unknown or invalid installed version produces an actionable error rather than an assumed version.

Menu actions include **Check for updates…**, **Release notes**, **Update…**, **Retry**, and **View update log…** when applicable. The target version appears when available. Update initiation confirms the target and explains that Heed will restart and macOS permissions may need renewal. Busy work produces an explanation and a retry action; it is never interrupted to satisfy an update request.

### Trusted update helper

A Python 3.9-compatible standard-library helper owns release discovery, validation, downloads, installation coordination and atomic durable status. It is shipped with the menu app or trusted installed runtime, so starting an update does not require fetching executable updater code from the network.

The coordinator runs independently of the initiating menu process and uses a private installation state directory outside versioned runtimes, under the selected `HEED_HOME`. Transaction files have restrictive permissions and never contain credentials, recordings or transcript contents. The coordinator's trusted files remain available until the transaction finishes, even if the installer prunes an old runtime.

### Existing installer and lifecycle guard

The updater passes a verified local payload to the verified installer pinned to the selected release. Preserve the existing staging, data migration, recovery backup and owned-component replacement behavior. Share an installation-wide advisory lock with manual installer entrypoints, with explicit lock ownership handoff to the child installer; another process cannot bypass locking by merely setting an environment flag.

Persist update maintenance through the service switch. New backend startup and background queues must honor the active update transaction until the coordinator verifies the new build and releases maintenance. The installer and service bootstrap must not accidentally release another maintenance owner's guard.

## Release discovery and comparison

Check automatically at startup and every 24 hours. Persist the last attempt time so repeated launches do not create an unbounded automatic request loop. Manual checks remain available after failure. Allow one in-flight check and one installation transaction; do not change the chosen release midway through installation.

Query published GitHub release metadata for `augustocbx/heed-macos` and select the greatest valid stable semantic version greater than the installed version. Exclude drafts, GitHub prereleases, semantic prerelease tags, malformed versions and older/equal versions. Implement numeric major/minor/patch comparison and correct prerelease precedence for the installed version; build metadata does not affect precedence. Never compare version strings lexicographically or rely solely on publication date.

Use bounded pagination, request timeouts and response sizes. If the bounded lookup cannot establish a result, report a failed check rather than claiming up to date. GitHub rate limits, offline transport, malformed responses and missing manifests remain distinct technical failure codes with translated user guidance.

Fetch the selected release's manifest through HTTPS and require schema 1, app `heed`, the expected repository, matching version/tag, a valid commit, compatible architecture and minimum macOS, and the expected asset names. Release-note and initial asset URLs must identify the selected repository and tag. Allow the HTTPS GitHub asset delivery redirects required for downloads; reject insecure or unrelated initial URLs. Do not allow arbitrary manifest fields to become shell commands or filesystem paths.

## Durable state and progress

Check states are `notChecked`, `checking`, `upToDate`, `available` and `checkFailed`. Installation states are `downloading`, `verifying`, `waitingForIdle`, `installing`, `restarting`, `checkingServices`, `checkingPermissions`, `completed` and `failed`.

Store a schema version, transaction identity, coordinator identity, installed and target version/commit, phase, progress, timestamps, error code, recovery information and log path in an atomically replaced status document. The replacement menu reads this document and reports the terminal result. Failure is never rendered as success, and missing/stale state is never treated as an active process indefinitely.

Download progress uses verified asset sizes; preparation and restart use phase labels rather than fabricated percentages. Technical logs remain English. The menu maps stable error codes to English, Brazilian Portuguese, French and German, with the existing English fallback.

## Installation transaction

1. Acquire the shared installation lock. Reject a second update with translated guidance.
2. Validate installed service identity, configuration and current activity. Unknown ownership, an unresponsive running service or incomplete busy status prevents installation.
3. Download the selected installer and payload into a private transaction directory using bounded timeouts and size limits. Remove incomplete files after interruption; a retry creates clean staging.
4. Verify both assets' declared byte sizes and SHA-256 values before executing the installer or extracting the payload. Validate payload release metadata against the selected manifest and reject unsafe archive paths or links before extraction. Supply the checksum file expected by the existing installer from the verified payload digest.
5. Recheck processing and acquire maintenance atomically immediately before invoking installation. Include recording, starting, stopping, saving/finalization, transcription, manual/automatic notes, task generation, both chat modes, media import, migration and active synchronization. Once maintenance is held, new background work cannot start. Hold protection through restart and verification.
6. Invoke the pinned installer without a shell-constructed command string, using `--no-permission-prompt` so post-update authorization remains user initiated. Run it independently of the old menu and keep its output in the private technical log. Restart only verified Heed-owned components. Do not stop or restart shared Ollama or unrelated applications.
7. Require successful API, interface and transcription HTTP responses with the expected Heed identity, target version and commit. A listener or HTML response is insufficient. Verify the transcription service's existing model-readiness contract where applicable; service readiness does not prove real audio capture or renewed privacy permissions.
8. Check permission status and persist any required user action. Release update maintenance only after safe installation verification. Report installation outcome and permission outcome separately.
9. On failure, preserve data and use the existing safe rollback path when components are idle and owned. If rollback is unsafe or incomplete, retain the runtime and recovery backup, explain the actual state and provide a log/recovery action. Never claim the old installation was restored without verifying it.

Downloading does not stop a running meeting. An active meeting before installation produces a waiting/retry state and requires an explicit retry after work finishes; updates never install later merely because an automatic timer observes idle.

## Permissions after upgrade

Changing an ad-hoc signature can invalidate Microphone and Screen & System Audio Recording authorization. A successful installation must not imply that capture permissions are still usable.

After replacement, obtain a fresh permission report from the new menu app, associated with the new build. Do not reuse the old process's permission report. If required permission is denied, restricted or not determined, display a translated **Permissions need attention** state with **Settings and permissions…** and **Check permissions again** actions. Explain which permission is missing and provide the relevant System Settings destination. A restricted permission explains the device-policy limitation instead of offering an ineffective authorization retry.

Permission checks and post-update guidance must not initiate recording automatically. Permission prompts are user initiated, and the user handles macOS authorization. Preserve existing Slack and folder bookmarks; flag any access that actually needs renewal without requesting optional access unnecessarily.

macOS may show authorization as granted while blocking capture after a signature change. The completion guidance therefore explains that, if capture fails, the user may need to turn the relevant permission off and on in **System Settings → Privacy & Security**, then quit and reopen Heed. Offer the existing permission controls and a short user-initiated recording check. Never reset privacy permissions automatically or use `tccutil reset` as an update step.

Missing permissions are a recoverable post-install action, not a reason to roll back a verified upgrade. Preserve that state after reopening the app and clear it only after a fresh check confirms authorization. If permission reporting cannot be obtained, show **Could not verify permissions** with retry guidance, rather than claiming recording is ready. Explain that authorization checks alone cannot establish real capture success.

## Preservation and recovery

Keep recordings, transcripts, speaker names, configuration, scoped-folder bookmarks, cloud/private connection state, Keychain contents and model caches in their existing locations. Do not include their contents in release assets, updater state, test fixtures, logs or Git commits. Preserve the selected recordings path and application-state directory through migration and restart.

Retry is explicit and safe after offline checks, missing assets, corrupt downloads, busy work and dependency or installation failures. An interrupted transaction reconciles the coordinator, installed version and owned services before allowing a retry; it must not infer completion from the presence of a target directory. Document the installer recovery path and retained prior runtime when automatic rollback cannot finish.

## Validation and acceptance evidence

- Python tests: semantic precedence, release filtering, malformed metadata, failed/offline/rate-limited checks, bounded requests, compatibility, unsafe archive entries, installer and payload integrity, interrupted downloads, lock contention, retry and durable state across coordinator/menu replacement.
- Backend tests: all processing categories block maintenance; new work cannot start after acquisition; ownership prevents another process releasing the guard; maintenance persists across upgrade startup until authorized completion; unknown service identity fails closed.
- Native self-tests: menu actions and states, installed version, target/release notes, translated error mapping, English fallback, permission-attention and permission-check retry states.
- Existing installer simulation: preserved data, busy refusal, foreign-port refusal, failed install, safe recovery, fresh permission reports and shared-lock behavior. Run on approved isolated ports with synthetic data.
- Repository verification: focused server/helper checks, interface tests, production build, native build/self-tests and exact-head CI checks relevant to modified components.
- Actual menu QA on supported Macs: initiate an upgrade through the menu, observe replacement and progress, verify target build and owned service readiness, compare retained synthetic recordings/transcripts/speaker names/settings, and verify permission guidance and retry. Keep recording quality and real privacy authorization as separately observed acceptance evidence.

At design time only release `v0.1.0` exists. Test greater target versions with clearly identified local fixture releases in isolated installations; do not publish a release solely to satisfy a test. A fixture upgrade validates the menu-driven transaction but does not prove a real upgrade between two public stable releases. Report that limitation and leave unsupported or unavailable physical-Mac acceptance unchecked.

Before merge handoff, commit and push all issue work, verify the remote branch matches local HEAD, stop and verify only issue-owned services, remove the clean dedicated worktree safely, and confirm its absence. Do not close acceptance gaps merely because CI passes.
