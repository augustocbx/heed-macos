# Issue #62: implementable physical deletion protocol

Status: reviewed implementation specification for issue #62. The owner authorized physical remote deletion with explicit confirmation and shared-version protection. One consolidated PR contains this work with the chat and port corrections. Device/provider acceptance remains separate.

## Scope and feasibility

Implement actual file removal of explicitly confirmed revision artifacts. SMB v2 physically removes exact selected revision metadata. Production shared-audio reclamation remains disabled until real cross-host freshness and contention acceptance is established; the conservative graph planner and removal primitive can be tested without enabling this capability. iCloud performs coordinated exact metadata removal locally, retains shared/content-addressed audio, and reports propagation pending. Google Drive/OneDrive runtime gates remain fixed false (#56); no auth construction, account connection, or account acceptance in this feature.

This is implementable using the current mounted SMB/native helpers without a new SMB client dependency. Its guarantee is **cooperative v2 clients on one authoritative SMB namespace**. It is not protection against a share administrator, malicious arbitrary filesystem writers, a server that violates SMB semantics, or asynchronously replicated namespace views. No double scan, advisory lock, timer, or cached “complete” flag substitutes for exclusion.

## Verified primary SMB guarantee

[MS-SMB2 CREATE request §2.2.13](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-smb2/e8fb45c1-a03d-44ca-b7ae-47385cfd7997) defines FILE_CREATE as fail when an entry exists and create when absent, including directory-create options. [CREATE response §2.2.14](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-smb2/d166aa9e-0b53-410e-b35e-3933d8131927) distinguishes FILE_CREATED from FILE_OPENED. [MS-FSA existing-file processing §2.1.5.1.2](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/41f3734a-5bba-4c3b-9d04-7baafc9b7bfe) rejects existing directory/file collisions for this disposition. Consequently, competing conformant server creates of the same fixed directory name cannot both establish a new entry; this is the mutual-exclusion inference.

Use a single descriptor-relative `mkdir(".heed-v2-lease", dir_fd=root)`, with no exists-then-create sequence and no `exist_ok`. EEXIST means busy, not acquisition. Directory creation is preferred over an overwriteable lock file. Apple's primary [SMBClient smbfs_smb.c](https://raw.githubusercontent.com/apple-oss-distributions/SMBClient/main/kernel/smbfs/smbfs_smb.c), lines 5148–5180, maps mkdir to FILE_CREATE; [smbfs_vnops.c](https://raw.githubusercontent.com/apple-oss-distributions/SMBClient/main/kernel/smbfs/smbfs_vnops.c), lines 3453–3459, also maps O_EXCL to FILE_CREATE. This verifies the intended mounted-client mapping in published source. It does not certify the actual installed build/server configuration. Synthetic two-process tests verify the local algorithm behavior; real two-host mkdir/collision testing is a separate acceptance gate. Do not label that gate passed from documentation.

For quarantine, [MS-FSCC FileRenameInformation for SMB2](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fscc/52aa0b70-8094-4971-862d-79793f41e6a8) specifies rename fail-if-target-exists when replacement is false. Reuse existing Darwin `renameatx_np(RENAME_EXCL)`; never replace an existing quarantine file.

## Destination fencing and format

New, empty destination creation writes `{format:"heed-portable-library",schemaVersion:2,destinationId:<UUID>}`. Existing v1 adapters reject that header before any data operation. Payload, manifest and commit schemas may remain version1; version2 is the **destination transaction/deletion protocol**, not a transcript rewrite.

- Create v2 only in a new empty selected dedicated folder. Do not rewrite a v1 header or adopt populated arbitrary folders.
- Continue legacy v1 reads/publication as today, with physical deletion disabled and an explicit “new v2 destination required” reason.
- A user may copy verified legacy content into a new v2 destination through existing import/publication; never treat an in-place header edit as fencing.
- Persist destination header version with each connector binding; stale settings/API requests must include the connection ID/generation and destination UUID. Existing global fixed-off cloud controls remain untouched.
- Old clients cannot have a pre-header-v2 request in flight in a truly new destination. Merely bumping a populated old header does not provide that property.

## SMB exclusive transaction

Use **one exclusive lease for every v2 remote transaction**, including discover/import, full publication, audio fetch/read, preview and physical deletion. This serializes readers/publishers on this modest personal library and avoids a new distributed reader/writer-lock protocol.

1. Persist a private operation UUID/nonce before acquisition. Native acquire opens the bound mount/root/header via existing no-follow traversal and atomically mkdirs the fixed lease directory.
2. Open the newly created directory no-follow; write a bounded exclusive owner record `{version:1,destinationId,deviceId,operationId,nonce}`; fsync owner and lease/root directories. Return an opaque owner receipt including verified lease directory identity. Never accept an existing directory as acquisition.
3. Each subsequent v2 native request carries that receipt, reopens and verifies the exact owner record, directory identity, header and bound mount identity before any I/O. Native read/write/delete entry points reject v2 operations lacking the receipt. Raw provider methods cannot bypass this guard.
4. Hold the persistent lease entry across the whole object→payload→manifest→commit→read-back publication and the whole audio read. No per-object acquisition/release. Core ALS supplies a reentrant local owner boundary; child provider methods borrow it, while separate callers cannot.
5. Release only after transfer cleanup and durable checkpoints. Atomically rename the entire exact verified claim directory, with its owner record intact, to a unique released-claim name and fsync the root; then perform bounded exact cleanup. Never unlink the owner followed by rmdir at the fixed claim name: a crash between them would strand an ambiguous empty claim. Rename failure retains the claim; no unlink/rmdir fallback is allowed. Changed identity, unexpected content or unknown owner => retain and report blocked.
6. No TTL, heartbeat expiry, forced takeover, “unlock” button, or clock-based lock stealing. A crashed/ambiguous lease remains busy. Cancellation must await native exit/cleanup before releasing ownership.
7. Same-owner recovery is allowed only when the original private operation journal matches the complete remote receipt, native recomputation verifies the original physical-device/app-directory/guard-file origin binding below, and a retained local kernel guard excludes a live prior helper. Copied nonce/deviceId/job receipts are not authority to resume. If death/ownership/origin cannot be proved, report recovery required and do not resume/release. A lease left empty by a crash before owner-write is ambiguous and remains blocked. Remote/unreachable device ownership is never assumed dead.

Because the directory persists independently of a connection, transient SMB session loss cannot make a second cooperative client acquire while the first is partitioned. The original must stop on mount/header/owner verification failure. Do not unlink the lease from an error handler lacking verified ownership.

**Native ownership/lifetime implementation:** start one tracked persistent Python transaction helper for the entire core operation, not one claimant per artifact. Before remote acquisition/resumption, it opens the private per-destination local guard with O_NOFOLLOW/O_CLOEXEC, requires a regular single-link file, acquires a nonblocking kernel lock, and retains that FD until exit. This local lock is only an anti-orphan/same-device-singleton guard; it supplies no remote exclusion. The helper pins root/lease descriptors and serves bounded framed read/write/list/remove RPCs over its existing stdin/stdout pipes; all actual I/O occurs in that process under the claim. A restarted server cannot recover the same private job while the old helper still holds its local lock. If the old helper died (including SIGKILL), the kernel releases only the local guard; the persistent remote claim remains and recovery additionally verifies the durable job, origin binding and complete owner receipt. Matching device ID/PID alone is insufficient. EOF, pipe errors and capture preemption stop new RPCs, await the current helper operation/cleanup, and retain the remote claim unless an explicit verified release was reached after the parent's durable checkpoint. No detached child per-file workers may outlive the guardian. Track/reap the helper through the existing process registry; retain it for bounded cancellation cleanup, never unlock before its I/O has stopped.

**Non-transferable recovery origin:** before the first remote claim, persist a private native-derived origin binding: a domain-separated digest of the actual physical-device identity; a digest of the canonical APP_DIR path plus its descriptor-verified device/inode; and the persistent guard file's device/inode. Native recomputes these values itself for every acquire/resume, rather than trusting copied portable device UUIDs or request fields. The guard pathname must still name the same inode as the retained FD, and APP_DIR must still resolve to the same canonical path/inode; recheck both before each effect and release. Reject symlinks, multiple links, replaced/missing guards and unknown/unavailable physical identity. Use a bounded native macOS identity lookup (for example the platform UUID from local IORegistry), immediately derive the digest, and never put the raw identifier in portable records, API responses, logs or exceptions. Only the private origin binding is retained. A new private job may use a freshly established origin; an already-claimed job must never rewrite its original binding. Copying/restoring to another APP_DIR or Mac, moving the original directory, or replacing its guard changes the binding: preserve both jobs/claim and return recovery-required with zero remote native effects. Native origin validation and guard acquisition must happen before any remote probe, inventory, claim mutation or release. No automatic transfer of recovery authority or independently unproved remote-owner death is permitted.

**Read-only limit:** a genuinely read-only mount/account cannot create the coordination lease. Preserve v1 read-only imports. For v2, deny transactions requiring the lease with a specific coordination-permission reason; do not secretly write despite read-only policy. An ACL that permits only control-directory writes could support coordinated read-only data access, but that richer ACL probing is outside this minimal implementation. Physical deletion always requires writable data and control access.

## Small concrete interfaces

Add a separate shared deletion types file and keep ordinary browser-visible APIs free of physical paths:

```ts
type RevisionKey = {libraryId:string;meetingId:string;revisionId:string};
type DeletionCapabilities = {
  revisionMetadata:boolean;
  sharedAudioGC:boolean;
  exclusion:'exclusive-create'|'local-coordination'|'none';
  confirmation:'pending-verification'|'pending-propagation'|'disabled';
  destinationVersion:1|2;
  blockedReason?:string;
};
type ArtifactIdentity = {path:string;bytes:number;sha256:string};
interface RemoteTransaction {
  inventory(signal?:AbortSignal): Promise<{
    commits:PortableCommit[];deletions:DeletionRecord[];
    pending:PublicationIntent[];complete:boolean;
  }>;
  writeDeletion(record:DeletionRecord,signal?:AbortSignal):Promise<void>;
  removeExact(jobId:string,artifact:ArtifactIdentity,signal?:AbortSignal):
    Promise<'removed'|'already-removed'>;
}
interface LibraryProvider {
  // Existing methods remain.
  deletionCapabilities?:DeletionCapabilities;
  withTransaction?<T>(
    context:{operationId:string;deviceId:string;kind:'read'|'publish'|'delete'},
    run:(transaction:RemoteTransaction)=>Promise<T>,
    signal?:AbortSignal
  ):Promise<T>;
}
```

SMB adds bounded native acquire/check/release/inventory/quarantine/remove actions. Scope owner/control paths separately from existing public `providerPath`; browsers never supply either. iCloud's transaction implementation is local coordination only and refuses sharedAudioGC. Native receipts stay private; API previews expose counts, retained reasons, exact revision selection and opaque tokens only.

Core-owned transaction wrapping is required in both direct `operation()` paths and connector `withProvider()` ticks. Do not nest acquisition when provider methods inherit the existing owner; explicitly reject calling v2 native methods outside a transaction. Unit mocks/default providers retain unsupported deletion unless they implement this interface.

## Control records and complete reference graph

Within v2 add strict bounded native-controlled namespaces for immutable deletion records, publication intents and per-job quarantine. For example `control/deletions/<jobId>.json`, `control/pending/<deviceId>/<operationId>.json`, `control/quarantine/<jobId>/<ordinal>`. Validators reject traversal, symlink/hardlink entries, unsupported records and page/byte excesses. No transcript text, token, local absolute path or credential appears in portable control records.

Before publishing any audio, persist and read-back a pending intent enumerating that revision's exact audio hash/length. Keep it through commit verification. Remove/retire it only after successful durable publication or safely confirmed abandonment; a crash/cancelled intent protects its hash until reconciled. A foreign unresolved intent is conservative live ownership, not an orphan eligible for deletion.

Inventory under the held exclusive lease must be fresh and complete. Read and validate **every committed bundle in the destination**, including all origin library IDs; do not combine provider leftovers from the private historical catalog. Include pending references, deletion records and duplicate commit markers. Corrupt or unsupported referenced content blocks GC. Ordinary unknown user files are untouched; unknown control records block destructive planning.

An audio hash is eligible only if it is referenced by the explicitly selected revisions and by no surviving committed revision or unresolved publication intent. Do not garbage-collect arbitrary pre-existing/orphan objects. Shared hashes are retained and their bytes/reasons shown. A selected parent with a surviving child leaves a deletion descriptor containing identity, manifest hash and parent IDs so lineage remains interpretable.

## Preview, confirmation and durable physical effects

Origin guard first, disabled cloud 503 second, then exact request validation. Dedicated preview/confirm/status/retry routes reuse the core local operation boundary and provider transaction.

Preview takes exact provider/connection/generation/destination and full RevisionKeys. It performs fresh inventory, builds the graph, records target file identities and digest, and fsyncs a bounded private preview with opaque token/expiry. It releases the lease; nothing remote is deleted.

Confirm requires that token plus explicit confirmation. It durably creates a job, reacquires the lease, checks all settings/destination identities and rescans. Any added/removed/changed committed or pending reference changes the digest => 409, no new physical effects, new preview required. Repeated same token/selection returns the original job; mismatched reuse cannot select different work.

Phases:
1. Prepared private job, including full expected artifacts and exact destination receipt.
2. Immutable remote deletion record, read-back verified, covering selected revisions and ancestry descriptors. This dominates stale replay/import.
3. Quarantine all selected commit markers first, then selected payload/manifest metadata. Only after each quarantine identity/hash is verified may its file be unlinked. Record each receipt.
4. Remove eligible audio last, and only for SMB with proven held exclusion/full graph. iCloud retains all shared-layout audio and reports retained bytes.
5. Reconcile absence/quarantine receipts under the same destination, persist local catalog/deletion state and connector pending-job retirement, then acknowledge provider checkpoints. SMB reports observed exact namespace removal with cross-host verification pending; iCloud remains pending propagation. Neither result is a provider-certified permanent-erasure receipt.
6. Explicitly checkpoint the transaction after durable local/remote progress before allowing verified release. Retried work reopens the same bounded job, never the current UI-selected provider. Hard EOF or persistence failure keeps the claim for original-owner recovery; recording preemption waits for helper cleanup.

A physical file must actually be unlinked for a successful removal receipt. Tombstones alone do not complete this feature.

### Hash-bound quarantine primitive

Native opens each regular single-link artifact no-follow under checked parent/root descriptors, streams its exact declared length/hash, compares the current source directory entry with the opened identity, then exclusive-renames it into the job's unique quarantine slot on the same mounted destination. Open and hash the quarantined file again and compare identity/length/digest before unlink/fsync. Any mismatch or parent/root/lease change preserves quarantine and blocks the job; never unlink unexpected bytes. Do not recurse or remove directories containing user/other-device files.

Recovery cases are deterministic: source present + quarantine absent => verify/move; source absent + matching quarantine => verify/unlink; both absent with matching durable remote job intent => already removed; both present/conflicting quarantine => block. Lost unlink acknowledgement is reconciled, not a broadened delete. This gives expected-content deletion under cooperative immutability; POSIX rename-by-name does not itself provide an atomic hash-CAS against malicious arbitrary replacement, so make no adversarial-file-writer claim.

After durable deletion intent, never restore old commit markers pointing at partly removed payloads. Cancellation/preemption returns a resumable incomplete job, awaits cleanup, and keeps receipts. Local meetings/tasks/chat remain usable; explicit remote deletion does not silently delete their local transcript.

## iCloud physical boundary

Add native exact-file deletion using `NSFileCoordinator.WritingOptions.forDeleting`, existing bookmark/account/root/header checks and descriptor-relative quarantine/unlink. Validate current path/parent identities and prohibit recursive removal. Delete only explicitly selected revision metadata and its commit markers; retain deletion descriptors/remote records, preserve unselected versions, and keep every legacy content-addressed audio object.

Local coordination is not the SMB lease and does not prove a globally complete graph. Do not create a replicated “lock” directory and call it distributed exclusion. Every v2 iCloud publisher/discoverer processes deletion records before publishing/importing and reconciles a late-arriving old artifact; concurrent/offline replication therefore remains a visible pending state. Do not claim stable remote absence, provider-certified permanence, or full shared-object GC. External provider restore/history copies are outside the operation's erasure scope.

## Bounded implementation order and owned files for one PR

1. **Types/protocol/native RED tests:** shared remote-deletion types; header version handling; strict control schemas; tests for v1 refusal/new-empty-v2-only and capability labels. Existing v1 imports/publication stay passing.
2. **SMB exclusion/native effects:** `smb-filesystem.py` and tests, `smb-provider.ts` and tests, minimal `smb-connections.ts` version binding/create changes. Implement atomic mkdir ownership, no-takeover behavior, full inventory, expected-hash quarantine/unlink.
3. **Core durable engine:** new `remote-deletion.ts/.test.ts`, `portable-provider.ts`, `portable-library.ts`, `portable-schema.ts`, runtime/quota protection. Wire whole-operation transactions, publisher intents, deletion-aware ancestry/discovery and registry job retirement.
4. **iCloud local effect:** `ScopedFiles.swift`, `Runtime.swift`, native protocol tests, `icloud-folder.ts`, minimal `icloud-connections.ts` binding/replay changes. Keep shared-GC disabled and pending honest.
5. **API/UI:** new guarded deletion HTTP/controller tests, shared API client, storage preview/confirmation/job-status components and four locale dictionaries. Stale tabs/double confirm/expired preview tests; existing local delete and quota flows remain zero remote effects.
6. **Combined checks/review:** full server/client/Python/native/build, independent distributed-race/fault review and exact-head CI. Real synthetic two-Mac SMB acquire/collision/publication-vs-deletion QA and iCloud propagation acceptance stay separately evidenced. No actual shares/accounts/services in implementation tests.

Essential RED scenarios: two independent cores contending for the same fixed lease; crashed/empty owner never stolen; stalled publisher before commit blocks deletion; shared hash across meetings/origin libraries retained; foreign pending intent protects hash; no lease bypass through manual API/background/audio; stale token/provider/new reference has zero deletes; every native/journal phase crash; rename/hash/parent/mount/header/readonly fault; lineage through selected parent; interrupted job retry without broadened target; iCloud physical unlink but never shared-GC/remote-confirmed; disabled cloud endpoints never auth/vault/native access.

Mandatory recovery-authority RED tests: copy the complete private job/nonce/deviceId into a second APP_DIR while the original persistent helper is alive; simulate the same copied job on a different physical-device fingerprint; move/restore the original app directory; replace the guard inode while the original FD remains locked; present a symlink or hard-linked guard; make native hardware identity unavailable. Every case must return recovery-required before any remote native call, including probes. Positive same-path/same-origin crash recovery acquires the original guard only after the original helper is actually dead and retains its original inode. A same-origin live/orphan helper after server SIGKILL prevents resume. Never substitute synthetic fingerprints for physical acceptance evidence; injection is for deterministic protocol tests only.

## Honest limits to keep visible at freeze

The protocol is bounded enough for one cohesive PR but is larger than adding `deleteObject`: publication and native entry points must all adopt it. Shortcuts around that integration are unsafe. Physical SMB GC remains unsupported if exclusive mkdir semantics, one authoritative namespace, mount identity or cooperative v2-only access cannot be established. A crashed ambiguous lease can leave a destination unavailable; automatic stale-lock recovery is intentionally absent. iCloud cannot complete the same strong deletion/GC promise with current public folder APIs. These are explicit capabilities and acceptance limits, not reasons to skip the authorized actual metadata file-removal implementation.

## Independent recovery correction

The private guard is a no-follow regular single-link file whose descriptor and identity remain pinned for the complete helper lifetime. Its exact device/inode and the app-directory device/inode must match the original private recovery receipt. The physical-device fingerprint is recomputed from the platform identity locally, with only a derived value retained privately; it is not accepted from a copied journal. Do not replace or unlink the guard while a remote operation exists. Tests must attempt recovery from a copied journal in a second app directory and with a replaced guard while the original helper remains alive; both must refuse with zero native effects. Normal same-origin process death recovery still requires the original remote receipt and exclusive local guard.

## Claude second-opinion amendments

The actual read-only protocol review identified the release crash window and repeated the copied-owner problem; both are corrected above. A held exclusive claim alone does not prove macOS SMB directory caches are fresh across hosts. An authoritative index would still require a proven fresh-read boundary. Therefore production `sharedAudioGC` remains false with an actionable pending-acceptance reason. Do not add an index and claim it proves coherence. Known selected immutable metadata may be removed under exact identity/hash verification; every content-addressed audio object stays protected in production. Confirm header rejection against supported legacy sources, cross-host open/list coherence and real acquire/reconnect/crash behavior before enabling shared-audio reclamation.

The exclusive audio transaction ends after verified bytes have reached the local cache; interactive playback never retains a remote claim. Borrowed asynchronous transaction contexts carry a closed/released flag checked on every provider call; escaped callbacks must fail. All publishers, including SMB reconnect ticks, consult deletion intent before republishing a selected revision. Unknown lease versions remain busy.

`RemoteTransaction.checkpoint()` authorizes release only after the caller has durably persisted catalog/pending/deletion state. Successful callbacks checkpoint before release. Read-only errors may release after awaited cleanup because they made no remote artifact mutations; publication/deletion errors may checkpoint only after their exact private interrupted state write succeeds. Unhandled persistence failure, hard EOF or ambiguous ownership retains the claim. A future recovery reconciles exact touched bytes/receipts before trusting them. Document creating a fresh v2 destination as the safe recovery alternative when the original owner is lost; offer no automatic takeover.
