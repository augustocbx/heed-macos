# OneDrive portable library design

Status: approved implementation design for #29, following #25, #26 and #27. Automated work uses synthetic OAuth/HTTP fixtures. Real account connections, registration, private uploads and deployment remain outside this validation scope. Public documentation was checked on 2026-10-05. Provider acceptance remains unverified.

## Destination and permission gate

Prefer an explicitly selected library inside the application's OneDrive app folder. Microsoft documents `Files.ReadWrite.AppFolder` for home, work/school and SharePoint drives; users can alter its contents and its files consume remote capacity. Both Macs must use the same public application registration and select the same destination header UUID, independent of originating library UUIDs. Selecting a library does not broaden the permission grant. [App-folder guidance](https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder)

Documentation alone does not prove the required endpoint combination: the delegated app-folder permission is marked preview, while the generic upload-session and delta permission tables list broader permissions. Capability checks must establish discovery, delta, resumable upload, read-back and cross-device reuse under the actual grant before enabling publication. Reject unsupported configurations with an explanation; never silently request broader scopes or scan unrelated files. Arbitrary folders outside app root require a separately reviewed permission design. [Permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference#filesreadwriteappfolder), [upload sessions](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0), [delta](https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0)

| Account/storage | Proposed eligibility | Current evidence |
| --- | --- | --- |
| Personal OneDrive | App-root library after all capability checks | Documentation only; no authenticated probe |
| Work/school OneDrive | Same checks plus tenant consent/access restrictions | Documentation only; no authenticated probe |
| SharePoint document library | Explicit known drive and eligible app-root library | Discovery, consent and folder-scoped delta unverified |
| Guest/shared shortcut or arbitrary outside folder | Unavailable in initial design | No permission escalation or shortcut traversal |

An authenticated synthetic-account probe is a future acceptance step, requiring separate authorization. Failure of least-scope delta support leaves the connector unavailable; periodic children listing must not be advertised as equivalent incremental synchronization.

## Desktop authorization and credential boundary

Use a supported public-client authorization-code flow with PKCE and browser interaction. No client secret belongs in a desktop installation. The proposed initial grant is app-folder access plus `openid` and `offline_access`; verify the precise SDK request and returned account identity without adding `User.Read` merely to display a profile. Bind each interaction to a short-lived one-use request, validate its result, and serialize refresh. [Authorization flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)

The implementation will reuse #28's shared desktop PKCE helper and compiled native Keychain helper, with protocol tests, installer packaging and CI builds. This keeps account scopes, token refresh and Graph behavior provider-specific while sharing browser/callback and secret storage boundaries. Microsoft recommends its authentication libraries; MSAL remains a future packaging option, requiring its registered redirect, Keychain and signing configuration. No authentication SDK dependency has been added. [Authorization-flow guidance](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [MSAL installation and configuration](https://learn.microsoft.com/en-us/entra/msal/objc/install-and-configure-msal)

The registered native callback must match the helper's exact host/path. Microsoft's documented ephemeral-port exception applies to localhost redirects; a numeric-loopback callback must satisfy its registration restrictions. Configure a validated loopback hostname or fixed registered port without opening an external listener, and test real bound callbacks. Registration instructions must state the chosen URI precisely. [Redirect restrictions](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url#localhost-exceptions)

Tokens and preauthenticated upload-session URLs remain in device-local Keychain storage. Private provider journals contain opaque credential references, never secret values; exported bundles, React responses, process arguments and logs contain neither. Use a nonsynchronizing credential policy and explicit Keychain error states. The native bridge exposes only narrowly scoped account/authorization commands and short-lived in-memory access to the local Graph worker. [Apple Keychain services](https://developer.apple.com/documentation/security/adding-a-password-to-the-keychain)

Disconnect first blocks future jobs, aborts/reaps current requests and invalidates their connection generation, then removes the selected account's credential cache and upload-session secrets. Local transcripts, accepted tasks and cached meetings remain usable. Local credential removal does not guarantee server-side consent revocation; document how the user removes application consent in Microsoft account/tenant settings. Reauthorization of the same account/destination resumes verified identities rather than creating duplicate libraries.

## Provider mapping and durable discovery

Implement the #26 `LibraryProvider` interface over Graph HTTPS. Keep a private mapping from strict portable paths to `(driveId, itemId, parentId, ETag)`; validate ancestry beneath the selected root and reject remote shortcuts, malformed names and changed destination identities. Never resolve meeting identity by display name or timestamp. Use the shared destination header and independent immutable per-device commit markers. Local OneDrive sync folders do not satisfy provider confirmation.

Delta processing stores a bounded generation of item metadata, using the last occurrence of repeated item IDs. Track parent IDs because folder renames do not enumerate every descendant. Follow validated continuation URLs, detect loops and enforce response/page/item caps. A 410 checkpoint invalidation starts a bounded rescan; partial or truncated scans retain earlier records. [Delta behavior](https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0)

Durably acknowledge each processed page only after its records and required verified metadata have been committed locally. Advance the final delta checkpoint only after completing that generation. Keep transcript imports as a separate quota-aware queue: remote-only previews remain outside `SessionTags` and local AI, and a full device retains pending imports rather than skipping their identities. A crash replays the page idempotently. Deleted remote items mark provider availability; they never delete retained local transcripts or infer deletion from an incomplete listing.

Opaque delta continuations stay in the private catalog, are never displayed or logged, and are accepted only for the configured Graph authority/drive. Provider state and bounded indexes consume the same managed quota as other library metadata.

## Immutable publication and media

Publication writes hash-addressed audio, meeting JSON, manifest and the device commit marker last. Existing immutable paths are accepted only after verifying identical bytes; collisions remain conflicts. Conditional updates are reserved for unavoidable mutable provider bookkeeping, where an ETag mismatch preserves both versions.

Use sequential upload fragments of 10 MiB, with an aligned nonfinal length and the declared total fixed throughout. Recover expected ranges and expiry from the session after interruption; ambiguous final acceptance triggers stable-item lookup and integrity verification before creating another session. Upload URLs are preauthenticated, so fragment PUTs must not carry the Graph bearer header. [Upload-session protocol](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0)

Remote completion moves the revision to provider-confirmed. Graph's SHA-256 property is unsupported; QuickXorHash is not the portable SHA-256 proof. Stream the remote object through the shared SHA-256 verifier, with bounded memory and byte counts, before acknowledging verified publication. Expose that read-back cost and state explicitly. A lost final response or provider outage keeps the only pending copy protected. [Provider hashes](https://learn.microsoft.com/en-us/graph/api/resources/hashes?view=graph-rest-1.0)

Limit transfer concurrency, honor Retry-After on 429 and retain a bounded exponential retry schedule for transient failures. Cancellation/disconnect releases staging after writers stop while retaining immutable pending sources. Remote quota errors remain distinct from local quota blocks. [Graph throttling](https://learn.microsoft.com/en-us/graph/throttling)

Audio download is explicit and streams into quota-reserved private staging; only a complete hash-verified object enters managed media. Local cache eviction never invokes a remote object deletion. Show managed local usage, remote capacity when available, and Microsoft-controlled residency separately; missing remote capacity is unknown. [Drive capacity metadata](https://learn.microsoft.com/en-us/graph/api/resources/drive?view=graph-rest-1.0)

## Validation and unresolved release gates

Synthetic HTTP fixtures must cover duplicate pages/items, malformed continuations, quota pressure, journal acknowledgment faults, 410 rescan, expired sessions, fragment retries, immutable collisions, ETag conflicts, missing hashes, 429, revocation, read-only destinations and disconnect during transfer. Test independent device markers and divergent parent graphs through the real portable service, with offline `SessionTags` consumers after import. Include four-locale settings, keyboard access and distinct permission/quota/provider errors.

Public documentation does not establish real account permissions, cross-device app-root reuse, current signing/installer compatibility or physical-device behavior. Personal and every claimed organizational configuration require explicit synthetic-account probes, including interruption after remote acceptance. M1/M4 Pro, English/Portuguese meetings and macOS 14+ compatibility remain separate acceptance evidence. The current portable schema excludes tasks/chat; no-date task portability requires an explicit later schema extension and cannot be claimed by this connector alone.
