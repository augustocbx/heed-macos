# Credits

## Offline export dependencies

Selective PDF exports use [pdf-lib 1.17.1](https://github.com/Hopding/pdf-lib) and [@pdf-lib/fontkit 1.1.1](https://github.com/Hopding/fontkit), distributed under the MIT license. Independent subtitle QA uses the dev-only MIT [subtitle 4.2.2](https://github.com/gsantiago/subtitle.js) parser.

The bundled static Noto Sans Regular and Bold fonts are from the official [Noto Sans 2.015 release](https://github.com/notofonts/latin-greek-cyrillic/releases/tag/NotoSans-v2.015), copyright 2022 The Noto Project Authors, licensed under the SIL Open Font License 1.1. Their complete license, exact source and SHA-256 hashes are included in `packages/client/src/lib/export/fonts/`. The application loads these local assets; no font CDN is used.

## Original project

**Heed** was created by **Junior Rodriguez (@isjunrod)**. This macOS adaptation is based on his open-source work and retains its local transcription, speaker diarization, saved meetings, and AI notes foundation.

- Original project: [isjunrod/heed](https://github.com/isjunrod/heed)
- Original author: [Junior Rodriguez](https://github.com/isjunrod)
- Original license: [MIT License](LICENSE)
- Preserved copyright: Copyright (c) 2026 Junior Rodriguez

## macOS adaptation

This repository, [augustocbx/heed-macos](https://github.com/augustocbx/heed-macos), maintains the macOS installation and additional menu bar controls, Slack meeting automation, permission guidance, local audio retention, transcript playback, manual transcription controls, and interface localization described in the README.

Credit for the original project and its code remains with the upstream author and contributors. The original license and copyright notice are preserved without replacement.
