// What Restate recorded of suspensions, for the tests against a Restate
// server: an invocation suspended on its cancel signal and nothing else is
// one that only a cancellation resumes. No handler here waits for that: one
// that awaits its cancellation watches for it, while it works. So every
// suite ends by asking Restate whether it saw such a suspension.
import assert from 'node:assert/strict';

/** A future as Restate stores it: a leaf, or a combinator over futures. */
type Future = { Single: Record<string, unknown> } | Record<string, Future[]>;

const leaves = (future: Future): Record<string, unknown>[] =>
  'Single' in future
    ? [(future as { Single: Record<string, unknown> }).Single]
    : Object.values(future as Record<string, Future[]>)
        .flat()
        .flatMap(leaves);

/** The cancel signal: signal 1 of every invocation. */
const isCancellation = (leaf: Record<string, unknown>) => leaf.SignalIndex === 1;

/** The suspensions Restate at `admin` recorded, each with what its invocation awaited. */
export async function suspensions(admin: string) {
  const r = await fetch(`${admin}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      query: `SELECT e.id, i.target, e.event_json FROM sys_journal_events e JOIN sys_invocation i ON i.id = e.id WHERE e.event_type = 'Suspended'`,
    }),
  });
  if (!r.ok) throw new Error(`suspensions: ${r.status} ${await r.text()}`);
  const { rows } = (await r.json()) as { rows: { id: string; target: string; event_json: string }[] };
  return rows.map(({ id, target, event_json }) => {
    const awaited = leaves((JSON.parse(event_json) as { awaiting_on: Future }).awaiting_on);
    return { id, target, awaited, onCancellationAlone: awaited.length > 0 && awaited.every(isCancellation) };
  });
}

/** Fails if Restate at `admin` suspended an invocation on its cancel signal alone; returns how many suspensions it saw. */
export async function assertNoneSuspendedOnCancellationAlone(admin: string): Promise<number> {
  const all = await suspensions(admin);
  const alone = all.filter((s) => s.onCancellationAlone);
  assert.deepEqual(
    alone.map((s) => `${s.target} ${s.id}`),
    [],
    'invocations were suspended on their cancel signal alone: only a cancellation resumes them',
  );
  return all.length;
}
