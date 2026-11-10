// What a turn costs: its commits to the key's database (each a flush to
// Restate: two state sets, a run, a round trip) and its calls to the
// companion, for Claude, the built-in LangGraph loop and a graph of your
// own, without a Restate server. A turn of `r` model requests makes `r - 1`
// rounds of `k` tool calls, then answers.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { sessionObject, tool } from '@restatedev/agents';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import * as claude from '@restatedev/agents/claude';
import * as langgraph from '@restatedev/agents/langgraph';
import { followingOf, handlerOf, type PromptHandler, sqlAttempt } from './support.ts';
import { reply as tellerReply, teller } from './fakes/claude.ts';
import { Teller } from './fakes/langgraph.ts';

vi.mock('@anthropic-ai/sdk', () => import('./fakes/claude.ts'));

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

/** The plan of the turn being answered: so many rounds of so many tool calls, then the answer. */
const plan = { rounds: 0, calls: 0, asked: 0, ids: 0 };

/** The tool calls of the model's next reply, if the plan has a round left: each with an id of its own. */
const nextCalls = () =>
  plan.asked++ < plan.rounds
    ? Array.from({ length: plan.calls }, (_, i) => ({ id: `call_${++plan.ids}`, name: `t${i + 1}` }))
    : undefined;

const tools = () =>
  ['t1', 't2', 't3'].map((name) =>
    tool({ name, description: `tool ${name}`, input: z.object({}), run: () => `result of ${name}` }),
  );

/** Claude's model, by the plan. */
function claudePlanned() {
  teller.reply = (messages: MessageParam[]) => {
    const calls = nextCalls();
    const message = tellerReply(messages);
    message.content = calls
      ? [
          { type: 'text', text: 'On it.', citations: null },
          ...calls.map(({ id, name }) => ({ type: 'tool_use' as const, id, name, input: {} })),
        ]
      : [{ type: 'text', text: 'Done', citations: null }];
    message.stop_reason = calls ? 'tool_use' : 'end_turn';
    return message;
  };
}

/** LangGraph's model, by the plan. */
class Planned extends Teller {
  override reply(_messages: BaseMessage[]) {
    const calls = nextCalls();
    if (!calls) return new AIMessage('Done');
    return new AIMessage({ content: 'On it.', tool_calls: calls.map(({ id, name }) => ({ id, name, args: {} })) });
  }
}

/** A graph of your own: a model node and LangGraph's ToolNode, as the usual tool-calling loop. */
const ownGraph = () => {
  const model = new Planned({});
  return new StateGraph(MessagesAnnotation)
    .addNode('model', async ({ messages }) => ({ messages: [await model.invoke(messages)] }))
    .addNode('tools', new ToolNode(langgraph.tools(tools())))
    .addEdge(START, 'model')
    .addConditionalEdges('model', toolsCondition)
    .addEdge('tools', 'model');
};

/** What a turn cost: its commits, and the companion's handlers it called, in order. */
interface Cost {
  commits: number;
  companion: string[];
}

/**
 * Two turns of `chat` on a key of its own, each of `r` requests with `k` tool
 * calls a round: what each cost. With `olderCompanion`, the companion's
 * `start` returns nothing (see support.ts); `object` is the agent's.
 */
async function costs(
  chat: PromptHandler,
  r: number,
  k: number,
  { olderCompanion = false, object }: { olderCompanion?: boolean; object?: { readonly name: string } } = {},
): Promise<Cost[]> {
  const map = new Map<string, Uint8Array>();
  const following = followingOf(map);
  const handler = handlerOf(chat);
  const out: Cost[] = [];
  for (const [i, text] of ['first', 'second'].entries()) {
    Object.assign(plan, { rounds: r - 1, calls: k, asked: 0 });
    let commits = 0;
    const made = following.made.length;
    const onSync = async () => void commits++;
    const sql = sqlAttempt({ map, key: 'k', id: `inv${i}`, onSync, olderCompanion, object });
    expect(await sql.end(() => handler(sql.ctx, text))).toBe('Done');
    out.push({ commits, companion: following.made.slice(made) });
  }
  return out;
}

const AGENTS: [string, () => PromptHandler][] = [
  ['Claude', () => (claudePlanned(), claude.chat({ tools: tools() }))],
  ['the built-in LangGraph loop', () => langgraph.chat({ model: new Planned({}), tools: tools() })],
  ['a LangGraph graph of your own', () => langgraph.chat({ graph: ownGraph() })],
];

describe("a turn's commits", () => {
  afterAll(() => {
    teller.reply = tellerReply;
  });

  it.each(AGENTS)("apply a key's schemas in one commit, on its first turn: %s", async (_name, chat) => {
    for (const [r, k] of [
      [1, 0],
      [2, 3],
    ] as const) {
      const [first, second] = await costs(chat(), r, k);
      expect(first!.commits - second!.commits).toBe(1);
    }
  });
});

describe("a turn's start", () => {
  afterAll(() => {
    teller.reply = tellerReply;
  });

  it.each(AGENTS)(
    "is published by the companion's `start`, or by the turn when `start` returns nothing: %s",
    async (_name, chat) => {
      for (const [r, k] of [
        [1, 0],
        [2, 3],
      ] as const) {
        const [, turn] = await costs(chat(), r, k);
        const [, older] = await costs(chat(), r, k, { olderCompanion: true });
        // The turn's own publish to start is the companion's `start`'s.
        expect(older!.companion.slice(0, 2)).toEqual(['start', 'publish']);
        expect(turn!.companion).toEqual(['start', ...older!.companion.slice(2)]);
      }
    },
  );

  it('is not published in the background: the turn says it does not publish, and the turn makes none', async () => {
    claudePlanned();
    const chat = claude.chat({ tools: tools() });
    const object = sessionObject({ name: 'quiet', background: true, handlers: { chat }, views: {} });
    const [, plain] = await costs(chat, 1, 0, { object });
    expect(plain!.companion).toEqual(['start', 'close']);
  });
});
