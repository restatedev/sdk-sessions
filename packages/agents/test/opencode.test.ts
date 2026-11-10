// The OpenCode agent without a Restate server, through crashes and kills of
// the handler (see ./support.ts): a crashed attempt gets no chance to store
// anything on the way out. Its model is the teller of ./fakes/opencode.ts,
// given to every boot of OpenCode (the mock below).
//
// OpenCode needs Node 24 (its sources use syntax Node 22 does not parse): on
// older Node the suite is skipped, and nothing of OpenCode is imported.
// `pnpm --filter @restatedev/agents exec vitest run test/opencode.test.ts`.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { APICallError } from '@ai-sdk/provider';
import * as restate from '@restatedev/sessions';
import { invoke } from '@restatedev/sessions/internal';
import { fakeContext } from '@restatedev/sessions/test/support';
import { z } from 'zod';
import { tool } from '@restatedev/agents';
import { callOf } from '../src/calls.ts';
import { CANCELLED, ENDED, REFUSED, RETURNED_UNRECORDED } from '../src/common.ts';
import type * as Db from '../src/opencode/db.ts';
import type * as OpenCode from '../src/opencode/index.ts';
import type * as Fake from './fakes/opencode.ts';
import type * as Bank from './opencode.ts';
import { bank } from './bank.ts';
import {
  afterCancel,
  cancelledTransfer,
  conversation,
  crashedAnywhere,
  followedWhileWorking,
  followingOf,
  handlerOf,
  sqlAttempt,
  steeredAtAStep,
  type PromptHandler,
  SAID_IN_TURNS as SAID,
} from './support.ts';

const NODE_24 = Number(process.versions.node.split('.')[0]) >= 24;

/** How often OpenCode was booted; `prompted`, if a test sets it, is told of each prompt OpenCode took, as it returns. */
const boots = vi.hoisted(() => ({ n: 0, prompted: undefined as ((input: { id?: unknown }) => void) | undefined }));

// Every boot of OpenCode has the teller's provider.
vi.mock('@restatedev/agents/opencode/db', async (original) => {
  const db = await original<typeof Db>();
  const { scriptedPlugin } = await import('./fakes/opencode.ts');
  const { Effect } = await import('effect');
  const openOpenCode: typeof db.openOpenCode = async (database, fence, options) => {
    boots.n++;
    const host = await db.openOpenCode(database, fence, {
      ...options,
      plugins: [scriptedPlugin, ...(options.plugins ?? [])],
    });
    // `session.prompt`, which tells `boots.prompted` once OpenCode took the prompt.
    const prompt = (input: Parameters<typeof host.client.session.prompt>[0]) =>
      host.client.session.prompt(input).pipe(Effect.tap(() => Effect.sync(() => boots.prompted?.(input))));
    const session = new Proxy(host.client.session, {
      get: (target, key, receiver) => (key === 'prompt' ? prompt : Reflect.get(target, key, receiver)),
    });
    const client = new Proxy(host.client, {
      get: (target, key, receiver) => (key === 'session' ? session : Reflect.get(target, key, receiver)),
    });
    return { ...host, client };
  };
  return { ...db, openOpenCode };
});
vi.stubEnv('MODEL', 'scripted/scripted');

// Imported only on Node 24: OpenCode does not load on older Node.
let opencode: typeof OpenCode;
let fake: typeof Fake;
let prompt: typeof Bank.prompt;
beforeAll(async () => {
  if (!NODE_24) return;
  opencode = await import('@restatedev/agents/opencode');
  fake = await import('./fakes/opencode.ts');
  ({ prompt } = await import('./opencode.ts'));
});

beforeEach(() => {
  if (!NODE_24) return;
  fake.script.requests.length = 0;
  fake.script.reply = fake.teller;
  boots.prompted = undefined;
});

/** The texts of the user's messages of the model's latest request, in order. */
const userTexts = () =>
  fake.script.requests
    .at(-1)!
    .prompt.filter((m) => m.role === 'user')
    .map((m) => fake.textOf(m));

