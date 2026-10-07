"""Exercise simulator fixture ordering without running an installer or services."""
import json
import pathlib
import subprocess
import tarfile
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]


class SimulatorFixtureTest(unittest.TestCase):
    def test_unsupported_checkout_refuses_before_supported_migration(self):
        simulator = (ROOT / "scripts/release/simulate.sh").read_text()
        installer = (ROOT / "scripts/release/install.sh").read_text()
        setup = simulator.split('LEGACY="$SIM_HOME/heed-checkout"\n', 1)[1].split(
            'step "Refusal: checkout predates safe service configuration"', 1)[0]
        migration = simulator.split(
            "# The supported migration fixture has the real configuration and lifecycle helpers.\n", 1)[1].split(
            'step "Fresh release installation', 1)[0]
        predicate = installer.split(
            'HEED_PREVIOUS_ROOT="${HEED_PREVIOUS_DIR:-$HEED_LEGACY_ROOT}"\n', 1)[1].split(
            'if [ -n "$HEED_PREVIOUS_ROOT" ] && [ "$HEED_PRIOR_PORTS_EXISTED"', 1)[0]
        refusal_end = simulator.index('"$SIM/calls-before-legacy-refusal.log" "$SIM/calls.log"')
        self.assertLess(refusal_end, simulator.index("# The supported migration fixture"))

        with tempfile.TemporaryDirectory(prefix="heed-simulator-order-") as temporary:
            directory = pathlib.Path(temporary)
            home = directory / "home"
            legacy = home / "heed-checkout"
            releases = directory / "releases"
            (releases / "v1.2.3").mkdir(parents=True)
            # Use real helper bytes in a tiny local archive so payload extraction is exercised.
            helpers = ["scripts/service_config.py", "scripts/service_runtime.py",
                       "scripts/lifecycle_metadata.py", "config/service-ports.json",
                       "packages/desktop/guard-lifecycle.py"]
            with tarfile.open(releases / "v1.2.3/heed-macos-1.2.3-arm64.tar.gz", "w:gz") as archive:
                for helper in helpers:
                    archive.add(ROOT / helper, arcname="heed-macos-1.2.3-arm64/" + helper)
            environment = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(home),
                           "SIM": temporary, "SIM_HOME": str(home), "LEGACY": str(legacy),
                           "HEED_REPO_ROOT": str(ROOT), "SIM_RELEASES": str(releases), "V1": "1.2.3",
                           "HEED_APP_DIR": str(home / ".heed-app"),
                           "HEED_API_PORT": "48920", "PORT": "48920",
                           "HEED_UI_PORT": "48921", "HEED_TRANSCRIPTION_PORT": "48922"}
            guard = ('HEED_PREVIOUS_ROOT="$LEGACY"\n'
                     'fail() { printf "%s\\n" "$*" >&2; exit 83; }\n' + predicate)

            def run(script):
                return subprocess.run(["/bin/bash", "-euo", "pipefail", "-c", script],
                                      env=environment, capture_output=True, text=True, timeout=10)

            before = run(setup + guard)
            self.assertEqual(before.returncode, 83, before.stdout + before.stderr)
            self.assertIn("The previous checkout predates safe service-port configuration", before.stderr)
            self.assertTrue((legacy / "package.json").is_file())
            for helper in helpers:
                self.assertFalse((legacy / helper).exists(), helper)
            self.assertFalse((home / ".heed-app/service-ports.json").exists())
            existing = {path: path.read_bytes() for path in home.rglob("*") if path.is_file()}

            after = run(migration + guard)
            self.assertEqual(after.returncode, 0, after.stdout + after.stderr)
            for helper in helpers:
                self.assertEqual((legacy / helper).read_bytes(), (ROOT / helper).read_bytes(), helper)
            saved = json.loads((home / ".heed-app/service-ports.json").read_text())
            self.assertEqual(saved, {"version": 1, "api": 48920, "ui": 48921, "transcription": 48922})
            for path, original in existing.items():
                self.assertEqual(path.read_bytes(), original, str(path.relative_to(home)))


if __name__ == "__main__":
    unittest.main()
