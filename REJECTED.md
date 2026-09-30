# REJECTED

## Part A: Acceptance criteria

I checked each criterion against the brief's non-negotiable rules and the event stream. I refused four. Each criterion has a matching test in `test/acceptance.test.ts`. Tests for accepted criteria assert the criterion as written. Tests for refused criteria assert what really happens.

| # | Criterion (abridged) | Verdict |
|---|---|---|
| C1 | Day 2 closing at end of Day 5, before fees, is AED −370.00 | **Accepted** |
| C2 | E7 causes exactly one overdraft fee, on Day 2 | **Refused** |
| C3 | Day 4 settlement of Auth-A must be accepted | **Accepted** |
| C4 | Settlement for an auth ID not in the ledger is rejected; funds do not leave | **Accepted, with a caveat** |
| C5 | If Auth-B is approved, its hold reduces available but not ledger balance | **Accepted** (the condition never occurs in this stream) |
| C6 | After E9, all balances and fees return to pre-E7 values | **Refused** |
| C7 | The three BHD instalments must each be BHD 3.334 | **Refused** |
| C8 | If rounded accruals don't sum to the capitalized total, discard the remainder | **Refused** |

### C2: refused. E7 causes three fees, not one.

E7 is booked on Day 5 with value date Day 2. It lowers **every** value day from Day 2 onward by 620.00, not only Day 2. The brief defines the fee test per day as "that day's closing ledger balance (all entries with value_date ≤ that day)". With E7 in place, walking forward and letting each fee count toward later days:

| Value day | Before fees | Fees on earlier days | Closing before this day's fee | Fee? |
|---|---|---|---|---|
| 1 | 250.00 | 0 | 250.00 | no |
| 2 | −370.00 | 0 | −370.00 | **yes** |
| 3 | 30.00 | −25.00 | 5.00 | no |
| 4 | −155.00 | −25.00 | −180.00 | **yes** |
| 5 | −155.00 | −50.00 | −205.00 | **yes** |

Without E7, none of these days is negative. So E7 causes fees on Days 2, 4 and 5. "Exactly one, on Day 2" only holds if you check Day 2 and nothing else. That breaks the brief's own per-day rule. Even ignoring the fee cascade, Day 4 alone (−155.00 before fees) is negative.

### C6: refused. Some things return, but not "all balances and fees".

After E9, the **value-dated ledger balances** do match a world without E7. This design gets that by refunding fees, and the test checks it. The criterion still fails on three counts:

1. **Fees.** The ledger is append-only. Three `OVERDRAFT_FEE` entries were booked on night 5 and stay forever. E9 adds three `FEE_REFUND` entries on top. Net fees go back to zero, but the fees themselves are not "returned to pre-E7 values". Six extra records exist that did not exist before E7.
2. **Available balance.** Auth-B (E8) was judged on Day 5 against an available balance of −155.00 and **declined**. Without E7 it would have been approved (465.00 − 90.00 ≥ 0), and its 90.00 hold would still be active at window end, so available would close at 376.03. As replayed, available closes at 466.03 (465.00 plus 1.03 capitalized interest) with no hold. An authorization decision is a point-in-time answer already given to a merchant. A later reversal cannot undo it (see the known failing test).
3. **What was reported.** Night 5's closing balance was −230.00. That report was made and cannot be un-made. Only the value-dated *history* returns to pre-E7 figures.

"All balances and fees return" can only be true if the ledger is allowed to delete or edit records. The brief forbids that ("No event record is ever mutated or deleted").

### C7: refused. 3 × 3.334 = 10.002, not 10.000.

E10 instructs a BHD 10.000 credit in three equal instalments. At 3 decimal places, 10.000 / 3 = 3.333… has no exact representation. Making every instalment 3.334 credits 10.002 BHD. That creates 0.002 BHD out of nothing and posts a credit that differs from the instruction. It also breaks "amounts stored and rounded to their own precision", which only works if rounding does not change totals.

What I do instead: 3.333 + 3.333 + 3.334 = 10.000. The one leftover fils goes on the last instalment, and an `INSTALMENTS_NOT_EQUAL` notice says the split could not be equal. The total is always kept; equality is kept as far as the currency allows. See AMBIGUITIES §A25.

### C8: refused. It contradicts a non-negotiable rule.

