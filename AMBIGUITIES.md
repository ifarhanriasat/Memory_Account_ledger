# AMBIGUITIES

Each entry gives the ambiguity, the options I weighed, the resolution, and where it lives in code or tests. Section references like "§A4" are used across the other documents.

## Time and ordering

### A1. What an event's "Day" means, and when a day closes
The stream gives each event a Day and a separate value_date. **Resolution:** the Day is the *processing (booking) day*. The engine keeps a clock. When an event arrives for a later day, the engine first runs end-of-day ("night") processing for each day it passes: fees, then interest accrual. `finish()` closes the remaining days through Day 6. The value_date only decides which days' balances an entry counts toward. `LedgerEngine.ingest`, `endOfDay`.

### A2. E10 is stamped Day 5 but arrives after E9 (Day 6)
"Replayed in this order" conflicts with the stamps: time would run backward. Options: (a) reject as out of order; (b) rewind and re-run night 5; (c) book on the current day, keep the value date. **Resolution: (c).** (a) loses a real credit (REJECTED §B5). (b) would re-issue a night-5 report that was already published. Night 6 gets a `LATE_EVENT` notice, and interest for Day 5 is restated (A11).

### A3. Backdated entries: are past days re-checked for fees?
E7 (booked Day 5, value Day 2) makes Day 2 negative long after night 2 has passed. The brief's fee test is phrased by value date ("all entries with value_date ≤ that day"), and criterion C1/C2 talk about a Day 2 fee. **Resolution:** every night re-checks *every* value day from Day 1 to tonight, not only tonight. (NUMBERS.md explains why the lookback is the whole window.)

