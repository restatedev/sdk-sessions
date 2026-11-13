// When a session object's handler is suspended, against a real Restate server
// whose inactivity timeout is a second: Restate closes the input of a handler
// that sent or got nothing for that long, and the SDK suspends the invocation
// if the handler waits for something. A handler that works outside Restate (a
// model's request, say) waits for nothing, and must go on; one with explicit
// cancellation that also watches for its cancellation (`cancelled(ctx)`, as an
// agent's turn does) must fare exactly as one that does not. Suspended on the
// cancel signal alone, it would lose its work, and nothing but a cancellation
// would resume it.
//
// The handlers here are sessions' only: `watching` and `plain` do the same
// work, and differ in the watch. Some checks hold the selector's loop at its
// failpoints, so that the input closes, or a cancel signal comes, between two
// of its steps.
//
//   pnpm --filter e2e suspension   (RESTATE_SERVER=/path/to/restate-server to use another)
import * as restate from '@restatedev/sessions';
import { cancelled, failpoints, type Failpoint, type UnresolvedFuture } from '@restatedev/sessions/internal';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RESTATE_SERVER as SERVER } from './restate-server.ts';

const INGRESS = 'http://127.0.0.1:8080';
const ADMIN = 'http://127.0.0.1:9070';
const PORT = 9186;
const INACTIVITY = 1000; // the server's inactivity timeout: Restate closes the input of a handler idle this long
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- Services

// A journaled service: a call to it is something a handler waits for in Restate.
const helper = restate.service({
  name: 'Helper',
  handlers: {
    slow: async (ctx: restate.Context, ms: number) => {
      await ctx.sleep(ms);
    },
  },
});

/** What a probe does: see `work`. */
interface Work {
  /** How long it works outside Restate. */
  ms: number;
  /** What it awaits of Restate's after that: a call, or the call raced with its cancellation. */
  after?: 'call' | 'race';
  /** A call it makes first and never awaits, which takes this long. */
  pending?: number;
  /** Works on its first attempt only: later ones go straight on. */
  once?: boolean;
}

interface Outcome {
  /** Whether its cancellation stopped it. */
  stopped: boolean;
  attempts: number;
}

const attempts = new Map<string, number>();
// The attempts that ended, by invocation: the SDK ends one when it suspends, or when Restate aborts it.
const ended = new Map<string, number>();

/**
 * Work outside Restate for `ms`, stopped by the invocation's cancellation if
 * `watch`; then await what `after` says.
 */
const work =
  (watch: boolean) =>
  async (ctx: restate.SessionContext, { ms, after, pending, once }: Work): Promise<Outcome> => {
    const id = ctx.request.id;
    const n = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, n);
    ctx.request.attemptCompletedSignal.addEventListener('abort', () => ended.set(id, (ended.get(id) ?? 0) + 1));
    const call = (tag: string, callMs: number) => ctx.rpc(helper, { idempotencyKey: `${id}:${tag}` }).slow(callMs);
    // The session's own read of its database first: from here on, the watch is all the handler awaits of Restate's.
    await ctx.db.values('SELECT 1');
    const watched = watch ? cancelled(ctx).then(() => true) : new Promise<boolean>(() => {});
    if (pending !== undefined) void call('pending', pending).catch(() => {});
    let stopped = await Promise.race([watched, sleep(once && n > 1 ? 0 : ms).then(() => false)]);
    if (!stopped && after === 'call') await call('then', 50);
    if (!stopped && after === 'race') stopped = await Promise.race([watched, call('then', 50).then(() => false)]);
    return { stopped, attempts: attempts.get(id)! };
  };

const explicit = { explicitCancellation: true } as const;
const probe = restate.sessionObject({
  name: 'Probe',
  handlers: {
    watching: { ...explicit, handler: work(true) },
    plain: { ...explicit, handler: work(false) },
    // Aborted by Restate half a second after its input closed.
    watchingAborted: { ...explicit, abortTimeout: 500, handler: work(true) },
    plainAborted: { ...explicit, abortTimeout: 500, handler: work(false) },
  },
});

