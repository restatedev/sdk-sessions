// Turns of the conversation of turns, on a made-up framework (fakes/items.ts):
// the call records a closed turn reports, crashes at every state request, and
// what an agent on the store has (`settle`, `compact`, `erase`, `window` and
// `budget`).
import * as restate from '@restatedev/sessions';
import { invoke } from '@restatedev/sessions/internal';
import { fakeContext, type Made } from '@restatedev/sessions/test/support';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { call, chatHandler, sessionObject, type Tool } from '@restatedev/agents';
import { callOf } from '../src/calls.ts';
import { CANCELLED, ENDED, RETURNED_UNRECORDED, toolCallEnded, toolCallStarted } from '../src/common.ts';
import { answerOnce, Conversation, type Run, STEPS, SUMMARY } from '../src/conversation.ts';
import { conversationView } from '../src/messages.ts';
import { waitFor } from '../src/tools.ts';
import { bank } from './bank.ts';
import { calling, type Item, ITEMS } from './fakes/items.ts';
import { conversation as banking, followingOf, handlerOf, sqlAttempt } from './support.ts';

/** The results a turn stored, by their calls' ids. */
const resultsOf = (conversation: Conversation<Item>) =>
  Object.fromEntries(
    conversation.entries.flatMap((e) => (e.parsed?.results ?? []).map((r) => [r.id, r.output] as const)),
  );

/**
 * What a turn stopped right after `wait` stores as the result of its tool
 * call `c1`: `wait` runs in the turn's attempt, whose companion answers a
 * wait with `no`, and its `lookups` with `found`.
 */
async function closedResult(wait: (ctx: restate.SessionContext) => Promise<void>) {
  const map = new Map<string, Uint8Array>();
  const sql = sqlAttempt({ map, key: 'k', id: 'inv_stopped', signal: () => 'no', route: async () => 'found' });
  await expect(
    sql.end(() =>
      answerOnce(sql.ctx, 'q', ITEMS, async (conversation) => {
        await conversation.turn.appendReply([calling('c1')]);
        await wait(sql.ctx);
        // The turn is stopped before the call's result is stored.
        throw new restate.CancelledError();
      }),
    ),
  ).rejects.toBeInstanceOf(restate.CancelledError);
  const read = sqlAttempt({ map, key: 'k', id: 'read' });
  return resultsOf(await read.end(() => Conversation.load(read.ctx.db, ITEMS))).c1;
}

const lookup = call(restate.service({ name: 'lookups', handlers: { lookup: async () => 'found' } }), 'lookup', {
  description: 'Look it up.',
  input: z.object({ about: z.string() }),
});

describe("a closed turn's calls", () => {
  it('report a call that returned as done, not cancelled', async () => {
    expect(await closedResult(async (ctx) => (await callOf(ctx, 'lookup', {}, 'c1')).answered())).toBe(
      RETURNED_UNRECORDED,
    );
  });

  it('report a call that failed with its error', async () => {
    expect(
      await closedResult(async (ctx: restate.SessionContext) =>
        (await callOf(ctx, 'lookup', {}, 'c1')).answered('Error: no'),
      ),
    ).toBe('Error: no');
  });

  it('report a call that never returned as cancelled', async () => {
    expect(await closedResult(async (ctx) => void (await callOf(ctx, 'lookup', {}, 'c1')))).toBe(CANCELLED);
  });

  it('do not report a call done because its approval returned', async () => {
    expect(
      await closedResult(async (ctx: restate.SessionContext) => {
        expect(await waitFor(ctx, 'c1', 'approval', { refund: 5 }, { approval: true })).toBe('no');
      }),
    ).toBe(CANCELLED);
  });

  it('report a call done once the result it waited for returned', async () => {
    expect(
      await closedResult(async (ctx: restate.SessionContext) => {
        expect(await waitFor(ctx, 'c1', 'lookup', { about: 'x' })).toBe('no');
      }),
    ).toBe(RETURNED_UNRECORDED);
  });

  it("report an approved call done once its own Restate call returned, whatever its approval's", async () => {
    expect(
      await closedResult(async (ctx: restate.SessionContext) => {
        await waitFor(ctx, 'c1', 'approval', { refund: 5 }, { approval: true });
        await lookup.run({ about: 'x' }, { ctx, callId: 'c1' });
      }),
    ).toBe(RETURNED_UNRECORDED);
  });

  it('keep a returned call until its result is stored, and forget it once it is', async () => {
    const map = new Map<string, Uint8Array>();
    const made: Made[] = [];
    const args = { about: 'o1' };
    let attempts = 0;
    const run: Run<Item> = async (conversation) => {
      const ctx = contexts.at(-1)!;
      attempts += 1;
      if (attempts === 1) {
        await conversation.turn.appendReply([
          { role: 'assistant', text: '', calls: [{ id: 't1', name: lookup.name, input: args }] },
        ]);
        await toolCallStarted(ctx);
        await lookup.run(args, { ctx, callId: 't1' });
        await toolCallEnded(ctx); // a publish: the calls whose results are stored are forgotten
        throw new Error('the process crashed before the result was stored');
      }
      // The framework drops the cut-off reply, and the model makes the call again under a new id.
      await conversation.turn.drop(conversation.turn.replies()[0]!);
      await conversation.turn.appendReply([
        { role: 'assistant', text: '', calls: [{ id: 't2', name: lookup.name, input: args }] },
      ]);
      await toolCallStarted(ctx);
      const output = await lookup.run(args, { ctx, callId: 't2' });
      await conversation.turn.append({ result: 't2', output });
      await toolCallEnded(ctx);
      await conversation.turn.appendReply([{ role: 'assistant', text: 'shipped' }]);
      return 'shipped';
    };
    const contexts: restate.SessionContext[] = [];
    const attempt = () => {
      const sql = sqlAttempt({
        map,
        key: 'k',
        id: 'inv_crashed',
        route: async (c) => {
          made.push(c);
          return 'found';
        },
      });
      contexts.push(sql.ctx);
      return sql.end(() => answerOnce(sql.ctx, 'where is o1?', ITEMS, run));
    };
    const records = async () => {
      const sql = sqlAttempt({ map, key: 'k', id: 'read' });
      const row = await sql.end(() => sql.ctx.db.get<{ calls: string }>('SELECT calls FROM restate_agent_calls'));
      return row ? (JSON.parse(row.calls) as unknown[]) : [];
    };
    await expect(attempt()).rejects.toThrow('crashed');
    // The call returned, but its result is not stored: it is kept.
    expect(await records()).toHaveLength(1);
    expect(await attempt()).toBe('shipped');
    // The retry, under a new id, reached the same Restate call; and once its result is stored, it is forgotten.
    expect(made.map((m) => m.idempotencyKey)).toEqual(['inv_crashed:t1', 'inv_crashed:t1']);
    expect(await records()).toEqual([]);
  });
});

