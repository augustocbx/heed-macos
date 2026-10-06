# OneDrive portable meeting storage

The connector uses Microsoft Graph directly. It does not require the OneDrive desktop sync client. It supports explicitly selected libraries immediately inside the application's `approot`; it does not claim arbitrary folders, shared shortcuts, sovereign Graph clouds, or SharePoint site selection.

## Register and connect

1. Register a **public desktop application** in Microsoft Entra. Choose the supported account audience appropriate to the registration and use the same application client ID on both Macs.
2. Register `http://localhost/oauth/callback` as the desktop redirect. Heed listens only on IPv4 loopback and uses an ephemeral port, one-use state, and PKCE S256. Do not create or enter a client secret.
3. Grant delegated `Files.ReadWrite.AppFolder`. Heed also requests `openid` and `offline_access`. No broader file/site grant is added automatically.
4. In Settings → Microsoft OneDrive, enter the public client ID, choose the account audience, and select **Authorize Microsoft account**. Microsoft owns credential entry in the browser.
5. Browse app-folder libraries. Select an existing versioned Heed library, initialize an explicitly selected empty app folder, or create a new named library. Other contents are preserved; occupied unversioned folders cannot be initialized.
6. Select the library. Local meeting uploads are **off by default**. Enable the upload checkbox explicitly to publish local finalized meetings to that destination. The generic portable-library controls remain available for manual publication and transcript import.

App-folder permission documentation includes personal, work/school and SharePoint drives, but its delegated grant is preview and the generic delta/upload permission tables list broader grants. Before enabling a destination, Heed checks the actual selected account's app-root, scoped delta, resumable upload, and streamed read-back. This reuses a deterministic, versioned public connector-check object per destination without meeting content. It remains in the selected library; the connector never automatically deletes remote objects. Unsupported grants fail closed and require a supported configuration; a successful authorization alone does not prove full connector support. Organizational policy can still deny individual operations later.

A work account's default OneDrive app root may work when these checks succeed. This connector does not offer a SharePoint site/drive chooser or claim that every tenant and document library is supported. Microsoft controls remote capacity, storage region and residency. Heed displays remote capacity when available and never treats missing capacity as free space or as the local quota.

## Data and durable states

Complete transcript, notes, title, tags and speaker metadata enter the local session store only after validated immutable artifacts have been committed under the managed local quota. Remote-only previews remain outside local AI. Audio stays remote until requested, then streams into reserved staging and becomes playable only after SHA-256 verification. Portable schema v1 does not export tasks, chats, credentials, embeddings or absolute paths.

Publication writes hash-addressed audio, meeting JSON and the manifest before a separate immutable device commit marker. Existing conflicting content is preserved. Local persistence, pending upload, provider completion and verified publication remain separate states. Microsoft does not expose the portable SHA-256 proof, so confirmation performs a full streamed remote SHA-256 read-back. This adds network traffic proportional to the verified objects; it does not buffer an entire audio file in memory.

Transfers use sequential 10 MiB fragments, fixed total lengths and aligned nonfinal fragments. Expired sessions, expected offsets, 416 responses, ambiguous final acceptance and restarts are recovered using durable private journals and stable remote identities. A completed provider response alone is not verification. Partial discovery retains prior entries. Delta checkpoints advance only after the shared library durably acknowledges complete validated discovery; replay is idempotent. Remote deletions never delete retained transcripts or automatically restore meetings explicitly deleted on this Mac.

Pending sources and unpublished eligible audio are protected from local cleanup. Provider metadata and staging consume the managed library budget; OAuth device preferences and protected credentials do not. Local quota, remote quota, authorization, unsupported grant and throttling failures remain distinct. Automatic retries respect bounded exponential backoff and Microsoft Retry-After. The connector uses the shared exclusive library lease across each whole background tick and across awaited configuration/authorization changes. Requests carry the expected connection and configuration generations to reject stale tabs.

## Pause and disconnect

Pause disables background synchronization. Disconnect first stops its jobs and removes the selected provider registration, then invalidates account credentials on this Mac. Upload-session URLs and tokens are stored only in the nonsynchronizing native Keychain helper; durable files contain opaque UUID references. Selection and configuration changes persist a transition intent until both connector state and the shared provider preference are committed. Failed changes restore the prior state; an unresolved rollback blocks synchronization, cached provider access, and startup recovery while protecting all finalized audio. Preserve the private configuration for recovery.

A locked/unavailable vault leaves explicit credential-cleanup state and retains references for retry. Local transcripts and remote immutable history remain available; there is no remote-delete call.

Local disconnect does not revoke Microsoft application consent globally. Remove the application's consent separately through your personal Microsoft account or your organization's application permissions controls. Reconnect with the same application and library to resume durable identities. Before any read or publication, the connector verifies the current account's app root, selected folder ancestry and destination header; a different account cannot silently use the old destination.

## Validation boundaries

Automated tests use synthetic OAuth, Graph and Keychain protocols, real loopback HTTP routing, isolated app directories, valid WAV fixtures and the actual portable store/quota services. They cover scoped deltas, duplicate IDs, rename ancestry, 410 rescan, checkpoint replay, interrupted/resumed uploads, 416, ambiguous acceptance, SHA-256 corruption, ETag conflict, remote capacity failure, local quota preservation, stale tabs, mutation leases, optional-config corruption and lazy second-device audio.

No Microsoft registration, actual account connection, private upload or interactive Keychain item was used for automated validation. Personal-account and each organizational configuration require the capability checks above on the user's explicitly connected account. Physical M1/M4 Pro capture, macOS permission/signing behavior, English/Portuguese meeting quality and an interrupted real two-Mac transfer remain manual acceptance gates. These are not established by green CI.

Official contracts checked for this implementation: [app folders](https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder), [desktop authorization](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [localhost redirects](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url#localhost-exceptions), [delta](https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0), [resumable uploads](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0), [provider hashes](https://learn.microsoft.com/en-us/graph/api/resources/hashes?view=graph-rest-1.0), [throttling](https://learn.microsoft.com/en-us/graph/throttling).

Private connector files use bounded, no-follow regular-file reads. Authorization durably reserves an opaque credential reference before writing the new Keychain entry; interrupted activation retains that reference for retirement on the next explicit authorization or disconnect. Disconnect keeps a durable settings intent and source-audio protection until account invalidation and the settings commit finish. A persistence failure restores the still-authorized prior selection when possible; ambiguous credential or rollback failures preserve the intent and require recovery, retaining finalized source audio.
