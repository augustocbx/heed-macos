import { useCallback, useEffect, useState } from 'react';
import type { AutomaticNotesSettings as Settings, NotesLanguagePolicy, Template } from '@heed/shared';
import { automaticNotesApi } from '@/api/automaticNotes';
import { templatesApi } from '@/api/templates';
import { useLocale } from '@/lib/i18n';
import styles from './AutomaticNotes.module.css';
const defaults: Settings = { enabled: false, templateId: 'general', model: null, language: 'meeting' };
export function AutomaticNotesSettings() {
 const { tr } = useLocale();
 const [settings, setSettings] = useState<Settings>(defaults);
 const [models, setModels] = useState<string[]>([]);
 const [templates, setTemplates] = useState<Template[]>([]);
 const [loading, setLoading] = useState(true);
 const [saving, setSaving] = useState(false);
 const [error, setError] = useState<string | null>(null);
 const [saved, setSaved] = useState(false);
 const [loaded, setLoaded] = useState(false);
 const load = useCallback(async () => {
  setLoading(true); setError(null);
  try {
   const [configuration, installed, available] = await Promise.allSettled([automaticNotesApi.settings(), automaticNotesApi.models(), templatesApi.list()]);
   if (configuration.status === 'fulfilled') { setSettings(configuration.value); setLoaded(true); }
   if (installed.status === 'fulfilled' && Array.isArray(installed.value.models)) setModels(installed.value.models);
   else setModels([]);
   if (available.status === 'fulfilled' && Array.isArray(available.value)) setTemplates(available.value);
   else setTemplates([]);
   if (configuration.status === 'rejected' || installed.status === 'rejected' || available.status === 'rejected' || (installed.status === 'fulfilled' && !Array.isArray(installed.value.models)) || (available.status === 'fulfilled' && !Array.isArray(available.value))) {
    setError('Could not load automatic notes settings. Start Ollama and retry.');
   }
  } catch { setError('Could not load automatic notes settings. Start Ollama and retry.'); }
  finally { setLoading(false); }
 }, []);
 useEffect(() => { void load(); }, [load]);
 const valid = !!settings.model && models.includes(settings.model) && templates.some(template => template.id === settings.templateId);
 const change = (patch: Partial<Settings>) => { setSettings(current => ({ ...current, ...patch })); setSaved(false); };
 const save = async () => {
  setSaving(true); setError(null); setSaved(false);
  try { setSettings(await automaticNotesApi.saveSettings(settings)); setSaved(true); }
  catch { setError('Could not save automatic notes settings. Check the installed model and template, then retry.'); }
  finally { setSaving(false); }
 };
 return <article className={styles.settings} aria-labelledby="automatic-notes-heading">
  <h2 id="automatic-notes-heading">{tr('Automatic meeting notes')}</h2>
  <p>{tr('Generate notes locally after the final transcript is saved. Existing meetings are not changed.')}</p>
  <label className={styles.toggle}><input type="checkbox" checked={settings.enabled} disabled={loading || saving || !loaded || (!settings.enabled && !valid)} onChange={event => change({ enabled: event.target.checked })}/>{tr('Generate notes automatically')}</label>
  <div className={styles.fields}>
   <label>{tr('Local notes model')}<select value={settings.model || ''} disabled={loading || saving || !loaded} onChange={event => change({ model: event.target.value || null })}>
    <option value="">{tr('Choose an installed local model')}</option>
    {settings.model && !models.includes(settings.model) && <option value={settings.model}>{settings.model} — {tr('Not installed')}</option>}
    {models.map(model => <option key={model} value={model}>{model}</option>)}
   </select></label>
   <label>{tr('Notes template')}<select value={settings.templateId} disabled={loading || saving || !loaded} onChange={event => change({ templateId: event.target.value })}>
    {!templates.some(template => template.id === settings.templateId) && <option value={settings.templateId}>{tr('Choose a notes template')}</option>}
    {templates.map(template => <option key={template.id} value={template.id}>{tr(template.name)}</option>)}
   </select></label>
   <label>{tr('Notes language')}<select value={settings.language} disabled={loading || saving || !loaded} onChange={event => change({ language: event.target.value as NotesLanguagePolicy })}>
    {(['meeting', 'en', 'pt', 'fr', 'de'] as const).map(language => <option key={language} value={language}>{tr(({ meeting: 'Meeting language', en: 'English', pt: 'Portuguese', fr: 'French', de: 'German' })[language])}</option>)}
   </select></label>
  </div>
  {!loading && !valid && <p>{tr('Choose an installed local model and a template before enabling automatic notes.')}</p>}
  {error && <p role="alert">{tr(error)}</p>}
  {loading && <p role="status">{tr('Loading automatic notes settings…')}</p>}
  {saved && <p role="status">{tr('Automatic notes settings saved.')}</p>}
  <div className={styles.actions}>
   <button disabled={loading || saving || !loaded || (settings.enabled && !valid)} onClick={() => void save()}>{tr(saving ? 'Saving…' : 'Save automatic notes settings')}</button>
   <button disabled={loading || saving} onClick={() => void load()}>{tr('Retry loading')}</button>
  </div>
 </article>;
}
