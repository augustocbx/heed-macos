import { useId, useRef, useState } from "react";
import { normalizeTag, tagKey, uniqueTags, type Session } from "@heed/shared";
import { tr, useLocale } from "@/lib/i18n";
import { useSessionsStore } from "@/stores/sessions";
import type { TagCommand } from "@/api/tags";
import styles from "./TagEditor.module.css";

type Mode = { action: "add" } | { action: "rename" | "delete"; tag: string };
export function TagEditor({ session, onTagClick }: { session: Session; onTagClick?: (tag: string) => void }) {
  useLocale();
  const { tagCatalog, tagsBusy, tagsError, mutateTag, loadTags } = useSessionsStore();
  const [mode, setMode] = useState<Mode | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [active, setActive] = useState(-1);
  const id = useId();
  const addRef = useRef<HTMLButtonElement>(null);
  const menuRefs = useRef(new Map<string, HTMLButtonElement>());
  const tags = uniqueTags(session.tags ?? []);
  const choices = tagCatalog.filter(t => !tags.some(tag => tagKey(tag) === tagKey(t.name)) && tagKey(t.name).includes(tagKey(text)));
  const selected = mode && mode.action !== "add" ? tagCatalog.find(t => tagKey(t.name) === tagKey(mode.tag)) : null;
  const close = () => {
    const previous = mode && mode.action !== "add" ? mode.tag : menu;
    setMode(null); setMenu(null); setError(""); setText(""); setActive(-1);
    (previous ? menuRefs.current.get(previous) ?? addRef.current : addRef.current)?.focus();
  };
  const open = (next: Mode) => {
    setMenu(null); setMode(next); setText(next.action === "rename" ? next.tag : ""); setError(""); setActive(-1);
  };
  const run = async (command: TagCommand) => {
    if (tagsBusy) return;
    setError("");
    try { await mutateTag(command); close(); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed to save tags"); }
  };
  const submit = () => {
    if (!mode) return;
    if (mode.action === "delete") return void run({ action: "delete", tag: mode.tag });
    const name = normalizeTag(text);
    if (!name) { setError("Enter a tag name"); return; }
    if (mode.action === "rename") return void run({ action: "rename", tag: mode.tag, name });
    return void run({ action: "add", sessionId: session.id, tag: choices[active]?.name ?? name });
  };
  return <div className={styles.editor} onClick={e => e.stopPropagation()} onKeyDown={e => {
    e.stopPropagation();
    if (e.key === "Escape" && !tagsBusy) { e.preventDefault(); close(); }
  }}>
    <div className={styles.row}>
      {tags.map(tag => <span key={tagKey(tag)} className={styles.chip}>
        <button type="button" aria-label={tr("Filter by {tag}", undefined, { tag })} onClick={() => onTagClick?.(tag)}>#{tag}</button>
        <button type="button" ref={element => { if (element) menuRefs.current.set(tag, element); else menuRefs.current.delete(tag); }}
          disabled={tagsBusy} aria-label={tr("Tag actions for {tag}", undefined, { tag })} aria-expanded={menu === tag}
          onClick={() => { setMenu(menu === tag ? null : tag); setMode(null); setError(""); }}>⋯</button>
      </span>)}
      <button className={styles.add} type="button" ref={addRef} disabled={tagsBusy} onClick={() => open({ action: "add" })}>{tr("Add tag")}</button>
    </div>
    {menu && <div className={styles.panel} role="group" aria-label={tr("Tag actions for {tag}", undefined, { tag: menu })}>
      <button type="button" autoFocus disabled={tagsBusy} onClick={() => open({ action: "rename", tag: menu })}>{tr("Rename tag")}</button>
      <button type="button" disabled={tagsBusy} onClick={() => void run({ action: "remove", sessionId: session.id, tag: menu })}>{tr("Remove from this meeting")}</button>
      <button type="button" disabled={tagsBusy} onClick={() => open({ action: "delete", tag: menu })}>{tr("Delete tag everywhere")}</button>
      <button type="button" disabled={tagsBusy} onClick={close}>{tr("Cancel")}</button>
    </div>}
    {mode && <form className={styles.panel} onSubmit={e => { e.preventDefault(); submit(); }}>
      {mode.action === "delete" ? <p>{tr('Delete "{tag}" from {count} meetings? Meeting content will be kept.', undefined, { tag: mode.tag, count: selected?.meetingCount ?? 0 })}</p> : <>
        {mode.action === "rename" && <p>{tr('Rename "{tag}" in {count} meetings.', undefined, { tag: mode.tag, count: selected?.meetingCount ?? 0 })}</p>}
        <label htmlFor={`${id}-input`}>{tr(mode.action === "add" ? "Tag name" : "New tag name")}</label>
        <input id={`${id}-input`} autoFocus value={text} disabled={tagsBusy} autoComplete="off"
          role={mode.action === "add" ? "combobox" : undefined}
          aria-expanded={mode.action === "add" ? choices.length > 0 : undefined}
          aria-controls={mode.action === "add" ? `${id}-suggestions` : undefined}
          aria-autocomplete={mode.action === "add" ? "list" : undefined}
          aria-activedescendant={mode.action === "add" && active >= 0 && choices[active] ? `${id}-option-${active}` : undefined}
          onChange={e => { setText(e.target.value); setActive(-1); }}
          onKeyDown={e => {
            if (mode.action !== "add" || !choices.length) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault(); setActive(current => e.key === "ArrowDown" ? Math.min(current + 1, choices.length - 1) : Math.max(current - 1, 0));
            }
          }}/>
        {mode.action === "add" && choices.length > 0 && <div id={`${id}-suggestions`} role="listbox" aria-label={tr("Existing tags")} className={styles.suggestions}>
          {choices.map((choice, index) => <button id={`${id}-option-${index}`} key={tagKey(choice.name)} type="button" role="option"
            aria-selected={active === index} disabled={tagsBusy} onClick={() => void run({ action: "add", sessionId: session.id, tag: choice.name })}>{choice.name}</button>)}
        </div>}
      </>}
      <div className={styles.buttons}>
        <button type="submit" disabled={tagsBusy}>{tr(tagsBusy ? "Saving tags…" : mode.action === "delete" ? "Delete tag" : mode.action === "rename" ? "Save" : "Add")}</button>
        <button type="button" disabled={tagsBusy} onClick={close}>{tr("Cancel")}</button>
      </div>
    </form>}
    {(error || tagsError) && <div className={styles.error} role="alert">{tr(error || tagsError)}
      <button type="button" disabled={tagsBusy} onClick={() => void loadTags()}>{tr("Reload tags")}</button>
    </div>}
  </div>;
}
