// Every tunable number the engine uses lives here. NUMBERS.md explains each one.
import type { Currency } from './money';

export const POLICY = Object.freeze({
  /** Business days in the replay window, inclusive. */
  window: Object.freeze({ first: 1, last: 6 }),

  /**
   * Overdraft fee per currency, in minor units. The brief only prices it in AED.
   * No BHD figure is given and no FX rate either, so there is deliberately no
   * BHD entry. See AMBIGUITIES.md §A8.
   */
  overdraftFee: Object.freeze({ AED: 2500n } as Partial<Record<Currency, bigint>>),

  /** Daily interest as an exact fraction: 0.04% = 4 / 10 000. */
  dailyInterest: Object.freeze({ numerator: 4n, denominator: 10_000n }),

  /** A settlement may take at most the held amount plus this many minor units. */
  settlementOverHoldTolerance: 0n,
});
