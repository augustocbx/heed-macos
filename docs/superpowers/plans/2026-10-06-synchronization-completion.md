# Synchronization Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Implement and evidence the 15 active synchronization acceptance criteria in draft PR #84.

**Architecture:** Add a protected direct SMB3 adapter to the existing portable-library and provider-registry contracts, with a separate packaged Python runtime and a guardian owning each complete remote transaction. Preserve mounted legacy and iCloud destinations, local capture priority and private pending media. Validate actual provider/device behavior separately from deterministic protocol tests.

**Tech Stack:** Bun/TypeScript, React, Swift Keychain helper, Python 3.12, public MIT `smbprotocol==1.17.0`, FFmpeg, local Ollama models.

**Spec:** [Approved synchronization completion design](../specs/2026-10-06-synchronization-completion-design.md). The owner explicitly approved detailing and executing this design on PR #84 on October 6, 2026.

## Global Constraints

- All project-facing content is English; preserve English, Brazilian Portuguese, French and German interface translations. Never add `Co-Authored-By`.
- Work only in `feat/issue-18-synchronization-completion` and its dedicated worktree. Preserve the dirty primary checkout and unrelated services/worktrees.
- The active acceptance set is 15 original criteria in #18/#25/#26/#27/#30. Excluded account integrations remain outside this delivery.
- Pin `smbprotocol==1.17.0`; target Python 3.12 in a separate private `runtime/smb` environment. The transcription installer currently selects Python 3.14; do not replace its interpreter as a side effect.
- Ship the complete hash-locked arm64/macOS-14-compatible transitive wheel set and install with `--no-index --require-hashes`. No implicit downloads, source builds or arbitrary interpreter fallback.
- New direct destinations use exactly `format`, `schemaVersion: 3`, `destinationId` in their header. Reject direct writes/deletes to v1/v2; preserve mounted/iCloud support and portable payload schema version 1.
- Require authenticated SMB3 with actual signed or authenticated encrypted traffic. Reject guest/null sessions, unsupported identities, reparse/multiple-link/DFS paths and namespace enforcement failures.
- Remote SMB uses port 445; alternate QA ports are explicitly limited to 48000–48999 on `localhost` or `127.0.0.1`. The settings interface defaults to 445.
- Credentials cross helper boundaries on stdin only and persist only in the existing unsynchronized Keychain vault. No secrets in arguments, environment, configuration, logs or browser storage.
- One guardian owns a complete operation. Pin server/volume/stable object identity and all parents; never treat the SMB CREATE handle ID as a persistent receipt.
- Exclusive create, non-replacing rename, whole-operation exclusion with no takeover, permanent fences before effects, durable original-owner receipts, marker-last publication and complete read-back verification are mandatory.
- Shared audio garbage collection remains disabled. Ambiguous effect/close/release outcomes retain original jobs. Cancellation must drain owned helpers before optional work resumes.
- Bound revisions/jobs at 10,000 and use existing quota reservations. Default managed quota is exactly `2_000_000_000` bytes; preserve valid custom values.
- Real two-device/account/macOS acceptance is distinct from fixtures, CI and server-reported status. Mark criteria only with complete evidence; unsupported servers remain gated.

## Review Focus

- A Unicode hostname or trailing-dot/case alias must resolve to the reviewed endpoint without accepting credential URLs or DFS redirection; Task 1 endpoint tests pin this.
- A stale tab, rapid reconnect or failed credential removal must preserve the original binding and an explicit bounded recovery obligation; Task 4 fault tests pin this.
- A server may acknowledge SET_INFO yet retain delete-pending data, or drop the subsequent close reply; Task 3 tests require verified absence before removal counts.
- Changing accounts or restarting while a placeholder is downloading must preserve private pending media and avoid unlimited staging/retry growth; Task 8 recovery tests pin this.
- An installed helper may be launched after the source/build directory is removed; Tasks 5 and 9 detached-runtime tests pin this.

## File and ownership map

