# Offline synchronization AI acceptance

Run the opt-in harness with an already installed, compatible local completion model:

```sh
bun scripts/check-synchronization-offline-ai.ts \
  --model INSTALLED_MODEL \
  --output /private/tmp/heed-offline-report.json \
  --fixture-root /private/tmp/heed-offline-fixture
```

Both paths must be new, outside the checkout, and their parents must be physical directories. The harness exclusively creates a public English/Portuguese fixture, commits its imports through `PortableLibrary`, disables its synthetic provider, and reconstructs the library and chat stores. It uses production meeting chat, label chat, current-revision citation validation, and the same structured local generation settings as the server. It never reads installed meeting content, downloads a model, or changes the personal application.

The report records source commit and selected source hashes, model, language, required decision/correction facts, exact current-revision citation checks, label exclusion, missing facts, and provider request count after disable. Correction success requires a closed affirmative fixture assertion and the exact supporting correction quote; an unrecognized paraphrase requires review instead of an automatic pass. Merely mentioning 43 does not validate the approved budget. Model failures remain observed gaps. Passing these cases does not establish general model accuracy. The fixture's source is explicitly seeded in memory; this proves durable offline use of production imports, not real SMB/iCloud replication, physical recording, or archived-audio availability.

The public fixture includes corrected English/Portuguese text, manual speaker names, labels, notes, summary, model/language provenance, ancestry, and a deterministic stereo WAV. `comparePortableRevision` compares those fields and optional observed audio hashes without echoing meeting content in its differences. Actual provider round trips must independently establish the observed artifacts and audio bytes.

The harness stops its own chat requests before deleting the directory using its original creation receipt. `--keep-fixture` retains the public fixture. Failed or unverified cleanup retains the directory for inspection. The local model server is outside fixture ownership and remains running. Public reports and generated fixture directories stay outside Git.