// --- Harness

const dir = mkdtempSync(join(tmpdir(), 'restate-sessions-suspension-'));
console.error(`logs in ${dir}`);
if (
  await fetch(`${ADMIN}/health`).then(
    () => true,
    () => false,
  )
) {
  throw new Error(`a Restate server already listens at ${ADMIN}; stop it first`);
}
const server = spawn(SERVER, ['--base-dir', join(dir, 'server')], {
  env: {
    ...process.env,
    RESTATE_BIND_IP: '127.0.0.1',
    RESTATE_LISTEN_MODE: 'tcp',
    RESTATE_WORKER__INVOKER__INACTIVITY_TIMEOUT: `${INACTIVITY}ms`,
  },
  stdio: ['ignore', openSync(join(dir, 'server.log'), 'a'), openSync(join(dir, 'server.log'), 'a')],
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(1));
process.on('exit', () => server.kill('SIGKILL'));

for (const deadline = Date.now() + 60_000; ; await sleep(200)) {
  if (
    await fetch(`${ADMIN}/health`).then(
      (r) => r.ok,
      () => false,
    )
  )
    break;
  if (Date.now() > deadline) throw new Error('restate-server did not start');
}
void (await restate.endpoint().bind(helper).bind(probe).listen(PORT));
for (const deadline = Date.now() + 60_000; ; await sleep(200)) {
  const registered = await fetch(`${ADMIN}/deployments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uri: `http://127.0.0.1:${PORT}`, force: true }),
  }).then(
    (r) => r.ok,
    () => false,
  );
  if (registered) break;
  if (Date.now() > deadline) throw new Error('registration failed');
}

async function query<T>(sql: string): Promise<T[]> {
  const r = await fetch(`${ADMIN}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!r.ok) throw new Error(`query: ${r.status} ${await r.text()}`);
  return ((await r.json()) as { rows: T[] }).rows;
}
const statusOf = async (id: string) =>
  (await query<{ status: string }>(`SELECT status FROM sys_invocation WHERE id = '${id}'`))[0]?.status;

let keys = 0;
/** A probe, started: its invocation id, and its outcome. */
async function start(handler: string, body: Work) {
  const r = await fetch(`${INGRESS}/Probe/k${keys++}/${handler}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${handler}: ${r.status} ${await r.text()}`);
  const { invocationId } = (await r.json()) as { invocationId: string };
  const started = Date.now();
  return {
    id: invocationId,
    /** Its outcome and how long it took, or how it stands if it has none within `withinMs`. */
    async outcome(withinMs = 15_000): Promise<Outcome & { ms: number }> {
      const attached = await fetch(`${INGRESS}/restate/invocation/${invocationId}/attach`, {
        signal: AbortSignal.timeout(withinMs),
      }).catch(() => undefined);
      if (!attached?.ok) {
        const where = `${await statusOf(invocationId)}, after ${attempts.get(invocationId)} attempts`;
        throw new Error(`${handler}: no outcome within ${withinMs} ms: it is ${where}`);
      }
      return { ...((await attached.json()) as Outcome), ms: Date.now() - started };
    },
    async cancel() {
      const cancel = await fetch(`${ADMIN}/invocations/${invocationId}/cancel`, { method: 'PATCH' });
      assert.ok(cancel.ok, `cancel: ${cancel.status} ${await cancel.text()}`);
    },
  };
}

/** Whether a check asked for the invocation's cancellation, and nothing else. */
const forCancellationAlone = (asked?: UnresolvedFuture) =>
  asked !== undefined && 'Single' in asked && asked.Single === 1;

/** Holds every selector's loop at `point`, from its next arrival there (after a check that `when` takes) until released. */
function hold(point: Failpoint, when: (asked?: UnresolvedFuture) => boolean = () => true) {
  const gate = Promise.withResolvers<void>();
  const arrived = Promise.withResolvers<void>();
  failpoints.set(point, (asked) => {
    if (!when(asked)) return undefined;
    arrived.resolve();
    return gate.promise;
  });
  return {
    arrived: arrived.promise,
    release() {
      failpoints.delete(point);
      gate.resolve();
    },
  };
}

let failed = 0;
const only = process.argv[2];
async function check(name: string, body: () => Promise<void>) {
  if (only && !name.includes(only)) return;
  failpoints.clear();
  try {
    await body();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${(e as Error).message.replaceAll('\n', ' | ')}`);
  }
}

