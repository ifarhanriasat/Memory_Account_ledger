import {
  Currency,
  divRoundHalfEven,
  formatAmount,
  LedgerError,
  parseAmount,
  splitEvenly,
} from './money';
import { POLICY } from './policy';

export type Day = number;

// ---------------------------------------------------------------------------
// Inbound events (what the stream says happened)
// ---------------------------------------------------------------------------

interface EventBase {
  readonly id: string;
  /** Business day the event arrives on (its booking day). */
  readonly day: Day;
  readonly account: string;
  readonly currency: Currency;
  readonly valueDate: Day;
}

export type LedgerEvent =
  | (EventBase & { readonly type: 'CREDIT' | 'DEBIT'; readonly amount: string; readonly instalments?: number })
  | (EventBase & { readonly type: 'AUTHORIZATION'; readonly authId: string; readonly amount: string })
  | (EventBase & { readonly type: 'SETTLEMENT'; readonly authId: string; readonly amount: string })
  | (EventBase & { readonly type: 'REVERSAL'; readonly targetEventId: string });

// ---------------------------------------------------------------------------
// Records the engine writes. Each is frozen when created and never edited.
// ---------------------------------------------------------------------------

export type EntryKind =
  | 'CREDIT'
  | 'DEBIT'
  | 'SETTLEMENT'
  | 'REVERSAL'
  | 'OVERDRAFT_FEE'
  | 'FEE_REFUND'
  | 'INTEREST_CAPITALIZATION';

export interface LedgerEntry {
  readonly seq: number;
  readonly account: string;
  readonly kind: EntryKind;
  /** Signed minor units: positive credits, negative debits. */
  readonly amount: bigint;
  readonly valueDate: Day;
  readonly bookedOn: Day;
  /** The inbound event that caused this entry, or null for engine-generated entries. */
  readonly sourceEventId: string | null;
  /** seq of the entry this one offsets (reversals, fee refunds). */
  readonly offsets?: number;
  readonly memo: string;
}

export type EventOutcome = 'APPLIED' | 'DECLINED' | 'REJECTED';

export interface EventRecord {
  readonly seq: number;
  readonly event: LedgerEvent;
  readonly processedOn: Day;
  readonly outcome: EventOutcome;
  readonly code?: string;
}

export type AuthStatus = 'APPROVED' | 'DECLINED' | 'SETTLED';

export interface AuthTransition {
  readonly seq: number;
  readonly authId: string;
  readonly account: string;
  readonly status: AuthStatus;
  /** Amount requested (for APPROVED/DECLINED) or settled (for SETTLED). */
  readonly amount: bigint;
  readonly day: Day;
  readonly eventId: string;
}

export interface Diagnostic {
  readonly day: Day;
  readonly eventId: string | null;
  readonly severity: 'ERROR' | 'NOTICE';
  readonly code: string;
  readonly message: string;
}

export interface AccrualRecord {
  readonly seq: number;
  readonly account: string;
  /** Value day the interest belongs to. */
  readonly forDay: Day;
  /** Processing day on which this record was written. */
  readonly computedOn: Day;
  /** DAILY = end-of-day accrual; RESTATEMENT = correction for a backdated change. */
  readonly kind: 'DAILY' | 'RESTATEMENT';
  readonly basis: bigint;
  readonly amount: bigint;
}

export interface AccountConfig {
  readonly id: string;
  readonly currency: Currency;
  readonly opening: string;
}

export interface AuthView {
  readonly authId: string;
  readonly account: string;
  readonly status: AuthStatus;
  readonly requested: bigint;
  readonly settled?: bigint;
  readonly decidedOn: Day;
}

export interface AccountDaySnapshot {
  readonly account: string;
  readonly currency: Currency;
  readonly closingLedger: bigint;
  readonly activeHolds: bigint;
  readonly available: bigint;
  readonly feeEntries: readonly LedgerEntry[];
  readonly accruals: readonly AccrualRecord[];
  readonly capitalization?: LedgerEntry;
  /** Closing ledger for every value day up to this one, as known tonight (index 0 = first day). */
  readonly history: readonly bigint[];
}

