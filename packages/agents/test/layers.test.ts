// Who publishes a turn: its `chat` turn (`chatTurn`), not the conversation.
// A turn run outside one, by a handler of your own that calls a framework's
// `prompt()` or `answerOnce`, stores its steps and calls no companion
// handler; a publish, a chat turn or a wait for a signal on an object with no
// companion fails once, with a terminal error that says why. Without a
// Restate server: the attempt's companion is the one of ./support.ts.
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as restate from '@restatedev/sessions';
import { createModels } from '@earendil-works/pi-ai/models';
import { chatHandler, sessionObject, signal, tool, type Tool } from '@restatedev/agents';
import * as claude from '@restatedev/agents/claude';
import * as pi from '@restatedev/agents/pi';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { publish } from '../src/common.ts';
import { NoCompanion } from '../src/companion.ts';
import { answerOnce, type Run } from '../src/conversation.ts';
import { reply as tellerReply, teller } from './fakes/claude.ts';
import { calling, type Item, ITEMS } from './fakes/items.ts';
import { callTools, fakeProvider, say } from './fakes/pi.ts';
import { followingOf, latestTurn, sqlAttempt } from './support.ts';

vi.mock('@anthropic-ai/sdk', () => import('./fakes/claude.ts'));

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

/** Whether the latest message holds a tool's result: the model then answers. */
const answeredTools = (messages: MessageParam[]) => {
  const last = messages.at(-1)!;
  return Array.isArray(last.content) && last.content.some((c) => c.type === 'tool_result');
};

/** Claude's model: a round of one call of `name`, then `Done`. */
function claudeCalls(name: string) {
  teller.reply = (messages: MessageParam[]) => {
    const message = tellerReply(messages);
    const done = answeredTools(messages);
    message.content = done
      ? [{ type: 'text', text: 'Done', citations: null }]
      : [{ type: 'tool_use', id: 'call_1', name, input: {} }];
    message.stop_reason = done ? 'end_turn' : 'tool_use';
    return message;
  };
}

/** pi's models: a round of one call of `name`, then `Done`. */
function piCalls(name: string) {
  const models = createModels();
  models.setProvider(
    fakeProvider('fake', 'fake', (context) =>
      context.messages.at(-1)!.role === 'toolResult' ? say('Done') : callTools([[name, {}]]),
    ),
  );
  return { models, model: 'fake/fake' };
}

const lookup = tool({ name: 'lookup', description: 'Look it up', input: z.object({}), run: () => 'found' });
const approval = signal('approval', { description: 'Wait for an approval' });

/** A handler of your own's prompt, by framework: a round of one call of `t`, then `Done`. */
const FRAMEWORKS: [string, (ctx: restate.SessionContext, text: string, t: Tool) => Promise<string>][] = [
  [
    'Claude',
    (ctx, text, t) => {
      claudeCalls(t.name);
      return claude.prompt(ctx, text, { tools: [t] });
    },
  ],
  ['pi', (ctx, text, t) => pi.prompt(ctx, text, { ...piCalls(t.name), tools: [t] })],
];

/** An object of @restatedev/agents, whose handler of its own prompts: it has a companion. */
const own = sessionObject({ name: 'own-handler', handlers: { ask: async () => 'unused' } });
/** A session object of @restatedev/sessions: it has no companion. */
const plain = restate.sessionObject({ name: 'plain-handler', handlers: {} });

/** Run `body` as an attempt of `object` over a key of its own: its outcome, what it asked of the companion, and the latest turn. */
async function attempt<T>(
  object: { readonly name: string },
  body: (ctx: restate.SessionContext) => Promise<T>,
  options: { signal?: (wait: { id: string; name: string }) => unknown } = {},
) {
  const map = new Map<string, Uint8Array>();
  const sql = sqlAttempt({ map, key: 'k', id: 'inv_own', object, ...options });
  const outcome: { value?: T; error?: unknown } = await sql
    .end(() => body(sql.ctx))
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  const read = sqlAttempt({ map, key: 'k', id: 'read', shared: true });
  const turn = await read.end(() => latestTurn(read.view));
  return { ...outcome, made: followingOf(map).made, turn };
}

afterAll(() => {
  teller.reply = tellerReply;
});

