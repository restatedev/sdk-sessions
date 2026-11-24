/**
 * Session objects on Restate's explicit recovery protocol, end to end: a
 * commit and its send in one atomic group, a call that outlives its attempt,
 * a signal the handler waits for, invocation state across attempts,
 * heartbeats, cancellation. Needs a Restate server with the protocol on
 * (`RESTATE_EXPERIMENTAL_ENABLE_EXPLICIT_RECOVERY_PROTOCOL=true`).
 *
 *   PORT=9081 node basic/explicit-recovery.ts
 *   curl localhost:9070/deployments --json '{"uri": "http://localhost:9081"}'
 *   curl localhost:8080/TsLedger/a/add --json '"first"'
 *   curl -X POST localhost:8080/TsMailer/a/sent
 *
 * `TsOracle/answer` takes ORACLE_DELAY seconds (12) for a question that
 * starts with "slow", heartbeating meanwhile: longer than Restate's
 * inactivity timeout, so the caller's attempt is shut down and suspends.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import * as restate from '@restatedev/sessions';
import { flush, invocationState, readSignal, sendSignal, span } from '@restatedev/sessions/internal';

const text = (bytes: Uint8Array | null) => (bytes === null ? null : new TextDecoder().decode(bytes));
/** `ctx.request.attempt`: the number of the attempt, from 1, a field of this protocol's. */
const attemptOf = (ctx: restate.SessionContext) => (ctx.request as { attempt?: number }).attempt;

const oracle = restate.sessionObject({
  name: 'TsOracle',
  schema: ['CREATE TABLE asked (q TEXT NOT NULL)'],
  handlers: {
    /** Slow when the question starts with "slow": the caller's attempt is shut down meanwhile. */
    answer: async (ctx, question: string) => {
      if (question.startsWith('slow')) {
        // Heartbeats meanwhile: without them, Restate restarts this attempt at its inactivity timeout.
        await ctx.working(() => sleep(Number(process.env.ORACLE_DELAY ?? 12) * 1000));
      }
      await ctx.db.execute('INSERT INTO asked (q) VALUES (?)', [question]);
      return `42 (${question})`;
    },
  },
});

const mailer = restate.sessionObject({
  name: 'TsMailer',
  schema: ['CREATE TABLE sent (body TEXT NOT NULL)'],
  handlers: {
    notify: async (ctx, body: string) => {
      await ctx.db.execute('INSERT INTO sent (body) VALUES (?)', [body]);
    },
  },
  views: {
    sent: async (ctx) =>
      (await ctx.db.query<{ body: string }>('SELECT body FROM sent ORDER BY rowid')).map((r) => r.body),
  },
});

const ledger = restate.sessionObject({
  name: 'TsLedger',
  schema: ['CREATE TABLE entries (id INTEGER PRIMARY KEY, body TEXT NOT NULL)'],
  handlers: {
    /** Commits a row and, in the same atomic group, a send to TsMailer/notify. */
    add: async (ctx, body: string) => {
      await ctx.db.transaction(async (tx) => {
        await tx.execute('INSERT INTO entries (body) VALUES (?)', [body]);
        tx.send({ service: 'TsMailer', key: ctx.key, handler: 'notify', input: body });
      });
      const row = await ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM entries');
      return { count: row?.n ?? 0, attempt: attemptOf(ctx) };
    },
    /** Waits for the signal `approval` (index 0), then records its payload. */
    approve: async (ctx) => {
      const approval = text(await readSignal(ctx, 'approval'));
      await ctx.db.execute('INSERT INTO entries (body) VALUES (?)', [`approval:${approval}`]);
      return { approval, attempt: attemptOf(ctx) };
    },
    /** Calls TsOracle/answer with an idempotency key, so a later attempt reaches the same call. */
    ask: async (ctx, question: string) => {
      const answer = await span(ctx, 'asking the oracle', () =>
        ctx.rpc<string>({
          service: 'TsOracle',
          key: ctx.key,
          handler: 'answer',
          input: question,
          idempotencyKey: `${ctx.request.id}/ask`,
        }),
      );
      await ctx.db.execute('INSERT INTO entries (body) VALUES (?)', [`answer:${answer}`]);
      return { answer, attempt: attemptOf(ctx) };
    },
    /** Invocation state across attempts: attempt 1 records a step, flushes, then waits on nothing. */
    progress: async (ctx) => {
      const state = invocationState(ctx);
      if ((await state.get('step')) === null) {
        state.set('step', new TextEncoder().encode('reserved'));
        await flush(ctx);
        await new Promise(() => {});
      }
      return { step: text(await state.get('step')), attempt: attemptOf(ctx) };
    },
    /** Works outside Restate for `seconds`, heartbeating (`ctx.working`): never shut down meanwhile. */
    beat: async (ctx, seconds: number) => {
      await ctx.working(() => sleep(seconds * 1000));
      return 'done';
    },
    /** Sends the signal `approval` to invocation `target`, and waits until Restate applied it. */
    notify: async (ctx, target: string) => {
      sendSignal(ctx, target, 'approval', new TextEncoder().encode('"from-notify"'));
      await flush(ctx);
      return 'notified';
    },
    /** Waits on nothing, never heartbeating: Restate restarts it, then treats the idle restarts as failures. */
    stuck: async () => {
      await new Promise(() => {});
      return 'never';
    },
    /** A call to the slow TsOracle, for cancel and kill. */
    held: async (ctx) => {
      const answer = await ctx.rpc<string>({
        service: 'TsOracle',
        key: ctx.key,
        handler: 'answer',
        input: 'slow held',
      });
      return `held: ${answer}`;
    },
  },
  views: {
    count: async (ctx) => (await ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM entries'))?.n ?? 0,
    entries: async (ctx) =>
      (await ctx.db.query<{ body: string }>('SELECT body FROM entries ORDER BY id')).map((r) => r.body),
  },
});

await restate.serve(ledger, oracle, mailer);
