// agentlib agents (@restatedev/agents/agentlib) against a real Restate server,
// on a scripted model: a classic virtual object, journaled, with the
// handlers and views of every agent.
//
// Checks: a turn with a tool that waits for a signal, as `pending` and
// `status` show it, and a message steered to it, which the turn takes after
// the tool's result, and whose own `steered` then does nothing; the
// conversation as `messages` gives it, by page and by cursor, and as `sync`
// does; a message steered with no turn running, a turn of its own; a tool
// call that needs approval, denied; a stopped turn, which the
// next turn's model sees ended (with a message steered to it, if it took
// one); a provider's refusal (424), and a model's
// failure that is none (500); a sub-agent of a pi agent; `clear`, whose
// ids go on; and a crash of the service process mid-turn, after which the
// turn is replayed: the model is asked no second time for a step it answered.
//
//   pnpm --filter e2e agentlib   (RESTATE_SERVER=/path/to/restate-server to use another)
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as restate from '@restatedev/restate-sdk';
import { asyncTool, journaledModel, tool, type Message, type ModelResponse } from '@restatedev/agentlib';
import { sleep as genSleep } from '@restatedev/restate-sdk-gen';
import { createModels } from '@earendil-works/pi-ai/models';
import { CANCELLED, served, subagent, UNANSWERED, type Messages, type Status, type Waiting } from '@restatedev/agents';
import * as agentlib from '@restatedev/agents/agentlib';
import type { Steered, Synced } from '@restatedev/agents/client';
import * as pi from '@restatedev/agents/pi';
import { callTools, fakeProvider, say, textOf } from '@restatedev/agents/test/fakes/pi';
import { z } from 'zod';
import { RESTATE_SERVER as SERVER } from './restate-server.ts';

const INGRESS = 'http://127.0.0.1:8080';
const ADMIN = 'http://127.0.0.1:9070';
const PORT = 9303;
const CHILD_PORT = 9304;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Messages as lines: each one's role, and its texts and tool calls with their outputs. */
const lines = (messages: Messages['messages']) =>
  messages.map((m) => [m.role, ...m.parts.map((p) => (p.type === 'text' ? p.text : `${p.name}: ${p.output}`))]);

/** What a tool message says to the scripted model. */
const said = (m: Extract<Message, { role: 'tool' }>) =>
  m.result.status === 'success' ? JSON.stringify(m.result.output).replaceAll('"', '') : m.result.status;

/**
 * The model: "Plan" waits for an approval, "Transfer" moves money (which
 * needs approval), "Nap" naps, "Refuse" is refused; after a tool's result,
 * it says what it did with, and with the message steered after it, if any;
 * anything else it answers as it is, saying how the turn before ended if it
 * did not answer.
 */
function script(messages: readonly Message[]): ModelResponse {
  const at = messages.findLastIndex((m) => m.role === 'tool');
  const prompt = messages.findLast((m) => m.role === 'user' && !m.content.startsWith('{'));
  if (at >= 0 && messages.slice(at).every((m) => m.role !== 'assistant')) {
    const steered = messages
      .slice(at + 1)
      .filter((m): m is Extract<Message, { role: 'user' }> => m.role === 'user')
      .map((m) => (JSON.parse(m.content) as { message: string }).message);
    // Steered to wait again: it does.
    if (steered.includes('Wait again')) {
      return { type: 'tool_calls', calls: [{ id: `call_${messages.length}`, name: 'wait_for_approval', input: {} }] };
    }
    const done = `Done with ${said(messages[at] as Extract<Message, { role: 'tool' }>)}`;
    return { type: 'final', text: steered.length > 0 ? `${done}, and: ${steered.join(' / ')}` : done };
  }
  const text = (prompt as { content: string }).content;
  if (text.startsWith('Plan'))
    return { type: 'tool_calls', calls: [{ id: `call_${messages.length}`, name: 'wait_for_approval', input: {} }] };
  if (text.startsWith('Transfer'))
    return { type: 'tool_calls', calls: [{ id: `call_${messages.length}`, name: 'transfer', input: { amount: 500 } }] };
  if (text.startsWith('Nap'))
    return { type: 'tool_calls', calls: [{ id: `call_${messages.length}`, name: 'nap', input: {} }] };
  // As agentlib's aiModel fails for a provider's 4xx, and for a model of its own that breaks.
  if (text.startsWith('Refuse')) throw new restate.TerminalError('Incorrect API key provided', { errorCode: 401 });
  if (text.startsWith('Break')) throw new restate.TerminalError('the model broke', { errorCode: 500 });
  const before = messages.at(-2);
  const ended =
    before?.role === 'assistant' && before.content.startsWith('Cancelled') ? ` (after: ${before.content})` : '';
  // A message steered to the turn before, which it took, kept with it.
  const noted = ended ? messages.at(-3) : undefined;
  const kept =
    noted?.role === 'user' && noted.content.startsWith('{')
      ? ` [steered: ${(JSON.parse(noted.content) as { message: string }).message}]`
      : '';
  return { type: 'final', text: `Answered: ${text}${ended}${kept}` };
}