export interface DayReport {
  readonly day: Day;
  readonly events: readonly EventRecord[];
  readonly accounts: readonly AccountDaySnapshot[];
  readonly auths: readonly AuthView[];
  readonly diagnostics: readonly Diagnostic[];
}

const FEE_KINDS: ReadonlySet<EntryKind> = new Set(['OVERDRAFT_FEE', 'FEE_REFUND']);
const REVERSIBLE: ReadonlySet<LedgerEvent['type']> = new Set(['CREDIT', 'DEBIT']);

/** Appends are the only write; readers get a frozen snapshot copy. */
class AppendOnlyLog<T extends object> {
  private readonly items: T[] = [];
  append(item: Omit<T, 'seq'>): T {
    const record = Object.freeze({ ...item, seq: this.items.length + 1 }) as unknown as T;
    this.items.push(record);
    return record;
  }
  all(): readonly T[] {
    return Object.freeze(this.items.slice());
  }
  filter(pred: (t: T) => boolean): T[] {
    return this.items.filter(pred);
  }
  get size(): number {
    return this.items.length;
  }
}

export class LedgerEngine {
  private readonly ledger = new AppendOnlyLog<LedgerEntry>();
  private readonly eventLog = new AppendOnlyLog<EventRecord>();
  private readonly authLog = new AppendOnlyLog<AuthTransition>();
  private readonly accrualLog = new AppendOnlyLog<AccrualRecord>();
  private readonly diagnosticsLog: Diagnostic[] = [];
  private readonly reports: DayReport[] = [];
  private readonly accounts = new Map<string, AccountConfig>();
  /** "account|day" pairs already reported as NO_FEE_SCHEDULE, so each is reported once. */
  private readonly unpricedOverdrafts = new Set<string>();
  private clock: Day = POLICY.window.first;
  private finished = false;

  constructor(accounts: readonly AccountConfig[]) {
    for (const acc of accounts) {
      if (this.accounts.has(acc.id)) throw new LedgerError('DUPLICATE_ACCOUNT', acc.id);
      this.accounts.set(acc.id, Object.freeze({ ...acc }));
      const opening = parseAmount(acc.opening, acc.currency);
      if (opening !== 0n) {
        this.post(acc.id, opening > 0n ? 'CREDIT' : 'DEBIT', opening, POLICY.window.first, null, 'opening balance');
      }
    }
  }

  // ------------------------------------------------------------------ queries

  get currentDay(): Day {
    return this.clock;
  }

  entries(): readonly LedgerEntry[] {
    return this.ledger.all();
  }

  events(): readonly EventRecord[] {
    return this.eventLog.all();
  }

  authTransitions(): readonly AuthTransition[] {
    return this.authLog.all();
  }

  accruals(): readonly AccrualRecord[] {
    return this.accrualLog.all();
  }

  diagnostics(): readonly Diagnostic[] {
    return Object.freeze(this.diagnosticsLog.slice());
  }

  dayReports(): readonly DayReport[] {
    return Object.freeze(this.reports.slice());
  }

  currencyOf(account: string): Currency {
    return this.account(account).currency;
  }

  /** Sum of every entry booked so far whose value date is on or before `asOf`. */
  ledgerBalance(account: string, asOf: Day, filter: (e: LedgerEntry) => boolean = () => true): bigint {
    this.account(account);
    let sum = 0n;
    for (const e of this.ledger.filter((e) => e.account === account && e.valueDate <= asOf && filter(e))) {
      sum += e.amount;
    }
    return sum;
  }

  authState(authId: string): AuthView | undefined {
    const history = this.authLog.filter((t) => t.authId === authId);
    const first = history[0];
    const last = history[history.length - 1];
    if (!first || !last) return undefined;
    return Object.freeze({
      authId,
      account: first.account,
      status: last.status,
      requested: first.amount,
      settled: last.status === 'SETTLED' ? last.amount : undefined,
      decidedOn: first.day,
    });
  }