/** Whether a request to the model went on with a turn after a restart: OpenCode's "Continue". */
const continued = () =>
  fake.script.requests.some((r) => r.prompt.some((m) => m.role === 'user' && fake.CONTINUE.test(fake.textOf(m))));

describe.skipIf(!NODE_24)('the OpenCode agent', () => {
  it('answers a message once: a retried attempt of an answered prompt boots nothing', async () => {
    const c = conversation(prompt, 'once');
    const first = await c.attempt('inv1', 'Please move 5 from 1 to 2');
    expect(first).toBe('Done: moved 5 from account 1 to account 2');
    const booted = boots.n;
    const asked = fake.script.requests.length;
    expect(await c.attempt('inv1', 'Please move 5 from 1 to 2')).toBe(first);
    expect(boots.n).toBe(booted);
    expect(fake.script.requests.length).toBe(asked);
    expect(c.ledger.transfers.size).toBe(1);
    // The next prompt goes on in the same session.
    expect(await c.attempt('inv2', 'audit the books')).toMatch(/^Done: .*"transfers":1/);
  }, 60_000);

  it('resumes a crashed attempt in its tool call: the transfer is made once', async () => {
    const c = conversation(prompt, 'crash');
    const input = 'Please move 7 from 3 to 4';
    await c.crash('inv1', input);
    // The retried attempt resumes OpenCode's turn: the model retries the interrupted transfer, then answers.
    expect(await c.attempt('inv1', input)).toBe('Done: moved 7 from account 3 to account 4');
    expect(continued()).toBe(true);
    expect(c.ledger.transfers.size).toBe(1);
    const { messages } = await c.read(opencode.messages(), {});
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(messages.at(-1)!.parts).toEqual([{ type: 'text', text: 'Done: moved 7 from account 3 to account 4' }]);
  }, 60_000);

  it('resumes a turn however many attempts crash: Restate decides', async () => {
    const c = conversation(prompt, 'crashes');
    const input = 'Please move 4 from 2 to 3';
    // More than the ten resumes OpenCode allows a turn by default.
    for (let n = 0; n < 12; n++) await c.crash('inv1', input);
    expect(await c.attempt('inv1', input)).toBe('Done: moved 4 from account 2 to account 3');
    expect(c.ledger.transfers.size).toBe(1);
  }, 120_000);

  it('closes a killed turn by the next message: never finished, the note told to the model', async () => {
    const c = conversation(prompt, 'dead');
    // Killed in its transfer: its invocation is gone, and the next message comes.
    await c.crash('inv1', 'Please move 1 from 0 to 1');
    expect(await c.attempt('inv2', 'Please move 2 from 0 to 1')).toBe('Done: moved 2 from account 0 to account 1');
    // The dead turn's transfer was not made again under the new invocation.
    expect(c.ledger.calls.map((call) => call.key?.split(':')[0])).toEqual(['inv1', 'inv2']);
    expect(continued()).toBe(false);
    // The next model request: the note, then the prompt.
    expect(userTexts().at(-1)).toBe(`(${ENDED})\n\nPlease move 2 from 0 to 1`);
    const { messages } = await c.read(opencode.messages(), {});
    expect(messages[1]!.parts[1]).toMatchObject({ type: 'tool', output: ENDED, error: true });
    expect(messages[2]!.parts).toEqual([{ type: 'text', text: ENDED }]);
    expect(messages[3]!.parts).toEqual([{ type: 'text', text: 'Please move 2 from 0 to 1' }]);
    // The store has the turn ended.
    const statuses = await c.read(async (ctx) => ctx.db.values('SELECT status FROM restate_agent_turns ORDER BY n'));
    expect(statuses).toEqual([['ended'], ['answered']]);
    // Its invocation, should it come again, fails with the note.
    await expect(c.attempt('inv1', 'Please move 1 from 0 to 1')).rejects.toThrow(ENDED);
    expect(c.ledger.transfers.size).toBe(2);
  }, 60_000);

  it('tells the model which calls of a killed turn did happen', async () => {
    // A transfer whose Restate call returned, and whose attempt was killed before OpenCode stored its result.
    const returned = Promise.withResolvers<void>();
    const transfer = tool({
      name: 'transfer',
      description: 'Move money.',
      input: z.object({ from: z.number(), to: z.number(), amount: z.number() }),
      run: async (input, { ctx, callId }) => {
        await (await callOf(ctx, 'transfer', input, callId)).answered();
        returned.resolve();
        return new Promise<never>(() => {});
      },
    });
    const chat = handlerOf(opencode.chat({ tools: [transfer] }));
    const map = new Map<string, Uint8Array>();
    const fence = { closed: false };
    const first = sqlAttempt({ map, fence, key: 'happened', id: 'inv1' });
    void first.end(() => chat(first.ctx, 'Please move 5 from 1 to 2')).catch(() => {});
    await returned.promise;
    fence.closed = true;
    first.abort();
    const second = sqlAttempt({ map, key: 'happened', id: 'inv2' });
    expect(await second.end(() => chat(second.ctx, 'Hello'))).toMatch(/^Ask me/);
    const read = sqlAttempt({ map, key: 'happened', id: 'read', shared: true });
    const { messages } = await read.end(() => opencode.messages()(read.view, {}));
    // The store has the call done, its result not recorded.
    expect(messages[1]!.parts[1]).toMatchObject({ type: 'tool', output: RETURNED_UNRECORDED });
    const id = (messages[1]!.parts[1] as { id: string }).id;
    expect(userTexts().at(-1)).toBe(`(${ENDED} These calls did happen: transfer (${id}).)\n\nHello`);
    expect(continued()).toBe(false);
  }, 60_000);

  it("closes a killed turn on its companion's `settle`: never finished", async () => {
    const c = conversation(prompt, 'settled');
    await c.crash('inv1', 'Please move 1 from 0 to 1');
    const agent = opencode.agent({ name: 'OpenCodeAgent', tools: bank('OpenCodeAgent') });
    const map = c.state as Map<string, Uint8Array>;
    const asked = fake.script.requests.length;
    const settle = (id: string) =>
      invoke(agent, 'settle', fakeContext({ map, service: 'OpenCodeAgent', key: 'settled', id: `inv_s${id}` }), 'inv1');
    expect(await settle('1')).toBe(true);
    expect(await settle('2')).toBe(false);
    // Closed without the model.
    expect(fake.script.requests.length).toBe(asked);
    const { messages } = await c.read(opencode.messages(), {});
    expect(messages[1]!.parts[1]).toMatchObject({ type: 'tool', output: ENDED, error: true });
    expect(messages.at(-1)!.parts).toEqual([{ type: 'text', text: ENDED }]);
    const summary = await c.read(opencode.messages(), { view: 'summary' });
    expect(summary.messages.at(-1)!.parts).toEqual([{ type: 'text', text: ENDED }]);
    // The next message is a turn of its own: the dead transfer not made again, the note told.
    expect(await c.attempt('inv2', 'Please move 2 from 0 to 1')).toBe('Done: moved 2 from account 0 to account 1');
    expect(continued()).toBe(false);
    expect(userTexts().at(-1)).toBe(`(${ENDED})\n\nPlease move 2 from 0 to 1`);
    expect(c.ledger.calls.map((call) => call.key?.split(':')[0])).toEqual(['inv1', 'inv2']);
  }, 60_000);

  it('closes a stopped turn cancelled, and answers the next message afresh with the note', async () => {
    const { failed, answer, parts } = await afterCancel(
      opencode.chat({ tools: [cancelledTransfer] }),
      opencode.messages(),
    );
    expect(failed).toBeInstanceOf(restate.CancelledError);
    expect(answer).toBe('Ask me to "move 5 from 1 to 2", or to "audit" the books.');
    expect(userTexts().at(-1)).toBe(`(${CANCELLED})\n\nHello`);
    expect(continued()).toBe(false);
    expect(parts).toEqual([
      [{ type: 'text', text: 'Please move 5 from 1 to 2' }],
      [
        { type: 'text', text: 'On it.' },
        {
          type: 'tool',
          id: expect.any(String),
          name: 'transfer',
          input: { from: 1, to: 2, amount: 5 },
          output: CANCELLED,
          error: true,
        },
      ],
      [{ type: 'text', text: CANCELLED }],
      [{ type: 'text', text: 'Hello' }],
      [{ type: 'text', text: 'Ask me to "move 5 from 1 to 2", or to "audit" the books.' }],
    ]);
  }, 60_000);

  it('fails a prompt its provider refuses with 424, and closes its turn', async () => {
    // A wrong API key: the provider answers 401, which no retry changes.
    fake.script.reply = () => {
      throw new APICallError({
        message: 'Incorrect API key provided',
        url: 'https://scripted.invalid/v1',
        requestBodyValues: {},
        statusCode: 401,
        isRetryable: false,
      });
    };
    const c = conversation(prompt, 'refused');
    const failed = await c.attempt('inv1', 'Hello').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(restate.TerminalError);
    expect((failed as restate.TerminalError).code).toBe(REFUSED);
    fake.script.reply = fake.teller;
    expect(await c.attempt('inv2', 'Hello')).toMatch(/^Ask me/);
  }, 60_000);

  it('publishes the conversation as a turn and its tool calls start and end', async () => {
    const { answer, parts, published } = await followedWhileWorking(
      (tools) => opencode.chat({ tools }),
      opencode.messages(),
    );
    expect(answer).toBe('Done: moved 5 from account 1 to account 2');
    expect(parts).toEqual([
      [{ type: 'text', text: 'Please move 5 from 1 to 2' }],
      [
        { type: 'text', text: 'On it.' },
        {
          type: 'tool',
          name: 'transfer',
          input: { from: 1, to: 2, amount: 5 },
          output: 'moved 5 from account 1 to account 2',
        },
      ],
      [{ type: 'text', text: answer }],
    ]);
    expect(published).toBe(4);
  }, 60_000);

  it('gives the conversation from the store: what was said, in order, with the tool calls', async () => {
    const c = conversation(prompt, 'm');
    await c.attempt('inv1', 'Please move 5 from 1 to 2');
    await c.attempt('inv2', 'audit the books');
    expect(await c.read(opencode.messages(), {})).toEqual({ messages: SAID, more: false, cursor: expect.any(Number) });
  }, 60_000);

  it("forgets the conversation on `clear`, OpenCode's database too", async () => {
    const c = conversation(prompt, 'clear');
    await c.attempt('inv1', 'Please move 5 from 1 to 2');
    const agent = opencode.agent({ name: 'OpenCodeAgent', tools: bank('OpenCodeAgent') });
    const map = c.state as Map<string, Uint8Array>;
    await invoke(agent, 'erase', fakeContext({ map, service: 'OpenCodeAgent', key: 'clear', id: 'inv_erase' }));
    expect((await c.read(opencode.messages(), {})).messages).toEqual([]);
    expect(await c.attempt('inv2', 'Hello')).toMatch(/^Ask me/);
    // OpenCode's session starts anew: the model sees only the new prompt.
    expect(userTexts()).toEqual(['Hello']);
  }, 60_000);

  it('asks again within the turn for an answer that is not the output asked for', async () => {
    fake.script.reply = ({ prompt: asked }) =>
      fake.textOf(asked.at(-1)!).startsWith('Your reply is not the answer') ? { text: '{"n":1}' } : { text: 'one' };
    const c = conversation(
      opencode.chat({ output: z.object({ n: z.number() }) }) as unknown as PromptHandler,
      'output',
    );
    expect(await c.attempt('inv1', 'How many?')).toEqual({ n: 1 });
    // One turn: its prompt, the reply, the ask again, and its answer.
    const { messages } = await c.read(opencode.messages(), {});
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages.at(-1)!.parts).toEqual([{ type: 'text', text: '{"n":1}' }]);
    expect(fake.script.requests).toHaveLength(2);
  }, 60_000);

  it('gives the model its system prompt', async () => {
    const c = conversation(opencode.chat({ system: 'You are Ada.' }), 'ada');
    expect(await c.attempt('inv1', 'Who are you?')).toContain('You are Ada.');
  }, 60_000);

  it('answers a message once after a crash at any of its state requests', async () => {
    // One at a time: the teller's script is shared.
    expect(
      await crashedAnywhere(prompt, opencode.messages(), {
        concurrency: 1,
        stride: Number(process.env.CRASH_STRIDE ?? 7),
      }),
    ).toEqual([]);
  }, 600_000);
});

