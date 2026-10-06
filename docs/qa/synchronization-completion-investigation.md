# Synchronization completion investigation

## Scope and current state

The requested follow-up covers every unchecked original criterion in [the synchronization TODO](synchronization-todo.md): 15 active original criteria in #18/#25/#26/#27/#30. The owner removed account-backed integrations from the active backlog; they are outside this delivery. Criteria overlap across parent/child issues; each complete original requirement must remain traceable. Existing code is not evidence of actual device, account, provider or installed-runtime acceptance.

Investigated source: `880a0bf6f17128e5bff57854cc4a7337e338d29d` on October 6, 2026. PRs #81, #78 and #79 are merged; the exact integrated main Verification run [37500635011](https://github.com/augustocbx/heed-macos/actions/runs/37500635011) passed. The source checkout's pre-existing `AGENTS.md` changes were preserved. Read-only SSH confirms access to the second Mac; both devices report arm64/macOS 27.0.1 and have local models. This does not establish macOS 14 runtime interoperability or any recording/provider acceptance.

No real account, mounted destination, installed application or personal meeting was changed during this investigation. The owner confirmed device/provider resources are available and selected direct public SMB3 with Keychain credentials. Disposable SMB/iCloud roots still require exact local identity verification before fixture effects.

## Findings and proposed workstreams

### Mounted SMB is an architectural blocker

The current v1 publication path also requires exclusive rename. It cannot serve as a writable fallback. Both actual Mac mounts previously refused exclusive rename and hardlink publication. Apple's public SMB client source provides ordinary rename, while its vnode implementation and volume capabilities omit the required exclusive-rename interface. Another NAS is not a demonstrated workaround: [vnode implementation](https://github.com/apple-oss-distributions/SMBClient/blob/main/kernel/smbfs/smbfs_vnops.c), [volume capabilities](https://github.com/apple-oss-distributions/SMBClient/blob/main/kernel/smbfs/smbfs_vfsops.c).

The owner selected the first approach below. The alternative is recorded to explain its unresolved deletion boundary:

