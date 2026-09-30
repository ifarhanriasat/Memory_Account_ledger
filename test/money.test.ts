import { test } from 'node:test';
import assert from 'node:assert/strict';
import { divRoundHalfEven, formatAmount, LedgerError, parseAmount, splitEvenly } from '../src/money';

test('parses amounts into minor units at each currency precision', () => {
  assert.equal(parseAmount('1,200.00', 'AED'), 120000n);
  assert.equal(parseAmount('950', 'AED'), 95000n);
  assert.equal(parseAmount('10.000', 'BHD'), 10000n);
  assert.equal(parseAmount('0.5', 'BHD'), 500n);
});

test('refuses amounts with more precision than the currency carries', () => {
  assert.throws(() => parseAmount('3.334', 'AED'), (e: unknown) => e instanceof LedgerError && e.code === 'PRECISION_EXCEEDED');
  assert.throws(() => parseAmount('3.3334', 'BHD'), (e: unknown) => e instanceof LedgerError && e.code === 'PRECISION_EXCEEDED');
});

test('formats minor units back at currency precision, including negatives', () => {
  assert.equal(formatAmount(-37000n, 'AED'), '-370.00');
  assert.equal(formatAmount(8n, 'BHD'), '0.008');
  assert.equal(formatAmount(-5n, 'AED'), '-0.05');
});

test('half-even rounding', () => {
  assert.equal(divRoundHalfEven(186n, 1000n), 0n); // 0.186 -> 0
  assert.equal(divRoundHalfEven(46500n * 4n, 10000n), 19n); // 18.6 -> 19
  assert.equal(divRoundHalfEven(25n, 10n), 2n); // 2.5 -> 2 (tie to even)
  assert.equal(divRoundHalfEven(35n, 10n), 4n); // 3.5 -> 4 (tie to even)
  assert.equal(divRoundHalfEven(-35n, 10n), -4n);
});

test('splitEvenly sums exactly and differs by at most one minor unit', () => {
  assert.deepEqual(splitEvenly(10000n, 3), [3333n, 3333n, 3334n]);
  assert.deepEqual(splitEvenly(9000n, 3), [3000n, 3000n, 3000n]);
  assert.deepEqual(splitEvenly(10001n, 3), [3333n, 3334n, 3334n]);
  assert.throws(() => splitEvenly(10000n, 0));
});
