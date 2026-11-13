// When an attempt of a session object's handler is suspended, on the wire:
// the SDK's own request handler and VM (the shared core it ships), and all of
// @restatedev/sessions, with Restate's side of the protocol played by a test
// (wire.ts), which closes the input when it says, as Restate's inactivity
// timeout does. No fake of the VM stands between the selector and the
// suspension it must not cause: a handler that works outside Restate, and
// awaits its cancellation alone, is never suspended on the cancel signal.
import * as restate from '@restatedev/sessions';
import { cancelled } from '@restatedev/sessions/internal';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { attempt, CANCEL, type Outcome } from './wire.ts';

interface Work {
  /** How long it works outside Restate. */
  ms: number;
  /** Whether it watches for its cancellation as it works. */
  watch: boolean;
  /** Whether it commits to its database after the work, raced with its cancellation. */
  commit?: boolean;
}

/** Work outside Restate, stopped by the invocation's cancellation if it watches; then a commit, if asked. */
const work = async (ctx: restate.SessionContext, { ms, watch, commit }: Work) => {
  const watched = watch ? cancelled(ctx).then(() => true) : new Promise<boolean>(() => {});
  let stopped = await Promise.race([watched, sleep(ms).then(() => false)]);
  if (!stopped && commit) {
    const committed = ctx.db.execute('CREATE TABLE IF NOT EXISTS t (v INTEGER)').then(() => false);
    stopped = await Promise.race([watched, committed]);
  }
  return { stopped };
};

const probe = restate.sessionObject({
  name: 'Probe',
  handlers: { work: { explicitCancellation: true, handler: work } },
});

const run = (input: Work, options?: Parameters<typeof attempt>[3]) => attempt(probe, 'Probe/work', input, options);
const SUSPENSION = 0x0001;
const PROPOSE_RUN_COMPLETION = 0x0005;
const RUN = 0x0411;
const onCancellationAlone = (o: Outcome) => o.kind === 'suspended' && o.on.completions.length === 0;
const within = <T>(promise: Promise<T>, ms: number, what: string) =>
  Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error(`${what}: not within ${ms} ms`);
    }),
  ]);

