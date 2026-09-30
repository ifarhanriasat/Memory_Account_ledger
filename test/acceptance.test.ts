// One test per acceptance criterion from the brief. ACCEPTED criteria are
// asserted as written. For REFUSED criteria (see REJECTED.md), the test
// asserts what actually happens and shows why the criterion cannot hold.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { divRoundHalfEven } from '../src/money';
import { EVENTS, replay } from '../src/scenario';

const without = (...ids: string[]) => EVENTS.filter((e) => !ids.includes(e.id));
const upTo = (id: string) => EVENTS.slice(0, EVENTS.findIndex((e) => e.id === id) + 1);

describe('C1 ACCEPTED: Day 2 closing, at end of Day 5 before fees, is AED -370.00', () => {
  test('holds', () => {
    // E1..E8 are all the events that arrive by the end of Day 5. finish:false stops
    // before night 5 runs, so no fee exists yet.
    const engine = replay(upTo('E8'), { finish: false });
    assert.equal(engine.currentDay, 5);
    assert.equal(engine.entries().filter((e) => e.kind === 'OVERDRAFT_FEE').length, 0);
    assert.equal(engine.ledgerBalance('ACC-001', 2), -37000n);
  });
});

describe('C2 REFUSED: "E7 causes exactly one overdraft fee, on Day 2"', () => {
  test('E7 causes three fees: Days 2, 4 and 5', () => {
    const withE7 = replay(upTo('E8'));
    const withoutE7 = replay(without('E7', 'E9', 'E10'));
    const feeDays = (e: ReturnType<typeof replay>) =>
      e.entries().filter((x) => x.kind === 'OVERDRAFT_FEE' && x.bookedOn <= 5).map((x) => x.valueDate);
    assert.deepEqual(feeDays(withoutE7), []);
    assert.deepEqual(feeDays(withE7), [2, 4, 5]);
    assert.notEqual(feeDays(withE7).length, 1);
  });
});

describe('C3 ACCEPTED: Day 4 settlement of Auth-A is accepted', () => {
  test('holds', () => {
    const engine = replay();
    assert.equal(engine.events().find((r) => r.event.id === 'E5')!.outcome, 'APPLIED');
    const s = engine.authState('Auth-A')!;
    assert.equal(s.status, 'SETTLED');
    assert.equal(s.settled, 18500n);
    const entry = engine.entries().find((e) => e.sourceEventId === 'E5')!;
    assert.equal(entry.amount, -18500n);
    assert.equal(entry.valueDate, 4);
  });
});

describe('C4 ACCEPTED: settlement for an unknown auth is rejected; no funds leave', () => {
  test('holds', () => {
    const engine = replay();
    const e6 = engine.events().find((r) => r.event.id === 'E6')!;
    assert.equal(e6.outcome, 'REJECTED');
    assert.equal(e6.code, 'AUTH_NOT_FOUND');
    assert.equal(engine.entries().filter((e) => e.sourceEventId === 'E6').length, 0);
    assert.equal(engine.authState('Auth-Z'), undefined, 'no auth record is invented for Auth-Z');
    // Day 4 closes at 465.00, not 285.00.
    assert.equal(engine.dayReports()[3]!.accounts[0]!.closingLedger, 46500n);
  });
});

describe('C5 ACCEPTED: an approved Auth-B hold reduces available balance, not ledger balance', () => {
  test('in the given stream Auth-B is declined, so the condition is never met', () => {
    assert.equal(replay().authState('Auth-B')!.status, 'DECLINED');
  });
  test('when Auth-B is approved (stream without E7), ledger is unchanged and available drops by 90.00', () => {
    const engine = replay(without('E7', 'E8', 'E9'), { finish: false });
    const ledgerBefore = engine.ledgerBalance('ACC-001', 5);
    const availableBefore = engine.availableBalance('ACC-001');
    engine.ingest(EVENTS.find((e) => e.id === 'E8')!);
    assert.equal(engine.authState('Auth-B')!.status, 'APPROVED');
    assert.equal(engine.ledgerBalance('ACC-001', 5), ledgerBefore);
    assert.equal(engine.availableBalance('ACC-001'), availableBefore - 9000n);
    engine.finish();
    assert.equal(engine.authState('Auth-B')!.status, 'APPROVED', 'still held at window end: never settled');
    assert.equal(engine.activeHolds('ACC-001'), 9000n);
  });
});

