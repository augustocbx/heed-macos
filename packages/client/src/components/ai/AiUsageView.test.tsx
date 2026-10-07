import { render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test } from 'vitest';
import type { AiUsageEntry, AiUsageSnapshot } from '@heed/shared';
import { setLocale, tr } from '@/lib/i18n';
import { AiUsageView } from './AiUsageView';
const snapshot: AiUsageSnapshot = { policy: { jobLimitMicroUsd: 1, periodLimitMicroUsd: 100, periodDays: 30, periodStart: 1700000000000, maxRemoteAttempts: 3, unknownCost: 'block' }, policyGeneration: 1, periodStart: 1700000000000, heldMicroUsd: 30, liabilityMicroUsd: 50, unknownLiabilityCount: 1, strictRemainingMicroUsd: null, overflow: false, entries: [], entriesTruncated: false, limitation: 'device-local-accounting-not-account-wide-invoice' };
const entry: AiUsageEntry = { attemptId: 'attempt-1', reservationId: 'reservation-1', jobId: 'job-1', feature: 'chat', selection: { provider: 'xai', connectionId: 'private-connection', model: 'fixture-model' }, callId: 'call-1', round: 1, periodStart: 1690000000000, state: 'uncertain', liabilityMicroUsd: 1, unknownLiability: true, dispatchedAt: 1700000000100, outcome: 'cancelled', accounting: { usage: { inputTokens: 10, cachedInputTokens: 3, outputTokens: 8, reasoningTokens: 2, supported: true }, tokenEstimate: { status: 'stale', amountMicroUsd: 1, basis: 'estimated-from-provider-token-counts', categories: [], uncertainty: ['price-stale'] }, reportedCharge: { basis: 'provider-reported-request-charge', provider: 'xai', currency: 'USD', source: 'cost_in_usd_ticks', ticks: '1', amountMicroUsd: 1 }, uncertainty: ['unknown'] } };
beforeEach(() => setLocale('en'));
test.each(['en', 'pt-BR', 'fr', 'de'] as const)('distinguishes estimates, provider counts, charges and invoices in %s', locale => {
 setLocale(locale); render(<AiUsageView snapshot={snapshot} />);
 for (const text of ['Usage on this Mac', 'Token estimates use provider-reported counts and dated prices. They are estimates, not invoices; conditional fees may be missing.', 'Provider-reported request charges are separate from token estimates and are not a final invoice. Do not add these amounts together.', 'Reported token categories may overlap; inclusion in input or output totals is not established for every provider. Do not add the categories together. Missing or unsupported counts are unknown, not zero.', 'These controls apply only to Heed on this Mac. They cannot cap your entire provider account; provider invoices may differ.']) expect(screen.getByText(tr(text, locale))).toBeInTheDocument();
 expect(screen.getByText(tr('No attempts are shown. This does not prove there are no charges outside Heed.', locale))).toBeInTheDocument();
});
test('does not add held amounts twice or invent remaining balance', () => {
 render(<AiUsageView snapshot={snapshot} />);
 expect(screen.getByText('Accounted liability (includes held amounts)')).toBeInTheDocument();
 expect(screen.getByText('$0.00005')).toBeInTheDocument(); expect(screen.getByText('$0.00003')).toBeInTheDocument();
 expect(screen.queryByText('$0.00008')).not.toBeInTheDocument(); expect(screen.getByText('Unknown — no strict remaining-budget claim')).toBeInTheDocument();
});
test.each(['en', 'pt-BR', 'fr', 'de'] as const)('keeps cancelled charged attempts, retries, old allocation and microcharges visible in %s', locale => {
 setLocale(locale);
 render(<AiUsageView snapshot={{ ...snapshot, entries: [entry, { ...entry, attemptId: 'attempt-2', round: 2, outcome: 'timeout', accounting: null }] }} />);
 const rows = screen.getAllByRole('row'); const cancelled = rows[1];
 expect(within(cancelled).getByText(tr('Cancelled', locale))).toBeInTheDocument(); expect(within(cancelled).getByText(tr('May still be charged', locale))).toBeInTheDocument();
 expect(within(cancelled).getByText(tr('Older-period allocation', locale))).toBeInTheDocument(); expect(within(cancelled).getByText(tr('Stale pricing', locale))).toBeInTheDocument();
 const microAmounts = { en: '$0.000001', 'pt-BR': 'US$ 0,000001', fr: '0,000001 $US', de: '0,000001 $' };
 expect(within(cancelled).getAllByText(microAmounts[locale])).toHaveLength(3);
 expect(within(cancelled).getByText(tr('Input: {input}; output: {output}', locale, { input: '10', output: '8' }))).toBeInTheDocument();
 expect(within(cancelled).getByText(tr('Reported categories — cached input: {cached}; cache writes: {writes}; reasoning: {reasoning}', locale, { cached: '3', writes: tr('Unknown', locale), reasoning: '2' }))).toBeInTheDocument();
 expect(screen.queryByText(/Included subsets/)).not.toBeInTheDocument();
 expect(within(rows[2]).getByText('2')).toBeInTheDocument(); expect(within(rows[2]).getByText(tr('Timeout', locale))).toBeInTheDocument();
});
test('marks unknown whole-attempt liability even when token prices are known and omits arbitrary content/secrets', () => {
 const contaminated = { ...entry, title: 'private meeting title', prompt: 'private prompt', credentialRef: 'private credential', accounting: { ...entry.accounting!, tokenEstimate: { ...entry.accounting!.tokenEstimate, status: 'known' as const }, uncertainty: ['private raw provider text'] } };
 render(<AiUsageView snapshot={{ ...snapshot, entries: [contaminated] }} />);
 expect(screen.getByText('Whole request liability is unknown; known token prices do not establish the full charge.')).toBeInTheDocument();
 for (const text of ['private meeting title', 'private prompt', 'private credential', 'private-connection', 'private raw provider text']) expect(screen.queryByText(new RegExp(text))).not.toBeInTheDocument();
});
test('shows aggregate overflow and truncated history without suggesting zero or a complete table', () => {
 render(<AiUsageView snapshot={{ ...snapshot, overflow: true, heldMicroUsd: null, liabilityMicroUsd: null, strictRemainingMicroUsd: null, entriesTruncated: true }} />);
 expect(screen.getByText('Totals exceed the supported range and are unknown. Remote admission remains blocked under strict limits.')).toBeInTheDocument();
 expect(screen.getByText('Only the most recent attempts are shown. Totals include all applicable records, including older pending liability.')).toBeInTheDocument();
 expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
});
test.each(['en', 'pt-BR', 'fr', 'de'] as const)('rate-limit and unknown pricing guidance offers user choices in %s', locale => {
 setLocale(locale); render(<AiUsageView snapshot={{ ...snapshot, entries: [{ ...entry, outcome: 'rate-limited', accounting: null }] }} />);
 expect(screen.getByText(tr('For quota or rate limits, wait for the provider’s reset or change your AI settings. Local operation remains available. Heed does not switch provider, purchase access, or retry automatically.', locale))).toBeInTheDocument();
 expect(screen.getByText(tr('Unknown pricing or usage', locale))).toBeInTheDocument();
});
test('formats large amounts exactly without hiding fractional precision', () => {
 render(<AiUsageView snapshot={{ ...snapshot, unknownLiabilityCount: 0, liabilityMicroUsd: Number.MAX_SAFE_INTEGER, heldMicroUsd: 0, strictRemainingMicroUsd: 1 }} />);
 expect(screen.getByText('$9,007,199,254.740991')).toBeInTheDocument(); expect(screen.getByText('$0.000001')).toBeInTheDocument();
});
test('qualifies a one-tick reported charge rounded up to one microdollar for spending controls', () => {
 render(<AiUsageView snapshot={{ ...snapshot, entries: [entry] }} />);
 const reported = screen.getAllByRole('row')[1].children[5] as HTMLElement;
 expect(within(reported).getByText('$0.000001')).toBeInTheDocument();
 expect(within(reported).getByText('Rounded up to six decimal places for spending controls.')).toBeInTheDocument();
 expect(screen.getByText('Provider-reported request charges are separate from token estimates and are not a final invoice. Do not add these amounts together.')).toBeInTheDocument();
});
