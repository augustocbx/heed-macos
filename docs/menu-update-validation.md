# Issue 61 validation

Validation host: MacBookAir10,1, Apple Silicon, macOS 27.0.1. This is one available supported Mac;
validation on another physical Mac remains pending. Fixtures use local versions 0.1.0 and 0.1.1
and synthetic data; no release was published for QA.

| Criterion | Evidence / status |
| --- | --- |
| Stable semantic versions, bounded checks, compatibility and asset integrity | Python release-update tests cover numeric ordering, prereleases/drafts, pagination, offline/rate-limit failures, metadata, digests, sizes and archive safety. |
| Complete processing admission and durable maintenance | Server tests cover asynchronous request lifetime, busy work, restart, ownership and persistence errors. |
| Installation-wide serialization | Real lock/process tests cover concurrent entry points, inherited descriptors, surviving children and uninstall deleting the runtime directory. |
| Production helper contracts | A real loopback HTTP fixture checks the recording-maintenance endpoint and ownership; validated configuration is exercised without injected activity mocks. |
| Recovery state races | Regression tests cover completion while status takes the lock and durable intent before requesting maintenance. |
| Four languages and permission states | Native build/self-tests and bridge tests cover menu states, scheduling, locale coverage and matching-build report expiration. |
| Separate QA app replacement | CLI-triggered local transaction replaced the actual separate QA bundle. The replacement process submitted a fresh matching 0.1.1 report; completion, permission attention and five synthetic data digests passed. Installer, maintenance and services are simulated in this UI fixture. |
| Actual menu initiation | Pending. Computer Use timed out when selecting the separate QA app; no successful click was observed. CLI initiation does not satisfy this criterion. |
| Production coordinator and surviving installer | Release simulation exercises the real installer and services on isolated ports, kills the coordinator after installer handoff, requires the surviving lock, and reconciles the installed build before releasing durable maintenance. Passed in the 66-check release simulation on API 48900, interface 48901 and transcription 48902. |
| Real macOS authorization and capture | Pending. Permission values in fixtures are synthetic. No real Microphone, ScreenCaptureKit, Slack or folder authorization was changed. No real post-upgrade capture/intelligibility claim. |
| Public stable-to-stable upgrade | Pending: local fixture versions do not prove upgrading between two published stable releases. |

Automated checks: 604 server tests, 293 interface tests, interface production build, native menu
self-tests, 70 Python release/helper/transaction tests and shell syntax checks. The CLI dispatch test
also verifies trusted helper copying, detached-worker arguments and inherited lock ownership; a
physical menu-to-worker run remains pending. Exact-head CI status is recorded in the pull request.
CI is separate from physical QA.

## Reproduce the isolated menu fixture

Run `bash scripts/release/menu-update-qa.sh`. It creates a private `heed-menu-qa-*` directory and
launches a bundle with an independent `local.heed.menu-qa.*` identifier. Choose its **Updates →
Update…** action and confirm local version 0.1.1. The command prints fixture verification and stop
commands. Retain needed evidence outside the issue worktree, stop the QA process, and remove only
that generated directory after checking its ownership. The normal Heed bundle cannot enable this
fixture transport; it requires the QA identifier, marker and explicit `--update-qa` argument.

The UI fixture uses no launchd login item, network downloads, production connection state, model
changes or TCC reset. Its synthetic permission report intentionally requires attention. To verify
real authorization, use a supported Mac and let its user complete any macOS prompts, then observe
capture separately from service readiness.

## Release simulation record

Initial runs exposed stale simulation assumptions: the legacy fixture lacked the migrated service
helpers and saved ports, and a packaged native self-test depended on its removed compilation path.
Fixtures now save their isolated ports and include the safe ownership helpers. The native transport
self-test injects synthetic endpoints, so a relocated release binary can run it independently of
the build tree. Foreign listeners were refused and preserved during these failed attempts.

Final simulation passed 66 checks, including the real coordinator/installer interruption and
reconciliation, busy and foreign-port refusal, corrupt downloads, dependency failure, keep-data
removal, reinstall and complete removal. The simulation verified that no owned processes or
listeners remained and no Homebrew package was installed. Recording shims run ahead of Homebrew
in the disposable installer PATH, emulate launchd descriptor isolation, and intercept Keychain,
privacy and preferences changes. The initial direct coordinator call is separate from the native
Process/CLI dispatch test and from the pending real menu click.
