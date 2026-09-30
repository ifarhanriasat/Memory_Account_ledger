// Money is held as a bigint count of the currency's minor unit (fils for AED,
// fils-of-a-thousand for BHD). No floating point touches an amount anywhere.

export type Currency = 'AED' | 'BHD';

/** Decimal places per currency (ISO 4217 minor units). */
export const CURRENCY_SCALE: Readonly<Record<Currency, number>> = Object.freeze({
  AED: 2,
  BHD: 3,
});

export class LedgerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

/**
 * Parse a decimal string ("1,200.00", "10.000") into minor units.
 * Rejects more decimal places than the currency carries rather than rounding:
 * silently rounding an inbound instruction would change what the sender asked for.
 */
export function parseAmount(text: string, currency: Currency): bigint {
  const scale = CURRENCY_SCALE[currency];
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text.replace(/,/g, '').trim());
  if (!match) throw new LedgerError('BAD_AMOUNT', `cannot parse amount "${text}"`);
  const [, sign, whole = '0', frac = ''] = match;
  if (frac.length > scale) {
    throw new LedgerError(
      'PRECISION_EXCEEDED',
      `"${text}" has ${frac.length} decimals; ${currency} carries ${scale}`,
    );
  }
  const minor = BigInt(whole) * 10n ** BigInt(scale) + BigInt(frac.padEnd(scale, '0'));
  return sign ? -minor : minor;
}

export function formatAmount(minor: bigint, currency: Currency): string {
  const scale = CURRENCY_SCALE[currency];
  const unit = 10n ** BigInt(scale);
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const frac = (abs % unit).toString().padStart(scale, '0');
  return `${negative ? '-' : ''}${abs / unit}.${frac}`;
}

/** num / den rounded to the nearest integer, ties to even (banker's rounding). */
export function divRoundHalfEven(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new RangeError('denominator must be positive');
  const negative = num < 0n;
  const n = negative ? -num : num;
  let q = n / den;
  const twiceRem = (n % den) * 2n;
  if (twiceRem > den || (twiceRem === den && q % 2n === 1n)) q += 1n;
  return negative ? -q : q;
}

/**
 * Split `total` minor units into `parts` instalments that differ by at most one
 * minor unit and sum exactly to `total`. Leftover units go on the last
 * instalments, so the earlier ones match what a naive per-part division gives.
 */
export function splitEvenly(total: bigint, parts: number): bigint[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new LedgerError('BAD_INSTALMENTS', `instalment count must be a positive integer, got ${parts}`);
  }
  if (total <= 0n) throw new LedgerError('BAD_AMOUNT', 'only positive totals can be split');
  const n = BigInt(parts);
  const base = total / n;
  const remainder = Number(total % n);
  return Array.from({ length: parts }, (_, i) => (i >= parts - remainder ? base + 1n : base));
}
