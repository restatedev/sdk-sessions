// Step 0 of docs/opencode.md, run: OpenCode 2.2.6 on the object's database
// (src/opencode/db.ts), its model scripted (./fakes/opencode.ts). A turn
// whose invocation died in a tool call is CLOSED at the next boot without
// the model being asked (`restart: 'close'`, by our own SessionRestart or by
// OpenCode's resume budget), or RESUMED, the crash case (`restart: 'resume'`).
//
// An attempt is killed in a tool call that never returns: its fence closes
// (nothing more is stored) and it is abandoned, the execution claim left, as
// a dead process leaves it. The next boot is a new attempt over the same
// state.
//
// OpenCode needs Node 24 (its sources use syntax Node 22 does not parse):
// on older Node the suite is skipped.
// `pnpm --filter @restatedev/agents exec vitest run test/opencode-spike.test.ts`.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { LanguageModelV3Message } from '@ai-sdk/provider';
import type { Plugin } from '@opencode/plugin';
import { database } from '@restatedev/sessions/internal';
import { sqlAttempt } from '@restatedev/sessions/test/support';
import type * as Db from '../src/opencode/db.ts';
import type { Closer, Fence, Host, OpenOptions } from '../src/opencode/db.ts';
import type * as Fake from './fakes/opencode.ts';

const NODE_24 = Number(process.versions.node.split('.')[0]) >= 24;

// Imported only on Node 24: OpenCode does not load on older Node.
let openOpenCode: typeof Db.openOpenCode;
let fake: typeof Fake;
beforeAll(async () => {
  if (!NODE_24) return;
  ({ openOpenCode } = await import('../src/opencode/db.ts'));
  fake = await import('./fakes/opencode.ts');
});

const SESSION = 'ses_root' as never;
/** The key's database where OpenCode's tables are, as the old integration had it. */
const DATABASE = 'restate-agents.opencode';
/** How OpenCode asks the model to go on with a turn a restart interrupted. */
const CONTINUE = /The server restarted while you were working/;
/** The result our closer gives a cut-off call. */
const cutOff = (id: string, name: string) => `cut off: ${name} ${id} may or may not have happened`;
/** The error our closer ends a turn with. */
const ENDED = 'Ended: the invocation was killed';

/** The `transfer` tool's calls, and what it does: by default, it returns at once. */
const tool = {
  executed: [] as string[],
  run: (_callId: string): Promise<string> => Promise.resolve('moved'),
};

/** An OpenCode plugin whose only tool is `transfer`, which does what `tool.run` does. */
const toolsPlugin: Plugin.Plugin = {
  id: 'test.tools',
  async setup(ctx) {
    const transform = await ctx.tool.transform((editor) => {
      for (const { id } of editor.list()) editor.remove(id);
      editor.add({
        name: 'transfer',
        description: 'Move money',
        input: z.object({ amount: z.number() }),
        options: { codemode: false },
        execute: async (_input, context) => {
          tool.executed.push(context.id);
          return { content: await tool.run(context.id) };
        },
      });
    });
    return () => transform.dispose();
  },
};

/** One attempt of the object's handler, holding OpenCode booted over its database. */
interface Attempt {
  host: Host;
  /** Killed: nothing more is stored, nothing more runs to the end, nothing is torn down. */
  kill(): void;
  /** Closes the host and ends the attempt. */
  end(): Promise<void>;
}

/** The object: its state lives across attempts. */
function object() {
  const map = new Map<string, Uint8Array>();
  let n = 0;
  return {
    async boot(options: OpenOptions = {}): Promise<Attempt> {
      const fence: Fence = { closed: false };
      const sql = sqlAttempt({ map, fence, key: 'k', id: `inv${++n}` });
      const opened = Promise.withResolvers<Host>();
      const done = Promise.withResolvers<void>();
      const ended = sql.end(async () => {
        const host = await openOpenCode(database(sql.ctx.db, DATABASE), fence, {
          plugins: [fake.scriptedPlugin, toolsPlugin],
          config: { default_agent: 'build' },
          ...options,
        });
        opened.resolve(host);
        await done.promise;
        await host.close();
      });
      ended.catch((error: unknown) => opened.reject(error));
      const host = await opened.promise;
      return {
        host,
        kill: () => {
          fence.closed = true;
          sql.abort();
        },
        end: async () => {
          done.resolve();
          await ended;
        },
      };
    },
  };
}