describe('C6 REFUSED: "after E9, all balances and fees return to their pre-E7 values"', () => {
  const actual = replay();
  const counterfactual = replay(without('E7', 'E9')); // the world E7 never touched

  test('what does return: value-dated ledger balances and net fees', () => {
    for (let d = 1; d <= 6; d++) {
      assert.equal(actual.ledgerBalance('ACC-001', d), counterfactual.ledgerBalance('ACC-001', d), `Day ${d}`);
    }
  });
  test('fees do not return: three fees and three refunds are on the ledger for good', () => {
    const kinds = (e: typeof actual) => e.entries().filter((x) => x.account === 'ACC-001').map((x) => x.kind);
    assert.equal(kinds(actual).filter((k) => k === 'OVERDRAFT_FEE').length, 3);
    assert.equal(kinds(actual).filter((k) => k === 'FEE_REFUND').length, 3);
    assert.equal(kinds(counterfactual).filter((k) => k === 'OVERDRAFT_FEE').length, 0);
  });
  test('available balance does not return: Auth-B stays declined', () => {
    assert.equal(actual.authState('Auth-B')!.status, 'DECLINED');
    assert.equal(counterfactual.authState('Auth-B')!.status, 'APPROVED');
    assert.notEqual(actual.availableBalance('ACC-001'), counterfactual.availableBalance('ACC-001'));
  });
  test('what was reported on night 5 stays reported: -230.00, not 465.00', () => {
    assert.equal(actual.dayReports()[4]!.accounts[0]!.closingLedger, -23000n);
  });
});

describe('C7 REFUSED: "the three BHD instalments must each be BHD 3.334"', () => {
  test('3 x 3.334 = 10.002, which is not the 10.000 instructed', () => {
    assert.equal(3n * 3334n, 10002n);
    const parts = replay().entries().filter((e) => e.sourceEventId === 'E10').map((e) => e.amount);
    assert.deepEqual(parts, [3333n, 3333n, 3334n]);
    assert.equal(parts.reduce((a, b) => a + b, 0n), 10000n);
  });
});

describe('C8 REFUSED: "if rounded daily accruals do not sum to the capitalized total, discard the remainder"', () => {
  test('the capitalized total is the sum of rounded accruals, so there is never a remainder to discard', () => {
    const engine = replay();
    const acc = engine.accruals().filter((a) => a.account === 'ACC-001');
    const perDay = [1, 2, 3, 4, 5, 6].map((d) => acc.filter((a) => a.forDay === d).reduce((s, a) => s + a.amount, 0n));
    assert.deepEqual(perDay, [10n, 10n, 26n, 19n, 19n, 19n]);
    const cap = engine.entries().find((e) => e.account === 'ACC-001' && e.kind === 'INTEREST_CAPITALIZATION')!;
    assert.equal(cap.amount, 103n);
  });
  test('the trap: rounding the unrounded total would give 1.02, not 1.03', () => {
    // Unrounded: 0.10 + 0.10 + 0.26 + 3 x 0.186 = 1.018 AED, which rounds to 1.02.
    // Discarding (or absorbing) that 0.01 difference is what the criterion
    // proposes, and the brief's own rule forbids it.
    const basisTimesRate = [25000n, 25000n, 65000n, 46500n, 46500n, 46500n].reduce((s, b) => s + b * 4n, 0n);
    const roundedOnce = divRoundHalfEven(basisTimesRate, 10000n); // 101.8 fils -> 102
    assert.equal(roundedOnce, 102n);
    const cap = replay().entries().find((e) => e.account === 'ACC-001' && e.kind === 'INTEREST_CAPITALIZATION')!;
    assert.equal(cap.amount - roundedOnce, 1n, 'the 0.01 that criterion C8 would throw away');
  });
});
