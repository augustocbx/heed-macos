/** Draft and display conversions preserve integer accounting without floating money math. */
export function usdDraft(microUsd: number): string {
 const amount = BigInt(microUsd);
 const fraction = (amount % 1000000n).toString().padStart(6, '0');
 return `${amount / 1000000n}${amount % 1000000n ? `.${fraction}` : ''}`;
}
export function parseUsdDraft(value: string): number | null {
 if (value.length > 30 || !/^\d+(?:\.\d{1,6})?$/.test(value)) return null;
 const [whole, fraction = ''] = value.split('.');
 const amount = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
 return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null;
}
export function formatUsd(microUsd: number, locale: string): string {
 const amount = BigInt(microUsd);
 const fraction = (amount % 1000000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
 const parts = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 }).formatToParts(amount / 1000000n);
 const decimal = new Intl.NumberFormat(locale).formatToParts(1.1).find(part => part.type === 'decimal')!.value;
 const lastInteger = parts.reduce((last, part, index) => part.type === 'integer' ? index : last, -1);
 return parts.map((part, index) => part.value + (index === lastInteger ? decimal + fraction : '')).join('');
}