| Unit | Files | Responsibility |
| --- | --- | --- |
| Direct contracts and transport | `packages/server/lib/smb-direct-types.ts`, `smb-direct-native.ts`, `smb-direct-native.test.ts`; `packages/server/native/smb-direct/{guardian.py,transport.py,identity.py,protocol.py,test_transport.py}` | Validated endpoint, protected stdin RPC, authenticated low-level session and identity-bound reads |
| Direct remote authority | `packages/server/native/smb-direct/{journal.py,transaction.py,test_transaction.py}` | Original-owner journal, complete exclusion, immutable admission, fences and exact handle effects |
| Provider and admission | `packages/server/lib/smb-direct-provider.ts`, `smb-direct-provider.test.ts`, `portable-library.ts`, `remote-deletion.ts`; `packages/shared/types/remote-deletion.ts` | Existing provider contract, explicit v3 capabilities and core gates |
| Connection state/routes | `packages/server/lib/smb-direct-connections.ts`, `smb-direct-connections.test.ts`, `smb-direct-http.ts`, `smb-direct-http.test.ts`, `packages/server/server.ts` | Keychain transitions, registry, generation-bound controls, queues and startup protection |
| Release runtime | `packages/server/native/smb-direct/{requirements.lock,wheels/,wheel-manifest.json,runtime.py,test_runtime.py}`; `packages/server/lib/{smb-direct-runtime.ts,smb-direct-runtime.test.ts}`; `scripts/release/{build-release.sh,install.sh,simulate.sh,service_integration_test.py}`; `.github/workflows/smb-runtime.yml`, `.github/workflows/ci.yml` | Offline hashed dependencies, verified interpreter, detached self-test and rollback |
| Interface | `packages/client/src/api/smb-direct.ts`, `components/settings/DirectSmbSettings.tsx`, `DirectSmbSettings.test.tsx`, `StorageSettings.tsx`, `lib/translations-smb-direct.ts`, `translations-smb-direct.test.ts` | Distinct direct option, reviewed connection preview and four locales |
| Quota acceptance | `packages/server/lib/capture-start-quota.http.test.ts`; `scripts/check-synchronization-quota.ts` | Actual FFmpeg pressure finalization and persisted multi-page/device observations |
| Portable/AI acceptance | `scripts/check-synchronization-integrity.ts`, `check-synchronization-offline-ai.ts`; their focused tests | Public fixtures, exact revision/audio comparison and production offline model/citation validation |
| iCloud recovery/evidence | Existing `connectors/icloud-*` tests, `docs/icloud-folder.md`, `docs/qa/synchronization-completion-evidence.md` | Reproduced state faults, real independent replication and honest acceptance ledger |

Separate modules may be refined when SDK constraints require it; record concrete interface changes in the private execution ledger before a dependent task starts. Do not silently relax a security or acceptance requirement.

### Task 1: Authenticated direct transport and validated receipts

**Files:** Direct contracts/transport unit from the map.

**Interfaces:**
- Produce `DirectSmbEndpoint {server:string;port:number;share:string;folder:string;requireEncryption:boolean}` and `DirectSmbCredentials {username:string;password:string;domain:string}` in `smb-direct-types.ts`.
- Produce `DirectSmbIdentity {serverGuid:string;volumeSerial:string;volumeCreated:string;rootId:string;rootCreated:string}`; all numeric identities are fixed lowercase hex strings, nonzero/non-sentinel, obtained from supported server queries rather than CREATE FileId.
- Produce `DirectSmbProbe {identity:DirectSmbIdentity;dialect:string;authentication:'authenticated';security:'signed'|'encrypted';encrypted:boolean;readOnly:boolean;namespaceSafe:boolean;destinationId:string|null;destinationVersion:3|null;empty:boolean}`.
- Produce `validateDirectEndpoint(value:unknown):DirectSmbEndpoint`, `validateDirectCredentials(value:unknown):DirectSmbCredentials`, `validateDirectProbe(value:unknown):DirectSmbProbe`.
- Produce `DirectSmbTransactionContext = TransactionContext & {appDir:string}` for explicit per-operation private authority.
- Produce `DirectSmbNative.probe(endpoint,credentials,signal?):Promise<DirectSmbProbe>`, `initialize(endpoint,credentials,expectedIdentity,destinationId,signal?):Promise<DirectSmbProbe>` and `open(binding,credentials,context:DirectSmbTransactionContext,signal?):Promise<DirectSmbSession>`.
- `DirectSmbBinding` contains `id`, `name`, `endpoint`, `identity`, `destinationId`, `destinationVersion:3`, `connectionGeneration`, `credentialRef`, `readOnly`, `security`.
- `DirectSmbSession` has `command(action:string,value?:Record<string,unknown>,signal?):Promise<unknown>`, `read(path,maxBytes,signal?):Promise<Uint8Array>`, `stream(path,maxBytes,signal?):AsyncIterable<Uint8Array>`, `write(path,bytes,sha256,source,signal?):Promise<void>`, `close():Promise<void>`.
- Guardian startup is one bounded newline JSON stdin object `{protocol:1,action:'probe'|'initialize'|'transaction',endpoint,credentials,identity?,destinationId?,binding?,context?,appDir?}`. Output is sanitized `{ok:false,error:code}` or `{ok:true,value:probe}`; transaction ready is `{ok:true,ready:true,checkpointed:boolean,completed?:true}`. Subsequent sequenced newline RPC frames `{id,nonce,action,...value}` use a fresh random 256-bit nonce encoded as 64 lowercase hex characters per request. Every progress/chunk/terminal/error reply echoes `{id,nonce,...}`; reject unknown/stale nonces before consuming data, trailing buffered frames and unsolicited idle output, then stop/reap the owned helper. Binary chunks remain at most 131072 bytes. This private direct protocol extends correlation without modifying the existing mounted guardian. Malformed/extra/oversized frames refuse effects. Credentials appear only in startup stdin.

