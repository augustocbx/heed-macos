# Google Drive implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Publish and quota-import portable meeting libraries through an optional explicitly authorized Google Drive connection.
**Architecture:** Shared desktop PKCE and opaque Keychain vault support a device-local Google controller. A Drive LibraryProvider stages discovery checkpoints, reserves stable file IDs, and confirms integrity before immutable commit publication. Settings consumes guarded local routes and shared library/quota UI.
**Tech Stack:** Bun/TypeScript, Swift Security framework, React, existing atomic JSON and portable library.
**Spec:** docs/superpowers/specs/2026-10-05-issue-28-google-drive-design.md

## Global constraints

- English project-facing content; preserve en/pt/fr/de UI; macOS 14+.
- Dedicated worktree, synthetic isolated state, no real OAuth/account/Keychain-secret interactions during automated checks.
- Credentials and resumable URLs never enter config, process arguments, logs or Git.
- Shared paths owned here: server/lib/connectors/oauth-pkce.ts, keychain-vault.ts and desktop/native-keychain.
- Agent29 owns portable-provider/library acknowledgeDiscovery integration; consume its optional async hook after foundation merges.

## Review focus

- Broader scopes require explicit consent; denied grants never become usable connections.
- Folder/Drive ID changes cannot redirect pending uploads outside the originally selected library.
- Checkpoints cannot advance before full validated catalog durability.
- Interrupted uploads retain source protection and secret URL refs across restart.
- Hash acknowledgment, verified contents and immutable conflict branches remain distinct.

### Task 1: shared OAuth and vault

Files: packages/server/lib/connectors/{oauth-pkce,keychain-vault}.ts and tests; packages/desktop/native-keychain/{Sources/main.swift,build.sh}; installer and CI packaging.
Interfaces: beginDesktopOAuth({authorizationEndpoint,clientId,scopes,parameters,openBrowser,signal,timeoutMs}): Promise<{code,redirectUri,codeVerifier}>; SecretVault put(value,reference?), get(reference), remove(reference), each async.
- [x] Write failing real-loopback tests for S256, state, denial, replay, callback method/path, cancellation and timeout; fake native-process tests prove stdin-only secrets, opaque refs, unavailable vault fails closed.
- [x] Implement helpers, compile native Security bridge with no-Keychain self-test, include install/build/CI paths, run tests and commit isolated shared helper for agent29 reuse.

### Task 2: Google auth and provider

Files: packages/server/lib/connectors/google-{auth,drive}.ts and tests, shared/types/google-drive.ts.
Interfaces: GoogleConnection controller snapshot/connect/cancel/disconnect/select/create; GoogleDriveProvider implements LibraryProvider with acknowledgeDiscovery. Config stores client ID/mode/vault refs/selected folder and nonsecret job/checkpoint metadata only.
- [x] Write failing synthetic HTTP tests for refresh and scope enforcement, stable selected-folder IDs/capabilities, all-page discovery and acknowledge, expired checkpoints, immutable collisions, resumed/expired uploads, readback integrity, quota/rate-limit/offline errors.
- [x] Implement bounded network requests with exact Google origin allowlists and explicit redirect rejection, immutable stable-ID writes and durable checkpoints/jobs, rerun tests green.

### Task 3: HTTP, Settings and portable integration

Files: server/server.ts, client/api/google-drive.ts, components/settings/GoogleDriveSettings.tsx and tests, translations-google-drive.ts.
- [ ] Rebase merged storage/quota foundations, use selected provider through existing PortableLibrary, test imported complete sessions remain offline AI-ready and pending sources protected.
- [ ] Write failing actual isolated server/UI tests for hostile origins, explicit access consent, connection status, create/select/switch/disconnect and capacity distinction; implement four-locale UI and guarded routes.

### Task 4: verify and publish

- [ ] Run entire current CI workflow, frozen install, synthetic integration and native helper compile; document real-account/two-Mac acceptance limits.
- [ ] Independent parent review, fix proven findings with regressions; commit/push English PR Refs #28 with no auto-close, exact-head match, clean worktree and stopped own services.