/** The same work with the watch and without: both outcomes. */
const both = async (suffix: string, body: Work, withinMs?: number) => {
  const [watching, plain] = await Promise.all([start(`watching${suffix}`, body), start(`plain${suffix}`, body)]);
  const [w, p] = await Promise.all([watching.outcome(withinMs), plain.outcome(withinMs)]);
  return { watching: w, plain: p, ids: [watching.id, plain.id] };
};

// --- A handler that works past the inactivity timeout, and waits for nothing

await check('work past the inactivity timeout: one attempt, with the watch as without', async () => {
  const { watching, plain } = await both('', { ms: 3 * INACTIVITY });
  assert.deepEqual({ ...plain, ms: 0 }, { stopped: false, attempts: 1, ms: 0 });
  assert.deepEqual({ ...watching, ms: 0 }, { stopped: false, attempts: 1, ms: 0 });
});

await check('work, then a call, past the inactivity timeout: suspended on the call, and resumed by it', async () => {
  // With explicit recovery, the resumed attempt starts over: it works on its first attempt only.
  const { watching, plain } = await both('', { ms: 2 * INACTIVITY, after: 'call', once: true });
  assert.deepEqual({ ...plain, ms: 0 }, { stopped: false, attempts: 2, ms: 0 });
  assert.deepEqual({ ...watching, ms: 0 }, { stopped: false, attempts: 2, ms: 0 });
});

await check('work that Restate aborts after its abort timeout is retried, with the watch as without', async () => {
  const { watching, plain, ids } = await both('Aborted', { ms: 3 * INACTIVITY, once: true });
  assert.deepEqual({ ...plain, ms: 0 }, { stopped: false, attempts: 2, ms: 0 });
  assert.deepEqual({ ...watching, ms: 0 }, { stopped: false, attempts: 2, ms: 0 });
  for (const id of ids) assert.equal(ended.get(id), 2, 'the aborted attempt ended, and the one that answered');
});

// --- Its cancellation

await check('a cancellation while the input is open stops the work at once', async () => {
  const p = await start('watching', { ms: 20_000 });
  await sleep(INACTIVITY / 3);
  await p.cancel();
  const outcome = await p.outcome();
  assert.deepEqual({ ...outcome, ms: 0 }, { stopped: true, attempts: 1, ms: 0 });
  assert.ok(outcome.ms < INACTIVITY, `${outcome.ms} ms`);
});

await check('a cancellation after the input closed does not reach work that awaits nothing more', async () => {
  // Restate has no way to deliver it: the handler finishes its work, and its answer stands.
  const p = await start('watching', { ms: 3 * INACTIVITY });
  await sleep(2 * INACTIVITY);
  await p.cancel();
  assert.deepEqual({ ...(await p.outcome()), ms: 0 }, { stopped: false, attempts: 1, ms: 0 });
});

await check(
  'a cancellation after the input closed reaches the handler at its next await: the next attempt',
  async () => {
    // The call suspends the invocation on the call and the cancel signal, which Restate has: it resumes at once.
    const p = await start('watching', { ms: 3 * INACTIVITY, after: 'call' });
    await sleep(2 * INACTIVITY);
    await p.cancel();
    const outcome = await p.outcome();
    assert.deepEqual({ ...outcome, ms: 0 }, { stopped: true, attempts: 2, ms: 0 });
    assert.ok(outcome.ms < 3 * INACTIVITY + 1500, `${outcome.ms} ms`); // no second round of work
  },
);

// --- The loop held between two of its steps

