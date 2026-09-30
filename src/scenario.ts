import { AccountConfig, LedgerEngine, LedgerEvent } from './ledger';

export const ACCOUNTS: readonly AccountConfig[] = Object.freeze([
  { id: 'ACC-001', currency: 'AED', opening: '0.00' },
  { id: 'ACC-002', currency: 'BHD', opening: '0.000' },
]);

/** The brief's event stream, in the brief's replay order. */
export const EVENTS: readonly LedgerEvent[] = Object.freeze([
  { id: 'E1', day: 1, type: 'CREDIT', account: 'ACC-001', currency: 'AED', amount: '1,200.00', valueDate: 1 },
  { id: 'E2', day: 1, type: 'DEBIT', account: 'ACC-001', currency: 'AED', amount: '950.00', valueDate: 1 },
  { id: 'E3', day: 2, type: 'AUTHORIZATION', account: 'ACC-001', currency: 'AED', authId: 'Auth-A', amount: '200.00', valueDate: 2 },
  { id: 'E4', day: 3, type: 'CREDIT', account: 'ACC-001', currency: 'AED', amount: '400.00', valueDate: 3 },
  { id: 'E5', day: 4, type: 'SETTLEMENT', account: 'ACC-001', currency: 'AED', authId: 'Auth-A', amount: '185.00', valueDate: 4 },
  { id: 'E6', day: 4, type: 'SETTLEMENT', account: 'ACC-001', currency: 'AED', authId: 'Auth-Z', amount: '180.00', valueDate: 4 },
  { id: 'E7', day: 5, type: 'DEBIT', account: 'ACC-001', currency: 'AED', amount: '620.00', valueDate: 2 },
  { id: 'E8', day: 5, type: 'AUTHORIZATION', account: 'ACC-001', currency: 'AED', authId: 'Auth-B', amount: '90.00', valueDate: 5 },
  { id: 'E9', day: 6, type: 'REVERSAL', account: 'ACC-001', currency: 'AED', targetEventId: 'E7', valueDate: 2 },
  { id: 'E10', day: 5, type: 'CREDIT', account: 'ACC-002', currency: 'BHD', amount: '10.000', instalments: 3, valueDate: 5 },
] satisfies LedgerEvent[]);

/** Replay `events` into a fresh engine and close the window. */
export function replay(events: readonly LedgerEvent[] = EVENTS, opts: { finish?: boolean } = {}): LedgerEngine {
  const engine = new LedgerEngine(ACCOUNTS);
  for (const ev of events) engine.ingest(ev);
  if (opts.finish ?? true) engine.finish();
  return engine;
}
