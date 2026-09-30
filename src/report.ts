import { DayReport, LedgerEngine } from './ledger';
import { formatAmount } from './money';
import { POLICY } from './policy';

const pad = (s: string, n: number) => s.padStart(n);

export function renderDay(r: DayReport): string {
  const out: string[] = [];
  out.push(`=== Day ${r.day} (end of day) ${'='.repeat(50)}`);

  out.push('Events processed:');
  if (r.events.length === 0) out.push('  (none)');
  for (const e of r.events) {
    out.push(`  ${e.event.id.padEnd(4)} ${e.event.type.padEnd(13)} ${e.event.account}  value Day ${e.event.valueDate}  -> ${e.outcome}${e.code ? ` (${e.code})` : ''}`);
  }

  out.push('Balances (closing ledger = entries with value_date <= this day, as known tonight):');
  for (const a of r.accounts) {
    const f = (v: bigint) => pad(formatAmount(v, a.currency), 10);
    out.push(`  ${a.account} ${a.currency}  closing ledger ${f(a.closingLedger)}   holds ${f(a.activeHolds)}   available ${f(a.available)}`);
  }

  out.push('Fee assessments:');
  const fees = r.accounts.flatMap((a) => a.feeEntries.map((e) => ({ a, e })));
  if (fees.length === 0) out.push('  (none)');
  for (const { a, e } of fees) {
    out.push(`  ${a.account} ${e.kind.padEnd(13)} ${pad(formatAmount(e.amount, a.currency), 8)} value Day ${e.valueDate}  - ${e.memo}`);
  }

  out.push('Interest accruals:');
  for (const a of r.accounts) {
    for (const x of a.accruals) {
      out.push(`  ${a.account} ${x.kind.padEnd(11)} for Day ${x.forDay}  basis ${pad(formatAmount(x.basis, a.currency), 9)}  accrual ${pad(formatAmount(x.amount, a.currency), 6)}`);
    }
    if (a.capitalization) {
      out.push(`  ${a.account} CAPITALIZED ${formatAmount(a.capitalization.amount, a.currency)} ${a.currency} (value Day ${a.capitalization.valueDate}); closing ledger above includes it`);
    }
  }

  out.push('Authorization states:');
  if (r.auths.length === 0) out.push('  (none)');
  for (const au of r.auths) {
    const cur = r.accounts.find((a) => a.account === au.account)?.currency ?? 'AED';
    const settled = au.settled !== undefined ? `, settled ${formatAmount(au.settled, cur)}` : '';
    out.push(`  ${au.authId.padEnd(7)} ${au.account} ${au.status.padEnd(9)} requested ${formatAmount(au.requested, cur)}${settled} (decided Day ${au.decidedOn})`);
  }

  out.push('Errors and notices:');
  if (r.diagnostics.length === 0) out.push('  (none)');
  for (const d of r.diagnostics) {
    out.push(`  ${d.severity.padEnd(6)} ${d.code.padEnd(22)} ${d.eventId ?? '-'}: ${d.message}`);
  }
  return out.join('\n');
}

/**
 * Backdated entries rewrite history, so a single "closing balance for Day 2"
 * does not exist. This matrix shows the closing balance of each value day
 * (rows) as it stood at the end of each processing night (columns).
 */
export function renderRestatement(engine: LedgerEngine): string {
  const out: string[] = ['=== Value-dated closing balances: value day (rows) as known at end of night N (columns) ==='];
  const reports = engine.dayReports();
  const W = 10;
  for (const acc of reports[0]?.accounts ?? []) {
    out.push(`  ${acc.account} (${acc.currency})`);
    out.push(`    value day |${reports.map((r) => pad(`night ${r.day}`, W)).join('')}`);
    for (let d = POLICY.window.first; d <= POLICY.window.last; d++) {
      const cells = reports.map((r) => {
        const v = r.accounts.find((a) => a.account === acc.account)?.history[d - POLICY.window.first];
        return pad(v === undefined ? '.' : formatAmount(v, acc.currency), W);
      });
      out.push(`    ${pad(String(d), 9)} |${cells.join('')}`);
    }
  }
  out.push(`  Ledger entries: ${engine.entries().length} (append-only; none edited or removed)`);
  return out.join('\n');
}

export function renderAll(engine: LedgerEngine): string {
  return [...engine.dayReports().map(renderDay), renderRestatement(engine)].join('\n\n');
}