  activeHolds(account: string): bigint {
    let sum = 0n;
    for (const id of this.authIds()) {
      const s = this.authState(id);
      if (s && s.account === account && s.status === 'APPROVED') sum += s.requested;
    }
    return sum;
  }

  /** Ledger balance as of the current processing day, minus active holds. */
  availableBalance(account: string): bigint {
    return this.ledgerBalance(account, this.clock) - this.activeHolds(account);
  }

  // ------------------------------------------------------------------ commands

  /** Process one event. Crossing a day boundary closes the days in between. */
  ingest(event: LedgerEvent): EventRecord {
    if (this.finished) throw new LedgerError('WINDOW_CLOSED', `window closed; cannot ingest ${event.id}`);
    const frozen = Object.freeze({ ...event }) as LedgerEvent;

    if (!this.inWindow(frozen.day)) {
      return this.reject(frozen, 'OUTSIDE_WINDOW', `booking day ${frozen.day} is outside Day ${POLICY.window.first}-${POLICY.window.last}`);
    }
    while (this.clock < frozen.day) {
      this.endOfDay(this.clock);
      this.clock += 1;
    }
    if (frozen.day < this.clock) {
      this.diagnose(frozen.id, 'NOTICE', 'LATE_EVENT',
        `stamped Day ${frozen.day} but arrived after Day ${frozen.day} closed; booked on Day ${this.clock}, value date Day ${frozen.valueDate} kept`);
    }

    try {
      return this.apply(frozen);
    } catch (err) {
      if (err instanceof LedgerError) return this.reject(frozen, err.code, err.message);
      throw err;
    }
  }

  /** Close every remaining day through the end of the window, including interest capitalization. */
  finish(): void {
    if (this.finished) return;
    for (;;) {
      this.endOfDay(this.clock);
      if (this.clock >= POLICY.window.last) break;
      this.clock += 1;
    }
    this.finished = true;
  }

  // ------------------------------------------------------------------ event handling

  private apply(ev: LedgerEvent): EventRecord {
    const acc = this.account(ev.account);
    if (ev.currency !== acc.currency) {
      throw new LedgerError('CURRENCY_MISMATCH', `${ev.account} is ${acc.currency}; event is ${ev.currency}`);
    }
    if (!this.inWindow(ev.valueDate)) {
      throw new LedgerError('BAD_VALUE_DATE', `value date Day ${ev.valueDate} is outside the window`);
    }
    if (ev.valueDate > this.clock) {
      throw new LedgerError('FUTURE_VALUE_DATE', `value date Day ${ev.valueDate} is after processing day ${this.clock}`);
    }

    switch (ev.type) {
      case 'CREDIT':
      case 'DEBIT':
        return this.applyTransfer(ev);
      case 'AUTHORIZATION':
        return this.applyAuthorization(ev);
      case 'SETTLEMENT':
        return this.applySettlement(ev);
      case 'REVERSAL':
        return this.applyReversal(ev);
    }
  }

  private applyTransfer(ev: Extract<LedgerEvent, { type: 'CREDIT' | 'DEBIT' }>): EventRecord {
    const total = this.positiveAmount(ev.amount, ev.currency);
    const parts = splitEvenly(total, ev.instalments ?? 1);
    if (parts.some((p) => p !== parts[0])) {
      this.diagnose(ev.id, 'NOTICE', 'INSTALMENTS_NOT_EQUAL',
        `${formatAmount(total, ev.currency)} cannot be split into ${parts.length} equal ${ev.currency} amounts; posted ${parts.map((p) => formatAmount(p, ev.currency)).join(' + ')}`);
    }
    const sign = ev.type === 'CREDIT' ? 1n : -1n;
    parts.forEach((p, i) => {
      const memo = parts.length > 1 ? `${ev.type.toLowerCase()} instalment ${i + 1}/${parts.length}` : ev.type.toLowerCase();
      this.post(ev.account, ev.type, sign * p, ev.valueDate, ev.id, memo);
    });
    return this.record(ev, 'APPLIED');
  }

