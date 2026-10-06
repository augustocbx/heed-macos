# Managed local storage quota

Heed defaults to a decimal **2 GB (2,000,000,000 bytes)** budget for managed meeting data. Settings accepts integer-byte limits from **1 MiB (1,048,576 bytes)** through **8 TB (8,000,000,000,000 bytes)** and persists `storage_limit_bytes` in device-local configuration. Invalid or missing configuration uses the default. Reinstallation preserves existing preferences.

## What counts

The shared allocator counts regular files in the managed roots, once per filesystem device/inode, without following symlinks:

- Text: sessions, tasks, meeting/library chat, recording manifests and recovery archives, and the portable library catalog.
- Media: retained recordings and private downloaded library audio.
- Indexes: the portable library index directory.
- Staging: Heed-owned recording, import and transfer working directories.

Snapshots expose used, reserved, protected, reclaimable and available bytes, plus category totals. Reservations count only their unmaterialized remainder, so staged bytes are not counted twice. Non-media files in the recording directory remain protected text.

Models, application binaries, credentials and device preferences, diagnostic logs, external provider libraries, and operating-system/provider caches outside these roots are not managed meeting data. The reservation ledger is allocator metadata rather than meeting usage. This quota does not replace free-disk checks or a provider's own storage limit.

## Allocation and recovery

Recording, conversion, import, retranscription, lazy audio download and catalog writes share the allocator. Work reserves space before staging; atomic JSON replacement also budgets the old and replacement copies. A reservation cannot overlap another allocation. Insufficient space rejects optional work or stops capture through its controlled finalization path rather than discarding finalized text.

`quota-reservations.json` retains allocations and atomic-write intents across restart. Startup releases interrupted inspector and known media-worker claims, removes only their recognized temporary work, and preserves source recordings and catalog references. Invalid allocator state fails closed for recovery. It is not silently reset.

## Reviewed cleanup

Settings previews a reduction before applying it. The preview identifies eligible local media, oldest first, and binds the requested limit to the current files, reservations and protection state. A changed preview requires another review. A limit below protected data is rejected.

Complete text, catalogs, indexes, staging and active reservations are protected. Active capture/processing and provider-pending source audio are also protected. Provider receipts are destination-specific; publication to one destination does not authorize eviction while another still needs the source. Unavailable or corrupt optional connector state protects media instead of guessing that it is safe to remove. iCloud's system-reported uploaded status is not an independent integrity receipt and does not release its pending source audio.

Cleanup removes eligible private media only. It records missing audio on the retained session so transcript, notes and tasks remain available. It does not delete remote provider history. Explicit meeting deletion and remote deletion policies are separate actions.

## Validation boundary

Automated tests cover default persistence, range/origin checks, stale cleanup previews, text preservation, concurrent reservations, replacement-copy accounting, restart recovery, low-rate audio expansion, blocked upload staging, and provider-pending audio under quota pressure. They use isolated private directories and synthetic audio. Actual recording behavior, resource use and two-device/provider round trips still require acceptance on the supported Macs and consented accounts.
