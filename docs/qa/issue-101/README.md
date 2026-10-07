# Native menu QA — issue #101

This procedure uses a separate, disposable macOS status menu. Its bundle identifier, data, update helper, and instance lock are isolated from the installed Heed app. Screenshots show the real native menu rendering synthetic states; they do not prove physical capture, real service recovery, or macOS permission grants.

## Launch and set a state

From the issue worktree, run `bash scripts/release/menu-update-qa.sh`. Record the printed QA folder and PID. The script compiles the current worktree, builds a private `heed-menu-qa-*` folder, and launches `Heed QA.app`. Do not run `packages/desktop/install-menubar.sh` without `--build-only`: its normal mode changes the installed app. Identify the separate **Heed QA** menu by its tooltip before interacting with it.

Set `HEED_QA_FIXTURE` to the printed QA folder. The menu reads `menu-state.json` every two seconds. Write each scenario atomically, replacing `ready` below with `recording`, `processing`, `unavailable`, or `permissions`, and replacing `en` with `pt-BR`, `fr`, or `de` for locale checks:

```sh
HEED_QA_FIXTURE=/private/var/folders/.../heed-menu-qa-...
/usr/bin/python3 - "$HEED_QA_FIXTURE" ready en <<'PY'
import json, os, pathlib, sys, tempfile
root=pathlib.Path(sys.argv[1]); scenario=sys.argv[2]; locale=sys.argv[3]
control={'recording':False,'processing':False,'seconds':0,'ready':True,
         'clientConnected':True,'pending':False,'uiLocale':locale}
state={'control':control,'fresh':True,'microphone':'authorized',
       'screenCapture':True,'services':[]}
if scenario=='recording':
    control.update(recording=True,meetingId='qa-meeting',seconds=65)
elif scenario=='processing':
    control.update(processing=True,ready=False)
elif scenario=='unavailable':
    state.update(control=None,fresh=False,services=[{'service':'api','port':48870,'state':'unavailable'}])
elif scenario=='permissions':
    state.update(microphone='denied',screenCapture=False)
elif scenario!='ready':
    raise SystemExit('Unknown QA scenario')
with tempfile.NamedTemporaryFile(mode='w',dir=root,delete=False) as file:
    json.dump(state,file); temporary=file.name
os.replace(temporary,root/'menu-state.json')
PY
```

The fixture helper reads the same validated file when generating its synthetic permission report. Without the file, it retains the older `denied` microphone and `false` screen capture defaults. After capturing permission attention, set `ready` again and choose **Settings and permissions → Check permissions again** in the QA menu to demonstrate warning clearance. This simulates a permission change; it never changes macOS Privacy settings. Invalid JSON or invalid permission values must be corrected before rechecking.

## Capture and compare

Capture the actual menu while it is open. Read its Accessibility `position` and `size`, then use `/usr/sbin/screencapture -x -R x,y,width,height /path/to/capture.png` to capture only that menu frame. Do the same for a submenu or native alert, and inspect every image before adding it to the repository. Record the Mac model, macOS version, physical resolution, “Looks like” scaling, locale, QA binary commit and hash, scenario, and whether keyboard or VoiceOver interaction was actually tested. Capture both the main menu and relevant submenus, including the permission blocker beside disabled **Start recording**. Exercise keyboard navigation and VoiceOver separately; a screenshot alone does not establish either behavior. The observed results and cropped before/after images are in [the validation record](validation.md).

The unmodified pre-change binary does **not** read `menu-state.json`, so merely launching it cannot produce seven before-state screenshots. For a reproducible, test-only baseline, extract the exact pre-change commit and apply [the baseline instrumentation patch](baseline-instrumentation.patch). It adds only isolated scenario inputs to the old menu; it does not change its layout or readiness rules:

```sh
BASELINE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/heed-menu-baseline-XXXXXX")
git archive a4a0e982704a43d7381a9cbdfcf7b425b811cee6 packages/desktop/macos | tar -x -C "$BASELINE_DIR"
patch -d "$BASELINE_DIR" -p1 < docs/qa/issue-101/baseline-instrumentation.patch
swiftc -target arm64-apple-macosx14.0 "$BASELINE_DIR"/packages/desktop/macos/*.swift -o "$BASELINE_DIR"/Heed -framework AppKit
"$BASELINE_DIR"/Heed --self-test
/usr/bin/python3 scripts/release/menu_update_qa.py prepare "$BASELINE_DIR"/Heed
```

Launch only the resulting `Heed QA.app/Contents/MacOS/Heed --update-qa <QA folder>` with `HEED_HOME=<QA folder>/home/.heed` and `HEED_APP_DIR=<QA folder>/home/app`, then use the same scenario file as above. Record the old commit, patch hash, binary hash, and QA bundle ID; label every baseline capture **instrumented baseline**, not production behavior. The wrapper script has no older-binary option and builds the current checkout into a shared `${TMPDIR:-/tmp}/heed-menubar-build/Heed`; use separate build directories or serialize builds. Both bundles display synthetic fixture versions 0.1.0→0.1.1 regardless of their source commit. Remove only the private baseline and QA folders after retaining the evidence. Never label fixture screenshots as production behavior.

The fixture update action supplies the available, installation, completed, and permission-attention views. Installation can finish too quickly for a reliable in-progress screenshot; record that state as unverified unless it is visibly captured. The seven requested scenario labels are ready idle, recording, saving/processing, service unavailable, update in progress, update completed, and permission attention. Check the console and observed menu before assigning each label; switching a fixture file does not itself prove the native menu refreshed.

Run the printed `verify` command after the synthetic update to check replacement, a fresh report, and retained data. Save evidence outside the disposable QA folder. Run its printed `stop` command, confirm that only its QA PID exited, and remove that private folder after preserving needed screenshots and logs. Leave the installed Heed app, its services, and all real authorization settings untouched.
