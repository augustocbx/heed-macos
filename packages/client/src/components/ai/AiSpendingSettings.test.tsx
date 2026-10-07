import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import type { AiBudgetPolicy, AiPreset } from '@heed/shared';
import { ApiError } from '@/api/client';
import { setLocale, tr } from '@/lib/i18n';
import { AiSpendingSettings } from './AiSpendingSettings';

const policy: AiBudgetPolicy = { jobLimitMicroUsd: 0, periodLimitMicroUsd: 0, periodDays: 30, periodStart: 1700000000000, maxRemoteAttempts: 1, unknownCost: 'block' };
beforeEach(() => setLocale('en'));
afterEach(() => vi.useRealTimers());
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Save spending limits' }));
test.each(['en', 'pt-BR', 'fr', 'de'] as const)('labels and safe defaults in %s', locale => {
 setLocale(locale); render(<AiSpendingSettings policy={policy} onSave={vi.fn()} />);
 for (const label of ['Job limit (USD)', 'Period limit (USD)', 'Period length (days)', 'Maximum remote attempts', 'Unknown cost']) expect(screen.getByLabelText(tr(label, locale))).toBeInTheDocument();
 expect(screen.getByLabelText(tr('Job limit (USD)', locale))).toHaveValue('0');
 expect(screen.getByText(tr('Both limits must be positive to allow remote requests. Zero blocks remote spending. Local models have no API charges.', locale))).toBeInTheDocument();
 expect(screen.getByText(tr('These controls apply only to Heed on this Mac. They cannot cap your entire provider account; provider invoices may differ.', locale))).toBeInTheDocument();
 expect(screen.getByText(tr('Free quota, promotional credit, and paid API usage are different. Eligibility, region, expiry, privacy conditions, and rate limits depend on your account. Consumer chat subscriptions provide no API credit.', locale))).toBeInTheDocument();
});
test('saves exact dollars, cumulative rounds and unknown-cost policy without authorizing a request', async () => {
 const save = vi.fn(async (next: AiBudgetPolicy) => next); render(<AiSpendingSettings policy={policy} onSave={save} />);
 fireEvent.change(screen.getByLabelText('Job limit (USD)'), { target: { value: '0.000001' } });
 fireEvent.change(screen.getByLabelText('Period limit (USD)'), { target: { value: '9007199254.740991' } });
 fireEvent.change(screen.getByLabelText('Maximum remote attempts'), { target: { value: '3' } });
 fireEvent.change(screen.getByLabelText('Unknown cost'), { target: { value: 'explicit' } });
 expect(screen.getByText('Known token prices can still leave the whole request charge unknown. Asking permits a later single-use decision; saving does not authorize content upload or spending, or guarantee a strict cap.')).toBeInTheDocument();
 submit(); await screen.findByRole('status');
 expect(save).toHaveBeenCalledExactlyOnceWith({ ...policy, jobLimitMicroUsd: 1, periodLimitMicroUsd: Number.MAX_SAFE_INTEGER, maxRemoteAttempts: 3, unknownCost: 'explicit' });
});
test('prefills and round-trips maximum safe amounts without fractional rounding', async () => {
 const save = vi.fn(async (next: AiBudgetPolicy) => next);
 render(<AiSpendingSettings policy={{ ...policy, jobLimitMicroUsd: Number.MAX_SAFE_INTEGER, periodLimitMicroUsd: Number.MAX_SAFE_INTEGER - 1 }} onSave={save} />);
 expect(screen.getByLabelText('Job limit (USD)')).toHaveValue('9007199254.740991');
 expect(screen.getByLabelText('Period limit (USD)')).toHaveValue('9007199254.740990');
 submit(); await screen.findByRole('status');
 expect(save.mock.calls[0][0].periodLimitMicroUsd).toBe(Number.MAX_SAFE_INTEGER - 1);
});
test.each(['', '-1', '1e2', '1,000', '0.0000001', '9007199254.740992'])('rejects invalid money %j with an associated error and focus', value => {
 const save = vi.fn(); render(<AiSpendingSettings policy={policy} onSave={save} />);
 const input = screen.getByLabelText('Job limit (USD)'); fireEvent.change(input, { target: { value } }); submit();
 expect(save).not.toHaveBeenCalled(); expect(input).toHaveAttribute('aria-invalid', 'true'); expect(input).toHaveFocus();
 expect(input).toHaveAccessibleDescription(/Enter a nonnegative USD amount/); expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
});
test.each([['Period length (days)', '0'], ['Period length (days)', '367'], ['Period length (days)', '1.5'], ['Maximum remote attempts', '0'], ['Maximum remote attempts', '4']])('validates %s at %s', (label, value) => {
 const save = vi.fn(); render(<AiSpendingSettings policy={policy} onSave={save} />);
 const input = screen.getByLabelText(label); fireEvent.change(input, { target: { value } }); submit();
 expect(save).not.toHaveBeenCalled(); expect(input).toHaveAttribute('aria-invalid', 'true');
});
test('retains failed draft, disables duplicate submission and applies authoritative returned policy', async () => {
 let reject!: (error: unknown) => void;
 const save = vi.fn().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })).mockImplementationOnce(async (next: AiBudgetPolicy) => ({ ...next, jobLimitMicroUsd: 1000001, periodDays: 7 }));
 render(<AiSpendingSettings policy={policy} onSave={save} />);
 fireEvent.change(screen.getByLabelText('Job limit (USD)'), { target: { value: '2.000001' } }); submit();
 expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
 reject(new ApiError('private provider details', 503, 'budget-unavailable'));
 expect(await screen.findByRole('alert')).toHaveTextContent('Spending records are unavailable. Preserve the records and retry; local operation remains available.');
 expect(screen.queryByText(/private provider/)).not.toBeInTheDocument(); expect(screen.getByLabelText('Job limit (USD)')).toHaveValue('2.000001');
 submit(); await screen.findByRole('status'); expect(screen.getByLabelText('Job limit (USD)')).toHaveValue('1.000001'); expect(screen.getByLabelText('Period length (days)')).toHaveValue('7');
});
test('refreshes from a newly supplied authoritative policy', () => {
 const { rerender } = render(<AiSpendingSettings policy={policy} onSave={vi.fn()} />);
 rerender(<AiSpendingSettings policy={{ ...policy, jobLimitMicroUsd: 3 }} onSave={vi.fn()} />);
 expect(screen.getByLabelText('Job limit (USD)')).toHaveValue('0.000003');
});
test('future anchor repair changes draft only and preserves failed repair for retry', async () => {
 vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1800000000000);
 const save = vi.fn().mockRejectedValueOnce(new ApiError('bad', 400, 'invalid-budget-policy')).mockImplementationOnce(async (next: AiBudgetPolicy) => next);
 render(<AiSpendingSettings policy={{ ...policy, periodStart: 1800000100000 }} onSave={save} />);
 expect(screen.getByText('Check this Mac’s date and time. The budget period has not started; choose the current time below only if the clock is correct, then save.')).toBeInTheDocument();
 expect(screen.getByText('Changing the period start changes which completed requests belong to the active period. Pending and uncertain liability is retained; previous charges are not deleted or refunded.')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button', { name: 'Use current time as period start' })); expect(save).not.toHaveBeenCalled();
 submit(); await screen.findByRole('alert'); expect(save.mock.calls[0][0].periodStart).toBe(1800000000000);
 submit(); await screen.findByRole('status'); expect(save.mock.calls[1][0].periodStart).toBe(1800000000000);
 expect(screen.queryByText('The period start has changed in this draft. Save to apply it.')).not.toBeInTheDocument();
});
test.each(['en', 'pt-BR', 'fr', 'de'] as const)('actual period-not-started failure offers explicit draft repair in %s', async locale => {
 setLocale(locale); const save = vi.fn().mockRejectedValue(new ApiError('ignored', 503, 'budget-period-not-started'));
 render(<AiSpendingSettings policy={policy} onSave={save} />);
 fireEvent.click(screen.getByRole('button', { name: tr('Save spending limits', locale) })); await screen.findByRole('alert');
 fireEvent.click(screen.getByRole('button', { name: tr('Use current time as period start', locale) })); expect(save).toHaveBeenCalledTimes(1);
});
test('renders only supplied dated safe catalog links and qualified allowance/privacy facts', () => {
 const preset: AiPreset = { id: 'fixture', provider: 'openai', model: 'fixture-model', access: 'paid', apiCharges: 'paid-rates', features: ['notes'], capabilities: null, price: null, verifiedAt: '2026-10-07', sourceUrl: 'https://example.com/pricing', dataUrl: 'https://example.com/privacy', consumerSubscriptionProvidesApiCredit: false, offers: [{ kind: 'free-quota', accountEligibility: 'unknown', sourceUrl: 'https://example.com/quota', verifiedAt: '2026-10-06', dataSharingRequired: true, conditions: ['Fixture account condition'] }, { kind: 'promotional-credit', accountEligibility: 'unknown', sourceUrl: 'javascript:alert(1)', verifiedAt: '2026-10-05', dataSharingRequired: false, conditions: ['Fixture expiry condition'] }], limitations: ['Fixture limitation'], dataHandling: ['Fixture data policy'], rateLimits: ['Fixture rate restriction'], optimizations: { hostedCacheEnabled: false, batchEnabled: false, evaluation: [] } };
 render(<AiSpendingSettings policy={policy} onSave={vi.fn()} presets={[preset]} />);
 expect(screen.getByRole('link', { name: 'Official pricing' })).toHaveAttribute('href', preset.sourceUrl);
 expect(screen.getByRole('link', { name: 'Official data handling' })).toHaveAttribute('href', preset.dataUrl);
 expect(screen.getByText('Verified {date}'.replace('{date}', '2026-10-07'))).toBeInTheDocument();
 expect(screen.getByText('Free quota')).toBeInTheDocument(); expect(screen.getByText('Promotional credit')).toBeInTheDocument();
 expect(screen.getAllByText('Account eligibility is unknown. Check the official conditions before relying on this offer.')).toHaveLength(2);
 expect(screen.getByText('This offer requires data sharing. Review the official privacy conditions before opting in.')).toBeInTheDocument();
 expect(screen.getByText('Fixture data policy')).toBeInTheDocument(); expect(screen.getByText('Fixture rate restriction')).toBeInTheDocument();
 expect(screen.getAllByRole('link').every(link => link.getAttribute('href')?.startsWith('https://'))).toBe(true);
});
