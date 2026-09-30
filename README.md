# In-memory account ledger core

An append-only, in-memory ledger for two accounts (ACC-001 AED, ACC-002 BHD), replayed against a fixed six-day event stream. There is no web layer, no persistence, no UI and no database. TypeScript, standard library only. The only dev dependencies are `typescript` and `@types/node`.

## Run it

Requires Node.js 20 or later.

```sh
npm install          # installs typescript + @types/node only
npm run replay       # compile, replay E1..E10, print the per-day report
npm test             # compile, run every test: 32 pass, 1 fails on purpose
npm run test:green   # the 32 passing tests only (exit code 0)
npm run test:known-failure   # only the deliberate failure
```

`npm test` **exits non-zero by design.** `test/known-failure.test.ts` is a real failing test against this design. It is not marked skip or todo. Its header comment explains what it reveals: an authorization outcome depends on the arrival order of events within a day. Use `npm run test:green` when you need a clean exit code.

## Read the output

`npm run replay` prints one block per business day, produced at that day's end-of-day ("night") run, then a history matrix.

```
=== Day 5 (end of day) ===
Events processed:            each event handled today -> APPLIED / DECLINED / REJECTED (code)
Balances:                    per account, as known tonight
  closing ledger             sum of all entries with value_date <= this day
  holds                      approved, unsettled authorizations
  available                  closing ledger - holds
Fee assessments:             OVERDRAFT_FEE / FEE_REFUND entries booked tonight, with their value day
Interest accruals:           DAILY accrual for tonight; RESTATEMENT and CAPITALIZED lines on Day 6
Authorization states:        every auth decided so far: APPROVED / DECLINED / SETTLED
Errors and notices:          ERROR = event refused or rule blocked; NOTICE = handled, but worth a look
```

**Why there is a matrix at the end.** Backdated entries (E7 on Day 5 for value Day 2, E9 on Day 6 for value Day 2, E10 arriving late) mean a single "Day 2 closing balance" does not exist. It was 250.00 on nights 2–4, −395.00 on night 5, and 250.00 again on night 6. The matrix shows each value day (rows) as known at the end of each night (columns).

What happens in the stream, briefly:

- **Days 1–4:** nothing unusual. Auth-A is approved on Day 2 and settles for 185.00 on Day 4 (hold released). E6's settlement against the unknown Auth-Z is **rejected** (`AUTH_NOT_FOUND`) and nothing is debited.
- **Day 5:** E7 debits 620.00 **backdated to Day 2**. Auth-B (90.00) arrives straight after and is **declined**: available is −155.00. Night 5 re-checks every value day and books **three** overdraft fees (Days 2, 4, 5).
- **Day 6:** E9 reverses E7 back to Day 2. E10 (stamped Day 5, arriving late) credits BHD 10.000 as 3.333 + 3.333 + 3.334. Night 6 refunds all three fees, restates the Day 5 accruals, and capitalizes interest: AED 1.03 and BHD 0.008.

## Layout

```
src/money.ts      bigint minor units, parsing, formatting, half-even rounding, exact split
src/policy.ts     every tunable constant (see NUMBERS.md)
src/ledger.ts     LedgerEngine: append-only logs, auth/settlement/reversal, night processing
src/scenario.ts   the brief's accounts and event stream, plus replay()
src/report.ts     text renderer for the per-day report and history matrix
src/replay.ts     entry point for `npm run replay`
test/money.test.ts         money primitives
test/ledger.test.ts        engine behaviour: append-only, validation, fees, interest, late events
test/acceptance.test.ts    one test per acceptance criterion (accepted and refused)
test/known-failure.test.ts the deliberate failing test
```

## Design in five points

1. **Append-only everywhere.** Ledger entries, event outcomes, auth transitions and interest accruals each live in their own append-only log. Every record is frozen (`Object.freeze`) when created. Readers get frozen copies. Corrections are new records: `REVERSAL`, `FEE_REFUND`, `RESTATEMENT`.
2. **Money is `bigint` minor units.** No floating point anywhere. Interest is the exact fraction 4/10 000, rounded half-even once per account per day.
3. **Value date and booking day are separate.** Balances follow value dates. `bookedOn` records when the engine learned of an entry.
4. **Fees and interest heal after backdated changes; authorizations do not.** Each night recomputes which value days deserve a fee and books only the difference. Capitalization restates any accrual a backdated entry changed. Auth decisions are final once made. That is the known failing test.
5. **The capitalized credit is, by definition, the sum of the rounded accrual records.** An invariant check guards it.

## Other documents

- [REJECTED.md](REJECTED.md): the four acceptance criteria refused (C2, C6, C7, C8) with reasoning, and approaches abandoned.
- [AMBIGUITIES.md](AMBIGUITIES.md): 29 ambiguities and how each was resolved.
- [NUMBERS.md](NUMBERS.md): every constant, and why that value and not half of it.
- [WORKLOG.md](WORKLOG.md): timestamped build log.