- [x] Write transport tests: traversal/percent/credentials/control characters/alias validation; SMB2/guest/null/unknown security rejection; signed and encrypted-session acceptance; wrong server/volume/root/birth identity; DFS/reparse/multilink; denied read and bounded listing; unsanitized SDK exception and secret-containing stderr suppression; cancellation and helper reap. Real tests use injectable low-level session boundaries, not path-based SDK convenience functions.
- [x] Run `python3.12 -m unittest discover -s packages/server/native/smb-direct -p 'test_transport.py'` and `bun test packages/server/lib/smb-direct-native.test.ts`; observe the new assertions fail before implementation.
- [x] Implement the exact public contracts, strict validators and bounded subprocess protocol. Query and pin complete ancestors and validate actual negotiated signing/encryption. Initialization exclusively creates a v3 header only in an empty revalidated folder; existing/changed headers are preserved.
- [x] Re-run both commands; expected zero failures. Document actual SDK limitations and refuse unsupported capability instead of inventing identity.
- [x] Commit only this unit as `feat: add authenticated direct SMB transport and identity validation`.

### Task 2: Original-owner exclusion and immutable publication

**Files:** Direct remote authority unit; Task 1 transport changes only when required by its public interface.

**Interfaces:**
- Consume Task 1 strict sequenced `id` plus fresh per-request `nonce` framing for all progress/chunk/terminal/error responses; no predictable future-ID acknowledgment.
- Consume Task 1 endpoint/session/identity. Portable transaction context is the existing `TransactionContext` from `portable-provider.ts`; the native call receives `DirectSmbTransactionContext`, including this original app directory.
- Produce guardian actions `inventory`, `list`, `read`, `write`, `write-pending`, `retire-pending`, `write-fence`, `write-deletion`, `checkpoint`, `close` and `confirm`. Values reuse existing portable schemas; `confirm` consumes `{commit:PortableCommit}` and returns `'remote-confirmed'` only after complete artifact read-back.
- Private per-binding journals live under the original app directory, record physical owner, exact endpoint/destination/generation, operation and stable receipts before effects. Produce a bounded sanitized `pendingTransactions(binding,appDir)` query; it never trusts a copied journal as physical authority.

- [x] Write fault tests for exclusive-create/rename collision, competing clients, ancestor replacement, unsupported server sharing, manifest admission before media, partial marker rejection, wrong-length/hash object, fence rejection, copied/foreign journals, lost rename/flush/close acknowledgment, restart and cancellation. Assert unknown remote objects survive and no TTL takeover occurs.
- [x] Run `python3.12 -m unittest discover -s packages/server/native/smb-direct -p 'test_transaction.py'`; observe intended failures.
- [x] Implement complete claim and parent pinning, durable receipt/journal writes before canonical operations, non-replacing share-relative rename with RootDirectory=0, fenced canonical admission, marker-last visibility, complete read-back and checkpoint-before-release. Preserve unresolved phase and do not touch a later claim.
- [x] Re-run Python transport/transaction tests; expected zero failures. Use real disposable SMB probes only after independent source review.
- [x] Commit as `feat: implement identity-bound SMB publication and owner recovery`.

### Task 3: Exact deletion and provider/core integration

**Files:** Direct provider/admission unit and remote authority deletion implementation/tests.

