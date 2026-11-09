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
  handlerOf,
  sqlAttempt,
  type PromptHandler,
  SAID_IN_TURNS as SAID,
} from './support.ts';

const NODE_24 = Number(process.versions.node.split('.')[0]) >= 24;

/** How often OpenCode was booted. */
const boots = vi.hoisted(() => ({ n: 0 }));

// Every boot of OpenCode has the teller's provider.
vi.mock('@restatedev/agents/opencode/db', async (original) => {
  const db = await original<typeof Db>();
  const { scriptedPlugin } = await import('./fakes/opencode.ts');
  const openOpenCode: typeof db.openOpenCode = (database, fence, options) => {
    boots.n++;
    return db.openOpenCode(database, fence, { ...options, plugins: [scriptedPlugin, ...(options.plugins ?? [])] });
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
