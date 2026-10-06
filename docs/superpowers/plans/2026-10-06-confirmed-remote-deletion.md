# Confirmed remote deletion implementation plan

**Goal:** Physically remove explicitly confirmed remote revision artifacts, preserve every unselected/shared version, and support bounded crash recovery without confusing local deletion or cache eviction with remote effects.

**Specification:** `docs/superpowers/specs/2026-10-06-confirmed-remote-deletion.md`.

**Architecture:** New empty v2 destinations fence legacy writers. A persistent SMB native guardian retains a server-enforced exclusive-create claim and a pinned local recovery guard across complete remote operations. A durable core engine binds previews/jobs to an exact destination and selected revision set. iCloud supports exact coordinated local metadata removal with pending propagation and retains shared audio. Google/OneDrive stay disabled under #56.

**Stack:** Bun/TypeScript core and API, React interface, Python mounted-SMB guardian, Swift scoped iCloud helper. All project-facing content is English; preserve all four interface locales.

## Tasks

- [ ] Add shared deletion capabilities, revision keys, strict bounded control records and private preview/job schemas. Keep unsupported providers disabled. Add failing tests for v1 refusal, newly empty v2 destinations and malformed controls before implementation.
- [ ] Implement the persistent SMB transaction guardian in `packages/server/native/smb-filesystem.py` and the provider bridge in `packages/server/lib/smb-provider.ts`. Retain root/lease/local-guard descriptors; enforce all v2 entry points; implement no-takeover ownership, atomic whole-claim rename release and hash-bound exclusive quarantine/unlink. Production shared-audio GC remains disabled pending cross-host freshness acceptance. Bind recovery to actual physical origin, app-directory and guard-file identities. Cover two-process contention, live orphan, copied journal, guard replacement, ambiguous crash and scope/path/mount faults.
- [ ] Extend `portable-provider.ts`, `portable-library.ts` and connector operation boundaries so publication, discovery/import and media reads participate in whole-operation exclusion. Persist pending references before audio upload; keep unresolved references protected. Add stalled-publisher and bypass regressions.
- [ ] Implement `remote-deletion.ts` with fresh all-origin reference inventory, opaque expiring preview, explicit stale-bound confirmation, durable jobs, immutable deletion intent, ancestry descriptors, explicit durable transaction checkpoints, ordered physical effects and exact-job recovery. Test shared cross-meeting/library hashes, fresh references after preview, every persistence/effect fault boundary, idempotency and cancellation. Preserve local sessions and invalidate destination-specific copy guarantees before media becomes reclaimable.
- [ ] Add coordinated exact metadata removal to the Swift iCloud scoped helper and its TypeScript adapter. Reject shared GC and false permanent/server-confirmed receipts. Test actual disposable local unlink, account/root/path changes and pending propagation; keep real account/two-device propagation acceptance separate.
- [ ] Add origin-guarded deletion preview/confirm/status/retry endpoints and a four-locale storage confirmation interface. Expose selected versions/destination, eligible/retained bytes and provider limits; never browser paths or native receipts. Test expired/stale previews, double confirmation, disabled clouds, and independence from local delete/disconnect/quota eviction.
- [ ] Run focused meaningful regressions while implementing; then full integrated server/interface/Python/native/build verification. Obtain independent and Claude reviews and fix proven findings before exact-head CI/merge. Publish remaining external/device acceptance gates honestly.

## Verification commands

Run from the dedicated issue worktree; use only disposable synthetic libraries and allowed service/QA ports.

```sh
bun test packages/server/lib
python3 packages/server/native/smb-filesystem.test.py
python3 -m unittest discover -s scripts -p 'service_*test.py'
NODE_OPTIONS=--no-experimental-webstorage bun run --cwd packages/client test --run
bun run build
HEED_ICLOUD_OUTPUT="$TMPDIR/heed-icloud-deletion-check" bash packages/desktop/icloud-folder/build.sh
"$TMPDIR/heed-icloud-deletion-check" --self-test
bash packages/desktop/install-menubar.sh --build-only
```

Synthetic algorithm tests and published SMB CREATE semantics do not establish real mounted-server interoperability. Real SMB two-host contention/reconnect/deletion and iCloud propagation remain acceptance gates until independently observed. Never modify personal libraries, installed applications or unrelated services during these tests.