**Interfaces:**
- The provider passes `{...context,appDir}` to native `open`, with no mutable/global native-instance directory selection.
- Produce `DirectSmbProvider(binding:DirectSmbBinding,native:DirectSmbNative,getCredentials:()=>Promise<DirectSmbCredentials>,appDir:string,quota?:QuotaBudget)` implementing `LibraryProvider` and `RemoteTransaction`.
- Extend `DeletionCapabilities.destinationVersion` to `1|2|3`. `revisionMetadata` and `exclusion` plus presence of `withTransaction` explicitly admit direct v3 coordination; numeric comparisons alone never admit new versions.
- Guardian `remove-exact` consumes `{jobId,artifact:ArtifactIdentity}` and returns `'removed'|'already-removed'` only for verified exact deletion/absence owned by the original operation.

- [x] Write provider/core tests rejecting uncoordinated v3, legacy direct writes, wrong binding/generation, stale deletion preview and incomplete artifacts; preserve mounted/iCloud v2 tests. Write guardian deletion tests for changed target/parent, multiple links, unknown same-content file, absent/failed permanent fence, delete-pending success without absence, lost SET_INFO/CLOSE reply and denied competing write/delete.
- [x] Run `bun test packages/server/lib/smb-direct-provider.test.ts packages/server/lib/portable-library.test.ts packages/server/lib/remote-deletion.test.ts` and the Python transaction suite; observe intended new failures.
- [x] Implement existing-provider adapters and explicit admission gates. Open without delete-on-close, retain exact read/delete handle with enforced sharing, validate current identity/hash/authority, verify permanent fence, journal intent, perform handle-bound disposition/quarantine, close and verify absence before counting. Retain ambiguous jobs; shared audio GC stays false.
- [x] Re-run specified tests and existing mounted provider/transaction/recovery suites; expected zero failures.
- [x] Commit as `feat: integrate direct SMB coordination and exact metadata deletion`.

### Task 4: Protected connections, bounded retries and HTTP controls

**Files:** Connection state/routes unit.

**Interfaces:**
- Consume Tasks 1–3, existing `SecretVault`, `ProviderRegistry`, portable library and quota.
- Produce `DirectSmbConnections({path,appDir,registry,library,busy,vault?,native?,quota?,sessions?,now?,write?})` with `snapshot()`, `test(endpoint,credentials,signal?)`, `connect({name,receipt,create,connectionId?,generation?})`, `rename(id,generation,name)`, `enable(id,generation,enabled)`, `disconnect(id,generation)`, `sync(id,generation)`, `tick(force?)`, `start()`, `close()`, `preempt():Promise<void>`, `unavailable()`, `protectedRevisionIds()` and `protectedLocalPaths()`.
- `test` returns a five-minute, one-use, private receipt plus sanitized probe; bounded uncommitted secrets remain memory-only until confirmed `connect`, at most eight receipts. `connect` protects credentials before state/provider activation and revalidates the reviewed receipt/identity; unused receipts expire. Failed activation retires the new reference or persists an explicit cleanup obligation.
- Produce `/api/smb/direct` GET snapshot and POST actions `test`, `connect`, `rename`, `enable`, `disconnect`, `sync`, each strict-field validated and desktop-origin protected. Every existing-connection mutation includes generation. Return sanitized 400 input, 409 stale/busy/recovery, 503 unavailable, with `Cache-Control:no-store`.
- Snapshot contains only public connection IDs/generation/name/endpoint/destination/capabilities/progress/sanitized error; never credential references or identities/private paths/secrets.

- [x] Write durable transition and HTTP tests: Keychain put/get/remove faults, configuration/registry failure rollback, interrupted transition startup, stale tab, duplicate receipt, rapid reconnect, eight-connection and 10,000-job bounds, exponential retry capped at one hour, disable/disconnect preserving recordings, pending original recovery guard, cleanup drain before optional retry, secret-free responses/state/logs.
- [x] Run `bun test packages/server/lib/smb-direct-connections.test.ts packages/server/lib/smb-direct-http.test.ts`; observe intended failures.
- [x] Implement protected durable transitions and background queue using existing library mutation ownership. Register before registry restore; wire all preemption/shutdown and private pending quota protection in `server.ts`. Failed rollback conservatively blocks synchronization.
- [x] Re-run tests plus server/provider-registry integration suites; expected zero failures.
- [x] Commit as `feat: add protected direct SMB connections and bounded synchronization`.

### Task 5: Offline dependency payload and installed runtime

**Files:** Release runtime unit.

