# macOS compatibility

Heed requires Apple Silicon and macOS 14 or later. This is the declared minimum, separate from validation on individual Macs and OS releases.

## Build requirements

The native transcription and capture package declares macOS 14 in `packages/transcription/native/heed-parakeet/Package.swift`. The menu app compiles for `arm64-apple-macosx14.0` and declares `LSMinimumSystemVersion` as `14.0`. The app bundle and native build targets therefore use the same minimum as the installation documentation.

Build the menu app without installing or launching it with:

```sh
bash packages/desktop/install-menubar.sh --build-only
```

This compiles the menu app and runs its self-tests. It does not grant recording permissions, start services, test actual audio capture, or prove runtime compatibility with every macOS 14+ release. The build reports its temporary executable path; inspect that executable's `LC_BUILD_VERSION` with `otool -l` to check the deployment target.

## Physical acceptance

The MacBook Air M1 and MacBook Pro M4 Pro have been reported as running macOS 27.0.1. Physical automatic-notes acceptance remains pending on both machines. Their reported OS versions are not evidence of validation on macOS 14, 15, or other releases.

For each tested machine and OS version, record the hardware, macOS version/build, Heed commit, Ollama version, and installed local model. Run English and Brazilian Portuguese meetings, check the four interface locales, and verify capture/transcription priority, memory pressure and responsiveness, model unload, missing-model/Ollama-stop retry, refresh, and installed-app crash/restart recovery. Review generated decisions and actions against the final transcript, including uncertainty and missing owners/deadlines. Use synthetic meeting content and retain personal recordings and logs outside the repository.

Passing automated tests or a build targeting macOS 14 establishes neither those physical outcomes nor a complete supported-OS test matrix. See [automatic-notes behavior and validation limits](automatic-notes.md).
