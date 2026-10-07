# System audio permission recovery

## Behavior

Settings shows **Recover system audio permission** when the connected menu app reports
system audio unavailable and supports recovery. Recording, transcription, notes, tasks,
chat, imports, migration, synchronization and update maintenance block recovery. Older menu
apps explain that an updated app is required; normal authorization remains available.

The menu app asks for confirmation before any reset. Cancellation acknowledges the request
without changing macOS permissions. After confirmation, a helper verifies the installed bundle,
request, original menu PID and matching API. It acquires the shared installation lock and an
owner-scoped ephemeral processing guard, then invokes only
`/usr/bin/tccutil reset ScreenCapture local.heed.menubar`. It never resets all grants,
changes the TCC database or stops the API/transcription services.

The helper signals the menu to quit normally, waits for the exact original PID and instance
lock to exit, and reopens the same bundle with the pending request ID. The replacement menu
requests ScreenCapture access and opens System Settings. A fresh replacement-instance report
acknowledges the request before the helper releases its own guard. A denied grant is a completed
attempt with unavailable access, never a successful authorization. Failures and timeouts release
only the helper's guard and expose a fixed message without private paths or worker output.

## Automated evidence

- Server bridge tests cover explicit capability, stale and legacy reports, busy processing,
  update maintenance, acknowledgement and actual grant status.
- Client tests cover confirmation guidance, disabled recovery, restart/disconnection polling,
  cancellation, errors and all four interface locales.
- `scripts/service_permission_recovery_test.py` uses isolated temporary bundles and fake OS/API
  adapters. It checks ordering, identity, fixed reset scope, busy rejection, restart failure,
  fresh replacement reports and guard cleanup without touching real privacy grants.
- Native menu self-tests exercise recovery request matching and helper-result parsing; the
  complete Swift menu compiles in the normal Verification workflow.

## Physical Mac acceptance still required

On the affected MacBook Pro with the reviewed build installed:

1. Open Settings with system audio unavailable. Confirm normal authorization remains available.
2. Cancel native recovery confirmation; verify the menu stays open and no grant changes.
3. Start a recording or AI task; verify recovery is disabled and active work continues.
4. With Heed idle, confirm recovery. Verify the menu exits and a single replacement appears,
   macOS requests access, and Settings reflects the fresh actual grant.
5. Decline access once; verify the status remains unavailable and another attempt is possible.
6. Grant access, record a short meeting with headphones, and verify other participants and the
   local microphone in saved playback and final transcription.
7. Verify existing meetings, microphone authorization and other permissions remain intact.

These manual results cannot be inferred from synthetic tests or a successful build. This PR
does not install or reset permissions on the user's Mac. Stable permission identity between
updates remains a separate Developer ID signing and immutable-bundle packaging prerequisite.