/**
 * A made-up framework's run, with `tools` and a model that, asked with the
 * conversation's history, calls the tool its prompt asks for or answers with
 * the last result: a stored final reply is answered without asking the model,
 * and the open calls of a cut-off reply run again with their ids.
 */
function teller(tools: Tool[], asked: { count: number } = { count: 0 }) {
  const model = (history: Item[]): Item => {
    asked.count += 1;
    const last = history.at(-1)!;
    if (last.result !== undefined) return { role: 'assistant', text: `Done: ${last.output}` };
    const transfer = /move (\d+) from (\d+) to (\d+)/.exec(last.text ?? '');
    if (transfer) {
      const [, amount, from, to] = transfer.map(Number);
      const input = { from, to, amount };
      return { role: 'assistant', text: 'On it.', calls: [{ id: `t${history.length}`, name: 'transfer', input }] };
    }
    return { role: 'assistant', text: '', calls: [{ id: `a${history.length}`, name: 'audit', input: {} }] };
  };
  return (ctx: restate.SessionContext): Run<Item> =>
    async (conversation) => {
      const turn = conversation.turn;
      for (;;) {
        const final = turn.finalReply();
        if (final !== undefined) return final;
        const open = turn.openCalls();
        if (open.length === 0) {
          await turn.appendReply([model(conversation.history())]);
          continue;
        }
        for (const c of open) {
          await toolCallStarted(ctx);
          const output = await tools.find((t) => t.name === c.name)!.run(c.input, { ctx, callId: c.id });
          await turn.append({ result: c.id, output });
          await toolCallEnded(ctx);
        }
      }
    };
}

/** The bank agent on the made-up framework, its model asked `asked.count` times. */
const tellerAgent = (asked?: { count: number }) => {
  const run = teller(bank('teller'), asked);
  return chatHandler((ctx, message) => answerOnce(ctx, message, ITEMS, run(ctx)));
};

describe('a call whose result a turn stored', () => {
  it('is forgotten as the turn ends, with no publish after', async () => {
    const map = new Map<string, Uint8Array>();
    const sql = sqlAttempt({ map, key: 'k', id: 'inv_quiet', route: async () => 'found' });
    await sql.end(() =>
      answerOnce(sql.ctx, 'q', ITEMS, async (conversation) => {
        await conversation.turn.appendReply([
          { role: 'assistant', text: '', calls: [{ id: 't1', name: lookup.name, input: {} }] },
        ]);
        const output = await lookup.run({ about: 'x' }, { ctx: sql.ctx, callId: 't1' });
        await conversation.turn.append({ result: 't1', output });
        return 'done';
      }),
    );
    const read = sqlAttempt({ map, key: 'k', id: 'read' });
    const row = await read.end(() => read.ctx.db.get<{ calls: string }>('SELECT calls FROM restate_agent_calls'));
    expect(JSON.parse(row!.calls)).toEqual([]);
  });
});

