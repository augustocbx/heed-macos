# Issue 71 offline export evidence

## Scope

The acceptance runner exercises the built production interface, actual protected API routes and the module worker, with isolated synthetic meetings and a silent PCM fixture. Browser routing permits only the owned loopback API origin. A local fixture sidecar records requests and rejects any assertion implying a provider generation call. This is export runtime evidence, not physical recording or transcription-quality evidence.

## Two-Mac production runtime

The production runner at `ad29e443b4e92cacd05b74d6576be73aeb0cdf06` generated nine files independently on the MacBook Air M1 (16 GiB) and MacBook Pro M4 Pro (48 GiB): transcript-only short/multi-page/Portuguese PDFs, unknown-notes-only PDF, completed-tasks-only PDF, SRT, two VTTs and a PDF frozen before a later title edit. Independent pypdf 6.1.3 extraction and Poppler rendering verified all nine PDF pages (the long file has four). All nine rendered pages on each Mac were visually inspected for glyphs, margins, fixed font size, reading order, headings and footers. Independent subtitle parsing and native Chromium TextTrack compared cue count, times and decoded literal text, including accents, overlap, markup/entities and arrows.

The run observed zero external requests, zero provider mutation requests, unchanged audio SHA-256 and no browser page errors. Owned workers terminated; download/TextTrack Blob URLs were revoked. Scope changes invalidated preview; an actual title conflict prevented Save; an edit after validation left output frozen; cancellation terminated a live long-PDF worker and navigation remained responsive. Escape restored focus to the persistent meeting control. English, Brazilian Portuguese, French and German dialogs were inspected at 360×740, with native Tab containment and no clipped controls. The API stopped and its port was successfully rebound after cleanup on both Macs. The runner waits for asynchronous default task discovery before choosing scope, then asserts exact selected task IDs, so transcript-only files do not accidentally include default tasks. Both completed runs report nine verified files/nine PDF pages, zero external attempts, zero provider mutations, unchanged retained audio and zero page errors.

The actual HTTP correction/revert/notes/task workflow test passed 31 assertions. It proves hash-ABA rejection through local version, changed task status and reviewed notes conflicts, repeat validation without source/task disk changes, frozen content and audio preservation. A production run also exposed old Google Fonts requests and an action menu below the viewport; both were corrected, with a meaningful failing/then-passing menu regression.

## Remaining final gates

Full reviewed issue 7 integration, final whole-branch verification/review and exact-head CI remain required before merge. The reviewed portable recovery/source-identity changes are integrated; client correction/candidate integration is still pending. This report does not assert those final gates have passed. Public raw artifacts/logs are retained outside tracked source under the controller's QA directory.
