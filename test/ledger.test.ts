import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LedgerEngine, LedgerEvent } from '../src/ledger';
import { ACCOUNTS, EVENTS, replay } from '../src/scenario';

const ev = (id: string) => EVENTS.find((e) => e.id === id)!;
const aed = { account: 'ACC-001', currency: 'AED' } as const;

test('replay: closing ledger balance printed for each night matches the hand trace', () => {
  const engine = replay();
  const closings = engine.dayReports().map((r) => r.accounts.map((a) => a.closingLedger));
  assert.deepEqual(closings, [
    [25000n, 0n],
    [25000n, 0n],
    [65000n, 0n],
    [46500n, 0n],
    [-23000n, 0n], // E7 backdated plus three fees
    [46603n, 10008n], // after E9, fee refunds, interest capitalization
  ]);
});

test('replay: every event outcome', () => {
  const outcomes = Object.fromEntries(replay().events().map((r) => [r.event.id, `${r.outcome}${r.code ? ':' + r.code : ''}`]));
  assert.deepEqual(outcomes, {
    E1: 'APPLIED', E2: 'APPLIED', E3: 'APPLIED', E4: 'APPLIED', E5: 'APPLIED',
    E6: 'REJECTED:AUTH_NOT_FOUND', E7: 'APPLIED', E8: 'DECLINED:INSUFFICIENT_AVAILABLE',
    E9: 'APPLIED', E10: 'APPLIED',
  });
});

test('append-only: records are frozen and readers get copies', () => {
  const engine = replay();
  const entries = engine.entries();
  assert.throws(() => { (entries[0] as { amount: bigint }).amount = 0n; }, TypeError);
  assert.throws(() => { (entries as LedgerEntryArray).push(entries[0]!); }, TypeError);
  assert.throws(() => { (engine.events()[0]!.event as { amount?: string }).amount = '0'; }, TypeError);
  assert.equal(engine.entries().length, entries.length);
});
type LedgerEntryArray = ReturnType<LedgerEngine['entries']>[number][];

test('append-only: each night only adds entries; earlier entries are unchanged', () => {
  const engine = new LedgerEngine(ACCOUNTS);
  let previous: ReturnType<LedgerEngine['entries']> = [];
  for (const e of EVENTS) {
    engine.ingest(e);
    const now = engine.entries();
    assert.ok(now.length >= previous.length);
    previous.forEach((p, i) => assert.equal(now[i], p, 'same frozen object, same position'));
    previous = now;
  }
});

test('reversal: cannot reverse twice, cannot reverse unknown or non-posted events', () => {
  const engine = new LedgerEngine(ACCOUNTS);
  for (const e of EVENTS.slice(0, 7)) engine.ingest(e); // through E7
  const rev = (id: string, target: string): LedgerEvent => ({ id, day: 6, type: 'REVERSAL', ...aed, targetEventId: target, valueDate: 2 });
  assert.equal(engine.ingest(rev('R1', 'E7')).outcome, 'APPLIED');
  assert.equal(engine.ingest(rev('R2', 'E7')).code, 'ALREADY_REVERSED');
  assert.equal(engine.ingest(rev('R3', 'E99')).code, 'REVERSAL_TARGET_NOT_FOUND');
  assert.equal(engine.ingest(rev('R4', 'E6')).code, 'REVERSAL_TARGET_NOT_POSTED');
  assert.equal(engine.ingest(rev('R5', 'E3')).code, 'REVERSAL_NOT_SUPPORTED');
  assert.equal(engine.ingest({ ...rev('R6', 'E4'), valueDate: 2 }).code, 'REVERSAL_BEFORE_ORIGINAL');
});

test('validation: currency mismatch, precision, future value date, unknown account, out of window', () => {
  const engine = new LedgerEngine(ACCOUNTS);
  const base = { day: 1, type: 'CREDIT', valueDate: 1 } as const;
  assert.equal(engine.ingest({ ...base, id: 'X1', account: 'ACC-001', currency: 'BHD', amount: '1.000' }).code, 'CURRENCY_MISMATCH');
  assert.equal(engine.ingest({ ...base, id: 'X2', ...aed, amount: '1.005' }).code, 'PRECISION_EXCEEDED');
  assert.equal(engine.ingest({ ...base, id: 'X3', ...aed, amount: '1.00', valueDate: 2 }).code, 'FUTURE_VALUE_DATE');
  assert.equal(engine.ingest({ ...base, id: 'X4', account: 'ACC-999', currency: 'AED', amount: '1.00' }).code, 'UNKNOWN_ACCOUNT');
  assert.equal(engine.ingest({ ...base, id: 'X5', ...aed, amount: '0.00' }).code, 'NON_POSITIVE_AMOUNT');
  assert.equal(engine.ingest({ ...base, id: 'X6', ...aed, amount: '1.00', day: 7 }).code, 'OUTSIDE_WINDOW');
  assert.equal(engine.entries().length, 0, 'no rejected event touched the ledger');
});

