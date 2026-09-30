# NUMBERS

Every constant the engine uses, where it lives, and why that value was chosen over **half of it**. Constants the brief fixes are marked *given*. For those, "why not half" means "what would break if someone halved it".

All tunables are in [`src/policy.ts`](src/policy.ts) or [`src/money.ts`](src/money.ts). Nothing numeric is hard-coded in the engine logic.

## Currency and precision

| Constant | Value | Where |
|---|---|---|
| AED scale | 2 (fils) *given* | `CURRENCY_SCALE.AED` |
| BHD scale | 3 (fils) *given* | `CURRENCY_SCALE.BHD` |

**Why not half:** 1 decimal place for AED could not hold 0.19 (a real daily accrual here), 0.01 would stop being the smallest unit, and every accrual would be forced to 0.1-steps. Scale 1 (half-ish of 3) for BHD would turn 3.333 + 3.333 + 3.334 into 3.3 + 3.3 + 3.4. Both scales are ISO 4217 minor units. Amounts are stored as `bigint` minor-unit counts, so no value is ever stored more precisely than its currency allows, and floating point never touches money.

## Fees

| Constant | Value | Where |
|---|---|---|
| Overdraft fee, AED | 2 500 fils = 25.00 *given* | `POLICY.overdraftFee.AED` |
| Overdraft fee, BHD | **not set** | deliberately absent |
| Fee lookback | whole window (Day 1 → tonight) | `trueUpFees` loop bounds |

**Why no BHD fee, and not "half" of anything:** any BHD number would be invented. 25.000 BHD is about 25× the AED fee in value, and there is no FX rate to convert with. Leaving it unset makes the engine raise `NO_FEE_SCHEDULE` instead of guessing (AMBIGUITIES §A8).

**Why a whole-window lookback, not half (3 days):** backdating reaches up to 3 days back in this stream. E7 is booked Day 5 and valued Day 2, so a 3-day lookback from night 5 (Days 3–5) *misses* Day 2 and never charges the Day 2 fee. On night 6, E9 needs Day 2 refunded, which is 4 days back. Half the window fails on both. In a six-day window, scanning all six days costs nothing. A production system would bound this by a backdating limit, and the lookback would have to be at least that limit.

## Interest

| Constant | Value | Where |
|---|---|---|
| Daily rate | 4 / 10 000 = 0.04% *given* | `POLICY.dailyInterest` |
| Rounding mode | half-even | `divRoundHalfEven` |
| Rounding points | once per account per day | `dailyInterestOn` |
| Capitalization day | Day 6 (window end) *given* | `endOfDay` |

**Why a fraction and not a float:** 0.0004 is not exact in binary floating point. Stored as the exact ratio 4/10 000 and applied to bigint minor units, the only rounding is the one the brief asks for.

**Why not half the rate (0.02% = 2/10 000):** it is given. Halving it would give ACC-001 accruals of 0.05, 0.05, 0.13, 0.09, 0.09, 0.09 = 0.50, not 1.03.

**Why half-even:** "Half" here means ties. No accrual in this stream lands exactly on a half minor unit (0.10, 0.10, 0.26, 0.186, 0.186, 0.186 AED; 0.004, 0.004 BHD), so half-up would print the same numbers. Half-even is the default for money because, over many ties, it does not drift upward.

**Why round per day, not once at the end:** the brief requires rounded daily accruals that sum to the credit. Rounding once gives 1.02 against lines that add to 1.03 (REJECTED.md, C8).

## Authorizations and settlements

| Constant | Value | Where |
|---|---|---|
| Approval threshold | available after hold ≥ 0 *given* | `applyAuthorization` |
| Settlement over-hold tolerance | 0 fils | `POLICY.settlementOverHoldTolerance` |
| Hold expiry | none within the window | (no timer exists) |

**Why tolerance 0 (half of 0 is 0, so why not larger):** some card schemes allow over-settlement (tips, fuel pumps, often 15–20%). Any tolerance above 0 lets a settlement debit money that was never reserved. That gets around the brief's rule that an auth is only approved while available stays ≥ 0. With no scheme rules in scope, 0 is the only value that keeps that guarantee.

**Why no hold expiry:** real holds expire after days to weeks. With a 6-day window, any expiry of 3 days (half) or more never triggers for Auth-A, which settles 2 days after approval. An expiry under 2 days would release Auth-A before its settlement arrived, and C3 (accepted) would then fail. No expiry is the only choice that doesn't need a number the brief doesn't give.

## Instalments

| Constant | Value | Where |
|---|---|---|
| E10 instalment count | 3 *given* | `scenario.ts` |
| Leftover placement | last instalment(s) | `splitEvenly` |
| Max spread between instalments | 1 minor unit | `splitEvenly` |

**Why the leftover goes last:** the first instalments then match the plain per-part division (3.333), which is what a reader checks first. The last one absorbs the difference. Putting it first (3.334, 3.333, 3.333) is equally valid. I chose last because a reconciler looking for "the odd one" usually looks at the final line.

**Why 1 minor unit of spread, not more:** this is the smallest possible spread when the total does not divide evenly. Any allocation with a larger spread is less equal than the brief asks.

## Window

| Constant | Value | Where |
|---|---|---|
| First day | 1 *given* | `POLICY.window.first` |
| Last day | 6 *given* | `POLICY.window.last` |

**Why not half (3 days):** E5–E10 would all fall outside the window and be rejected (`OUTSIDE_WINDOW`), and capitalization would happen on Day 3.

## Numbers the replay produces (for checking by hand)

| Figure | Value |
|---|---|
| ACC-001 Day 2 closing, end of Day 5, before fees (C1) | −370.00 |
| Fees caused by E7 | 3 (value Days 2, 4, 5), 75.00 total, all refunded night 6 |
| ACC-001 rounded daily accruals | 0.10, 0.10, 0.26, 0.19, 0.19, 0.19 = 1.03 |
| ACC-001 unrounded accrual total (the C8 trap) | 1.018 → would round to 1.02 |
| ACC-001 final closing (Day 6, after capitalization) | 466.03 |
| ACC-002 instalments | 3.333 + 3.333 + 3.334 = 10.000 |
| ACC-002 accruals | Day 5 0.004, Day 6 0.004 = 0.008 |
| ACC-002 final closing | 10.008 |
| Ledger entries at close | 17 |