describe('the bank agent on the made-up framework', () => {
  it('answers a message once after a crash at any of its state requests', async () => {
    const messages = conversationView(ITEMS);
    const clean = banking(tellerAgent(), 'clean');
    await clean.attempt('inv0', 'Please move 1 from 3 to 4');
    await clean.attempt('inv1', 'Please move 5 from 1 to 2');
    const expected = (await clean.read(messages, {})).messages;
    const wrong: string[] = [];
    for (let n = 1; ; n += 1) {
      const asked = { count: 0 };
      const c = banking(tellerAgent(asked), 'anywhere');
      await c.attempt('inv0', 'Please move 1 from 3 to 4');
      const before = asked.count;
      if ((await c.attempt('inv1', 'Please move 5 from 1 to 2', n)) !== 'crashed') break;
      const answer = await c.attempt('inv1', 'Please move 5 from 1 to 2').catch((error: unknown) => String(error));
      const seen = (await c.read(messages, {})).messages;
      // The model is asked twice for the prompt (the transfer, then the answer), and once more at most:
      // for a reply the crash cut off before it was stored.
      const ok =
        answer === 'Done: moved 5 from account 1 to account 2' &&
        c.ledger.transfers.size === 2 &&
        JSON.stringify(seen) === JSON.stringify(expected) &&
        asked.count - before <= 3;
      if (!ok) wrong.push(`${n}: ${answer}, ${c.ledger.transfers.size} transfers, asked ${asked.count - before}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it('answers a stored final reply without asking the model again', async () => {
    const asked = { count: 0 };
    const map = new Map<string, Uint8Array>();
    const run = teller([], asked);
    // The model's final reply is stored, then the attempt dies before the turn's answer is.
    const first = sqlAttempt({ map, key: 'k', id: 'inv_final' });
    await expect(
      first.end(() =>
        answerOnce(first.ctx, 'hello', ITEMS, async (conversation) => {
          await conversation.turn.appendReply([{ role: 'assistant', text: 'Hi there' }]);
          throw new Error('crashed');
        }),
      ),
    ).rejects.toThrow('crashed');
    const next = sqlAttempt({ map, key: 'k', id: 'inv_final' });
    expect(await next.end(() => answerOnce(next.ctx, 'hello', ITEMS, run(next.ctx)))).toBe('Hi there');
    expect(asked.count).toBe(0);
  });
});

/** An agent on the store, with a made-up framework that answers `fine`, and the calls its handlers make. */
function storeAgent(
  options: { budget?: number; summarize?: (ctx: restate.SessionContext, request: string) => Promise<string> } = {},
) {
  const agent = sessionObject({
    name: 'keeper',
    ...options,
    handlers: {
      chat: chatHandler((ctx, message) =>
        answerOnce(ctx, message, ITEMS, async (conversation) => {
          if (message === 'die') {
            await conversation.turn.appendReply([calling('c1')]);
            throw new Error('the invocation is gone');
          }
          return `fine: ${message}`;
        }),
      ),
    },
    views: { messages: conversationView(ITEMS) },
  });
  const map = new Map<string, Uint8Array>();
  const calls: Made[] = [];
  const sends: Made[] = [];
  let n = 0;
  const run = (handler: string, input?: unknown, id = `inv_${++n}`) =>
    invoke(agent, handler, fakeContext({ map, service: 'keeper', key: 'alice', id, calls, sends }), input);
  return { agent, run, calls, sends, map };
}

/** An agent of `options`, to define. */
const make = (options: object) => () =>
  sessionObject({ name: 'x', ...options, views: { messages: conversationView(ITEMS) } });

describe('an agent on the conversation of turns', () => {
  it('has `settle` and `compact`, private, beside `erase`', () => {
    const { agent } = storeAgent();
    const handlers = Object.keys((agent as unknown as { object: object }).object);
    expect(handlers).toEqual(expect.arrayContaining(['erase', 'settle', 'compact']));
    expect(() =>
      // @ts-expect-error: a handler every agent has
      sessionObject({ name: 'x', handlers: { settle: async () => {} }, views: { messages: conversationView(ITEMS) } }),
    ).toThrow('`settle` is a handler');
  });

  it("starts each turn saying it settles; another's turn does not", async () => {
    const { run, calls } = storeAgent();
    await run('chat', 'hi');
    expect(calls.find((c) => c.method === 'start')?.parameter).toMatchObject({ settles: true });
    const other = sessionObject({
      name: 'other',
      handlers: { chat: chatHandler(async () => 'ok') },
      views: { messages: async () => ({ messages: [], more: false, cursor: 0 }) },
    });
    const otherCalls: Made[] = [];
    await invoke(other, 'chat', fakeContext({ map: new Map(), service: 'other', calls: otherCalls }), 'hi');
    expect(otherCalls.find((c) => c.method === 'start')?.parameter).not.toHaveProperty('settles');
  });

  it("closes a gone invocation's turn on `settle`, and publishes it", async () => {
    const { run, calls } = storeAgent();
    await expect(run('chat', 'die', 'inv_gone')).rejects.toThrow('gone');
    calls.length = 0;
    expect(await run('settle', 'inv_other')).toBe(false);
    expect(calls).toEqual([]);
    expect(await run('settle', 'inv_gone')).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['publish']);
    const page = (await run('messages', {})) as { messages: { parts: { text?: string; output?: string }[] }[] };
    expect(page.messages.at(-1)!.parts).toEqual([{ type: 'text', text: ENDED }]);
    expect(await run('settle', 'inv_gone')).toBe(false);
  });

  it('keeps its ids and cursors going through `erase`', async () => {
    const { run } = storeAgent();
    await run('chat', 'one');
    const before = (await run('messages', {})) as { cursor: number };
    await run('erase');
    const emptied = (await run('messages', {})) as { messages: unknown[]; first: number; cursor: number };
    expect([emptied.messages, emptied.first, emptied.cursor]).toEqual([[], 2, before.cursor]);
    await run('chat', 'two');
    expect(((await run('messages', {})) as { messages: { id: number }[] }).messages.map((m) => m.id)).toEqual([2, 3]);
  });

  it('summarizes the earliest turns once they outgrow its budget, in `compact`', async () => {
    const requests: string[] = [];
    const { run, sends, map } = storeAgent({
      budget: 10,
      summarize: async (_ctx, request) => {
        requests.push(request);
        return 'they talked';
      },
    });
    for (let i = 0; i < 6; i++) await run('chat', `q${i}`, `inv_q${i}`);
    // The turns before the next window outgrew 40 characters: `compact` was sent, once per prompt.
    const compacts = sends.filter((s) => s.method === 'compact');
    expect(compacts.length).toBeGreaterThan(0);
    expect(compacts[0]).toMatchObject({ key: 'alice', idempotencyKey: expect.stringMatching(/:compact$/) });
    expect(await run('compact')).toBe(true);
    expect(requests[0]).toMatch(/^Summarize the conversation/);
    expect(requests[0]).toContain('User: q0\nAssistant: fine: q0');
    // The next turn's model sees the summary, then the turns after it.
    const seen: Item[][] = [];
    const sql = sqlAttempt({ map, key: 'alice', id: 'inv_next' });
    await sql.end(() =>
      answerOnce(
        sql.ctx,
        'next',
        ITEMS,
        async (conversation) => {
          seen.push(conversation.history());
          return 'ok';
        },
        { budget: 10, window: 1 },
      ),
    );
    expect(seen[0]![0]).toEqual({ role: 'user', text: `${SUMMARY}they talked` });
    // The rows stay: the views show every turn.
    const rows = await sqlAttempt({ map, key: 'alice', id: 'read' }).ctx.db.values(`SELECT COUNT(*) FROM ${STEPS}`);
    expect(Number(rows[0]![0])).toBeGreaterThan(0);
  });

  it('refuses a window or budget that is not a number of turns or tokens', () => {
    expect(make({ window: -1 })).toThrow('window');
    expect(make({ window: 1.5 })).toThrow('window');
    expect(make({ budget: -5 })).toThrow('budget');
    expect(make({ window: 'all', budget: 0 })).not.toThrow();
  });
});

describe('a turn of a chat handler on the store', () => {
  it('is settled by its agent when the next turn finds its invocation gone', async () => {
    const map = new Map<string, Uint8Array>();
    const { agent } = storeAgent();
    const chat = (agent as unknown as { object: Record<string, unknown> }).object;
    expect(chat).toBeDefined();
    const ask = (id: string, text: string) => {
      const sql = sqlAttempt({ map, key: 'k', id, object: agent });
      return sql.end(() => run(sql.ctx, text));
    };
    const run = handlerOf(
      chatHandler((ctx, message) =>
        answerOnce(ctx, message, ITEMS, async (conversation) => {
          if (message === 'die') {
            await conversation.turn.appendReply([calling('c1')]);
            throw new Error('the invocation is gone');
          }
          return 'fine';
        }),
      ),
    );
    await expect(ask('inv_a', 'die')).rejects.toThrow('gone');
    expect(await ask('inv_b', 'hi')).toBe('fine');
    // The companion closed the gone turn as the next started, and would have its agent settle it.
    expect(followingOf(map).settled).toEqual(['inv_a']);
  });
});
