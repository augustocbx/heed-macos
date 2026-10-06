# Automatic meeting detection

Enable each application separately in **Settings → Automatic meeting detection**, or from the Heed menu bar. Zoom, Teams and Meet start disabled. Existing Slack preferences migrate when the menu application reconnects. Capture still requires microphone/system-audio authorization, a ready transcription model and the recording helper. English live preview and final language detection use the normal recording lifecycle.

Detection does not need an open Heed browser tab. An app being open, a microphone being busy, silence, headphones or a calendar event is never a join signal.

## Capability matrix

| Application | Implemented signal | Authorization | Supported scope and limitations |
| --- | --- | --- | --- |
| Slack desktop | Existing native log STARTED/ENDING/NOT_STARTED transitions; process termination | User-selected exact Slack logs folder if macOS denies access | New transitions only, never historical calls at startup. Slack logs are a private, version-dependent format; unknown/read failures pause detection. |
| Zoom desktop | Public macOS Accessibility APIs: leave/end, microphone and camera controls in the same window; exact owned window destruction or explicit after-call control | Heed Accessibility in System Settings | Scoped to `us.zoom.xos`; English, Brazilian Portuguese, French and German action-label fixtures. This is UI-format-dependent, **not the Zoom Plugin SDK**. Hidden controls or changed hierarchy are unknown. Physical app/version acceptance remains required. |
| Teams desktop | Same strict AX evidence and exact owned call window destruction | Heed Accessibility in System Settings | Scoped to `com.microsoft.teams2` and `com.microsoft.teams`. Each application is one aggregate call; overlapping windows within the same app are not separately identified. No Graph presence inference, private logs or credentials. Physical app/version acceptance remains required. |
| Google Meet | Leave/microphone/camera accessible button labels, explicit after-call controls; browser tab close | Optional extension with host access only to `https://meet.google.com/*`; user-specific native host registration | Chrome and Edge Manifest V3. Top-level tabs only; each tab has an independent opaque identity. No Safari/Firefox support. A reload retains identity when tab session storage is available; the extension persists bounded opaque sequence metadata across browser restarts. A killed browser/extension or lost native host is unknown, requiring manual stop. Physical browser/DOM acceptance remains required. |

The action labels are inferred observable evidence, not stable vendor call-state APIs. A ready detector report means its configured signal was readable at that moment; it does not certify every vendor version. **Enabled**, **not checked**, **permission needed**, **detection unavailable**, and **paused for this call** are distinct statuses. When a vendor changes its UI, use manual recording and report the app version/UI language without private meeting content.

## Timing and ownership

Heed confirms a join after **3 seconds** of positive evidence. A positive end waits **5 seconds** for a reconnect; returning in that interval keeps the same call. Lost permission, hidden controls, minimization, unrelated window close, screen sharing and silence never prove an end. A missing heartbeat becomes unknown after **15 seconds**. Sleep/wake or a network outage can therefore require a manual stop until fresh positive signals return.

Overlapping enabled sources share one automatic capture. It ends once every source that joined that capture has positively ended. If a call switches rooms within the grace interval, the recording continues; after a fully confirmed end, rejoining creates a new call. Each desktop app is an aggregate source, so simultaneous calls in multiple windows of the same application cannot be distinguished.

A manual recording is never stopped by automation. Stopping an automatic recording manually suppresses every currently active detected call, and that suppression survives backend/menu restarts. Rejoin after a confirmed end to permit another automatic recording. Disabling an owning detector transfers the existing recording to manual control and **leaves it running**. There is no automatic pause/resume audio control in this issue; issue 12 owns that feature.

Readiness waits do not spend retries. A failed start gets at most three attempts per call, five seconds apart. Check the displayed error, authorize the capture source/model, and record manually if the call remains suppressed or retries are exhausted. A restart with retained audio uses normal recording recovery; it never silently resumes capture. A state-write failure rolls back settings/ownership and disables automation until storage is fixed and detection is reconfigured. A capture that cannot save automatic ownership stays under manual control.

## Accessibility setup