  private applyAuthorization(ev: Extract<LedgerEvent, { type: 'AUTHORIZATION' }>): EventRecord {
    const amount = this.positiveAmount(ev.amount, ev.currency);
    if (this.authState(ev.authId)) {
      throw new LedgerError('DUPLICATE_AUTH', `authorization ${ev.authId} already exists`);
    }
    const after = this.availableBalance(ev.account) - amount;
    const status: AuthStatus = after >= 0n ? 'APPROVED' : 'DECLINED';
    this.authLog.append({ authId: ev.authId, account: ev.account, status, amount, day: this.clock, eventId: ev.id });
    return this.record(ev, status === 'APPROVED' ? 'APPLIED' : 'DECLINED',
      status === 'DECLINED' ? 'INSUFFICIENT_AVAILABLE' : undefined);
  }

  private applySettlement(ev: Extract<LedgerEvent, { type: 'SETTLEMENT' }>): EventRecord {
    const amount = this.positiveAmount(ev.amount, ev.currency);
    const auth = this.authState(ev.authId);
    if (!auth) {
      throw new LedgerError('AUTH_NOT_FOUND', `no authorization ${ev.authId} in the ledger; nothing debited`);
    }
    if (auth.account !== ev.account) {
      throw new LedgerError('AUTH_ACCOUNT_MISMATCH', `${ev.authId} belongs to ${auth.account}`);
    }
    if (auth.status !== 'APPROVED') {
      throw new LedgerError('AUTH_NOT_OPEN', `${ev.authId} is ${auth.status}; only an approved, unsettled hold can settle`);
    }
    if (amount > auth.requested + POLICY.settlementOverHoldTolerance) {
      throw new LedgerError('SETTLEMENT_EXCEEDS_HOLD',
        `settles ${formatAmount(amount, ev.currency)} against a hold of ${formatAmount(auth.requested, ev.currency)}`);
    }
    this.post(ev.account, 'SETTLEMENT', -amount, ev.valueDate, ev.id,
      `settles ${ev.authId}; hold ${formatAmount(auth.requested, ev.currency)} released`);
    this.authLog.append({ authId: ev.authId, account: ev.account, status: 'SETTLED', amount, day: this.clock, eventId: ev.id });
    return this.record(ev, 'APPLIED');
  }

  private applyReversal(ev: Extract<LedgerEvent, { type: 'REVERSAL' }>): EventRecord {
    const target = this.eventLog.filter((r) => r.event.id === ev.targetEventId)[0];
    if (!target) throw new LedgerError('REVERSAL_TARGET_NOT_FOUND', `no event ${ev.targetEventId}`);
    if (target.outcome !== 'APPLIED') {
      throw new LedgerError('REVERSAL_TARGET_NOT_POSTED', `${ev.targetEventId} was ${target.outcome}; nothing to reverse`);
    }
    if (!REVERSIBLE.has(target.event.type)) {
      throw new LedgerError('REVERSAL_NOT_SUPPORTED', `${target.event.type} events cannot be reversed here`);
    }
    if (target.event.account !== ev.account) {
      throw new LedgerError('REVERSAL_ACCOUNT_MISMATCH', `${ev.targetEventId} is on ${target.event.account}`);
    }
    if (ev.valueDate < target.event.valueDate) {
      throw new LedgerError('REVERSAL_BEFORE_ORIGINAL',
        `reversal value date Day ${ev.valueDate} precedes original value date Day ${target.event.valueDate}`);
    }
    const originals = this.ledger.filter((e) => e.sourceEventId === ev.targetEventId);
    const alreadyReversed = this.ledger.filter((e) => e.kind === 'REVERSAL' && originals.some((o) => o.seq === e.offsets));
    if (alreadyReversed.length > 0) {
      throw new LedgerError('ALREADY_REVERSED', `${ev.targetEventId} has already been reversed`);
    }
    for (const o of originals) {
      this.post(ev.account, 'REVERSAL', -o.amount, ev.valueDate, ev.id, `reverses ${ev.targetEventId} (entry #${o.seq})`, o.seq);
    }
    return this.record(ev, 'APPLIED');
  }

