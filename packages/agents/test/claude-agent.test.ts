// The Claude Code agent without a Restate server, through crashes and kills of
// the handler (see ./support.ts): a crashed attempt gets no chance to store
// anything on the way out. Claude Code runs for real, as the Claude Agent SDK
// runs it (a process of its own); its model is the teller of
// ./fakes/claude-agent.ts, a Messages API on a local port.
// `pnpm --filter @restatedev/agents exec vitest run test/claude-agent.test.ts`.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as restate from '@restatedev/sessions';
import { invoke } from '@restatedev/sessions/internal';
import { fakeContext } from '@restatedev/sessions/test/support';
import { z } from 'zod';
import { tool } from '@restatedev/agents';
import * as claudeAgent from '@restatedev/agents/claude-agent';
import { callOf } from '../src/calls.ts';
import { CANCELLED, ENDED, REFUSED, RETURNED_UNRECORDED } from '../src/common.ts';
import { STEPS } from '../src/conversation.ts';
import { bank } from './bank.ts';
import { prompt } from './claude-agent.ts';
import { tied } from '../src/claude-agent/process.ts';
import type Anthropic from '@anthropic-ai/sdk';
import { HttpError, script, startTeller, teller, tellerEnv } from './fakes/claude-agent.ts';
import {
  afterCancel,
  cancelledTransfer,
  cancelledWhileWorking,
  conversation,
  crashedAnywhere,
  endedWhileWorking,
  followedWhileWorking,
  followingOf,
  handlerOf,
  invalidArguments,
  type PromptHandler,
  SAID_IN_TURNS as SAID,
  sqlAttempt,
  steeredAtAStep,
} from './support.ts';

beforeAll(async () => {
  for (const [name, value] of Object.entries(tellerEnv(await startTeller()))) vi.stubEnv(name, value);
  vi.stubEnv('MODEL', '');
});

beforeEach(() => {
  script.requests.length = 0;
  script.reply = teller;
});

/** The texts of the user's messages of the model's latest request, in order (Claude Code's own left out). */
const userTexts = () =>
  script.requests
    .at(-1)!
    .messages.filter((m) => m.role === 'user')
    .flatMap((m) =>
      typeof m.content === 'string' ? [m.content] : m.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])),
    );

/** The raw texts of every request's messages: what Claude Code sent, its own notes included. */
const rawTexts = () =>
  script.requests.flatMap((r) =>
    r.body.messages.flatMap((m) =>
      typeof m.content === 'string' ? [m.content] : m.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])),
    ),
  );

/** Whether a request went on with a turn without a prompt: Claude Code's "Continue". */
const continued = () => rawTexts().some((t) => t === 'Continue from where you left off.');