1. Open the Heed menu application and enable Zoom or Teams detection.
2. Choose **Authorize Accessibility** in Heed Settings or the menu bar. macOS asks explicitly; enable **Heed** under System Settings → Privacy & Security → Accessibility.
3. Join a real test call and keep its call controls exposed. Confirm Heed shows actual recording; then leave and confirm processing/saved session. If controls are hidden or unavailable, stop manually.

Heed reads action-control labels from the allowlisted conferencing apps. It does not invoke AX actions, read text values, retain chat/participant text, inspect other apps or bypass permission. macOS grants Accessibility broadly; the implementation scopes use to these apps. An upgrade/re-sign can require renewed authorization.

## Optional Meet setup

This extension is not silently installed by Heed. Use a stable checkout that you retain after updating.

1. In `chrome://extensions` or `edge://extensions`, enable Developer mode and load unpacked **packages/desktop/browser-meet** from that checkout. Grant its Meet-only access.
2. Copy the extension's 32-character ID from the Extensions page. Register only that extension:
   ```sh
   /usr/bin/python3 packages/desktop/browser-meet/register-host.py chrome EXTENSION_ID
   # For Edge use: register-host.py edge EXTENSION_ID
   ```
3. Restart/reload the extension, enable Google Meet in Heed Settings, then open a new Meet tab. Existing already-open tabs may need a refresh once after installation.
4. An extension badge `!` means the native host or local service failed. Open Heed, confirm host registration points to the retained checkout, then reload the extension. A disconnected bridge does not end a recording; stop manually.

Registration creates a user-specific manifest with one exact allowed extension origin and a host path. It changes no account, browser credentials, capture permission or other extension. To remove it, remove the extension and its `local.heed.meet.json` in the browser's user-specific `NativeMessagingHosts` directory. Do not remove other host manifests. Browser data cleared/disabled session storage can lose a call identity; stop manually before refreshing in that case. Navigating away without closing a tab is unknown unless an explicit after-call control was observed.

Closed sources retire after end confirmation. Unknown browser sources without recording ownership retire after 60 seconds without claiming a call ended. Recent opaque sequence tombstones and extension counters are bounded to 256; live sources are limited to 128. No meeting URLs or content are persisted in those registries.

## Vendor interfaces

Apple documents [AX attribute access and trust APIs](https://developer.apple.com/documentation/applicationservices/1462060-axuielementcopyattributevalues). Microsoft documents the [Teams call controls and Leave button for Mac screen readers](https://support.microsoft.com/en-us/accessibility/teams/quick-start-guide-using-microsoft-teams-with-a-screen-reader). Google documents the [Meet Leave call accessibility control](https://support.google.com/meet/answer/15738543?hl=en). Chrome documents [native messaging, origin validation and user host registration](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).

Zoom now offers an external-client [Plugin SDK for macOS](https://developers.zoom.us/docs/plugin-sdk/macos/) and [official lifecycle guidance](https://github.com/zoom/skills/blob/main/skills/plugin-sdk/macos/SKILL.md). It requires a Marketplace General app with Plugin SDK enabled, user OAuth scope `plugin_sdk:read:connection_meta`, a compatible Zoom Workplace client and signed SDK dependencies. Heed does not register an app, accept pasted tokens or bundle those libraries. The embedded Meeting SDK and remote webhooks do not observe an arbitrary already-running local desktop client. A future authenticated Plugin SDK adapter should replace AX only after app registration, supported package/version and real user acceptance are available.

## Acceptance evidence and remaining physical checks

Automated validation uses synthetic state/AX label fixtures, isolated HTTP controllers, native-message framing and client save/error regressions. Native self-tests build for arm64 macOS 14. These tests do not prove real capture quality, vendor Accessibility hierarchies or browser DOM compatibility.

Before claiming physical acceptance, use both the MacBook Air M1 and MacBook Pro M4 Pro on their current macOS 27.0.1. For each enabled app/browser test join, leave, host end, network drop/rejoin shorter and longer than grace, room switch, app crash, sleep/wake, minimized/shared-screen state, headphones and permission revocation. Check two Meet tabs, manual recording/manual stop, menu/backend restart, retained-audio recovery and one saved finalization. Exercise the four UI locales and English/Portuguese meeting content. No private recording or account authorization is performed during code validation. Test macOS 14 separately; the compilation target alone is not runtime proof.