await check('the input closes while the loop is held before its check: not suspended', async () => {
  const p = await start('watching', { ms: 4 * INACTIVITY });
  await sleep(200); // its first check is made, and it waits
  const held = hold('pass');
  const other = await start('plain', { ms: 0, after: 'call' }); // any invocation's: every loop is held
  await sleep(2 * INACTIVITY); // both inputs close
  held.release();
  assert.deepEqual({ ...(await p.outcome()), ms: 0 }, { stopped: false, attempts: 1, ms: 0 });
  await other.outcome();
});

await check('the input closes between a check and its wait: not suspended', async () => {
  const held = hold('wait', forCancellationAlone);
  const p = await start('watching', { ms: 4 * INACTIVITY });
  await held.arrived; // checked for its cancellation with the input open, and about to wait
  await sleep(2 * INACTIVITY); // the input closes
  held.release();
  assert.deepEqual({ ...(await p.outcome()), ms: 0 }, { stopped: false, attempts: 1, ms: 0 });
});

await check(
  'a cancel signal that comes, and the input that closes, while the loop is held: found at the next await',
  async () => {
    const p = await start('watching', { ms: 4 * INACTIVITY, after: 'race' });
    await sleep(200);
    const held = hold('pass');
    await p.cancel(); // wakes the loop, which is held at the start of its pass
    await held.arrived;
    await sleep(2 * INACTIVITY); // the input closes, with the signal in the VM and no check to see it
    held.release();
    // The work goes on to its end: nothing may ask for the cancellation alone. Then the race finds it.
    const outcome = await p.outcome();
    assert.deepEqual({ ...outcome, ms: 0 }, { stopped: true, attempts: 1, ms: 0 });
    assert.ok(outcome.ms >= 4 * INACTIVITY, `${outcome.ms} ms`);
  },
);

// --- Many at once

await check('30 at once, half of them cancelled at random: none is left suspended', async () => {
  const probes = await Promise.all(
    Array.from({ length: 30 }, async (_, i) => {
      const cancelAt = i % 2 === 0 ? Math.floor(Math.random() * 3 * INACTIVITY) : undefined;
      const p = await start('watching', { ms: 2 * INACTIVITY + Math.floor(Math.random() * INACTIVITY) });
      if (cancelAt !== undefined) void sleep(cancelAt).then(() => p.cancel().catch(() => {}));
      return { p, cancelAt };
    }),
  );
  for (const { p, cancelAt } of probes) {
    const outcome = await p.outcome();
    assert.equal(outcome.attempts, 1);
    // Cancelled well before its input closed, it stopped; never cancelled, it did not.
    if (cancelAt === undefined) assert.equal(outcome.stopped, false);
    else if (cancelAt < INACTIVITY / 2) assert.equal(outcome.stopped, true, `cancelled at ${cancelAt} ms`);
  }
});

// --- What stays as it was: a handler suspends on whatever it left pending

await check(
  'work with a call left pending is suspended on the call: its work is lost, and it resumes when the call ends',
  async () => {
    // Not the cancellation's doing: with the watch as without, to ask for a pending call is to wait for it.
    const { watching, plain } = await both('', { ms: 2 * INACTIVITY, pending: 4 * INACTIVITY, once: true });
    assert.deepEqual({ ...plain, ms: 0 }, { stopped: false, attempts: 2, ms: 0 });
    assert.deepEqual({ ...watching, ms: 0 }, { stopped: false, attempts: 2, ms: 0 });
    assert.ok(plain.ms >= 4 * INACTIVITY, `${plain.ms} ms`); // suspended until the call ended
  },
);

const left = await query<{ id: string; status: string }>(
  `SELECT id, status FROM sys_invocation WHERE target_service_name = 'Probe' AND status != 'completed'`,
);
await check('no invocation is left behind', async () => {
  assert.deepEqual(left, []);
});

console.log(failed === 0 ? 'all checks passed' : `${failed} checks failed`);
process.exit(failed === 0 ? 0 : 1);