describe('the Claude Code agent', () => {
  it('answers a message once: a retried attempt of an answered prompt starts nothing', async () => {
    const c = conversation(prompt, 'once');
    const first = await c.attempt('inv1', 'Please move 5 from 1 to 2');
    expect(first).toBe('Done: moved 5 from account 1 to account 2');
    const asked = script.requests.length;
    expect(await c.attempt('inv1', 'Please move 5 from 1 to 2')).toBe(first);
    expect(script.requests.length).toBe(asked);
    expect(c.ledger.transfers.size).toBe(1);
    // The next prompt goes on in the same session.
    expect(await c.attempt('inv2', 'audit the books')).toMatch(/^Done: .*"transfers":1/);
  }, 60_000);

  it('resumes a crashed attempt in its tool call: the call made again under its id, the transfer once', async () => {
    const c = conversation(prompt, 'crash');
    const input = 'Please move 7 from 3 to 4';
    await c.crash('inv1', input);
    expect(await c.attempt('inv1', input)).toBe('Done: moved 7 from account 3 to account 4');
    expect(continued()).toBe(true);
    expect(c.ledger.transfers.size).toBe(1);
    // Both attempts' calls are one call: the same idempotency key.
    expect(new Set(c.ledger.calls.map((call) => call.key)).size).toBe(1);
    const { messages } = await c.read(claudeAgent.messages(), {});
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(messages.at(-1)!.parts).toEqual([{ type: 'text', text: 'Done: moved 7 from account 3 to account 4' }]);
  }, 60_000);

  it('resumes a turn crashed twice in a row in the same tool call: the stored result keeps the transcript whole', async () => {
    const c = conversation(prompt, 'twice');
    const input = 'Please move 3 from 1 to 5';
    await c.crash('inv1', input);
    await c.crash('inv1', input);
    expect(await c.attempt('inv1', input)).toBe('Done: moved 3 from account 1 to account 5');
    expect(c.ledger.transfers.size).toBe(1);
    // The next turn resumes the transcript, with every line it holds.
    expect(await c.attempt('inv2', 'audit the books')).toMatch(/^Done: .*"transfers":1/);
  }, 90_000);

  it('resumes a turn however many attempts crash', async () => {
    const c = conversation(prompt, 'crashes');
    const input = 'Please move 4 from 2 to 3';
    for (let n = 0; n < 5; n++) await c.crash('inv1', input);
    expect(await c.attempt('inv1', input)).toBe('Done: moved 4 from account 2 to account 3');
    expect(c.ledger.transfers.size).toBe(1);
  }, 120_000);

  it('closes a killed turn by the next message: never finished, the note told to the model', async () => {
    const c = conversation(prompt, 'dead');
    await c.crash('inv1', 'Please move 1 from 0 to 1');
    expect(await c.attempt('inv2', 'Please move 2 from 0 to 1')).toBe('Done: moved 2 from account 0 to account 1');
    // The dead turn's transfer was not made again under the new invocation.
    expect(c.ledger.calls.map((call) => call.key?.split(':')[0])).toEqual(['inv1', 'inv2']);
    expect(continued()).toBe(false);
    expect(userTexts().at(-1)).toBe(`(${ENDED})\n\nPlease move 2 from 0 to 1`);
    const { messages } = await c.read(claudeAgent.messages(), {});
    expect(messages[1]!.parts[1]).toMatchObject({ type: 'tool', output: ENDED, error: true });
    expect(messages[2]!.parts).toEqual([{ type: 'text', text: ENDED }]);
    expect(messages[3]!.parts).toEqual([{ type: 'text', text: 'Please move 2 from 0 to 1' }]);
    const statuses = await c.read(async (ctx) => ctx.db.values('SELECT status FROM restate_agent_turns ORDER BY n'));
    expect(statuses).toEqual([['ended'], ['answered']]);
    await expect(c.attempt('inv1', 'Please move 1 from 0 to 1')).rejects.toThrow(ENDED);
    expect(c.ledger.transfers.size).toBe(2);
  }, 60_000);

  it('tells the model which calls of a killed turn did happen', async () => {
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
    const chat = handlerOf(claudeAgent.chat({ tools: [transfer] }));
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
    const { messages } = await read.end(() => claudeAgent.messages()(read.view, {}));
    expect(messages[1]!.parts[1]).toMatchObject({ type: 'tool', output: RETURNED_UNRECORDED });
    const id = (messages[1]!.parts[1] as { id: string }).id;
    expect(userTexts().at(-1)).toBe(`(${ENDED} These calls did happen: transfer (${id}).)\n\nHello`);
    expect(continued()).toBe(false);
  }, 60_000);

  it("closes a killed turn on its companion's `settle`, without Claude Code", async () => {
    const c = conversation(prompt, 'settled');
    await c.crash('inv1', 'Please move 1 from 0 to 1');
    const agent = claudeAgent.agent({ name: 'ClaudeCodeAgent', tools: bank('ClaudeCodeAgent') });
    const map = c.state as Map<string, Uint8Array>;
    const asked = script.requests.length;
    const settle = (id: string) =>
      invoke(
        agent,
        'settle',
        fakeContext({ map, service: 'ClaudeCodeAgent', key: 'settled', id: `inv_s${id}` }),
        'inv1',
      );
    expect(await settle('1')).toBe(true);
    expect(await settle('2')).toBe(false);
    expect(script.requests.length).toBe(asked);
    const { messages } = await c.read(claudeAgent.messages(), {});
    expect(messages[1]!.parts[1]).toMatchObject({ type: 'tool', output: ENDED, error: true });
    expect(messages.at(-1)!.parts).toEqual([{ type: 'text', text: ENDED }]);
    expect(await c.attempt('inv2', 'Please move 2 from 0 to 1')).toBe('Done: moved 2 from account 0 to account 1');
    expect(continued()).toBe(false);
    expect(userTexts().at(-1)).toBe(`(${ENDED})\n\nPlease move 2 from 0 to 1`);
    expect(c.ledger.calls.map((call) => call.key?.split(':')[0])).toEqual(['inv1', 'inv2']);
  }, 60_000);

  it('answers with the stored final reply after a crash at the end of the turn, without the model', async () => {
    const c = conversation(prompt, 'final');
    // Crash after the final reply is stored, before the answer is: at the turn's last state requests.
    let crashAt = 0;
    const full = conversation(prompt, 'final-count');
    await full.attempt('inv1', 'Hello');
    // Count the state requests of a whole turn.
    for (let n = 1; ; n++) {
      const probe = conversation(prompt, `final-probe-${n}`);
      if ((await probe.attempt('inv1', 'Hello', n)) !== 'crashed') {
        crashAt = n - 1;
        break;
      }
      if (n > 400) throw new Error('no end');
    }
    expect(await c.attempt('inv1', 'Hello', crashAt)).toBe('crashed');
    const asked = script.requests.length;
    expect(await c.attempt('inv1', 'Hello')).toMatch(/^Ask me/);
    expect(script.requests.length).toBe(asked);
  }, 300_000);

  it('closes a stopped turn cancelled, and answers the next message afresh with the note', async () => {
    const { failed, answer, parts } = await afterCancel(
      claudeAgent.chat({ tools: [cancelledTransfer] }),
      claudeAgent.messages(),
    );
    expect(failed).toBeInstanceOf(restate.CancelledError);
    expect(answer).toBe('Ask me to "move 5 from 1 to 2", or to "audit" the books.');
    expect(userTexts().at(-1)).toBe(`(${CANCELLED})\n\nHello`);
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

  it('ends a turn cancelled while a tool works: Claude Code interrupted, no model request', async () => {
    const now = await cancelledWhileWorking((tools) => claudeAgent.chat({ tools }), claudeAgent.messages());
    expect(now.failed).toBeInstanceOf(restate.CancelledError);
    expect(now.answer).toMatch(/^Ask me/);
    expect(now.parts[1]).toMatchObject([
      { type: 'text', text: 'On it.' },
      { type: 'tool', output: CANCELLED, error: true },
    ]);
    // The stopped turn asked the model once; the next message once.
    expect(script.requests).toHaveLength(2);
  }, 60_000);

  it('goes on with a turn whose attempt ended while a tool worked: the next attempt resumes it', async () => {
    const { failed, closed, answer } = await endedWhileWorking((tools) => claudeAgent.chat({ tools }));
    expect(failed).toBeDefined();
    expect(failed).not.toBeInstanceOf(restate.CancelledError);
    expect(closed).toEqual([]);
    expect(answer).toBe('Done: moved 5 from account 1 to account 2');
  }, 60_000);

  it('answers arguments that do not fit a tool with what is wrong, for the model to fix', async () => {
    const { answer, ran } = await invalidArguments((tools) => claudeAgent.chat({ tools }));
    expect(answer).toMatch(/error/i);
    expect(answer).toMatch(/amount/);
    expect(ran).toBe(false);
  }, 60_000);

  it('publishes the conversation as a turn starts, once its reply is stored, once its result is, and as it ends', async () => {
    const { answer, parts, published, outputs } = await followedWhileWorking(
      (tools) => claudeAgent.chat({ tools }),
      claudeAgent.messages(),
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
    // The call was read before its result, then with it.
    expect(outputs[0]).toBeUndefined();
    expect(outputs.at(-1)).toBe('moved 5 from account 1 to account 2');
  }, 60_000);

  it('gives the conversation from the store: what was said, in order, with the tool calls', async () => {
    const c = conversation(prompt, 'm');
    await c.attempt('inv1', 'Please move 5 from 1 to 2');
    await c.attempt('inv2', 'audit the books');
    expect(await c.read(claudeAgent.messages(), {})).toEqual({
      messages: SAID,
      more: false,
      cursor: expect.any(Number),
    });
  }, 60_000);

  it('forgets the conversation on `clear`, the transcript too: a new session', async () => {
    const c = conversation(prompt, 'clear');
    await c.attempt('inv1', 'Please move 5 from 1 to 2');
    const agent = claudeAgent.agent({ name: 'ClaudeCodeAgent', tools: bank('ClaudeCodeAgent') });
    const map = c.state as Map<string, Uint8Array>;
    await invoke(agent, 'erase', fakeContext({ map, service: 'ClaudeCodeAgent', key: 'clear', id: 'inv_erase' }));
    expect((await c.read(claudeAgent.messages(), {})).messages).toEqual([]);
    expect(await c.attempt('inv2', 'Hello')).toMatch(/^Ask me/);
    expect(userTexts()).toEqual(['Hello']);
  }, 60_000);

  it('asks again within the turn for an answer that is not the output asked for', async () => {
    script.reply = (request) => {
      const last = request.messages.at(-1)!;
      const text =
        typeof last.content === 'string'
          ? last.content
          : last.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
      return reply(text.startsWith('Your reply is not the answer') ? '{"n":1}' : 'one');
    };
    const c = conversation(
      claudeAgent.chat({ output: z.object({ n: z.number() }) }) as unknown as PromptHandler,
      'output',
    );
    expect(await c.attempt('inv1', 'How many?')).toEqual({ n: 1 });
    const { messages } = await c.read(claudeAgent.messages(), {});
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages.at(-1)!.parts).toEqual([{ type: 'text', text: '{"n":1}' }]);
    expect(script.requests).toHaveLength(2);
  }, 60_000);

  it('gives the model its system prompt', async () => {
    const c = conversation(claudeAgent.chat({ system: 'You are Ada.' }), 'ada');
    await c.attempt('inv1', 'Who are you?');
    expect(JSON.stringify(script.requests.at(-1)!.body.system)).toContain('You are Ada.');
  }, 60_000);

  it('passes the model, without `anthropic/`, and none by default', async () => {
    await conversation(claudeAgent.chat({ model: 'anthropic/claude-haiku-5-5' }), 'model').attempt('inv1', 'Hello');
    expect(script.requests.at(-1)!.body.model).toBe('claude-haiku-5-5');
    await conversation(claudeAgent.chat(), 'nomodel').attempt('inv1', 'Hello');
    expect(script.requests.at(-1)!.body.model).toMatch(/^claude-/);
  }, 60_000);
});

type Message = Anthropic.Beta.Messages.BetaMessage;

/** A reply of the model with `text`. */
const reply = (text: string): Message =>
  ({
    id: `msg_${text.length}`,
    type: 'message',
    role: 'assistant',
    model: 'teller',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  }) as Message;

describe("the Claude Code agent's model provider", () => {
  it('fails a prompt its provider refuses (a wrong key) with 424 at once, and closes its turn', async () => {
    script.reply = () => {
      throw new HttpError(401, 'authentication_error', 'invalid x-api-key');
    };
    const c = conversation(prompt, 'refused');
    const failed = await c.attempt('inv1', 'Hello').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(restate.TerminalError);
    expect((failed as restate.TerminalError).code).toBe(REFUSED);
    // Not asked again for minutes, as Claude Code would.
    expect(script.requests.length).toBeLessThanOrEqual(2);
    script.reply = teller;
    expect(await c.attempt('inv2', 'Hello')).toMatch(/^Ask me/);
  }, 60_000);

  it('fails a prompt of an unknown model with 424', async () => {
    script.reply = () => {
      throw new HttpError(404, 'not_found_error', 'model: claude-nope');
    };
    const failed = await conversation(prompt, 'nomodel')
      .attempt('inv1', 'Hello')
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect((failed as restate.TerminalError).code).toBe(REFUSED);
  }, 60_000);

  it('answers through an outage: Claude Code asks again', async () => {
    let n = 0;
    script.reply = (request) => {
      if (n++ < 2) throw new HttpError(529, 'overloaded_error', 'overloaded');
      return teller(request);
    };
    expect(await conversation(prompt, 'outage').attempt('inv1', 'Hello')).toMatch(/^Ask me/);
  }, 60_000);

  it('fails the attempt past the retries Claude Code makes, and the next attempt resumes the turn', async () => {
    let down = true;
    script.reply = (request) => {
      if (down) throw new HttpError(500, 'api_error', 'boom');
      return teller(request);
    };
    const c = conversation(claudeAgent.chat({ tools: bank('ClaudeCodeAgent'), retry: { maxRetries: 0 } }), 'past');
    const failed = await c.attempt('inv1', 'Hello').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(restate.TerminalError);
    down = false;
    expect(await c.attempt('inv1', 'Hello')).toMatch(/^Ask me/);
    expect(continued()).toBe(true);
  }, 60_000);

  it('ends a turn the model declines with a terminal error, after Claude Code tried its fallback model', async () => {
    script.reply = () =>
      ({
        ...reply('I can'),
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: 'no' },
      }) as never;
    const failed = await conversation(prompt, 'declined')
      .attempt('inv1', 'Hello')
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failed).toBeInstanceOf(restate.TerminalError);
    expect(String(failed)).toMatch(/declined/);
    expect(new Set(script.requests.map((r) => r.body.model)).size).toBe(2);
  }, 60_000);

  it('fails a turn past `maxTurns`', async () => {
    script.reply = (request) => {
      const ask = {
        ...reply(''),
        content: [{ type: 'tool_use', id: `toolu_${request.messages.length}`, name: 'audit', input: {} }],
        stop_reason: 'tool_use',
      };
      return ask as never;
    };
    const failed = await conversation(claudeAgent.chat({ tools: bank('ClaudeCodeAgent'), maxTurns: 2 }), 'turns')
      .attempt('inv1', 'audit, forever')
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failed).toBeInstanceOf(restate.TerminalError);
    expect(String(failed)).toMatch(/maxTurns/);
  }, 60_000);
});