describe('a turn outside a `chat` turn', () => {
  it.each(FRAMEWORKS)(
    "with a tool round, through %s's `prompt()`, stores the turn and calls no companion handler",
    async (_name, prompt) => {
      for (const object of [own, plain]) {
        const ran = await attempt(object, (ctx) => prompt(ctx, 'go', lookup));
        expect(ran).toMatchObject({ value: 'Done', made: [], turn: { status: 'answered' } });
        // The reply with the call and its result, at least: the steps were stored.
        expect(ran.turn.steps).toBeGreaterThanOrEqual(2);
      }
    },
  );

  it('with a tool round, through `answerOnce`, stores the turn and calls no companion handler', async () => {
    for (const object of [own, plain]) {
      const ran = await attempt(object, (ctx) =>
        answerOnce(ctx, 'go', ITEMS, async (conversation) => {
          await conversation.turn.appendReply([calling('c1')]);
          await conversation.turn.append({ result: 'c1', output: 'found' });
          await conversation.turn.stepsCommitted();
          return 'done';
        }),
      );
      expect(ran).toEqual({ value: 'done', made: [], turn: { status: 'answered', steps: 3 } });
    }
  });

  it.each(FRAMEWORKS)(
    "waits for a signal with the companion, through %s's `prompt()` in a handler of your own",
    async (_name, prompt) => {
      const ran = await attempt(own, (ctx) => prompt(ctx, 'go', approval), { signal: () => 'approved' });
      expect(ran).toMatchObject({ value: 'Done', made: ['wait'], turn: { status: 'answered' } });
    },
  );
});

/** A run of the made-up framework: a round of one tool call (`c1`), then `fail`, if given, or `done`. */
const roundThen =
  (fail?: Error): Run<Item> =>
  async (conversation) => {
    await conversation.turn.appendReply([calling('c1')]);
    await conversation.turn.append({ result: 'c1', output: 'found' });
    if (fail) throw fail;
    return 'done';
  };

describe('a prompt after a `chat` turn, in the same invocation', () => {
  it.each([
    ['answered', undefined],
    ['failed with a terminal error', new restate.TerminalError('no')],
    ['failed with an error Restate retries', new Error('flaky')],
  ] as const)('publishes nothing, the `chat` turn %s', async (_how, fail) => {
    const chat = chatHandler((ctx, text) => answerOnce(ctx, text, ITEMS, roundThen(fail)));
    const ran = await attempt(own, async (ctx) => {
      await chat.handler(ctx, 'first').catch(() => {});
      // Then a prompt of the handler's own, `<id>:2`: outside the `chat` turn, which has ended.
      return answerOnce(ctx, 'second', ITEMS, roundThen());
    });
    expect(ran.value).toBe('done');
    // The `chat` turn's own publishes (two of its steps' writes), with its start and, unless retried, its close.
    const turn = ['start', 'publish', 'publish', ...(fail instanceof restate.TerminalError || !fail ? ['close'] : [])];
    expect(ran.made).toEqual(turn);
  });
});

describe('an object without a companion', () => {
  it('fails a publish with a terminal error that says why', async () => {
    const ran = await attempt(plain, (ctx) => publish(ctx));
    expect(ran.error).toBeInstanceOf(NoCompanion);
    expect(ran.error).toBeInstanceOf(restate.TerminalError);
    expect(String(ran.error)).toContain(
      'plain-handler has no companion (plain-handler.prebuilt.restate), which a publish needs',
    );
    expect(ran.made).toEqual([]);
  });

  it('fails a `chat` turn once, with a terminal error, before it calls anything', async () => {
    const chat = chatHandler(async () => 'never');
    const ran = await attempt(plain, (ctx) => chat.handler(ctx, 'hi'));
    expect(ran.error).toBeInstanceOf(NoCompanion);
    expect(String(ran.error)).toContain('which a chat turn needs');
    expect(ran.made).toEqual([]);
  });

  it.each(FRAMEWORKS)(
    "fails a wait for a signal once, through %s's `prompt()`: the turn fails with a terminal error that says why",
    async (_name, prompt) => {
      const ran = await attempt(plain, (ctx) => prompt(ctx, 'go', approval), { signal: () => 'approved' });
      expect(ran.error).toBeInstanceOf(restate.TerminalError);
      expect(String(ran.error)).toContain(
        'plain-handler has no companion (plain-handler.prebuilt.restate), which a wait for a signal needs',
      );
      // Nothing waits, and the turn is closed with the error: the next prompt does not run into it again.
      expect(ran.made).toEqual([]);
      expect(ran.turn.status).toBe('failed');
    },
  );
});