/** A user message's text, as the model gets it. */
const said = (m: LanguageModelV3Message) => (m.role === 'user' ? fake.textOf(m) : '');

/** The session's messages, oldest first. */
async function messages(host: Host) {
  const all: Record<string, unknown>[] = [];
  for (let cursor: string | undefined; ;) {
    const page: { data: unknown[]; cursor: { next?: string } } = await host.call(
      host.client.message.list(
        cursor === undefined ? { sessionID: SESSION, order: 'asc', limit: 50 } : { sessionID: SESSION, cursor },
      ),
    );
    all.push(...(page.data as Record<string, unknown>[]));
    cursor = page.cursor.next;
    if (cursor === undefined) return all;
  }
}

/** The session's messages, each as `type: summary`, to compare. */
const outline = (all: Record<string, unknown>[]) =>
  all.map((m) => {
    if (m.type === 'user' || m.type === 'synthetic') return `${m.type}: ${String(m.text)}`;
    if (m.type === 'idle') {
      const error = m.error as { message?: string } | undefined;
      return `idle: ${String(m.outcome)}${error ? ` (${error.message})` : ''}`;
    }
    if (m.type !== 'assistant') return String(m.type);
    const parts = (m.content as { type: string; text?: string; id?: string; state?: Record<string, unknown> }[]).map(
      (c) => {
        if (c.type === 'text') return c.text;
        if (c.type !== 'tool') return c.type;
        const state = c.state ?? {};
        const error = state.error as { message?: string } | undefined;
        return `tool ${c.id} ${String(state.status)}${error ? ` (${error.message})` : ''}`;
      },
    );
    return `assistant: ${parts.join(' | ')}`;
  });

