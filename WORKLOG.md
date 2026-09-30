# WORKLOG

Times are local (UTC+04:00), taken from the shell clock (`date -Iseconds`) as each step happened.


| Time (2026-10-01) | Entry |
|---|---|
| 01:32 | Checked toolchain: Node 20.13.1 cannot run `.ts` files directly, so the build compiles with `tsc` and tests use the built-in `node:test`. The only dependencies are `typescript` and `@types/node`. |
| 01:34 | Scaffolded package.json, tsconfig (strict, `noUncheckedIndexedAccess`), .gitignore. Installed dev deps. |

## Hand trace done before coding (01:31)

ACC-001 value-dated closing balances, before any fees:

- Without E7: D1 250.00, D2 250.00, D3 650.00, D4 465.00, D5 465.00, D6 465.00
- With E7 (booked Day 5, value Day 2): D2 −370.00, D3 30.00, D4 −155.00, D5 −155.00
- Fees applied in value-date order: D2 −370 → fee → D3 5.00 → D4 −180.00 → fee → D5 −205.00 → fee. That is **three** fees, not one.
- At E8, available = −155.00 − 0 holds − 90.00 < 0, so Auth-B is **declined**.
- E10: 10.000 / 3 cannot be split evenly at 3 dp. The parts are 3.333 + 3.333 + 3.334.