/** The scripted model, journaled as agentlib's models are; each ask, logged to MODEL_LOG if set. */
const model = journaledModel(
  async (request) => {
    if (process.env.MODEL_LOG) appendFileSync(process.env.MODEL_LOG, `${request.messages.length}\n`);
    return script(request.messages);
  },
  { name: 'Ask model', retry: { maxAttempts: 1 } },
);

const planner = agentlib.agent({
  name: 'planner',
  model,
  tools: {
    wait_for_approval: agentlib.signal('approval', { description: 'Wait for a manager' }),
    transfer: asyncTool({
      description: 'Move money',
      input: z.object({ amount: z.number() }),
      needsApproval: true,
      execute: async ({ amount }) => `moved ${amount}`,
    }),
  },
});

// An agent of another framework (pi), whose tool hands the agentlib agent a task.
const models = createModels();
models.setProvider(
  fakeProvider('script', 'script', ({ messages }) => {
    const last = messages.at(-1)!;
    if (last.role === 'toolResult') return say(`Boss heard: ${textOf(last.content)}`);
    return callTools([['planner', { name: 'greeting', task: textOf(last.content) }]]);
  }),
);
const boss = pi.agent({ name: 'boss', model: 'script/script', models, tools: [subagent(planner)] });

const napper = agentlib.agent({
  name: 'napper',
  model,
  tools: {
    nap: tool({
      description: 'Nap',
      input: z.object({}),
      *execute() {
        yield* genSleep({ seconds: 3 });
        return 'a nap';
      },
    }),
  },
});