**Interfaces:**
- Produce `runtime.py verify-payload ROOT` and `runtime.py install ROOT --python ABSOLUTE_PYTHON_312`; no network fallback. Manifest pins interpreter 3.12, architecture arm64, minimum macOS 14 and each filename/size/SHA-256/distribution/version/ABI/platform tag.
- Runtime target is `ROOT/runtime/smb/bin/python`; Task 1 launcher verifies that exact runtime's receipt and executable before launch. The installer's Python 3.14 transcription environment remains separate.
- Builder verifies payload and performs a temporary offline install/self-test; staged installer verifies before activation. Rollback/uninstall preserve or retire only the relevant release runtime.
- Add a dedicated standard `macos-14` arm64 CI job with explicit Python 3.12, offline payload install, detached self-test and actual SDK-boundary Python tests (zero skips). Record its actual OS/architecture; do not use paid larger-runner labels. This establishes minimum-OS runtime execution separately from real NAS interoperability.

- [x] Write tests for missing/extra/corrupt/incompatible wheels, wrong Python version/architecture, offline pip failure, substituted runtime, failed self-test and old-release preservation. A detached runtime must pass imports, contract/structure self-test and sanitized error handling with the original checkout absent.
- [x] Run `python3.12 -m unittest discover -s packages/server/native/smb-direct -p 'test_runtime.py'`; observe intended failures.
- [x] Download public pinned wheels during development, verify primary package metadata/license and hashes, commit complete locked payload, implement offline runtime setup and integrate build/install/simulator. An absent compatible 3.12 prerequisite refuses explicitly before activation.
- [x] Re-run runtime tests, `bash -n scripts/release/{build-release,install,simulate}.sh`, release helper tests and a detached self-test; expected zero failures. macOS 14 runtime remains a separate actual acceptance gate.
- [x] Commit as `build: package a verified offline Python runtime for direct SMB`.

### Task 6: Four-locale direct connection interface

**Files:** Interface unit.

**Interfaces:**
- Consume Task 4 `/api/smb/direct`; produce typed `directSmbApi` matching exact actions and `DirectSmbSettings` mounted within existing storage settings.
- Show separate direct and mounted options, server/share/folder/domain/account/password and optional encryption requirement. Review preview distinguishes authentication, dialect, encryption/signing, read-only, namespace safety and destination creation; require explicit empty-folder creation confirmation.
- Preserve credentials in component memory only during the explicit test/connect flow; clear password on success/cancel/unmount. All reviewed controls submit ID/generation.

- [x] Write component tests for explicit creation review, direct v3 read-only coordination refusal with preserved mounted read-only import, capability rejection, stale-generation conflict refresh, rename/disable/disconnect, busy/recovery states, password clearing and no browser persistence. Verify dictionary key equality and actual translated copy in all four locales.
- [x] Run client focused tests; observe intended failures.
- [x] Implement typed API, focused settings component and translation dictionary without changing existing mounted controls or recording settings.
- [x] Re-run focused tests, full client suite and production build; expected zero failures.
- [x] Commit as `feat: expose reviewed direct SMB controls in four locales`.

### Task 7: Quota pressure and persisted interface acceptance

**Files:** Quota acceptance unit, narrowly reproduced production fixes only.

**Interfaces:**
- Produce opt-in `scripts/check-synchronization-quota.ts --source-root ROOT --output PUBLIC_REPORT --fixture-root OWNED_TEMP` using isolated configuration/ports, production HTTP/pages and synthetic PCM through actual FFmpeg; no private meeting imports.
- Report source hash/commit, session/artifact hashes, reserved/used/limit, two-page authoritative value and desktop API independently. Native visible propagation and physical recording are separately observed gates.

- [x] Extend production HTTP regression tests to exercise graceful quota-pressure finalization rather than just initial denial, retained-media failure and cleanup. Assert one completed durable session, valid WAV, no active recording, released reservations and `used + reserved <= limit`.
- [x] Run focused HTTP suite; observe any intended new failure. Fix only reproduced product defects through failing tests.
- [x] Implement opt-in acceptance harness; change quota from one page and observe the other and desktop API in all supported locales. Exercise missing/default settings and custom `3_000_000_000` preservation through simulator fresh/upgrade/rollback/reinstall.
- [ ] Re-run tests/harness and visible native-menu checks on each available Mac; record exact distinction between synthetic and actual capture.
- [x] Commit as `test: validate quota finalization and authoritative settings propagation`.


### Task 8: Portable integrity, actual offline AI and iCloud recovery

**Files:** Portable/AI acceptance and iCloud recovery/evidence units.