The brief says: "The rounded daily accruals must sum exactly to the capitalized total." C8 plans for the case where they do not, and then throws money away. Two problems:

- Under the rule, the case cannot happen. This engine *defines* the capitalized credit as the sum of the rounded accrual records, and checks that as an invariant (`capitalizeInterest` throws if it is ever broken).
- The trap is real here. For ACC-001 the rounded daily accruals are 0.10 + 0.10 + 0.26 + 0.19 + 0.19 + 0.19 = **1.03**. The unrounded total is 1.018, which rounds to **1.02**. An implementation that capitalizes `round(sum)` gets 1.02, then "discards" the 0.01 difference, and ships a customer statement whose accrual lines do not add up to the credit. The C8 test pins this: the capitalized amount is 1.03 and the 0.01 is kept.

### Accepted criteria: notes

- **C1.** Holds as written. "Evaluated at end of Day 5 and before any fee is assessed" means after all Day 5 events (E1–E8) and before the night-5 fee run. Fees for Days 2, 4 and 5 are booked in that run, so once it finishes, Day 2 reads −395.00. The report's history matrix shows both figures.
- **C3.** Auth-A was approved on Day 2 (available 250.00 − 200.00 = 50.00 ≥ 0). It settles for 185.00, which is within the 200.00 hold. The settlement is accepted and the whole hold is released.
- **C4.** Accepted for this core. Caveat: in real card schemes a "force post" (a settlement with no matching auth) is often binding on the issuer, so "the funds must not leave" is not always true in practice. This core has no scheme or chargeback model, so rejecting and recording `AUTH_NOT_FOUND` is the only safe choice. The engine goes further than C4: it also rejects settlements against declined, already-settled or other-account auths, and over-settlements. C4 as worded ("not present in the ledger") would let those through.
- **C5.** True as a statement of hold semantics, and tested on a counterfactual stream where Auth-B *is* approved. In the stream as given, Auth-B is declined (see C6 point 2), so the "if" never happens.

---


### B. "Fees are final": never refund (design time)
The simplest reading of "assessed once per day" is: book the fee and never look back. I dropped this because after E9 the ledger would keep a Day 2 fee while Day 2 closes at +250.00. The rule "assessed when that day's closing balance is negative" would then be false for the final ledger, with no way to tell a valid fee from a stale one. The fee true-up I chose (recompute the fee set nightly, book only the difference as FEE or FEE_REFUND) keeps the rule true of the ledger as it now stands, and never touches past entries.

### B1. Re-judging authorizations after backdated changes (design time)
Symmetry with the fee choice above argues for re-running Auth-B once E9 lands. I refused: a decline has already been returned to the point of sale, and flipping it to APPROVED in the ledger would record a hold no merchant is relying on. The cost of this choice is written up in `test/known-failure.test.ts`.

### B2. Computing interest only at capitalization (design time)
Computing all six accruals once, at end of Day 6, from final balances would be simpler, and the totals would be the same. I dropped it because the nightly output would have no accrual to show, and there would be no daily record to audit. Instead, each night writes a `DAILY` accrual, and capitalization writes `RESTATEMENT` records for days a backdated entry changed (ACC-001 Day 5, ACC-002 Day 5).

### B3. Rejecting E10 as out of order (design time)
E10 is stamped Day 5 but arrives after E9 (Day 6). Rejecting it would be the strictest reading of a monotonic clock, but it would silently lose a customer's 10.000 BHD credit. I book it on Day 6 with its Day 5 value date and raise a `LATE_EVENT` notice.

### B4. Rounding the accrual total at capitalization (design time)
Covered under C8. It gives 1.02 against accrual lines that add up to 1.03.

### B5. History table showing "first reported vs final" only (mid-build, commit `c00717c`)
The first report compared each day's closing on the night it was first reported with the final ledger. Running it showed a hole. Day 2 read 250.00 on night 2 and 250.00 at the end, so the table showed no change. But on night 5 it had read −395.00. The restatement was invisible. Before committing, I replaced the table with a value-day × night matrix.

### B6. Tautological assertion in the C8 test (mid-build, commit `1303876`)
The first C8 "trap" test ended with `assert.notEqual(102n, 103n)`, which proves nothing. The first full run passed 32/32 and I re-read the tests looking for exactly this kind of hollow pass. I replaced it with a computed `round(sum)` compared against the capitalized entry, before committing.
