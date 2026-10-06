# SMB synchronization implementation

Issue: #25. Implement only in the dedicated issue worktree. Real share credentials, mounts, private meetings and deployment are excluded from this execution.

The destination is an existing macOS SMB mount selected through the native folder picker. A dedicated `Heed Library` child contains an immutable version-one destination header with a UUID independent of meeting origin library IDs. Existing libraries require explicit connection confirmation; creating a library requires separate confirmation. Credentials stay in macOS. The guided address accepts only a credential-free `smb://server/share` URL.

1. Implement and test descriptor-relative native filesystem operations. Open every path component without following symlinks, compare `fstatfs` SMB type and mount identity before/after operations, and never recreate a missing mount. Parse scoped public `smbutil statshares` output, trusting active signing or required share encryption rather than advertised support. Keep raw command output and mounted credentials out of logs/config/API.
2. Implement an immutable provider adapter: bounded commit discovery, bounded streaming, temporary verified objects followed by atomic non-overwriting publication, commit markers last, fsync and read-back verification. Connection state distinguishes read-only access and publication acknowledgment from server power-loss durability. No remote deletion API.
3. Add a private, atomic connection registry and bounded retry scheduler. Test, rename, disable, disconnect and restart do not change recording settings or delete local/remote data. Mount identity changes require an explicit retest. Interrupted jobs remain pending; ordinary capture and local AI continue independently.
4. Integrate the #26 provider contract and #27 quota after their merge. Import newest-first complete text without downloading audio; queue eligible local revisions, preserve concurrent conflicts, and retry quota failures without evicting text.
5. Add Settings, native connection/folder commands, four locale dictionaries, HTTP/controller/UI regression tests, documentation and synthetic two-device/fault acceptance scenarios.

Physical acceptance remains separate: disposable Samba and native macOS SMB shares, both Macs, macOS 14, sleep/wake, disconnect during writes, server power-loss behavior, Unicode and actual OS permission prompts. Client fsync/read-back is a share acknowledgment; server storage durability depends on its configuration and hardware.