**Interfaces:**
- Produce reusable synthetic English/PT fixture builders and `comparePortableRevision(expected,actual):string[]` covering tags, manual speaker names, corrected segments/transcript, notes/summary, language/model provenance, parents and audio hashes.
- `check-synchronization-integrity.ts` takes a per-device locally resolved provider binding and an owned disposable child receipt; executes A-to-B-to-A and divergent edits without copying private bindings.
- `check-synchronization-offline-ai.ts` consumes committed imported fixtures, disables provider, restarts isolated stores, runs production meeting/label chat with available local models and validates strict current-revision citations, exact quotations, exclusion/missing facts and zero offline provider calls.

- [x] Write comparator and offline-isolation regression tests. Extend iCloud state/restart tests for disabled/signed-out/changed account, stale/denied bookmark, missing folder and delayed placeholders; bound job/staging growth and preserve private pending paths.
- [x] Run focused portable/chat/iCloud suites; observe intended new failures. Improve sanitized typed state reporting only for reproduced ambiguous states.
- [ ] Implement reusable opt-in harnesses using production stores/providers/chat validators; correct iCloud v2 documentation to canonical-manifest-first and marker-last. Use actual installed models with English/PT fixtures, then independent Macs for real provider round trips and concurrency.
- [ ] Record sleep/wake, offline/restart/account/unavailable-provider faults as actual or deterministic evidence explicitly. Never count manual seeding or same-host stores as real replication.
- [ ] Re-run focused suites and applicable real harnesses; expected passing results or explicit observed capability/acceptance gaps retained in the ledger.
- [ ] Commit as `test: validate portable integrity and offline local AI across devices`.

### Task 9: Real server safety and device acceptance

**Files:** Public sanitized acceptance evidence, owned opt-in harness additions only.

**Interfaces:** Consume Tasks 1–8. Both Macs resolve credentials/account bindings locally; owner enters credentials through the reviewed UI/Keychain flow. The owner confirmed no separate QA users exist and explicitly authorized uninstalling the existing Heed installation, including disposable current Heed data, for fresh native/device acceptance. Prepare the reviewed build/restoration and verify idle ownership before this change; do not affect other applications or unknown provider contents. Uniquely owned disposable libraries have explicit synthetic creation receipts; parent/private roots are never cleanup targets.

- [ ] Obtain independent source review of identity, ancestor pinning, claim release and deletion before effects on a real disposable server folder.
- [ ] Execute real authenticated SMB create/nonreplace/namespace-sharing enforcement, competing-client and target/ancestor replacement tests, lost-response recovery and complete publication/read-back/deletion. Unsupported enforcement gates write/delete and retains acceptance pending.
- [ ] Execute real SMB/iCloud A-to-B-to-A metadata/audio and divergent revision tests, partial visibility, interrupted/offline/sleep/restart scenarios and actual model answers.
- [ ] Validate packaged runtime on available M1/M4, fresh/upgrade/reinstall custom quota and visible menu/capture finalization within the owner's authorization to replace disposable Heed data. Preserve unrelated data and applications. Record macOS 14 runtime execution separately from real server/device interoperability.
- [ ] Update the 15-row evidence table with exact source/installed commit, language/locale/device/model and criterion-by-criterion results. No credentials, raw transport/account logs or personal recordings in Git.
- [ ] Commit only sanitized evidence as `docs: record synchronization acceptance and remaining external gates`.

### Task 10: Consolidated review, exact-head CI and merge handoff

**Files:** Final docs/TODO/PR description and independently reproduced fixes.

**Interfaces:** All tasks above and existing repository handoff instructions.

- [ ] Run consolidated server/client/Python/native/build checks and complete release simulator against final source. Review all diffs/untracked/outgoing changes and resolve required failures; do not broaden testing without a concrete unresolved concern.
- [ ] Obtain fresh whole-branch source review covering all five Review Focus conditions and all safety gates. Fix important findings with reproducing tests and verify affected suites.
- [ ] Rewrite PR #84 around actual final behavior/validation, commit and push every intended file, fetch and verify remote HEAD equals local HEAD. Wait for fresh exact-head CI; preserve acceptance limits instead of treating green CI as physical proof.
- [ ] Mark only fully evidenced original criteria and close only fully accepted issues. Keep excluded-provider not-planned closures unchanged.
- [ ] Stop only owned worktree services; preserve retained local evidence/data outside the worktree. Safely remove the clean worktree from outside it and verify `git worktree list` and owned ports/processes.
- [ ] Present the PR link, validations, remaining material gates, all-pushed confirmation and service/worktree cleanup. Do not merge PR #84 without applicable owner authorization.
