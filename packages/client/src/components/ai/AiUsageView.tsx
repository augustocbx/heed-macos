import { useId } from 'react';
import type { AiUsageSnapshot } from '@heed/shared';
import { useLocale } from '@/lib/i18n';
import { formatUsd } from './ai-money';
import styles from './AiSpending.module.css';

const states = { held: 'Held', dispatched: 'Dispatched', settled: 'Settled', uncertain: 'Uncertain', released: 'Released' };
const outcomes = { completed: 'Completed', cancelled: 'Cancelled', timeout: 'Timeout', 'rate-limited': 'Rate limited', rejected: 'Rejected', uncertain: 'Uncertain' };
export function AiUsageView({ snapshot }: { snapshot: AiUsageSnapshot }) {
 const { locale, tr } = useLocale(); const id = useId();
 const money = (value: number | null) => value === null ? tr('Unknown') : formatUsd(value, locale);
 const date = (value: number) => new Date(value).toLocaleString(locale);
 const count = (value: number | undefined) => value === undefined ? tr('Unknown') : new Intl.NumberFormat(locale).format(value);
 return <article className={styles.card} aria-labelledby={`${id}-heading`}>
  <h2 id={`${id}-heading`}>{tr('Usage on this Mac')}</h2>
  <p>{tr('These controls apply only to Heed on this Mac. They cannot cap your entire provider account; provider invoices may differ.')}</p>
  <p>{tr('Token estimates use provider-reported counts and dated prices. They are estimates, not invoices; conditional fees may be missing.')}</p>
  <p>{tr('Provider-reported request charges are separate from token estimates and are not a final invoice. Do not add these amounts together.')}</p>
  <p>{tr('Input and output totals already include cache and reasoning subsets. Missing or unsupported counts are unknown, not zero.')}</p>
  <dl className={styles.summary}>
   <div><dt>{tr('Active period start')}</dt><dd><time dateTime={new Date(snapshot.periodStart).toISOString()}>{date(snapshot.periodStart)}</time></dd></div>
   <div><dt>{tr('Accounted liability (includes held amounts)')}</dt><dd>{money(snapshot.liabilityMicroUsd)}</dd></div>
   <div><dt>{tr('Held amounts (already included)')}</dt><dd>{money(snapshot.heldMicroUsd)}</dd></div>
   <div><dt>{tr('Attempts with unknown liability')}</dt><dd>{count(snapshot.unknownLiabilityCount)}</dd></div>
   <div><dt>{tr('Strict remaining budget')}</dt><dd>{snapshot.strictRemainingMicroUsd === null || snapshot.unknownLiabilityCount > 0 || snapshot.overflow ? tr('Unknown — no strict remaining-budget claim') : money(snapshot.strictRemainingMicroUsd)}</dd></div>
  </dl>
  {snapshot.unknownLiabilityCount > 0 && <p>{tr('Unknown liability may exceed these accounted amounts. The full charge is not established.')}</p>}
  <p>{tr('Pending and uncertain allocations from older periods remain included. Cancellation or a retry does not prove a dispatched request was free.')}</p>
  {snapshot.overflow && <p role="status">{tr('Totals exceed the supported range and are unknown. Remote admission remains blocked under strict limits.')}</p>}
  {snapshot.entriesTruncated && <p role="status">{tr('Only the most recent attempts are shown. Totals include all applicable records, including older pending liability.')}</p>}
  {!snapshot.entries.length ? <p>{tr('No attempts are shown. This does not prove there are no charges outside Heed.')}</p> : <div className={styles.tableRegion} role="region" aria-label={tr('Remote request attempts')} tabIndex={0}>
   <table className={styles.table}>
    <caption>{tr('Remote request attempts')}</caption>
    <thead><tr>{['Attempt / model', 'Round', 'Dispatch / outcome', 'Accounted liability', 'Token estimate', 'Reported request charge', 'Provider-reported usage'].map(label => <th scope="col" key={label}>{tr(label)}</th>)}</tr></thead>
    <tbody>{snapshot.entries.map(entry => {
     const accounting = entry.accounting; const usage = accounting?.usage?.supported ? accounting.usage : null;
     return <tr key={entry.attemptId}>
      <th scope="row">{entry.attemptId}<small>{entry.callId}</small><small>{entry.selection.provider} / {entry.selection.model ?? tr('Unknown')}</small></th>
      <td>{entry.round}</td>
      <td>{entry.dispatchedAt === null ? tr('Not dispatched') : <time dateTime={new Date(entry.dispatchedAt).toISOString()}>{date(entry.dispatchedAt)}</time>}<small>{tr(states[entry.state])}</small>{entry.outcome && <small>{tr(outcomes[entry.outcome])}</small>}{entry.dispatchedAt !== null && (entry.unknownLiability || entry.state === 'uncertain' || entry.outcome !== 'completed') && <small>{tr('May still be charged')}</small>}</td>
      <td>{money(entry.liabilityMicroUsd)}{entry.periodStart < snapshot.periodStart && <small>{tr('Older-period allocation')}</small>}{entry.unknownLiability && <small>{tr('Whole request liability is unknown; known token prices do not establish the full charge.')}</small>}</td>
      <td>{money(accounting?.tokenEstimate.amountMicroUsd ?? null)}{accounting?.tokenEstimate.status === 'stale' ? <small>{tr('Stale pricing')}</small> : (!accounting || accounting.tokenEstimate.status === 'unknown') && <small>{tr('Unknown pricing or usage')}</small>}{!!accounting?.uncertainty.length && <small>{tr('Accounting evidence remains uncertain.')}</small>}</td>
      <td>{money(accounting?.reportedCharge?.amountMicroUsd ?? null)}{accounting?.reportedCharge && <small>{tr('Rounded up to six decimal places for spending controls.')}</small>}</td>
      <td>{usage ? <>{tr('Input: {input}; output: {output}', { input: count(usage.inputTokens), output: count(usage.outputTokens) })}<small>{tr('Included subsets — cached input: {cached}; cache writes: {writes}; reasoning: {reasoning}', { cached: count(usage.cachedInputTokens), writes: count(usage.cacheWriteTokens), reasoning: count(usage.reasoningTokens) })}</small></> : tr('Unknown')}</td>
     </tr>;
    })}</tbody>
   </table>
  </div>}
  <p>{tr('For quota or rate limits, wait for the provider’s reset or change your AI settings. Local operation remains available. Heed does not switch provider, purchase access, or retry automatically.')}</p>
 </article>;
}