/** Until the session runs nothing and its latest message is an idle marker. */
async function idle(host: Host) {
  const until = Date.now() + 10_000;
  for (;;) {
    await host.call(host.client.session.wait({ sessionID: SESSION }));
    const all = await messages(host);
    const active: Record<string, unknown> = await host.call(host.client.session.active());
    if (all.at(-1)?.type === 'idle' && active[SESSION] === undefined) return all;
    if (Date.now() > until) throw new Error(`the session never went idle: ${outline(all).join('\n')}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Submit prompt `id`, as the old integration did. */
const prompt = (host: Host, id: string, text: string, delivery: 'queue' | 'steer' = 'queue') =>
  host.call(host.client.session.prompt({ sessionID: SESSION, id: `msg_${id}` as never, text, delivery, resume: true }));

/** The model replies to the dead turn's prompt with a transfer, `call_dead`. */
const transferOnMove = (request: Fake.Request): Fake.Reply => {
  const last = request.prompt.at(-1)!;
  if (said(last) === 'Please move 5')
    return { text: 'On it.', call: { id: 'call_dead', name: 'transfer', input: { amount: 5 } } };
  throw new Error(`unexpected request: ${JSON.stringify(request.prompt)}`);
};

/** The model must not be asked: an ask fails the test (and the step OpenCode runs). */
const unasked: Fake.Request[] = [];
const notAsked = (request: Fake.Request): Fake.Reply => {
  unasked.push(request);
  throw new Error('the model was asked');
};

/**
 * A turn killed in a tool call: the model calls `transfer` (`call_dead`),
 * which never returns, and the attempt dies there, its claim left:
 * `abandoned` (a dead process: the fence closes, nothing is torn down), or
 * `closed` (the host closed mid-tool, as a process shutting down: OpenCode
 * keeps the claim of a shutdown's interruption, on purpose).
 */
async function killedInATool(o: ReturnType<typeof object>, death: Death = 'abandoned') {
  const first = await o.boot();
  await first.host.call(
    first.host.client.session.create({ id: SESSION, model: fake.MODEL as never, agent: 'build' as never }),
  );
  const started = Promise.withResolvers<void>();
  tool.run = () => {
    started.resolve();
    return new Promise<string>(() => {});
  };
  fake.script.reply = transferOnMove;
  await prompt(first.host, 'dead', 'Please move 5');
  await started.promise;
  // Its tool call's start is stored before the tool runs.
  const before = outline(await messages(first.host));
  if (death === 'abandoned') first.kill();
  else await first.end();
  tool.run = () => Promise.resolve('moved');
  fake.script.reply = notAsked;
  return before;
}

/** How the attempt in a tool call dies. */
type Death = 'abandoned' | 'closed';

/** A short while for anything forked at boot (a resume, say) to run. */
const settleBoot = async (host: Host) => {
  await host.swept;
  await new Promise((resolve) => setTimeout(resolve, 300));
  await host.call(host.client.session.wait({ sessionID: SESSION }));
};

/**
 * The model calls `transfer` for "Please move 5", and while the call runs
 * a second prompt comes, with `delivery`. Gives the model's requests after
 * the tool returned, as the texts of their user messages and tool results.
 */
async function promptedInATool(delivery: 'queue' | 'steer') {
  const o = object();
  const attempt = await o.boot();
  const { host } = attempt;
  await host.call(host.client.session.create({ id: SESSION, model: fake.MODEL as never, agent: 'build' as never }));
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<string>();
  tool.run = () => {
    started.resolve();
    return gate.promise;
  };
  fake.script.reply = (request) => {
    const last = request.prompt.at(-1)!;
    if (said(last) === 'Please move 5') return { call: { id: 'call_1', name: 'transfer', input: { amount: 5 } } };
    if (last.role === 'tool') return { text: `Done: ${fake.textOf(last)}` };
    return { text: `Heard: ${said(last)}` };
  };
  await prompt(host, 'first', 'Please move 5');
  await started.promise;
  await prompt(host, 'second', 'And say hi', delivery);
  gate.resolve('moved');
  const all = outline(await idle(host));
  await attempt.end();
  const steps = fake.script.requests.slice(1).map((r) =>
    r.prompt
      .filter((m) => m.role === 'user' || m.role === 'tool')
      .map((m) => fake.textOf(m))
      .slice(1),
  );
  return { all, steps };
}

beforeEach(() => {
  if (!NODE_24) return;
  fake.script.requests.length = 0;
  fake.script.reply = notAsked;
  unasked.length = 0;
  tool.executed.length = 0;
  tool.run = () => Promise.resolve('moved');
});

describe.skipIf(!NODE_24)('OpenCode 2.2.6 on the object database: the spike', () => {
  it('stores the killed turn as a running tool call, its claim left', async () => {
    const o = object();
    expect(await killedInATool(o)).toEqual(['user: Please move 5', 'assistant: On it. | tool call_dead running']);
    expect(tool.executed).toEqual(['call_dead']);
  });

  // a. A turn killed in a tool call is closed at the next boot, each way.
  for (const [closer, death] of [
    ['own', 'abandoned'],
    ['budget', 'abandoned'],
    ['own', 'closed'],
    ['budget', 'closed'],
  ] as [Closer, Death][]) {
    it(`a (${closer}, host ${death}): closes a killed turn without the model, and answers the next prompt in a turn of its own`, async () => {
      const o = object();
      await killedInATool(o, death);
      const asked = fake.script.requests.length;

      const second = await o.boot({ restart: 'close', closer, cutOff, ended: ENDED });
      await settleBoot(second.host);
      expect(unasked).toEqual([]);
      expect(fake.script.requests.length).toBe(asked);
      const closed = outline(await messages(second.host));
      // The dead call's result: ours (the closer); none yet, OpenCode's budget
      // leaving the call running; or, for a host closed mid-tool, OpenCode's
      // own, written at its shutdown, before any boot (see the next test).
      const failedAs =
        death === 'closed'
          ? 'error (Tool execution interrupted)'
          : closer === 'own'
            ? `error (${cutOff('call_dead', 'transfer')})`
            : 'running';
      expect(closed).toEqual([
        'user: Please move 5',
        `assistant: On it. | tool call_dead ${failedAs}`,
        // The idle marker: our error, or OpenCode's budget's.
        closer === 'own'
          ? `idle: failed (${ENDED})`
          : 'idle: failed (Execution was interrupted repeatedly and will not be resumed automatically.)',
      ]);
      expect(await second.host.call(second.host.client.session.active())).toEqual({});
      await second.end();

      // The claim is released: a boot that resumes resumes nothing.
      const third = await o.boot({ restart: 'resume' });
      await settleBoot(third.host);
      expect(unasked).toEqual([]);
      expect(outline(await messages(third.host))).toEqual(closed);

      // The next prompt is a turn of its own; the dead call is not made again.
      fake.script.reply = (request) => {
        if (said(request.prompt.at(-1)!) === 'Hello') return { text: 'Hi there' };
        return notAsked(request);
      };
      await prompt(third.host, 'next', 'Hello');
      const all = outline(await idle(third.host));
      expect(unasked).toEqual([]);
      expect(fake.script.requests.length).toBe(asked + 1);
      const result =
        death === 'closed'
          ? 'Tool execution interrupted'
          : closer === 'own'
            ? cutOff('call_dead', 'transfer')
            : 'Tool execution interrupted: transfer';
      expect(all).toEqual([
        'user: Please move 5',
        `assistant: On it. | tool call_dead error (${result})`,
        closer === 'own'
          ? `idle: failed (${ENDED})`
          : 'idle: failed (Execution was interrupted repeatedly and will not be resumed automatically.)',
        'user: Hello',
        'assistant: Hi there',
        'idle: succeeded',
      ]);
      // What the model got for it: the dead call with its result, no
      // "Continue", the new prompt last.
      const input = fake.script.requests.at(-1)!.prompt.filter((m) => m.role !== 'system');
      expect(input.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
      expect(input.some((m) => CONTINUE.test(fake.textOf(m)))).toBe(false);
      const [, call, results] = input;
      expect(call?.content).toEqual([
        { type: 'text', text: 'On it.' },
        expect.objectContaining({ type: 'tool-call', toolCallId: 'call_dead', toolName: 'transfer' }),
      ]);
      expect(fake.textOf(results!)).toContain(result);
      expect(tool.executed).toEqual(['call_dead']);
      await third.end();
    }, 60_000);
  }

  // Observed: a host closed mid-tool (its scope closed, as the old
  // integration's `finally` did on any attempt's end) fails the running call
  // itself as it shuts down, "Tool execution interrupted" (no tool name),
  // keeping the claim (an interruption of reason `shutdown`). At the next
  // boot the closer finds no running part: its result is never given. Only
  // a death without teardown (a kill, a dead process) leaves the call
  // running for the closer.
  it.fails('a (own, host closed): each running call fails with our result', async () => {
    const o = object();
    await killedInATool(o, 'closed');
    const second = await o.boot({ restart: 'close', closer: 'own', cutOff, ended: ENDED });
    await settleBoot(second.host);
    const closed = outline(await messages(second.host));
    await second.end();
    expect(closed[1]).toBe(`assistant: On it. | tool call_dead error (${cutOff('call_dead', 'transfer')})`);
  }, 60_000);

  // b. The crash case: the same death, the next boot resumes the turn.
  it('b: resumes a crashed turn: the model is asked, and the turn finishes', async () => {
    const o = object();
    await killedInATool(o);
    const asked = fake.script.requests.length;
    fake.script.reply = (request) => {
      const last = request.prompt.at(-1)!;
      if (CONTINUE.test(said(last))) return { text: 'Done, after the restart' };
      return notAsked(request);
    };
    const second = await o.boot({ restart: 'resume' });
    await second.host.swept;
    const all = outline(await idle(second.host));
    expect(unasked).toEqual([]);
    expect(fake.script.requests.length).toBe(asked + 1);
    expect(all).toEqual([
      'user: Please move 5',
      'assistant: On it. | tool call_dead error (Tool execution interrupted: transfer)',
      expect.stringMatching(/^synthetic: The server restarted while you were working/),
      'assistant: Done, after the restart',
      'idle: succeeded',
    ]);
    await second.end();
  }, 60_000);

  // c. The sweep awaited: a prompt submitted right after a 'close' boot never joins the dead turn.
  for (const closer of ['own', 'budget'] as Closer[]) {
    it(`c (${closer}): a prompt submitted once the sweep is done is a turn of its own`, async () => {
      const o = object();
      await killedInATool(o);
      fake.script.reply = (request) => {
        if (request.prompt.some((m) => CONTINUE.test(said(m)))) return notAsked(request);
        if (said(request.prompt.at(-1)!) === 'Hello') return { text: 'Hi there' };
        return notAsked(request);
      };
      const second = await o.boot({ restart: 'close', closer, cutOff, ended: ENDED });
      await second.host.swept;
      await prompt(second.host, 'next', 'Hello');
      const all = outline(await idle(second.host));
      expect(unasked).toEqual([]);
      // The dead turn's idle marker comes before the new prompt.
      expect(all.slice(2)).toEqual([
        expect.stringMatching(/^idle: failed/),
        'user: Hello',
        'assistant: Hi there',
        'idle: succeeded',
      ]);
      await second.end();
    }, 60_000);
  }

  // d. The inbox: a prompt queued while a drain runs joins that turn at its next step.

  // Observed: 'queue' waits for the turn's end. The drain promotes only
  // steers at a step boundary mid-turn (`advanceToStep` asks for "steer"
  // while continuing); a queued prompt is promoted at the idle boundary,
  // after the turn's last step, as a new turn in the same drain (step 1, no
  // idle marker between). The model's step after the tool result does not
  // see it: steps are [['moved'], ['moved', 'And say hi']], and the session
  // reads user, assistant(call), assistant('Done: moved'), user('And say
  // hi'), assistant, idle.
  it.fails("d: a prompt queued (delivery 'queue') while a drain runs joins that turn at its next step", async () => {
    const { steps } = await promptedInATool('queue');
    // The model's next step, after the tool result, has the second prompt.
    expect(steps[0]).toEqual(['moved', 'And say hi']);
  }, 60_000);

  it("d (steer): a prompt steered (delivery 'steer') while a drain runs joins that turn at its next step", async () => {
    const { all, steps } = await promptedInATool('steer');
    expect(steps[0]).toEqual(['moved', 'And say hi']);
    expect(all).toEqual([
      'user: Please move 5',
      'assistant: tool call_1 completed',
      'user: And say hi',
      'assistant: Heard: And say hi',
      'idle: succeeded',
    ]);
  }, 60_000);

  it("d (queue), as observed: a queued prompt starts after the turn's last step, in the same drain", async () => {
    const { all, steps } = await promptedInATool('queue');
    expect(steps).toEqual([['moved'], ['moved', 'And say hi']]);
    expect(all).toEqual([
      'user: Please move 5',
      'assistant: tool call_1 completed',
      'assistant: Done: moved',
      'user: And say hi',
      'assistant: Heard: And say hi',
      'idle: succeeded',
    ]);
  }, 60_000);
});
