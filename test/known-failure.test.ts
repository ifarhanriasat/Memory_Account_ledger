// ============================================================================
// KNOWN FAILING TEST. It fails on purpose and is not marked skip/todo, so it
// shows as a real failure in `npm test`. `npm run test:green` leaves it out.
// ============================================================================
//
// Property under test: two events stamped the same business day should give the
// same end-of-day state whatever order they arrive in. E7 (the Day 2-dated
// debit) and E8 (Auth-B) are both stamped Day 5.
//
// Why this design fails it:
//
//   1. An authorization decision happens once, at arrival, against the
//      available balance at that moment (brief: "approved only if available
//      ... remains at or above zero after the hold is applied"). The engine
//      never re-runs that decision.
//      E7 then E8: available -155.00 - 90.00 < 0, so DECLINED.
//      E8 then E7: available 465.00 - 90.00 >= 0, so APPROVED.
//
//   2. The ledger side heals itself: fees are recomputed nightly and refunded
//      (FEE_REFUND) when a backdated change removes the overdraft. The
//      authorization side does not. After E9 reverses E7, the ledger history
//      matches a world without E7, yet Auth-B is still DECLINED. A customer
//      was declined because of a debit the bank later said never happened, and
//      nothing in this core raises that.
//
//   3. There are two ways to make this pass, and neither is free:
//      (a) Re-adjudicate auths after backdated changes. But a decline has
//          already been sent to the merchant, so "approving it later" means
//          nothing at the point of sale. It would be a fiction in the ledger.
//      (b) Order same-day events before processing (e.g. debits after
//          auths). That needs a whole day's events up front, which a real-time
//          auth path never has. It also breaks the brief's "replayed in
//          this order".
//      I chose to keep auth decisions final (REJECTED.md §B1). This test marks
//      the cost of that choice. A fix would at least flag the auths that a later
//      correction invalidated (a DECLINE_UNDERMINED diagnostic) for operations.
//
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENTS, replay } from '../src/scenario';

test('KNOWN FAILURE: same-day arrival order of E7 and E8 does not change Auth-B', () => {
  const asGiven = replay(EVENTS);

  const e7 = EVENTS.findIndex((e) => e.id === 'E7');
  const swapped = [...EVENTS];
  [swapped[e7], swapped[e7 + 1]] = [swapped[e7 + 1]!, swapped[e7]!]; // E8 before E7, same Day 5
  const reordered = replay(swapped);

  // The ledger side agrees: final value-dated balances match in both orders.
  for (let d = 1; d <= 6; d++) {
    assert.equal(asGiven.ledgerBalance('ACC-001', d), reordered.ledgerBalance('ACC-001', d), `ledger Day ${d}`);
  }

  // The authorization side does not. This assertion fails:
  //   asGiven   -> Auth-B DECLINED (decided after E7 made available negative)
  //   reordered -> Auth-B APPROVED (decided before E7 arrived)
  assert.equal(asGiven.authState('Auth-B')!.status, reordered.authState('Auth-B')!.status,
    'Auth-B outcome depends on arrival order within Day 5 (see file header)');
});