describe('the Claude Code agent, its tool calls', () => {
  it('runs a tool only once its call is stored: the turn has it as the tool starts', async () => {
    const seen: unknown[] = [];
    const transfer = tool({
      name: 'transfer',
      description: 'Move money.',
      input: z.object({ from: z.number(), to: z.number(), amount: z.number() }),
      run: async (_input, { ctx, callId }) => {
        const rows = await ctx.db.values(`SELECT item FROM ${STEPS}`);
        seen.push(rows.some(([item]) => String(item).includes(callId)));
        return 'moved 5 from account 1 to account 2';
      },
    });
    const c = conversation(claudeAgent.chat({ tools: [transfer] }), 'gate');
    expect(await c.attempt('inv1', 'Please move 5 from 1 to 2')).toBe('Done: moved 5 from account 1 to account 2');
    expect(seen).toEqual([true]);
  }, 60_000);

  it('kills Claude Code as the attempt ends: no model request after it', async () => {
    const started = Promise.withResolvers<void>();
    const transfer = tool({
      name: 'transfer',
      description: 'Move money.',
      input: z.object({ from: z.number(), to: z.number(), amount: z.number() }),
      run: async () => {
        started.resolve();
        return new Promise<never>(() => {});
      },
    });
    const map = new Map<string, Uint8Array>();
    const fence = { closed: false };
    const first = sqlAttempt({ map, fence, key: 'killed', id: 'inv1' });
    void first
      .end(() => handlerOf(claudeAgent.chat({ tools: [transfer] }))(first.ctx, 'Please move 5 from 1 to 2'))
      .catch(() => {});
    await started.promise;
    const asked = script.requests.length;
    fence.closed = true;
    first.abort();
    // Claude Code alone would finish the turn within its 2 s grace, asking the model again.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(script.requests.length).toBe(asked);
  }, 60_000);

  it('answers a message once after a crash at any of its state requests', async () => {
    expect(
      await crashedAnywhere(prompt, claudeAgent.messages(), { stride: Number(process.env.CRASH_STRIDE ?? 5) }),
    ).toEqual([]);
  }, 600_000);
});

