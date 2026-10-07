# Issue 71 offline export evidence

## Scope

The acceptance runner exercises the built production interface, actual protected API routes and the module worker, with isolated synthetic meetings and a silent PCM fixture. Browser routing permits only the owned loopback API origin. A local fixture sidecar records requests and rejects any assertion implying a provider generation call. This is export runtime evidence, not physical recording or transcription-quality evidence.

## MacBook Air M1 preliminary runtime

The current production runner generated nine files: transcript-only short/multi-page/Portuguese PDFs, unknown-notes-only PDF, completed-tasks-only PDF, SRT, two VTTs and a PDF frozen before a later title edit. Independent pypdf 6.1.3 extraction and Poppler rendering verified all nine PDF pages (the long file has four). Every page was visually inspected for glyphs, margins, fixed font size, reading order, headings and footers. Independent subtitle parsing and native Chromium TextTrack compared cue count, times and decoded literal text, including accents, overlap, markup/entities and arrows.

The run observed zero external requests, zero provider mutation requests, unchanged audio SHA-256 and no browser page errors. Owned workers terminated; download/TextTrack Blob URLs were revoked. Scope changes invalidated preview; an actual title conflict prevented Save; an edit after validation left output frozen; cancellation terminated a live long-PDF worker and navigation remained responsive. Escape restored focus to the persistent meeting control. English, Brazilian Portuguese, French and German dialogs were inspected at 360×740, with native Tab containment and no clipped controls. The API stopped and its port was successfully rebound after cleanup.

The actual HTTP correction/revert/notes/task workflow test passed 31 assertions. It proves hash-ABA rejection through local version, changed task status and reviewed notes conflicts, repeat validation without source/task disk changes, frozen content and audio preservation. A production run also exposed old Google Fonts requests and an action menu below the viewport; both were corrected, with a meaningful failing/then-passing menu regression.

## Remaining final gates

Full reviewed issue 7 integration, final whole-branch verification/review, exact-head CI, MacBook Pro M4 Pro runtime and corresponding page inspection remain required before merge. This preliminary report does not assert those gates have passed. Public raw artifacts/logs are retained outside tracked source under the controller's QA directory.
