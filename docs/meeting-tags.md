# Meeting tags

Manage tags inline in a meeting card or in meeting detail. No separate tag-management page is needed.

- **Add tag** opens an inline field. Type a new name and press Enter or Add, or search the suggestions and select an existing tag. Several tags can be assigned to one meeting.
- Click a tag to filter the meeting library. Text search combines with the selected tag. Clicking a tag in detail returns to the filtered library.
- Open the tag's **⋯** actions and choose **Rename tag** to edit its name inline. The message shows how many meetings use it. Save renames it in every affected meeting; Cancel discards the edit.
- **Remove from this meeting** detaches the tag only from that meeting.
- **Delete tag everywhere** shows the tag name and affected meeting count before confirmation. It removes the tag's assignments from every meeting and keeps the meetings, transcripts, notes and audio.

All controls work with the keyboard. Use Tab to reach actions, arrow keys to select an inline suggestion, Enter to save, and Escape or Cancel to dismiss the current editor. Interface controls are available in English, Brazilian Portuguese, French and German. Tag names are user-authored and never translated.

## Names and existing data

Names support Unicode, accents, spaces and hyphens. Leading/trailing whitespace is removed, internal whitespace is collapsed to one space, and Unicode is normalized to NFC. Display case is preserved. Duplicate matching uses normalized lowercase keys and does not remove accents: `Planning` and `planning` identify the same reusable tag, while `Reunião` and `Reuniao` remain distinct.

Empty names are rejected. Selecting an already assigned tag does not duplicate it. Renaming a tag to the name of another existing tag reports an error instead of merging their assignments. Case-only renaming is allowed. Historical spelling variants remain readable; a global rename changes every matching variant together.

The existing `#tag` title shortcut still works, including accented single-word hashtags such as `#reunião`. Use the inline editor for names containing spaces. Existing session JSON files and their `tags` arrays remain the storage model.

## Saving and concurrent editing

Saved tags change only after the server confirms the operation. Failed saves show an inline error and retain unsaved input. A revision conflict refreshes the saved tags; inspect the current state, then retry your edit. Reload tags is also available next to errors. Returning focus to the application refreshes tags changed in another tab.

Assignment replacements carry an assignment-only revision. Global operations carry a library tag revision. Unrelated notes, speaker and transcription edits do not invalidate a tag revision and write only their intended metadata.

Global edits stage all original and replacement JSON in a hidden `.tag-transaction` journal before changing any meeting file. Synchronous commits cannot interleave within the server process. A failed or interrupted uncommitted transaction restores originals before session CRUD continues. If recovery cannot finish, requests fail instead of exposing partially updated tags. Automatic notes use the same persistence layer and reread current assignments for progress and completion. If a storage failure interrupts generation, the idle worker resumes the same job after recovery. Keep a single Heed server process per local library.

## Validation

Automated tests cover normalization, legacy data, global versus assignment-only scope, collisions, revision conflicts, disk failure/restart recovery, stale client responses, inline keyboard interaction, filtering, title shortcuts and all four interface locales. A Chrome smoke test used synthetic meetings and the production interface plus tag/session handlers; recording, ASR and AI services were not started.

Physical acceptance on both the MacBook Air M1 and MacBook Pro M4 Pro, and the full macOS 14+ version range, remains separate from these automated checks. The installed application is not changed by this pull request.
