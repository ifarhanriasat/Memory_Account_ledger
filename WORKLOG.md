# WORKLOG

Times are local (UTC+04:00), taken from the shell clock (`date -Iseconds`) as each step happened.


| Time (2026-10-01) | Entry |
|---|---|
| 01:32 | Checked toolchain: Node 20.13.1 cannot run `.ts` files directly, so the build compiles with `tsc` and tests use the built-in `node:test`. The only dependencies are `typescript` and `@types/node`. |
| 01:34 | Scaffolded package.json, tsconfig (strict, `noUncheckedIndexedAccess`), .gitignore. Installed dev deps. Commit `ea9e783`. |
| 01:35 | `money.ts`: bigint minor units, parse/format, half-even division, `splitEvenly`. `policy.ts` holds all constants. 5 money tests pass. Checked that Node 20's `node --test <dir>` finds compiled tests. Commit `77734e0`. |
| 01:36 | `ledger.ts`: append-only logs (entries, events, auth transitions, accruals), auth/settlement/reversal handlers, nightly fee true-up (fee or refund for the difference only), daily accrual plus restatement and capitalization. Swapped a string-matching dedupe for NO_FEE_SCHEDULE errors for a keyed set before committing. Commit `2d90df1`. |
| 01:37 | Scenario, report and replay. First run matched the 01:31 hand trace exactly (ACC-001 −230.00 on night 5, 466.03 at close; three fees then three refunds; Auth-B declined). The first history table hid the night-5 −395.00 for Day 2, so I replaced it with the value-day × night matrix (REJECTED §B5). Commit `c00717c`. |
| 01:39 | Engine tests plus one test per acceptance criterion. 32/32 passed on the first run. I treated that as a reason to re-read the tests, and found the C8 "trap" assertion was a tautology; replaced it (REJECTED §B6). Commit `1303876`. |
| 01:39 | Known failing test: swapping same-day E7/E8 flips Auth-B from DECLINED to APPROVED. Confirmed it fails on the intended assertion (ledger balances match; auth status differs). Removed a meaningless `* 0n` term I had left in its loop. Commit `5c09655`. |
| 01:42 | REJECTED.md and AMBIGUITIES.md. Wrote them against the actual replay. Ran a counterfactual (no E7/E9) to get C6's figure right: available would close at 376.03 vs 466.03 as replayed. My first draft said 375.00, which was the Day 5 figure, not the close. |
| 01:43 | README and NUMBERS.md. Checked the "half the rate" claim by hand (0.50 vs 1.03) and the 17-entry count. |
| 01:43 | Clean rebuild (`rm -rf dist`): `npm test` gives 33 tests, 32 pass, 1 fail (the deliberate one), exit 1. `npm run test:green` exits 0. `npm run replay` prints all six days. |

## Hand trace done before coding (01:31)

ACC-001 value-dated closing balances, before any fees:

- Without E7: D1 250.00, D2 250.00, D3 650.00, D4 465.00, D5 465.00, D6 465.00
- With E7 (booked Day 5, value Day 2): D2 −370.00, D3 30.00, D4 −155.00, D5 −155.00
- Fees applied in value-date order: D2 −370 → fee → D3 5.00 → D4 −180.00 → fee → D5 −205.00 → fee. That is **three** fees, not one.
- At E8, available = −155.00 − 0 holds − 90.00 < 0, so Auth-B is **declined**.
- E10: 10.000 / 3 cannot be split evenly at 3 dp. The parts are 3.333 + 3.333 + 3.334.