describe('the Claude Code agent, steered', () => {
  it('takes a message steered while a tool runs at its next step: the model audits, the message stored once', async () => {
    const { answer, taken, said } = await steeredAtAStep(
      (tools) => claudeAgent.chat({ tools }),
      claudeAgent.messages(),
    );
    expect(answer).toBe('Done: the books are fine');
    expect(taken).toEqual(['steer-1']);
    expect(said).toEqual([
      ['user', 'Please move 5 from 1 to 2'],
      ['assistant', 'On it. + transfer'],
      ['user', 'audit the books'],
      ['assistant', 'audit'],
      ['assistant', 'Done: the books are fine'],
    ]);
  }, 60_000);

  it('retries a turn that failed after it took the message, with the message, once', async () => {
    const { answer, failed, audits, taken, said } = await steeredAtAStep(
      (tools) => claudeAgent.chat({ tools }),
      claudeAgent.messages(),
      { failAudit: true },
    );
    expect(failed).toBeDefined();
    expect(answer).toBe('Done: the books are fine');
    expect(audits).toBe(2);
    expect(taken).toEqual(['steer-1']);
    expect(said.filter(([role, text]) => role === 'user' && text === 'audit the books')).toHaveLength(1);
  }, 60_000);

  it('takes no message steered once the tools are done: a turn of its own answers it', async () => {
    const c = conversation(prompt, 'late');
    const following = followingOf(c.state);
    script.reply = (request) => {
      const last = request.messages.at(-1)!;
      // Steered as the model writes the final answer: the turn has no step left.
      if (Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result')) {
        following.steering = [{ id: 'late-1', text: 'audit the books' }];
      }
      return teller(request);
    };
    expect(await c.attempt('inv1', 'Please move 5 from 1 to 2')).toBe('Done: moved 5 from account 1 to account 2');
    expect(following.taken.flat()).toEqual([]);
    expect(rawTexts().some((t) => t.includes('audit the books'))).toBe(false);
  }, 60_000);
});