### A4. "Booked with value_date equal to the day assessed": which day?
It could mean the processing day that ran the check (Day 5 for E7's effects) or the value day found negative (Day 2). **Resolution:** the value day found negative. A Day 2 overdraft gets a fee valued Day 2, even though it is booked on Day 5. This is the only reading under which "once per day" and C1/C2's "on Day 2" make sense. `bookedOn` records the processing day separately, so both facts are kept.

### A5. Does one day's fee count toward the next day's balance?
The fee is a ledger entry with a value date, so by the brief's own definition it is in "all entries with value_date ≤" later days. **Resolution:** yes. Fees are worked out in value-day order, and each fee counts toward later days. This decides the outcome: the Day 2 fee pushes Day 3 from 30.00 to 5.00 (still positive), and Day 4 from −155.00 to −180.00.

### A6. A backdated correction removes an overdraft that was already charged
The brief says when a fee is assessed, never when it is withdrawn. **Resolution:** each night the engine recomputes the set of days that deserve a fee and books only the difference. A new negative day gets an `OVERDRAFT_FEE`; a day no longer negative gets a `FEE_REFUND` (same value date as the fee, linked through `offsets`). Nothing is edited. After E9, the three fees from night 5 are refunded on night 6. See REJECTED §B2 for the other option.

### A7. "Once per day per account" when fees can be refunded
Can a day be charged, refunded and charged again? **Resolution:** the net fee on any account and value day is always 0 or −25.00. A charge, refund, charge sequence is possible if backdated entries keep flipping a day's sign. Each step is a separate record, but only one fee is ever outstanding. The test "at most one net fee per account per value day" pins this.

### A8. Overdraft fee on the BHD account
The fee is priced "AED 25.00", but ACC-002 is BHD and no FX rate is given. Options: charge 25.000 BHD (about 25× the intended cost); convert at an invented rate; charge nothing. **Resolution:** no BHD fee is configured. If a BHD account closes negative, the engine books nothing and raises a `NO_FEE_SCHEDULE` error once per account per day, so a person has to decide. It does not happen in this stream, but a test covers it.

## Balances

### A9. "Closing ledger balance" printed per day, when history changes
Day 5's closing was −230.00 on night 5 and is 465.00 in the final ledger. Which is "the" Day 5 closing? **Resolution:** print both. Each night's block shows the balance as known that night, since that is what was reported then. The summary matrix at the end shows every value day as known at the end of every night, so all restatements are visible.

### A10. Which ledger balance "available balance" uses
Ledger balance at what date? **Resolution:** all entries with value_date ≤ the current processing day, minus holds on APPROVED, unsettled auths. Future-dated entries could not exist anyway, because they are rejected (A20).

## Interest

### A11. Daily accrual when a backdated entry changes a past day
Night 5 accrued 0.00 on ACC-001 (Day 5 was −230.00). After E9, Day 5 is 465.00. **Resolution:** a night's `DAILY` accrual is never edited. At capitalization, each day's accrual is recomputed from the final value-dated balance, and any difference is booked as a `RESTATEMENT` record (ACC-001 Day 5 +0.19; ACC-002 Day 5 +0.004). The net per day equals the rounded accrual on the final balance, and the capitalized credit equals the sum of all records exactly.

### A12. Rounding mode
The brief says "rounded" without a mode. **Resolution:** half-even (banker's rounding), applied once per account per day. No accrual in this stream lands on a half, so half-up would print identical numbers (NUMBERS.md).

### A13. Interest on negative balances
"Positive balances only." **Resolution:** a zero or negative closing earns 0. There is no debit interest; the brief defines none.

### A14. Capitalization date, order at end of Day 6, and compounding
**Resolution:** night 6 runs fee true-up, then Day 6's accrual, then capitalization. The credit is valued Day 6. Day 6's accrual is on the balance *before* capitalization, so there is no interest on interest within the window. Fees are checked before capitalization, so interest cannot cure a Day 6 overdraft. It never matters in this stream: ACC-001 closes Day 6 at +465.00. The printed Day 6 closing includes the capitalized interest.

## Authorizations and settlements

### A15. Does a decline count as an "error"?
**Resolution:** no. A decline is a correct outcome. It appears as event outcome `DECLINED (INSUFFICIENT_AVAILABLE)` and in the authorization states, not in the errors list.

### A16. Partial settlement and the leftover hold
Auth-A holds 200.00 and settles 185.00. Does the 15.00 stay held? **Resolution:** a settlement closes the auth and releases the whole hold. Keeping 15.00 held with nothing left to settle it would lock the funds indefinitely.

### A17. Over-settlement, double settlement, declined-auth settlement
The brief is silent. **Resolution:** reject all three (`SETTLEMENT_EXCEEDS_HOLD`, `AUTH_NOT_OPEN`). Settling more than the hold would debit funds that were never reserved, getting around the rule that available must stay ≥ 0. Tolerance is 0 (NUMBERS.md).

### A18. Does a settlement re-check available balance?
**Resolution:** no. The funds were reserved when the auth was approved; a settlement within the hold always posts. This is why Auth-A's settlement goes through even though, in value-date terms, Day 4 was later driven negative by E7.

### A19. Settlement with no authorization (Auth-Z)
Criterion C4 says reject. In real card schemes, force-posts can bind the issuer. **Resolution:** reject with `AUTH_NOT_FOUND`, post nothing, and create no auth record. REJECTED.md (C4) has the caveat.

### A20. Hold expiry and window end
Auth-B "is never settled inside the window". **Resolution:** holds do not expire inside a six-day window. An approved hold stays active at window end and is reported as APPROVED. (Auth-B is declined in this stream, so this applies only to the counterfactual test for C5.)

### A21. Authorization value_date
E3 and E8 carry value dates, but a hold is not a ledger entry. **Resolution:** the value date is validated (inside the window, not in the future) but has no effect on balances.

## Reversals, instalments, input

### A22. What "reverses E7" means
No amount is given. **Resolution:** the reversal posts the exact negation of every ledger entry E7 produced (one entry here), each linked through `offsets`. A second reversal of the same event is rejected. Reversing a rejected or unknown event is rejected.

### A23. Reversal value date earlier than the original
**Resolution:** rejected (`REVERSAL_BEFORE_ORIGINAL`). It would create days on which the reversal exists but the thing it reverses does not. E9 uses the same value date as E7, which is allowed.

### A24. Which events can be reversed
**Resolution:** only CREDIT and DEBIT. Reversing a SETTLEMENT would also have to reopen or cancel the auth, and the brief gives no rule for that, so it is rejected (`REVERSAL_NOT_SUPPORTED`) rather than half-done.

### A25. "Three equal instalments" of an amount that does not divide
10.000 / 3 at 3 dp. **Resolution:** three entries of 3.333, 3.333, 3.334, all valued Day 5, plus an `INSTALMENTS_NOT_EQUAL` notice. The leftover minor unit goes on the *last* instalment (NUMBERS.md). See REJECTED §C7.

### A26. Are instalments separate ledger entries or one?
**Resolution:** separate entries (three lines), all tagged with source event E10, so a statement shows the instalment structure.

### A27. Amount format and precision
Amounts in the brief include thousands separators ("1,200.00"). **Resolution:** commas are stripped. An amount with *more* decimals than the currency carries is rejected (`PRECISION_EXCEEDED`), not rounded: silently rounding an instruction changes what was asked for.

### A28. Future value dates, events outside the window, currency mismatch
**Resolution:** all are rejected with a coded error and never reach the ledger: a value date after the processing day, a booking day or value date outside Days 1–6, or an event currency different from the account's.

### A29. Opening balances of zero
**Resolution:** no opening entry is posted when the opening balance is zero. A non-zero opening balance would be posted as an entry valued Day 1.