  // ------------------------------------------------------------------ end of day

  private endOfDay(day: Day): void {
    const feeEntriesBefore = this.ledger.size;
    const accrualsBefore = this.accrualLog.size;
    const capitalizations = new Map<string, LedgerEntry>();

    for (const account of this.accounts.keys()) this.trueUpFees(account, day);
    for (const account of this.accounts.keys()) this.accrueInterest(account, day);
    if (day === POLICY.window.last) {
      for (const account of this.accounts.keys()) {
        const cap = this.capitalizeInterest(account, day);
        if (cap) capitalizations.set(account, cap);
      }
    }

    const newEntries = this.ledger.all().slice(feeEntriesBefore);
    const newAccruals = this.accrualLog.all().slice(accrualsBefore);
    this.reports.push(Object.freeze({
      day,
      events: this.eventLog.filter((r) => r.processedOn === day),
      diagnostics: this.diagnosticsLog.filter((d) => d.day === day),
      auths: this.authIds().map((id) => this.authState(id)!).filter((a) => a.decidedOn <= day),
      accounts: [...this.accounts.values()].map((acc) => Object.freeze({
        account: acc.id,
        currency: acc.currency,
        closingLedger: this.ledgerBalance(acc.id, day),
        activeHolds: this.activeHolds(acc.id),
        available: this.ledgerBalance(acc.id, day) - this.activeHolds(acc.id),
        feeEntries: newEntries.filter((e) => e.account === acc.id && FEE_KINDS.has(e.kind)),
        accruals: newAccruals.filter((a) => a.account === acc.id),
        capitalization: capitalizations.get(acc.id),
        history: Object.freeze(Array.from({ length: day - POLICY.window.first + 1 },
          (_, i) => this.ledgerBalance(acc.id, POLICY.window.first + i))),
      })),
    }));
  }

  /**
   * Recompute which value days deserve an overdraft fee, walking forward so
   * that each fee counts toward the balances of later days, then book only the
   * difference: a FEE for a newly negative day, a FEE_REFUND for a day that is
   * no longer negative. Existing entries are never touched.
   */
  private trueUpFees(account: string, throughDay: Day): void {
    const { currency } = this.account(account);
    const fee = POLICY.overdraftFee[currency];
    let feesOnEarlierDays = 0n;

    for (let d = POLICY.window.first; d <= throughDay; d++) {
      const closingBeforeFee = this.ledgerBalance(account, d, (e) => !FEE_KINDS.has(e.kind)) - feesOnEarlierDays;
      const bookedFeeOnDay = this.ledger
        .filter((e) => e.account === account && FEE_KINDS.has(e.kind) && e.valueDate === d)
        .reduce((s, e) => s + e.amount, 0n);

      if (closingBeforeFee < 0n) {
        if (fee === undefined) {
          const key = `${account}|${d}`;
          if (!this.unpricedOverdrafts.has(key)) {
            this.unpricedOverdrafts.add(key);
            this.diagnose(null, 'ERROR', 'NO_FEE_SCHEDULE',
              `${account} Day ${d} closed negative but no ${currency} overdraft fee is configured; no fee booked`);
          }
          continue;
        }
        feesOnEarlierDays += fee;
        if (bookedFeeOnDay === 0n) {
          this.post(account, 'OVERDRAFT_FEE', -fee, d, null,
            `overdraft fee: Day ${d} closing ${formatAmount(closingBeforeFee, currency)}`);
        }
      } else if (bookedFeeOnDay !== 0n) {
        const feeEntry = this.ledger.filter((e) => e.account === account && e.kind === 'OVERDRAFT_FEE' && e.valueDate === d).pop();
        this.post(account, 'FEE_REFUND', -bookedFeeOnDay, d, null,
          `refund: Day ${d} now closes ${formatAmount(closingBeforeFee, currency)}`, feeEntry?.seq);
      }
    }
  }