test('settlement guards: over-settlement, double settlement, settling a declined auth', () => {
  const engine = new LedgerEngine(ACCOUNTS);
  engine.ingest(ev('E1'));
  const auth = (id: string, authId: string, amount: string): LedgerEvent => ({ id, day: 1, type: 'AUTHORIZATION', ...aed, authId, amount, valueDate: 1 });
  const settle = (id: string, authId: string, amount: string): LedgerEvent => ({ id, day: 1, type: 'SETTLEMENT', ...aed, authId, amount, valueDate: 1 });
  engine.ingest(auth('A1', 'H1', '100.00'));
  assert.equal(engine.ingest(settle('S1', 'H1', '100.01')).code, 'SETTLEMENT_EXCEEDS_HOLD');
  assert.equal(engine.ingest(settle('S2', 'H1', '100.00')).outcome, 'APPLIED');
  assert.equal(engine.ingest(settle('S3', 'H1', '1.00')).code, 'AUTH_NOT_OPEN');
  assert.equal(engine.ingest(auth('A2', 'H2', '5000.00')).outcome, 'DECLINED');
  assert.equal(engine.ingest(settle('S4', 'H2', '1.00')).code, 'AUTH_NOT_OPEN');
  assert.equal(engine.ingest(auth('A3', 'H1', '1.00')).code, 'DUPLICATE_AUTH');
});

test('authorization boundary: available exactly zero after the hold is approved', () => {
  const engine = new LedgerEngine(ACCOUNTS);
  engine.ingest(ev('E1'));
  const r = engine.ingest({ id: 'A', day: 1, type: 'AUTHORIZATION', ...aed, authId: 'H', amount: '1200.00', valueDate: 1 });
  assert.equal(r.outcome, 'APPLIED');
  assert.equal(engine.availableBalance('ACC-001'), 0n);
  const r2 = engine.ingest({ id: 'B', day: 1, type: 'AUTHORIZATION', ...aed, authId: 'H2', amount: '0.01', valueDate: 1 });
  assert.equal(r2.outcome, 'DECLINED');
});

test('overdraft fee: at most one net fee per account per value day across repeated nights', () => {
  const engine = replay();
  const net = new Map<string, bigint>();
  for (const e of engine.entries()) {
    if (e.kind === 'OVERDRAFT_FEE' || e.kind === 'FEE_REFUND') {
      const k = `${e.account}|${e.valueDate}`;
      net.set(k, (net.get(k) ?? 0n) + e.amount);
    }
  }
  for (const [k, v] of net) assert.ok(v === 0n || v === -2500n, `${k} net fee ${v}`);
  // Nights 1-4 must not repeat a fee: only night 5 books fees.
  const booked = engine.entries().filter((e) => e.kind === 'OVERDRAFT_FEE').map((e) => e.bookedOn);
  assert.deepEqual(booked, [5, 5, 5]);
});

test('overdraft fee: fee value date equals the day assessed, and the fee counts toward later days', () => {
  const engine = replay(EVENTS.slice(0, 8), { finish: false });
  // Night 5 has not run yet (the clock is on Day 5), so there are no fees.
  assert.equal(engine.entries().filter((e) => e.kind === 'OVERDRAFT_FEE').length, 0);
  engine.finish();
  const fees = engine.entries().filter((e) => e.kind === 'OVERDRAFT_FEE');
  assert.deepEqual(fees.map((f) => f.valueDate), [2, 4, 5, 6]); // no E9 in this run, so Day 6 is negative too
  // Day 3 before fees is +30.00; the Day 2 fee takes it to +5.00, so no fee on Day 3.
  assert.equal(engine.ledgerBalance('ACC-001', 3), 500n);
});

test('overdraft on a BHD account: no fee is invented, an error is reported once per day', () => {
  const engine = new LedgerEngine(ACCOUNTS);
  engine.ingest({ id: 'D', day: 1, type: 'DEBIT', account: 'ACC-002', currency: 'BHD', amount: '1.000', valueDate: 1 });
  engine.finish();
  assert.equal(engine.entries().filter((e) => e.kind === 'OVERDRAFT_FEE').length, 0);
  const errs = engine.diagnostics().filter((d) => d.code === 'NO_FEE_SCHEDULE');
  assert.equal(errs.length, 6, 'Days 1-6 each reported once, not once per night per day');
});

test('late event is booked on the current day with its value date kept, and a notice is recorded', () => {
  const engine = replay();
  const e10 = engine.events().find((r) => r.event.id === 'E10')!;
  assert.equal(e10.processedOn, 6);
  assert.ok(engine.diagnostics().some((d) => d.eventId === 'E10' && d.code === 'LATE_EVENT'));
  assert.deepEqual(engine.entries().filter((e) => e.sourceEventId === 'E10').map((e) => e.valueDate), [5, 5, 5]);
});

test('interest: rounded daily accruals sum exactly to the capitalized credit on each account', () => {
  const engine = replay();
  for (const acc of ACCOUNTS) {
    const sum = engine.accruals().filter((a) => a.account === acc.id).reduce((s, a) => s + a.amount, 0n);
    const cap = engine.entries().filter((e) => e.account === acc.id && e.kind === 'INTEREST_CAPITALIZATION');
    assert.equal(cap.length, 1);
    assert.equal(cap[0]!.amount, sum);
    assert.equal(cap[0]!.valueDate, 6);
  }
});

test('interest: no accrual on zero or negative balances', () => {
  const engine = replay(EVENTS.filter((e) => e.id !== 'E9'));
  const acc1 = engine.accruals().filter((a) => a.account === 'ACC-001' && a.basis <= 0n);
  assert.ok(acc1.length > 0);
  assert.ok(acc1.every((a) => a.amount === 0n || a.kind === 'RESTATEMENT'));
  // After restatement, net accrual for each negative day is zero.
  for (const d of [2, 4, 5, 6]) {
    const net = engine.accruals().filter((a) => a.account === 'ACC-001' && a.forDay === d).reduce((s, a) => s + a.amount, 0n);
    assert.equal(net, 0n, `Day ${d}`);
  }
});