/** The user's messages and tool results of each of the model's requests after its first, after the prompt. */
const steps = () =>
  fake.script.requests.slice(1).map((r) =>
    r.prompt
      .filter((m) => m.role === 'user' || m.role === 'tool')
      .slice(1)
      .map((m) => fake.textOf(m)),
  );

/** The texts of the conversation's messages, as the `messages` view of `map`'s key `key` gives them. */
const textsOf = async (map: Map<string, Uint8Array>, key: string) => {
  const read = sqlAttempt({ map, key, id: 'read', shared: true });
  const { messages } = await read.end(() => opencode.messages()(read.view, {}));
  return messages.flatMap((m) => m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])));
};

describe.skipIf(!NODE_24)('the OpenCode agent, steered', () => {
  /** The steered message, placed by OpenCode at the step after the transfer's round, after its result: the model audits. */
  const SAID_STEERED = [
    ['user', 'Please move 5 from 1 to 2'],
    ['assistant', 'On it. + transfer'],
    ['user', 'audit the books'],
    ['assistant', 'audit'],
    ['assistant', 'moved 5 from account 1 to account 2\nthe books are fine'],
  ];
  const STEERED = 'audit the books';
  const INTERRUPTED = /Tool execution interrupted/;

  /** How many tool calls the model made: each has an id of its own. */
  let calls = 0;
  const call = (name: string, input: Record<string, unknown>) => ({ id: `call_${++calls}`, name, input });
  /**
   * The model of `steeredAtAStep`: it transfers as asked, audits when told
   * to (again, after a restart cut the audit off), and answers with its
   * tools' results.
   */
  const steeredModel = ({ prompt: asked }: Fake.Request): Fake.Reply => {
    const last = asked.at(-1)!;
    const text = fake.textOf(last);
    if (last.role === 'tool') {
      const results = asked.flatMap((m) => (m.role === 'tool' ? [fake.textOf(m)] : []));
      return { text: results.filter((r) => !INTERRUPTED.test(r)).join('\n') };
    }
    if (text === STEERED || fake.CONTINUE.test(text)) return { call: call('audit', {}) };
    if (/move 5 from 1 to 2/.test(text))
      return { text: 'On it.', call: call('transfer', { from: 1, to: 2, amount: 5 }) };
    throw new Error(`unexpected request: ${text}`);
  };

  /** Whether any request to the model had the steered message. */
  const asked = () => fake.script.requests.some((r) => r.prompt.some((m) => fake.textOf(m) === STEERED));

  beforeEach(() => {
    if (!NODE_24) return;
    fake.script.reply = steeredModel;
  });

  it('submits a message steered while a tool runs as the round is done: the next request has it, after the results', async () => {
    const { answer, said, audits, taken } = await steeredAtAStep(
      (tools) => opencode.chat({ tools }),
      opencode.messages(),
    );
    // Stored once, in its place: after the transfer's round.
    expect(said).toEqual(SAID_STEERED);
    expect(answer).toBe('moved 5 from account 1 to account 2\nthe books are fine');
    expect(audits).toBe(1);
    expect(taken).toEqual(['steer-1']);
    // The model's request after the transfer's result has the message, after it: the turn's next step.
    expect(steps()).toEqual([
      ['moved 5 from account 1 to account 2', STEERED],
      ['moved 5 from account 1 to account 2', STEERED, 'the books are fine'],
    ]);
  }, 60_000);

  it('retries a turn that failed after it took the message with the message, once', async () => {
    const { answer, failed, said, audits, taken } = await steeredAtAStep(
      (tools) => opencode.chat({ tools }),
      opencode.messages(),
      { failAudit: true },
    );
    expect(failed).toBeInstanceOf(Error);
    // OpenCode resumes the turn: the cut-off audit keeps OpenCode's result, and the model audits again.
    expect(said).toEqual([...SAID_STEERED.slice(0, 4), ['assistant', 'audit'], SAID_STEERED[4]]);
    expect(answer).toBe('moved 5 from account 1 to account 2\nthe books are fine');
    expect(audits).toBe(2);
    expect(taken).toEqual(['steer-1']);
    // OpenCode has it once too: each request since has it once.
    for (const step of steps()) expect(step.filter((s) => s === STEERED)).toHaveLength(1);
  }, 60_000);

  /**
   * `steeredAtAStep`'s turn, whose attempt dies (killed: nothing more is
   * stored) once OpenCode took the message (`submitted`: before OpenCode
   * stored the transfer's result, or placed the message), or once the model
   * is asked with it (`asked`: OpenCode placed it); then the next attempt.
   * Its answer, the message's `taken`s, whether the turn had stored it when
   * the attempt died, and the conversation's texts and steered rows then.
   */
  async function diedAfterSteer(at: 'submitted' | 'asked') {
    const key = `died-${at}`;
    const map = new Map<string, Uint8Array>();
    const following = followingOf(map);
    const transfer = tool({
      name: 'transfer',
      description: 'Move money.',
      input: z.object({ from: z.number(), to: z.number(), amount: z.number() }),
      run: () => {
        if (!following.taken.flat().includes('steer-1')) following.steering = [{ id: 'steer-1', text: STEERED }];
        return 'moved 5 from account 1 to account 2';
      },
    });
    const audit = tool({ name: 'audit', description: 'Check the books.', input: z.object({}), run: () => 'fine' });
    const chat = handlerOf(opencode.chat({ tools: [transfer, audit] }));
    const fence = { closed: false };
    const first = sqlAttempt({ map, fence, key, id: 'inv1' });
    const died = Promise.withResolvers<void>();
    let storedThen: boolean | undefined;
    const die = () => {
      if (fence.closed) return;
      storedThen = following.taken.length > 0;
      fence.closed = true;
      first.abort();
      died.resolve();
    };
    if (at === 'submitted') boots.prompted = (input) => String(input.id).startsWith('msg_steer_') && die();
    fake.script.reply = (request) => {
      if (at === 'asked' && fake.textOf(request.prompt.at(-1)!) === STEERED) die();
      return steeredModel(request);
    };
    const answering = first.end(() => chat(first.ctx, 'Please move 5 from 1 to 2')).catch(() => {});
    await died.promise;
    await answering;
    boots.prompted = undefined;
    const second = sqlAttempt({ map, key, id: 'inv1' });
    const answer = await second.end(() => chat(second.ctx, 'Please move 5 from 1 to 2'));
    const read = sqlAttempt({ map, key, id: 'rows', shared: true });
    const rows = await read.end(() => read.view.db.values('SELECT turn, id FROM restate_agent_steers'));
    // Each `taken` once: the outbox sends one again after a crash, under the same idempotency key.
    const taken = [...new Set(following.taken.flat())];
    return { answer, taken, storedThen, texts: await textsOf(map, key), rows };
  }

  it('stores the message once when the attempt dies once OpenCode took it, before OpenCode placed it', async () => {
    const { answer, taken, storedThen, texts, rows } = await diedAfterSteer('submitted');
    expect(storedThen).toBe(false);
    // The resumed turn places it, after OpenCode's "Continue": the model audits. OpenCode never stored the
    // transfer's result, which it then gives as cut off (the turn keeps it as the tool returned it).
    expect(steps()[0]!.slice(-2)).toEqual([expect.stringMatching(fake.CONTINUE), STEERED]);
    expect(answer).toBe('fine');
    expect(taken).toEqual(['steer-1']);
    // The view has it once, after the transfer's round; the store holds it once, as the turn's.
    expect(texts.filter((t) => t === STEERED)).toHaveLength(1);
    expect(texts.indexOf(STEERED)).toBe(texts.indexOf('On it.') + 1);
    expect(rows).toEqual([[0, 'steer-1']]);
    for (const step of steps()) expect(step.filter((s) => s === STEERED).length).toBeLessThanOrEqual(1);
  }, 60_000);

  it('stores the message once when the attempt dies once the model is asked with it', async () => {
    const { answer, taken, texts, rows } = await diedAfterSteer('asked');
    expect(answer).toBe('moved 5 from account 1 to account 2\nfine');
    expect(taken).toEqual(['steer-1']);
    expect(texts.filter((t) => t === STEERED)).toHaveLength(1);
    expect(texts.indexOf(STEERED)).toBe(texts.indexOf('On it.') + 1);
    expect(rows).toEqual([[0, 'steer-1']]);
    for (const step of steps()) expect(step.filter((s) => s === STEERED).length).toBeLessThanOrEqual(1);
  }, 60_000);

  it('takes no message steered as the model writes the final answer: a turn of its own answers it', async () => {
    const map = new Map<string, Uint8Array>();
    const following = followingOf(map);
    fake.script.reply = (request) => {
      // The final answer: no step follows it.
      if (request.prompt.at(-1)!.role === 'tool') following.steering = [{ id: 'steer-1', text: STEERED }];
      return steeredModel(request);
    };
    const transfer = tool({
      name: 'transfer',
      description: 'Move money.',
      input: z.object({ from: z.number(), to: z.number(), amount: z.number() }),
      run: () => 'moved 5 from account 1 to account 2',
    });
    const sql = sqlAttempt({ map, key: 'late', id: 'inv1' });
    const chat = handlerOf(opencode.chat({ tools: [transfer] }));
    expect(await sql.end(() => chat(sql.ctx, 'Please move 5 from 1 to 2'))).toBe('moved 5 from account 1 to account 2');
    // Not taken: the message waits for the turn's end, then its own turn (`steered`) answers it.
    expect(following.taken).toEqual([]);
    expect(asked()).toBe(false);
    expect(await textsOf(map, 'late')).not.toContain(STEERED);
  }, 60_000);

  it('takes no message into a turn that is stopped', async () => {
    const map = new Map<string, Uint8Array>();
    const following = followingOf(map);
    const first = sqlAttempt({ map, key: 'stopped', id: 'inv1' });
    const transfer = tool({
      name: 'transfer',
      description: 'Move money.',
      input: z.object({ from: z.number(), to: z.number(), amount: z.number() }),
      // The message comes as the turn is stopped; the call returns anyway.
      run: async () => {
        following.steering = [{ id: 'steer-1', text: STEERED }];
        first.cancel();
        await new Promise((resolve) => setTimeout(resolve, 50));
        return 'moved 5 from account 1 to account 2';
      },
    });
    const chat = handlerOf(opencode.chat({ tools: [transfer] }));
    const failed = await first
      .end(() => chat(first.ctx, 'Please move 5 from 1 to 2'))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failed).toBeInstanceOf(restate.CancelledError);
    expect(following.taken).toEqual([]);
    expect(asked()).toBe(false);
    const texts = await textsOf(map, 'stopped');
    expect(texts).not.toContain(STEERED);
    expect(texts.at(-1)).toBe(CANCELLED);
  }, 60_000);
});
