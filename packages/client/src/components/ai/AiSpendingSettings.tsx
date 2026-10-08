import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { AiBudgetPolicy, AiPreset } from '@heed/shared';
import { ApiError } from '@/api/client';
import { useLocale } from '@/lib/i18n';
import { parseUsdDraft, usdDraft } from './ai-money';
import styles from './AiSpending.module.css';

export interface AiSpendingSettingsProps {
 policy: AiBudgetPolicy;
 /** Resolves with the persisted authoritative policy, not the submitted draft. */
 onSave: (policy: AiBudgetPolicy) => Promise<AiBudgetPolicy>;
 presets?: readonly AiPreset[];
}
const draftOf = (policy: AiBudgetPolicy) => ({ job: usdDraft(policy.jobLimitMicroUsd), period: usdDraft(policy.periodLimitMicroUsd), days: String(policy.periodDays), attempts: String(policy.maxRemoteAttempts), anchor: policy.periodStart, unknown: policy.unknownCost });
const policyKey = (policy: AiBudgetPolicy) => [policy.jobLimitMicroUsd, policy.periodLimitMicroUsd, policy.periodDays, policy.periodStart, policy.maxRemoteAttempts, policy.unknownCost].join('|');
type Draft = ReturnType<typeof draftOf>;
type Field = 'job' | 'period' | 'days' | 'attempts';
function safeUrl(value: string): string | undefined {
 try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
export function AiSpendingSettings({ policy, onSave, presets }: AiSpendingSettingsProps) {
 const { locale, tr } = useLocale(); const id = useId(); const form = useRef<HTMLFormElement>(null);
 const [draft, setDraft] = useState(() => draftOf(policy));
 const confirmedAnchor = useRef(policy.periodStart);
 const key = policyKey(policy);
 const authority = useRef({ key, revision: 0 });
 const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
 const [failure, setFailure] = useState<string | null>(null); const [periodFailure, setPeriodFailure] = useState(false);
 const [saving, setSaving] = useState(false); const [saved, setSaved] = useState(false);
 const inFlight = useRef(false);
 useEffect(() => {
  if (key === authority.current.key) return;
  authority.current = { key, revision: authority.current.revision + 1 };
  confirmedAnchor.current = policy.periodStart; setDraft(draftOf(policy)); setErrors({}); setFailure(null); setPeriodFailure(false); setSaved(false);
 }, [key]);
 const change = (patch: Partial<Draft>) => { setDraft(current => ({ ...current, ...patch })); setErrors({}); setFailure(null); setSaved(false); };
 const futureAnchor = draft.anchor > Date.now();
 const repairAvailable = futureAnchor || periodFailure;
 const save = async (event: FormEvent) => {
  event.preventDefault(); if (inFlight.current) return;
  const job = parseUsdDraft(draft.job); const period = parseUsdDraft(draft.period);
  const days = /^\d+$/.test(draft.days) ? Number(draft.days) : NaN;
  const attempts = /^\d+$/.test(draft.attempts) ? Number(draft.attempts) : NaN;
  const invalid: Partial<Record<Field, string>> = {};
  if (job === null) invalid.job = 'Enter a nonnegative USD amount with a decimal point and at most six decimal places, within the supported range. No grouping or exponents.';
  if (period === null) invalid.period = 'Enter a nonnegative USD amount with a decimal point and at most six decimal places, within the supported range. No grouping or exponents.';
  if (!Number.isSafeInteger(days) || days < 1 || days > 366) invalid.days = 'Enter a whole number from 1 to 366.';
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 3) invalid.attempts = 'Enter a whole number from 1 to 3.';
  setErrors(invalid); setFailure(null); setSaved(false);
  const first = (Object.keys(invalid) as Field[])[0];
  if (first) { form.current?.querySelector<HTMLInputElement>(`[name="${first}"]`)?.focus(); return; }
  if (futureAnchor) { setPeriodFailure(true); setFailure('Check this Mac’s date and time. The budget period has not started; choose the current time below only if the clock is correct, then save.'); return; }
  inFlight.current = true; setSaving(true);
  const revision = authority.current.revision;
  try {
   const confirmed = await onSave({ jobLimitMicroUsd: job!, periodLimitMicroUsd: period!, periodDays: days, periodStart: draft.anchor, maxRemoteAttempts: attempts, unknownCost: draft.unknown });
   const confirmedKey = policyKey(confirmed);
   // A parent may echo this same response before the callback resolves.
   if (authority.current.revision !== revision && authority.current.key !== confirmedKey) return;
   authority.current = { key: confirmedKey, revision: authority.current.revision + 1 };
   confirmedAnchor.current = confirmed.periodStart;
   setDraft(draftOf(confirmed)); setSaved(true); setPeriodFailure(false);
  } catch (error) {
   if (authority.current.revision !== revision) return;
   const code = error instanceof ApiError ? error.code : undefined;
   if (code === 'budget-period-not-started') { setPeriodFailure(true); setFailure('Check this Mac’s date and time. The budget period has not started; choose the current time below only if the clock is correct, then save.'); }
   else if (code === 'invalid-budget-policy') setFailure('The spending policy was rejected. Check the limits and this Mac’s date and time, then retry saving.');
   else if (code === 'budget-unavailable') setFailure('Spending records are unavailable. Preserve the records and retry; local operation remains available.');
   else setFailure('Could not save spending limits. Your changes are retained; check the settings and retry. Local operation remains available.');
  } finally { inFlight.current = false; setSaving(false); }
 };
 const help = { job: 'Use USD with a decimal point, up to six decimal places. Zero blocks remote requests.', period: 'Use USD with a decimal point, up to six decimal places. Zero blocks remote requests.', days: 'The period lasts 1–366 days from the saved period start.', attempts: 'Total remote rounds per logical job, including retries and all planned calls: 1–3. This does not enable automatic retries.' };
 const labels = { job: 'Job limit (USD)', period: 'Period limit (USD)', days: 'Period length (days)', attempts: 'Maximum remote attempts' };
 return <article className={styles.card} aria-labelledby={`${id}-heading`}>
  <h2 id={`${id}-heading`}>{tr('Spending limits')}</h2>
  <p>{tr('Both limits must be positive to allow remote requests. Zero blocks remote spending. Local models have no API charges.')}</p>
  <p>{tr('These controls apply only to Heed on this Mac. They cannot cap your entire provider account; provider invoices may differ.')}</p>
  <form ref={form} onSubmit={event => void save(event)} noValidate>
   <div className={styles.fields}>
    {(Object.keys(labels) as Field[]).map(field => <div className={styles.field} key={field}>
     <label htmlFor={`${id}-${field}`}>{tr(labels[field])}</label>
     <input id={`${id}-${field}`} name={field} type="text" inputMode={field === 'job' || field === 'period' ? 'decimal' : 'numeric'} maxLength={30} value={draft[field]} disabled={saving} aria-invalid={!!errors[field]} aria-describedby={`${id}-${field}-help${errors[field] ? ` ${id}-${field}-error` : ''}`} onChange={event => change({ [field]: event.target.value })}/>
     <small id={`${id}-${field}-help`}>{tr(help[field])}</small>
     {errors[field] && <small role="alert" id={`${id}-${field}-error`}>{tr(errors[field]!)}</small>}
    </div>)}
    <div className={styles.field}>
     <label htmlFor={`${id}-unknown`}>{tr('Unknown cost')}</label>
     <select id={`${id}-unknown`} value={draft.unknown} disabled={saving} aria-describedby={`${id}-unknown-help`} onChange={event => change({ unknown: event.target.value as AiBudgetPolicy['unknownCost'] })}>
      <option value="block">{tr('Block requests with unknown cost')}</option><option value="explicit">{tr('Ask for each request')}</option>
     </select>
     <small id={`${id}-unknown-help`}>{tr('Known token prices can still leave the whole request charge unknown. Asking permits a later single-use decision; saving does not authorize content upload or spending, or guarantee a strict cap.')}</small>
    </div>
   </div>
   <p className={styles.anchor}>{tr('Period start')}: <time dateTime={new Date(draft.anchor).toISOString()}>{new Date(draft.anchor).toLocaleString(locale)}</time></p>
   {(repairAvailable || draft.anchor !== confirmedAnchor.current) && <div>
    {repairAvailable && !failure && <p>{tr('Check this Mac’s date and time. The budget period has not started; choose the current time below only if the clock is correct, then save.')}</p>}
    <p>{tr('Changing the period start changes which completed requests belong to the active period. Pending and uncertain liability is retained; previous charges are not deleted or refunded.')}</p>
    {draft.anchor !== confirmedAnchor.current && <p>{tr('The period start has changed in this draft. Save to apply it.')}</p>}
    {repairAvailable && <div className={styles.actions}><button type="button" disabled={saving} onClick={() => { change({ anchor: Date.now() }); setPeriodFailure(false); }}>{tr('Use current time as period start')}</button></div>}
   </div>}
   {failure && <p role="alert">{tr(failure)}</p>}
   {saved && <p role="status">{tr('Spending limits saved.')}</p>}
   <div className={styles.actions}><button type="submit" disabled={saving}>{tr(saving ? 'Saving…' : 'Save spending limits')}</button></div>
  </form>
  <p>{tr('Free quota, promotional credit, and paid API usage are different. Eligibility, region, expiry, privacy conditions, and rate limits depend on your account. Consumer chat subscriptions provide no API credit.')}</p>
  <p>{tr('For quota or rate limits, wait for the provider’s reset or change your AI settings. Local operation remains available. Heed does not switch provider, purchase access, or retry automatically.')}</p>
  {!!presets?.length && <details className={styles.catalog}><summary>{tr('Pricing and allowance sources')}</summary>
   {presets.map(preset => <article key={preset.id}>
    <h3>{preset.provider} / {preset.model}</h3>
    <p>{tr(preset.apiCharges === 'zero' ? 'Local — no API charges' : 'Paid API rates (USD)')}</p>
    <p>{tr('Verified {date}', { date: preset.verifiedAt })}</p>
    {preset.access === 'paid' && <p>{tr(!preset.price ? 'Unknown pricing or usage' : Date.now() - Date.parse(preset.price.verifiedAt) > 30 * 86400000 ? 'Stale pricing' : 'Dated token pricing available; whole request charges may still be unknown.')}</p>}
    <p>{tr('Supported features')}: {preset.features.map(feature => tr(({ notes: 'Notes', tasks: 'Tasks', chat: 'Meeting chat', 'library-chat': 'Library chat' })[feature])).join(', ')}</p>
    <div className={styles.links}>{safeUrl(preset.sourceUrl) && <a href={safeUrl(preset.sourceUrl)} target="_blank" rel="noopener noreferrer">{tr('Official pricing')}</a>}{safeUrl(preset.dataUrl) && <a href={safeUrl(preset.dataUrl)} target="_blank" rel="noopener noreferrer">{tr('Official data handling')}</a>}</div>
    <ul>{[...preset.limitations, ...preset.dataHandling, ...preset.rateLimits].map((text, index) => <li key={index}>{tr(text)}</li>)}</ul>
    {preset.offers.map((offer, index) => <div key={index}>
     <h3>{tr(offer.kind === 'free-quota' ? 'Free quota' : 'Promotional credit')}</h3>
     <p>{tr('Verified {date}', { date: offer.verifiedAt })}</p>
     <p>{tr('Account eligibility is unknown. Check the official conditions before relying on this offer.')}</p>
     {offer.dataSharingRequired && <p>{tr('This offer requires data sharing. Review the official privacy conditions before opting in.')}</p>}
     {offer.quota && <p>{tr('Daily quota resets at {time} and is shared across models.', { time: offer.quota.reset })}</p>}
     <ul>{offer.conditions.map((text, condition) => <li key={condition}>{tr(text)}</li>)}</ul>
     {safeUrl(offer.sourceUrl) && <a href={safeUrl(offer.sourceUrl)} target="_blank" rel="noopener noreferrer">{tr('Official allowance conditions')}</a>}
    </div>)}
   </article>)}
  </details>}
 </article>;
}