if (process.argv[2] === 'serve') {
  // The crash test's service process: napper alone.
  await restate.serve({ services: served([napper]), port: CHILD_PORT });
} else {
  const dir = mkdtempSync(join(tmpdir(), 'restate-agentlib-'));
  const server = spawn(SERVER, ['--base-dir', dir], {
    env: { ...process.env, RESTATE_BIND_IP: '127.0.0.1', RESTATE_LISTEN_MODE: 'tcp' },
    stdio: 'ignore',
  });
  let child: ReturnType<typeof spawn> | undefined;
  const log = join(dir, 'model.log');
  const serveChild = () =>
    (child = spawn(process.execPath, [import.meta.filename, 'serve'], {
      env: { ...process.env, MODEL_LOG: log },
      stdio: ['ignore', 'ignore', 'inherit'],
    }));
  try {
    await restate.serve({ services: served([planner, boss]), port: PORT });
    serveChild();
    for (
      let i = 0;
      !(await fetch(`${ADMIN}/health`).then(
        (r) => r.ok,
        () => false,
      ));
      i++
    ) {
      if (i > 300) throw new Error('restate-server did not start');
      await sleep(100);
    }
    for (const port of [PORT, CHILD_PORT]) {
      for (let i = 0; ; i++) {
        const registered = await fetch(`${ADMIN}/deployments`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ uri: `http://127.0.0.1:${port}` }),
        });
        if (registered.ok) break;
        if (i > 100) throw new Error(`deployment ${port}: ${await registered.text()}`);
        await sleep(100);
      }
    }

    const request = async (path: string, body?: unknown, headers: Record<string, string> = {}) =>
      fetch(`${INGRESS}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body ?? null),
      });
    const post = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const response = await request(path, body, headers);
      const text = await response.text();
      assert.ok(response.ok, `${path}: ${response.status} ${text}`);
      return text ? (JSON.parse(text) as unknown) : undefined;
    };
    const attach = async (id: string) => fetch(`${INGRESS}/restate/invocation/${id}/attach`);
    const waiting = async (object: string) => {
      for (let i = 0; ; i++) {
        const [wait] = (await post(`${object}/pending`)) as Waiting[];
        if (wait) return wait;
        if (i > 300) throw new Error(`${object} does not wait`);
        await sleep(100);
      }
    };
    const conversation = async (object: string) => lines(((await post(`${object}/messages`)) as Messages).messages);

    // A tool that waits for a signal, and a message steered to its turn.
    const plan = (await post('planner/alice/chat/send', 'Plan my week')) as { invocationId: string };
    const wait = await waiting('planner/alice');
    assert.equal(wait.name, 'approval');
    assert.ok(wait.id.startsWith(`${plan.invocationId}:`));
    const status = (await post('planner/alice/status')) as Status;
    assert.equal(status.answering?.invocationId, plan.invocationId);
    // While it works: the message and the tool call so far.
    assert.deepEqual(await conversation('planner/alice'), [
      ['user', 'Plan my week'],
      ['assistant', 'wait_for_approval: undefined'],
    ]);
    const steered = (await post('planner/alice/steer', 'Skip Friday', { 'idempotency-key': 'steer-1' })) as Steered;
    assert.equal(steered.turn, plan.invocationId);
    assert.deepEqual(
      ((await post('planner/alice/status')) as Status).steering?.map((m) => m.id),
      [steered.id],
    );
    const { cursor } = (await post('planner/alice/messages')) as Messages;
    await post('planner/alice/signal', { id: wait.id, value: 'approved' });
    assert.equal(await (await attach(plan.invocationId)).json(), 'Done with approved, and: Skip Friday');
    // The steered message's own turn finds it taken, and does nothing: the next message is answered after it.
    assert.equal(await post('planner/alice/chat', 'Thanks'), 'Answered: Thanks');
    const all = (await post('planner/alice/messages')) as Messages;
    assert.deepEqual(lines(all.messages), [
      ['user', 'Plan my week'],
      ['assistant', 'wait_for_approval: approved'],
      ['user', 'Skip Friday'],
      ['assistant', 'Done with approved, and: Skip Friday'],
      ['user', 'Thanks'],
      ['assistant', 'Answered: Thanks'],
    ]);
    assert.deepEqual(
      all.messages.map((m) => m.id),
      [0, 1, 2, 3, 4, 5],
    );
    assert.deepEqual(await post('planner/alice/status'), { answering: null, waiting: [] });
    // By cursor: what changed since the steered message was sent (the tool call's result, and on).
    const since = (await post('planner/alice/messages', { cursor })) as Messages;
    assert.deepEqual(
      since.messages.map((m) => m.id).toSorted((a, b) => a - b),
      [0, 1, 2, 3, 4, 5],
    );
    assert.deepEqual(await post('planner/alice/messages', { cursor: all.cursor }), {
      messages: [],
      more: false,
      cursor: all.cursor,
    });
    // A page, and the one before it; the summary.
    const latest = (await post('planner/alice/messages', { limit: 2 })) as Messages;
    assert.deepEqual([latest.messages.map((m) => m.id), latest.more], [[4, 5], true]);
    const before = (await post('planner/alice/messages', { limit: 10, before: 4 })) as Messages;
    assert.deepEqual([before.messages.map((m) => m.id), before.more], [[0, 1, 2, 3], false]);
    const summary = (await post('planner/alice/messages', { view: 'summary' })) as Messages;
    assert.deepEqual(
      summary.messages.map((m) => m.id),
      [0, 3, 4, 5],
    );
    const synced = (await post('planner/alice/sync', {})) as Synced;
    assert.ok(synced.revision > 0);
    assert.deepEqual(synced.status, { answering: null, waiting: [] });
    assert.equal(synced.messages.length, 6);

    // No turn running: a steered message is a turn of its own (its `steered`).
    assert.deepEqual(
      ((await post('planner/gina/steer', 'Hello there', { 'idempotency-key': 'steer-2' })) as Steered).turn,
      null,
    );
    for (let i = 0; (await conversation('planner/gina')).length < 2; i++) {
      if (i > 300) throw new Error('the steered message was not answered');
      await sleep(100);
    }
    assert.deepEqual(await conversation('planner/gina'), [
      ['user', 'Hello there'],
      ['assistant', 'Answered: Hello there'],
    ]);

    // A call that needs approval, denied.
    const transfer = (await post('planner/bob/chat/send', 'Transfer 500')) as { invocationId: string };
    const approval = await waiting('planner/bob');
    assert.deepEqual(approval.input, { tool: 'transfer', input: { amount: 500 } });
    await post('planner/bob/signal', { name: 'approval', value: 'no' });
    assert.equal(await (await attach(transfer.invocationId)).json(), 'Done with denied');

    // Stopped: the turn ends cancelled, and the next turn's model sees it.
    const stopped = (await post('planner/carol/chat/send', 'Plan my week')) as { invocationId: string };
    await waiting('planner/carol');
    assert.deepEqual(await post('planner/carol/stop'), { stopped: stopped.invocationId });
    assert.equal((await attach(stopped.invocationId)).ok, false);
    assert.equal(await post('planner/carol/chat', 'Hello'), `Answered: Hello (after: ${CANCELLED})`);
    assert.deepEqual(await conversation('planner/carol'), [
      ['user', 'Plan my week'],
      ['assistant', 'wait_for_approval: undefined'],
      ['assistant', CANCELLED],
      ['user', 'Hello'],
      ['assistant', `Answered: Hello (after: ${CANCELLED})`],
    ]);
    assert.deepEqual(await post('planner/carol/pending'), []);

    // Stopped after it took a steered message: the next turn's model sees the message, with how the turn ended.
    const month = (await post('planner/ivan/chat/send', 'Plan my month')) as { invocationId: string };
    const first = await waiting('planner/ivan');
    assert.equal(
      ((await post('planner/ivan/steer', 'Wait again', { 'idempotency-key': 'steer-3' })) as Steered).turn,
      month.invocationId,
    );
    await post('planner/ivan/signal', { id: first.id, value: 'approved' });
    for (let i = 0; ; i++) {
      const [again] = (await post('planner/ivan/pending')) as Waiting[];
      if (again && again.id !== first.id) break;
      if (i > 300) throw new Error('ivan does not wait again');
      await sleep(100);
    }
    assert.deepEqual(await post('planner/ivan/stop'), { stopped: month.invocationId });
    assert.equal(
      await post('planner/ivan/chat', 'Hello'),
      `Answered: Hello (after: ${CANCELLED}) [steered: Wait again]`,
    );
    assert.deepEqual(await conversation('planner/ivan'), [
      ['user', 'Plan my month'],
      ['assistant', 'wait_for_approval: approved'],
      ['user', 'Wait again'],
      ['assistant', 'wait_for_approval: undefined'],
      ['assistant', CANCELLED],
      ['user', 'Hello'],
      ['assistant', `Answered: Hello (after: ${CANCELLED}) [steered: Wait again]`],
    ]);

    // Refused by the model's provider: 424, and the turn is over.
    const refused = await request('planner/dave/chat', 'Refuse me');
    assert.equal(refused.status, 424, await refused.text());
    assert.deepEqual(await conversation('planner/dave'), [
      ['user', 'Refuse me'],
      ['assistant', UNANSWERED],
    ]);

    // A terminal error of the model's that is no refusal: the turn failed (500), and says how.
    const broken = await request('planner/dora/chat', 'Break it');
    assert.equal(broken.status, 500, await broken.text());
    assert.deepEqual(await conversation('planner/dora'), [
      ['user', 'Break it'],
      ['assistant', 'Failed: the model broke'],
    ]);

    // A sub-agent of an agent of another framework: pi's `subagent` tool hands it a task, at its own key.
    assert.equal(await post('boss/henry/chat', 'Hello from the boss'), 'Boss heard: Answered: Hello from the boss');
    assert.deepEqual(await conversation('planner/henry.greeting'), [
      ['user', 'Hello from the boss'],
      ['assistant', 'Answered: Hello from the boss'],
    ]);

    // Cleared: the conversation starts over, its ids going on.
    await post('planner/erin/chat', 'Hi');
    assert.deepEqual(await post('planner/erin/clear'), { stopped: null });
    const cleared = (await post('planner/erin/messages')) as Messages;
    assert.deepEqual([cleared.messages, cleared.first], [[], 2]);
    assert.equal(await post('planner/erin/chat', 'Again'), 'Answered: Again');
    const again = (await post('planner/erin/messages')) as Messages;
    assert.deepEqual(
      again.messages.map((m) => m.id),
      [2, 3],
    );

    // A crash mid-turn: the service process is killed while the tool naps,
    // and served again; the turn is replayed, and the model asked once per step.
    const nap = (await post('napper/frank/chat/send', 'Nap now')) as { invocationId: string };
    // Once its tool call shows, the model's reply is in the journal: the run went on past it.
    for (let i = 0; (await conversation('napper/frank')).length < 2; i++) {
      if (i > 300) throw new Error('napper did not call its tool');
      await sleep(50);
    }
    child!.kill('SIGKILL');
    await sleep(500);
    serveChild();
    assert.equal(await (await attach(nap.invocationId)).json(), 'Done with a nap');
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['1', '3']);
    console.log('ok');
  } finally {
    child?.kill('SIGKILL');
    server.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
  process.exit(0);
}
