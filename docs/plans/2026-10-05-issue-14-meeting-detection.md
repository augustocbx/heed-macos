# Issue 14: meeting detection implementation

The approved scope is independently configurable Slack, Zoom, Teams and Meet detection using the authoritative recording lifecycle from issue 4. Each detector reports positive active/inactive or unknown evidence with an opaque call identity and monotonic sequence. The server arbitrates ownership; a browser tab cannot own capture/finalization. No app installation, account authorization, real meeting capture or private permission bypass is part of implementation validation.

## Design

- Start after three seconds of fresh positive evidence. End only after five seconds of explicit end evidence. Unknown, stale, inaccessible, minimized, muted or absent toolbar state never confirms an end.
- Persist settings, automatic meeting ownership and manual-stop suppression privately under Heed's data directory. Manual recording never becomes automatic. Disabling an owned detector transfers recording control to the user without stopping.
- Simultaneously detected calls share one capture, ending after every owned call positively ends. Each native application is one aggregate call; changing rooms during reconnect grace retains its opaque identity. A confirmed end/rejoin creates a new identity.
- Keep Slack's existing authorized log parser and regression suite. Observe only new transitions after startup; EOF is not an end signal. Zoom/Teams require explicit Accessibility authorization and exact action-control evidence in one window; an owned window's public destruction event can confirm end. Missing or changed AX controls degrade that detector.
- Meet uses a manually installed Chrome/Edge extension restricted to meet.google.com. It inspects accessible action labels, never page text, credentials, participant names or meeting URLs. Native messaging transports only whitelisted state metadata to loopback. Browser close is explicit end evidence; unobserved browser crash is unknown.
- Publish the supported scope and limitations; do not advertise AX fixtures as physical validation. Zoom's separate Plugin SDK needs registered General App/OAuth and signed libraries and is not bundled by this issue.

## Ordered execution and validation

1. Add failing controller/ownership tests, then implementation and private atomic journal.
2. Add strict loopback HTTP controls and synthetic real HTTP lifecycle tests.
3. Add public AX evidence and identity self-tests; integrate native reporting/settings without browser commands.
4. Add scoped Meet signals, extension/native host and transport tests.
5. Add settings, status, override guidance and English/Portuguese/French/German translations; test save/denial/stale poll behavior.
6. Integrate with merged issue 4; run full server/client tests, production build, native build/self-tests and diff review.
7. Independently review and correct QA findings. Publish physical two-Mac acceptance and macOS-version limitations honestly.