1. **Recommended: direct public SMB3 transport.** Evaluate the public [smbprotocol implementation](https://github.com/jborean93/smbprotocol) against the [SMB2 CREATE contract](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-smb2/e8fb45c1-a03d-44ca-b7ae-47385cfd7997). Server-side exclusive creation, non-replacing rename and handle-bound operations can bypass Darwin's missing mounted interface. This requires a separately verified transport, protected credential entry/storage, server/destination identity, signing/security gates, operation deadlines and crash recovery. It must preserve the existing canonical admission, marker-last visibility, deletion fences, owner-bound journals and pending-media protection. Existing v1/v2 destinations and mounted read-only import remain unchanged until compatibility is demonstrated.
2. **New mounted v3 based on exclusive creation.** A versioned append-only claim/marker protocol could provide publication without exclusive rename, subject to actual cross-host exclusion/coherence proof. It does not currently provide safe exact physical deletion. Hash/stat followed by unlink of a path may delete an unknown replacement; this cannot replace the current exclusive quarantine mechanism. Such a choice leaves physical-deletion acceptance pending and requires every reader/writer to understand the new coordination version.

A direct transport must open destructive targets without delete-on-close, validate the intended object's exact identity/hash under enforced share-access exclusion, and only then request handle-bound deletion. Enabling delete-on-close before validation would damage an unexpected object. Protocol specifications and library code are feasibility evidence, not proof that a particular NAS enforces the complete policy. No transport is enabled by this investigation.

Required tests include exclusive collision denial, no-overwrite publication, partial canonical admission/markers, copied or foreign recovery receipts, claim release races, cancellation, bounded retained state, namespace replacement during deletion, and real two-Mac reconnect/coherence. Shared-audio collection remains disabled.

### Local quota and offline AI

The merged quota fix protects retained audio and removes abandoned pre-audio staging. The full release simulator defines custom 3 GB checks in config, Storage API and desktop status after install/upgrade/reinstall. The first complete attempt passed five initial checks, then exposed an outdated legacy fixture: the real installer correctly refused a simulated checkout without current safe service-port configuration. Correcting that fixture and rerunning the complete simulator is part of this follow-up; later quota checks have not yet run.

Additional acceptance automation should exercise actual FFmpeg with synthetic PCM reaching the working-space bound, one durable finalization and released reservations; two production UI tabs propagating the same persisted quota in all four locales; and imported English/Portuguese transcripts answered by installed local models after provider disable/restart. Reuse production chat generators and strict citation validators. Do not replace model output with a synthetic model response when claiming semantic acceptance. Physical capture, visible native menu and physical installation remain separate retakes.

### iCloud

The iCloud connector already implements private account/bookmark binding, immutable branches, complete-import validation, bounded jobs, transition rollback and conservative local-only acknowledgment. A portable comparison/report tool can verify exact metadata/audio hashes, branch ancestry and local offline availability across independently collected device observations. Actual chosen-folder access, account errors, replication, concurrent edits and fault recovery still require two Macs and disposable folders.

Correct the iCloud publication documentation: v2 admits its canonical manifest before payload/media and publishes the commit marker last; legacy ordering differs. Compilation and synthetic self-tests cannot establish packaged bookmark access or actual cloud replication.

Excluded account-connector implementations remain disabled and their private pending-state protection remains intact. No account-backed connector enablement belongs to this delivery.

## Complete original-criterion coverage

| Criterion | Required implementation or acceptance work | External evidence still required |
|---|---|---|
| #18.2 | Production-provider import, local commit, restart with provider unavailable; bilingual meeting/label-scoped real-model answers and exact current-revision citations | Both devices and their installed models; no remote calls after offline transition |
| #18.5 | A-to-B-to-A metadata comparison including notes, corrections, labels, speakers and provenance | Real writable provider roundtrip between the Macs |
| #25.1 | Exercise connect/test/rename/disable/disconnect through reviewed controls; preserve recording configuration | Visible direct-provider UI on both Macs; legacy mounted controls tested separately |
| #25.2 | Explicit authentication/security, destination identity and independent read/write capability gates | Signed/authenticated actual NAS; real read-only and writable permissions |
| #25.4 | Quota-reserved committed text import and offline search/chat automation | Actual owner-selected direct connection/import plus real local-model output |
| #25.6 | Resolve SMB transport blocker; immutable complete publication and exact remote read-back | Real writable NAS acknowledgment and cross-device integrity |
| #25.8 | Bound and persist pending jobs across fault/restart; expose retryable status | Disconnect, sleep/wake, changed permissions, partial write and unavailable NAS |
| #25.12 | Sanitized transport/access capability reporting; reject unsupported security | Real negotiated session/security and required-access UI |
| #26.5 | Compare full portable payload and ancestry on each leg | Actual two-Mac writable roundtrip |
| #27.1 | Run existing complete sandboxed release simulator; separately verify default and preserved custom quota | Fresh/upgrade/reinstall on both physical installations |
| #27.2 | Two-tab production UI propagation plus authoritative desktop status comparison | Visible native menu and installed controls on both devices |
| #27.5 | Synthetic PCM through actual FFmpeg, bounded allocations, one finalization and durable session | Actual recording finalization under quota pressure on both devices |
| #30.2 | Preserve account/bookmark/destination gates and actionable sanitized states | Owner-controlled signed-out, disabled, unavailable and denied-access retakes |
| #30.7 | Exact branch/commit/artifact comparator; partial-revision exclusion | Independent two-Mac replication and concurrent edits |
| #30.9 | Bounded journal/restart/fault retakes and preserved protected media | Actual offline, sleep/wake and sign-out recovery |

## Evidence rules and next decisions

Every scenario records exact source/installed commit, device/model, content language, interface locale, fixture IDs, observed result and limitations. Keep synthetic/public fixture artifacts separate from private meetings and retain no credentials or token-bearing URLs. Report passed, failed and blocked scenarios independently; a blocked prerequisite is not an accepted criterion.

The owner-selected direct-SMB3 transport is an explicit scope change for #25. Record its real acceptance as direct transport; mounted writable operations remain refused and must not be reported as successful.

The implementation PR must not claim all original acceptance complete until every clause above has its applicable evidence. The remaining design work is the reviewed direct-SMB transport specification and exact disposable destination selection/identity verification. Missing external inputs do not justify weakening production publication/deletion policy or enabling accounts automatically.