/** A script whose model writes `file` with Claude Code's Write tool, again if a call was cut off, then says what it got. */
const writes = (file: string) => (request: Parameters<typeof teller>[0]) => {
  const last = request.messages.at(-1)!;
  const results = Array.isArray(last.content) ? last.content.filter((b) => b.type === 'tool_result') : [];
  const again = results.every((r) => JSON.stringify(r).includes('Tool call interrupted'));
  if (results.length > 0 && !again) return reply(`Done: ${JSON.stringify(results.map((r) => r.content).at(-1))}`);
  return {
    ...reply(''),
    content: [
      {
        type: 'tool_use',
        id: `toolu_w${request.messages.length}`,
        name: 'Write',
        input: { file_path: file, content: 'hi' },
      },
    ],
    stop_reason: 'tool_use',
  } as never;
};

describe("the Claude Code agent's workspace and permissions", () => {
  it("runs Claude Code's own tools in the workspace without asking", async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ws-'));
    script.reply = writes(join(workspace, 'a.txt'));
    const answer = await conversation(claudeAgent.chat({ workspace }), 'ws').attempt('inv1', 'Write it');
    expect(answer).toMatch(/File created/);
    expect(existsSync(join(workspace, 'a.txt'))).toBe(true);
  }, 60_000);

  it('denies what Claude Code would ask about, nobody being present: a write outside the workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ws-'));
    const outside = join(await mkdtemp(join(tmpdir(), 'out-')), 'b.txt');
    script.reply = writes(outside);
    const answer = await conversation(claudeAgent.chat({ workspace }), 'ws-out').attempt('inv1', 'Write it');
    expect(existsSync(outside)).toBe(false);
    expect(answer).toMatch(/Done/);
  }, 60_000);

  it('with `approval`, runs a call once a person approved it, and never one denied', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ws-'));
    script.reply = writes(join(workspace, 'c.txt'));
    const c = conversation(claudeAgent.chat({ workspace, approval: true }), 'approved');
    c.signals.answer = () => 'approved';
    expect(await c.attempt('inv1', 'Write it')).toMatch(/File created/);
    expect(c.signals.waits).toMatchObject([{ name: claudeAgent.APPROVAL, input: { tool: 'Write' } }]);
    expect(existsSync(join(workspace, 'c.txt'))).toBe(true);
    script.reply = writes(join(workspace, 'd.txt'));
    const d = conversation(claudeAgent.chat({ workspace, approval: true }), 'denied');
    d.signals.answer = () => 'no, not now';
    expect(await d.attempt('inv1', 'Write it')).toMatch(/denied tool \\"Write\\": no, not now/);
    expect(existsSync(join(workspace, 'd.txt'))).toBe(false);
  }, 60_000);

  it('waits for an approval through a crash: the person asked once, the call made once, after it', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ws-'));
    const file = join(workspace, 'e.txt');
    script.reply = writes(file);
    const c = conversation(claudeAgent.chat({ workspace, approval: true }), 'rejoin');
    const before: boolean[] = [];
    const asked = Promise.withResolvers<void>();
    c.signals.answer = async () => {
      before.push(existsSync(file));
      asked.resolve();
      return new Promise(() => {});
    };
    c.attempt('inv1', 'Write it').catch(() => {});
    await asked.promise;
    c.signals.answer = async () => {
      before.push(existsSync(file));
      return 'approved';
    };
    // The resumed turn cuts the call off, and the model makes it again under a new id: it joins the first's wait.
    expect(await c.attempt('inv1', 'Write it')).toMatch(/File created/);
    expect(continued()).toBe(true);
    const [wait, again] = c.signals.waits;
    expect(c.signals.waits).toHaveLength(2);
    expect(again).toEqual(wait);
    expect(before).toEqual([false, false]);
    expect(existsSync(file)).toBe(true);
  }, 60_000);
});

/** Whether process `pid` lives. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!tied)("Claude Code's process, tied to the handler's", () => {
  it('dies with the process that started it: a crashed handler leaves no Claude Code behind', async () => {
    const module = fileURLToPath(new URL('../src/claude-agent/process.ts', import.meta.url));
    // A handler's process, which starts a long-lived child as it starts Claude Code, then dies (SIGKILL).
    const parent = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { spawnTied } from ${JSON.stringify(module)}; const c = spawnTied('sleep', ['60'], {}); console.log(c.pid); setInterval(() => {}, 1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const pid = Number(await new Promise<string>((resolve) => parent.stdout.once('data', (d) => resolve(String(d)))));
    expect(alive(pid)).toBe(true);
    parent.kill('SIGKILL');
    for (let i = 0; i < 100 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(alive(pid)).toBe(false);
  }, 30_000);
});
