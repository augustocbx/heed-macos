# Contributing

Contributions are welcome through issues and pull requests. Fork this public repository, create a branch in your fork, and open a pull request against `main`.

Only [@augustocbx](https://github.com/augustocbx) can update or merge into the default branch. The repository ruleset enforces this restriction; contributors do not need write access to propose changes.

## Development

Follow [the installation guide](README-macos.md), then run `bun run dev`. Keep recording files, personal transcripts, credentials, and private logs out of commits and issue reports.

Before submitting a change, run the checks relevant to it:

```sh
bun run --cwd packages/client test
bun run build
bun test packages/server/lib
```

For native macOS changes, run `bash packages/desktop/install-menubar.sh --build-only` and the native self-tests described in the source. Installation may require renewing macOS permissions after the app signature changes.

Describe the problem, resulting behavior, and validation in your pull request. Keep documentation, commit messages, and pull requests in English. Application translations support English, Brazilian Portuguese, French, and German with English fallback. Interface language is independent of English/Portuguese speech recognition.

Preserve the original Heed attribution and MIT license. See [CREDITS.md](CREDITS.md).