describe('a handler that works outside Restate and watches for its cancellation, on the wire', () => {
  it.each([true, false])('answers though its input closes as it works (watch: %s)', async (watch) => {
    const a = run({ ms: 80, watch });
    await sleep(20);
    a.closeInput();
    expect(await within(a.ended, 2000, 'the attempt')).toEqual({ kind: 'output', value: { stopped: false } });
    expect(a.sent).not.toContain(SUSPENSION);
  });

  it.each([true, false])('answers with its input closed from the start (watch: %s)', async (watch) => {
    const a = run({ ms: 30, watch }, { closed: true });
    expect(await within(a.ended, 2000, 'the attempt')).toEqual({ kind: 'output', value: { stopped: false } });
    expect(a.sent).not.toContain(SUSPENSION);
    expect(a.reported).toEqual([]);
  });

  it('stops at a cancel signal that comes while its input is open', async () => {
    const a = run({ ms: 2000, watch: true });
    await sleep(20);
    a.cancel();
    expect(await within(a.ended, 1000, 'the attempt')).toEqual({ kind: 'output', value: { stopped: true } });
  });

  // To ask the VM for the cancellation alone would tell Restate that the handler awaits it, and nothing else.
  // Asked with the working run, the VM reports no await at all: the handler is at work.
  it('tells Restate of no await while it works, whether its input is open or closed', async () => {
    const a = run({ ms: 150, watch: true });
    await sleep(60);
    expect(a.reported).toEqual([]);
    a.closeInput();
    expect(await within(a.ended, 2000, 'the attempt')).toEqual({ kind: 'output', value: { stopped: false } });
    expect(a.reported).toEqual([]);
    expect(a.sent).toContain(RUN); // its working run, in the journal
    expect(a.sent).toContain(PROPOSE_RUN_COMPLETION); // and its end, with the attempt's
  });

  it('stops at a cancel signal that the input closes right behind', async () => {
    const a = run({ ms: 2000, watch: true });
    await sleep(20);
    a.cancel();
    a.closeInput(); // in the same turn: one read after the other
    expect(await within(a.ended, 1000, 'the attempt')).toEqual({ kind: 'output', value: { stopped: true } });
  });

  it('is suspended on its commit and its cancellation, when it commits after its input closed', async () => {
    const a = run({ ms: 40, watch: true, commit: true });
    await sleep(10);
    a.closeInput();
    const outcome = await within(a.ended, 2000, 'the attempt');
    expect(outcome.kind).toBe('suspended');
    expect((outcome as Extract<Outcome, { kind: 'suspended' }>).on.signals).toEqual([CANCEL]);
    expect((outcome as Extract<Outcome, { kind: 'suspended' }>).on.completions).toHaveLength(1);
  });

  it('commits and answers while its input is open', async () => {
    const a = run({ ms: 10, watch: true, commit: true });
    expect(await within(a.ended, 2000, 'the attempt')).toEqual({ kind: 'output', value: { stopped: false } });
  });

  it('finds a cancel signal that the input closed right behind, at its commit', async () => {
    const a = run({ ms: 40, watch: true, commit: true });
    await sleep(10);
    a.cancel();
    a.closeInput(); // in the same turn: one read after the other
    const outcome = await within(a.ended, 2000, 'the attempt');
    // The commit's check finds the signal, and the handler answers that it stopped; or the commit,
    // which the handler left behind, suspends the attempt first. Never the cancel signal alone.
    expect(onCancellationAlone(outcome)).toBe(false);
    expect(outcome.kind === 'suspended' || (outcome as { value: unknown }).value).toBeTruthy();
  });

  it('is never suspended on the cancel signal alone, whenever its input closes and a cancel signal comes', async () => {
    let seed = 5;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const pick = (n: number) => Math.floor(random() * n);
    const outcomes = { output: 0, stopped: 0, suspended: 0 };
    for (let batch = 0; batch < 12; batch++) {
      const rounds = Array.from({ length: 25 }, async () => {
        const input: Work = { ms: 2 + pick(40), watch: random() < 0.8, commit: random() < 0.4 };
        const closeAt = random() < 0.1 ? undefined : random() < 0.15 ? -1 : pick(50); // never, from the start, or then
        const cancelAt = random() < 0.4 ? pick(50) : undefined;
        const a = run(input, { closed: closeAt === -1 });
        if (closeAt !== undefined && closeAt >= 0) void sleep(closeAt).then(() => a.closeInput());
        if (cancelAt !== undefined) void sleep(cancelAt).then(() => a.cancel());
        const outcome = await within(a.ended, 5000, JSON.stringify({ input, closeAt, cancelAt }));
        const said = JSON.stringify({ input, closeAt, cancelAt, outcome });
        // Without a commit it awaits nothing of Restate's but its cancellation: it answers, whatever its input does.
        const answers = outcome.kind === 'output' ? (outcome.value as { stopped: boolean }) : undefined;
        const wrong = [
          onCancellationAlone(outcome) && 'suspended on the cancel signal alone',
          outcome.kind === 'error' && 'failed',
          a.reported.some((r) => r.completions.length === 0) && 'told Restate that it awaits its cancellation alone',
          !input.commit && answers === undefined && 'did not answer',
          // It stops for a cancel signal only: one sent, and to a handler that watches.
          answers?.stopped && !(cancelAt !== undefined && input.watch) && 'stopped without a cancel signal',
        ].filter(Boolean);
        expect(wrong.map((what) => `${what}: ${said}`)).toEqual([]);
        if (answers?.stopped) outcomes.stopped++;
        else if (answers) outcomes.output++;
        else outcomes.suspended++;
      });
      await Promise.all(rounds);
    }
    // All three came up.
    expect(Math.min(outcomes.output, outcomes.stopped, outcomes.suspended)).toBeGreaterThan(5);
  }, 60_000);
});