  private dailyInterestOn(balance: bigint): bigint {
    if (balance <= 0n) return 0n;
    const { numerator, denominator } = POLICY.dailyInterest;
    return divRoundHalfEven(balance * numerator, denominator);
  }

  private accrueInterest(account: string, day: Day): void {
    const basis = this.ledgerBalance(account, day);
    this.accrualLog.append({ account, forDay: day, computedOn: day, kind: 'DAILY', basis, amount: this.dailyInterestOn(basis) });
  }

  /**
   * Restate each day's accrual against the final value-dated balance, then
   * capitalize the sum of the rounded accrual records. The credit is defined
   * as that sum, so the accruals and the credit always match exactly.
   */
  private capitalizeInterest(account: string, day: Day): LedgerEntry | undefined {
    const { currency } = this.account(account);
    let expectedTotal = 0n;
    for (let d = POLICY.window.first; d <= day; d++) {
      const basis = this.ledgerBalance(account, d);
      const final = this.dailyInterestOn(basis);
      expectedTotal += final;
      const accrued = this.accrualLog
        .filter((a) => a.account === account && a.forDay === d)
        .reduce((s, a) => s + a.amount, 0n);
      if (accrued !== final) {
        this.accrualLog.append({ account, forDay: d, computedOn: day, kind: 'RESTATEMENT', basis, amount: final - accrued });
      }
    }
    const total = this.accrualLog.filter((a) => a.account === account).reduce((s, a) => s + a.amount, 0n);
    if (total !== expectedTotal) {
      // Unreachable by construction; kept as a guard so a future edit cannot quietly drop a remainder.
      throw new Error(`interest invariant broken on ${account}: ${total} != ${expectedTotal}`);
    }
    if (total === 0n) return undefined;
    return this.post(account, 'INTEREST_CAPITALIZATION', total, day, null,
      `capitalized interest, Days ${POLICY.window.first}-${day}: ${formatAmount(total, currency)}`);
  }

  // ------------------------------------------------------------------ helpers

  private post(account: string, kind: EntryKind, amount: bigint, valueDate: Day, sourceEventId: string | null, memo: string, offsets?: number): LedgerEntry {
    return this.ledger.append({ account, kind, amount, valueDate, bookedOn: this.clock, sourceEventId, memo, ...(offsets !== undefined ? { offsets } : {}) });
  }

  private record(event: LedgerEvent, outcome: EventOutcome, code?: string): EventRecord {
    return this.eventLog.append({ event, processedOn: this.clock, outcome, ...(code ? { code } : {}) });
  }

  private reject(event: LedgerEvent, code: string, message: string): EventRecord {
    this.diagnose(event.id, 'ERROR', code, message);
    return this.record(event, 'REJECTED', code);
  }

  private diagnose(eventId: string | null, severity: Diagnostic['severity'], code: string, message: string): void {
    this.diagnosticsLog.push(Object.freeze({ day: this.clock, eventId, severity, code, message }));
  }

  private account(id: string): AccountConfig {
    const acc = this.accounts.get(id);
    if (!acc) throw new LedgerError('UNKNOWN_ACCOUNT', `no account ${id}`);
    return acc;
  }

  private authIds(): string[] {
    return [...new Set(this.authLog.filter(() => true).map((t) => t.authId))];
  }

  private positiveAmount(text: string, currency: Currency): bigint {
    const amount = parseAmount(text, currency);
    if (amount <= 0n) throw new LedgerError('NON_POSITIVE_AMOUNT', `amount must be positive, got ${text}`);
    return amount;
  }

  private inWindow(day: Day): boolean {
    return Number.isInteger(day) && day >= POLICY.window.first && day <= POLICY.window.last;
  }
}
