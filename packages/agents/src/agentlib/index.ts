// An agent of Restate's agentlib (@restatedev/agentlib): its loop, its tools and
// its models, in a virtual object of the classic Restate SDK, journaled and
// replayed, rather than in a session object. Its conversation is in the
// object's key/value state, and it has the handlers and views of every agent
// here (`chat`, `messages`, `status`, `steer`, `stop`, `clear`, `sync`,
// `signal`, `pending`...), with the companion they ask, so that a client
// follows it as it follows any other.
//
//   const assistant = agentlib.agent({ name: 'assistant', tools: { weather } });
//   await serve(assistant);
import {
  agent as agentlibAgent,
  type Agent as LibAgent,
  type AgentOptions as LibOptions,
  type Conversation,
  type ConversationCompactionStatus,
  type ConversationSnapshot,
  type JsonValue,
  type Message,
  type Model,
  type ProgressEvent,
  type RunResult,
  type SteeringUpdate,
  LazyStateConversation,
  type CompactionPolicy,
  GuardrailError,
} from '@restatedev/agentlib';
import { channel, execute, internal, type Channel, type Future, type Operation } from '@restatedev/restate-sdk-gen';
import type { aiModel as aiModelType } from '@restatedev/agentlib/provider';
import { sdk as restate } from '@restatedev/sessions/internal';
import {
  approves,
  CANCELLED,
  CHECK_MODEL,
  ENDED,
  type ChatMessage,
  type Messages,
  type MessagesRequest,
  messageSerde,
  ModelError,
  type Part,
  REFUSED,
  UNANSWERED,
} from '../common.ts';
import {
  companionFor,
  type Notifications,
  type Published,
  type Resolved,
  type Signal,
  type Steer,
  type Steered,
  type Waiting,
  type Watch,
  withCompanion,
} from '../companion.ts';
import type { Status, Stopped, Synced, SyncRequest } from '../object.ts';
import { type AgentlibContext, type AgentlibTool, type Tools, toolsOf } from './tools.ts';
import { type Entry, outputOf, refused, render, type Rendered, steeringNote, withoutBounds } from './parts.ts';

export type { AgentlibContext, AgentlibTool, Tools };

const { adopt } = internal;

/** The value of state `key`, as an operation of a run: the SDK's read is a RestatePromise, though its type says Promise. */
const read = <T>(ctx: restate.ObjectContext, key: string) =>
  adopt(ctx.get<T>(key) as unknown as restate.RestatePromise<T | null>);

/** The model of an agent that names none, without MODEL: OpenAI's, with OPENAI_API_KEY. */
export const DEFAULT_MODEL = 'openai/gpt-6-sol';

/**
 * The options of an agent, beside agentlib's own (`maxSteps`, `compaction`,
 * `contextWindow`, `toolResults`, `skills`, `beforeTool`, `afterRun`...),
 * which go to its `agent()` as they are.
 */
export interface Options<O = string> extends Omit<
  LibOptions<AgentlibContext, O>,
  'model' | 'name' | 'instructions' | 'tools' | 'onApproval' | 'onHumanApproval'
> {
  /**
   * `provider/model-id` (`openai/…` or `anthropic/…`), or else MODEL, or
   * else {@link DEFAULT_MODEL}; or a model of agentlib (`aiModel` of
   * `@restatedev/agentlib/provider`, for any provider of the AI SDK).
   */
  model?: string | Model;
  /** The instructions (the system prompt): a text, or agentlib's function of the run's context that gives one. */
  system?: LibOptions<AgentlibContext, O>['instructions'];
  /**
   * The tools: those of `@restatedev/agents` (`tool()`, `call`, `send`,
   * `workflow`, `signal`, `subagent`), as every agent takes them, and
   * agentlib's own, by the name the model calls them: `[weather, call(...),
   * { transfer: asyncTool(...) }]`, or `{ transfer: asyncTool(...) }`.
   */
  tools?: Tools;
  /**
   * How the conversation the model gets stays short from turn to turn: at a
   * turn's start, once its messages since the last summary pass `maxMessages`
   * (default 64) or `maxChars` (default 64 000), the earliest are summarized
   * by `model` (by default the agent's), and the latest `retainMessages`
   * (default 12) stay as they are, from a message of the user's on. The
   * summary is kept, and the next turns build on it. `false` keeps the whole
   * conversation. `messages` keeps every turn as it was said either way.
   */
  history?: false | (CompactionPolicy & { model?: Model });
}

/** An agent's name, and what it is beside its options. */
export interface Definition<P extends string> {
  name: P;
  /** What it is: for the UI, and for the model of a parent that hands it tasks (`subagent`). */
  description?: string;
  /** It works unwatched (a subagent): its turn tells its companion at its end only, not at each step. */
  background?: boolean;
  /** Options of the object, beside the ones set here (`retryPolicy`, say). */
  options?: restate.ObjectOptions;
  metadata?: Record<string, string>;
}

// The AI SDK's provider of each (its Responses API, for OpenAI's), as agentlib's `aiModel`.
const providers: Record<string, () => Promise<(modelId: string) => Parameters<typeof aiModelType>[0]['model']>> = {
  openai: async () => (await import('@ai-sdk/openai')).openai,
  anthropic: async () => (await import('@ai-sdk/anthropic')).anthropic,
};

/** That agent `name`'s `history` bounds are positive integers (agentlib's `prepareCompaction` would refuse them). */
function checkHistory(name: string, history: CompactionPolicy) {
  for (const bound of ['maxMessages', 'maxChars', 'retainMessages'] as const) {
    const value = history[bound];
    if (value !== undefined && !(Number.isSafeInteger(value) && value > 0)) {
      throw new Error(`${name}: history.${bound} must be a positive integer, not ${JSON.stringify(value)}`);
    }
  }
}

/** `model` as agentlib takes it, once its provider's package is loaded: see {@link Options.model}. */
function modelOf(name: string, model: string | Model | undefined): () => Promise<Model> {
  if (typeof model === 'function') return () => Promise.resolve(model);
  const id = model ?? process.env.MODEL ?? DEFAULT_MODEL;
  const at = id.indexOf('/');
  if (at <= 0 || at === id.length - 1) throw new Error(`${name}: the model ${id} is not provider/model-id`);
  const provider = id.slice(0, at);
  const modelId = id.slice(at + 1);
  const providerOf = providers[provider];
  if (providerOf) {
    return async () => {
      const [{ aiModel }, of] = await Promise.all([
        import('@restatedev/agentlib/provider'),
        providerOf().catch((error: unknown) => {
          throw new ModelError(
            `${id} needs @ai-sdk/${provider}: install it beside @restatedev/agentlib (${String(error)})`,
          );
        }),
      ]);
      // No retry limit of the model's own: a provider's outage fails the attempt, and Restate retries it
      // (the object's retry policy), as every agent's is asked again; a refusal is terminal at once.
      const made = aiModel({ model: of(modelId), retry: {} });
      return provider === 'anthropic' ? unbounded(made) : made;
    };
  }
  throw new Error(
    `${name}: an agentlib agent takes openai/… and anthropic/… models by name, not ${id}: ` +
      'give any other as a model of agentlib (aiModel of @restatedev/agentlib/provider)',
  );
}

/**
 * `model` (Anthropic's), sent its tools' schemas without the bounds of their
 * numbers: agentlib 0.1.0's `aiModel` asks for strict tools where a schema
 * allows it, and Anthropic refuses a strict tool with bounded numbers (such
 * as agentlib's own `read_tool_result`). The tools still check their input
 * against their bounds. (agentlib after 0.1.0 leaves strictness to the AI SDK.)
 */
const unbounded =
  (model: Model): Model =>
  (request) =>
    model({
      ...request,
      tools: request.tools.map((t) => ({ ...t, inputSchema: withoutBounds(t.inputSchema) as Record<string, unknown> })),
    });

/** `model`, but its provider's refusal (see {@link refused}) answers as every agent's does, {@link REFUSED}. */
const refusing = (model: Model): Model =>
  function* (request) {
    try {
      return yield* model(request);
    } catch (error) {
      if (refused(error)) {
        throw new restate.TerminalError(`the model's provider refused the request: ${CHECK_MODEL}. ${error.message}`, {
          errorCode: REFUSED,
        });
      }
      throw error;
    }
  };

/** The companion of the agent of `ctx`, at its key. */
const companionAt = (ctx: restate.ObjectContext | restate.ObjectSharedContext) =>
  ctx.objectClient(companionFor(ctx.request().target.service), ctx.key);

/** A wait for the signal `name` (with `input`, as `pending` lists it), as `what` of the turn waits (a call's id): its value. */
function* waitFor(ctx: restate.ObjectContext, what: string, name: string, input?: unknown): Operation<unknown> {
  return yield* adopt(companionAt(ctx).wait({ id: `${ctx.request().id}:${what}`, name, input }));
}

/** What the agent keeps in its state, beside its messages: under `meta`. */
interface Meta {
  /** How many messages, as clients read them, its answered turns have (under `c/<id>`): the next turn's first id. */
  chats: number;
  /** The last change's cursor: each message written takes the next. */
  cursor: number;
  /** The id of the first message once the conversation was cleared. */
  first?: number;
  /** The turn being answered, if any: its messages so far are `from` and the `n` after it. */
  live?: { turn: string; prompt: string; from: number; n: number };
}

const META = 'meta';
/**
 * Where the conversation the model gets is (agentlib's `LazyStateConversation`):
 * its messages in chunks of 32 (`t/<n>`), and its count and summary (`t/meta`).
 */
const CONVERSATION = 't';
const CONVERSATION_META = `${CONVERSATION}/meta`;
const entryKey = (id: number) => `c/${id}`;
/** The ids of the messages steered to the turns that took them, which their own `steered` turn leaves be. */
const TAKEN = 'taken';

const emptyMeta = (): Meta => ({ chats: 0, cursor: 0 });

/**
 * The options of every agentlib agent, beside its own: an invocation starts
 * with `meta`, `taken` and the conversation's meta only, not the whole conversation (each message
 * is a key of its own), and reads the rest as it needs it; and retries as
 * every agent does, for weeks, soon after a failure and then twice as long
 * each time, up to 10 seconds apart (a provider's outage is asked again).
 */
const OPTIONS = {
  state: { preload: [META, TAKEN, CONVERSATION_META] },
  retryPolicy: { initialInterval: 50, exponentiationFactor: 2, maxInterval: 10_000, maxAttempts: 100_000 },
} satisfies restate.ObjectOptions;

/**
 * The conversation the model gets, in the state of the object of `ctx`
 * (agentlib's own, its reads journaled): summarized as `compaction` says, if
 * given (see {@link Options.history}).
 */
const conversationOf = (ctx: restate.ObjectContext, compaction?: { model: Model; policy?: CompactionPolicy }) =>
  new LazyStateConversation({
    stateKey: CONVERSATION,
    metaKey: CONVERSATION_META,
    store: {
      *get<T>(key: string) {
        return (yield* read<T>(ctx, key)) ?? undefined;
      },
      // A state write is the SDK's at once, and journaled: nothing to wait for.
      // oxlint-disable-next-line require-yield
      *set(key: string, value: unknown) {
        ctx.set(key, value);
      },
    },
    ...(compaction ? { compaction } : {}),
  });

/**
 * The turn being answered, as clients read it: its messages, kept in the
 * object's state as they come (`live`), and its messages of agentlib once
 * the run saves them, in the agent's conversation, which agentlib loads for
 * the next turn (a {@link Conversation} of agentlib's).
 */
class Turn implements Conversation {
  private entries: Rendered[] = [];
  /** The index of each step's reply among {@link entries}, by step. */
  private readonly replies = new Map<number, number>();
  private step = 0;
  /** The conversation's version, once loaded (and after each append): see {@link unsaved}. */
  private version?: number;
  /** The conversation that summarizes, for the run (see {@link compact}): set once the agent's model is. */
  compactor?: LazyStateConversation;
  /** This turn's messages of agentlib that the run saved, so far. */
  private saved: Message[] = [];

  private readonly ctx: restate.ObjectContext;
  private readonly meta: Meta;
  readonly live: NonNullable<Meta['live']>;
  private readonly conversation: LazyStateConversation;

  private constructor(ctx: restate.ObjectContext, meta: Meta, live: NonNullable<Meta['live']>) {
    this.ctx = ctx;
    this.meta = meta;
    this.live = live;
    this.conversation = conversationOf(ctx);
  }

  /**
   * The turn of `ctx` starts, answering `prompt`: a turn before it that never
   * ended (its invocation was killed) ends first, unanswered.
   */
  static async start(ctx: restate.ObjectContext, prompt: string): Promise<Turn> {
    const meta = (await ctx.get<Meta>(META)) ?? emptyMeta();
    if (meta.live) await Turn.ended(ctx, meta, meta.live);
    const turn = new Turn(ctx, meta, { turn: ctx.request().id, prompt, from: meta.chats, n: 0 });
    meta.live = turn.live;
    turn.entries.push({ role: 'user', parts: [{ type: 'text', text: prompt }], prompt: true });
    turn.write(0);
    return turn;
  }

  /** The turn `live`, whose invocation is gone: its messages so far, and how it ended, {@link ENDED}. */
  private static async ended(ctx: restate.ObjectContext, meta: Meta, live: NonNullable<Meta['live']>) {
    const entries: Rendered[] = [];
    for (let i = 0; i < live.n; i++) {
      const entry = await ctx.get<Entry>(entryKey(live.from + i));
      if (entry) entries.push({ role: entry.role, parts: entry.parts, ...(entry.prompt ? { prompt: true } : {}) });
    }
    const turn = new Turn(ctx, meta, live);
    turn.entries = entries;
    await turn.close(ENDED);
  }

  /** Keep entry `i` (of the turn's), with the next cursor, and the turn's place in the conversation. */
  private write(i: number) {
    const entry: Entry = { ...this.entries[i]!, at: ++this.meta.cursor };
    this.ctx.set(entryKey(this.live.from + i), entry);
    this.live.n = Math.max(this.live.n, this.entries.length);
    this.ctx.set(META, this.meta);
  }

  /** Keep the turn's entries as `rendered`, each with a cursor of its own, in order, and forget any it had past them. */
  private rewrite(rendered: Rendered[]) {
    for (let i = rendered.length; i < this.live.n; i++) this.ctx.clear(entryKey(this.live.from + i));
    this.entries = rendered;
    this.live.n = rendered.length;
    for (let i = 0; i < rendered.length; i++) this.write(i);
  }

  /** What an event of the run changes of what clients read: whether it changed anything. */
  progress(event: ProgressEvent): boolean {
    switch (event.type) {
      case 'step':
        this.step = event.step;
        return false;
      case 'tool-start':
        this.part(event.callId, event.name, event.input);
        return true;
      case 'tool-end': {
        const [i, part] = this.part(event.callId, event.name, undefined);
        Object.assign(part, outputOf(event.result));
        this.write(i);
        return true;
      }
      case 'steering':
        this.entries.push({ role: 'user', parts: [{ type: 'text', text: event.message }] });
        this.write(this.entries.length - 1);
        return true;
      default:
        return false;
    }
  }

  /**
   * The tool part of call `callId`, and the index of the reply it is in:
   * wherever the call started (a background call ends steps later), or else
   * new, in its step's reply (made, if new).
   */
  private part(callId: string, name: string, input: JsonValue | undefined): [number, Extract<Part, { type: 'tool' }>] {
    const isCall = (p: Part): p is Extract<Part, { type: 'tool' }> => p.type === 'tool' && p.id === callId;
    for (const [at, entry] of this.entries.entries()) {
      const found = entry.role === 'assistant' ? entry.parts.find(isCall) : undefined;
      if (found) return [at, found];
    }
    let i = this.replies.get(this.step);
    if (i === undefined) {
      i = this.entries.push({ role: 'assistant', parts: [] }) - 1;
      this.replies.set(this.step, i);
    }
    const part: Extract<Part, { type: 'tool' }> = { type: 'tool', id: callId, name, input: input ?? null };
    this.entries[i]!.parts.push(part);
    this.write(i);
    return [i, part];
  }

  *load(): Operation<ConversationSnapshot> {
    const snapshot = yield* this.conversation.load();
    this.version = snapshot.version;
    return snapshot;
  }

  /** Summarize the earliest of the conversation, as the agent's `history` says, at the run's start. */
  *compact(): Operation<ConversationCompactionStatus> {
    return this.compactor ? yield* this.compactor.compact() : 'skipped';
  }

  /**
   * The run saves its turn: its messages go in the conversation, and the
   * turn's messages, as clients read them, are its saved messages from now
   * on (with their replies' text, and the answer), each changed.
   */
  *append(messages: readonly Message[], expectedVersion: number): Operation<number> {
    this.version = yield* this.conversation.append(messages, expectedVersion);
    this.saved.push(...messages);
    this.rewrite(render(this.saved));
    return this.version;
  }

  /** Add `messages` to the conversation, outside the run (a turn that ends without its save). */
  private async store(messages: Message[]) {
    const conversation = this.conversation;
    const known = this.version;
    this.version = await execute(
      this.ctx,
      (function* () {
        const version = known ?? (yield* conversation.load()).version;
        return yield* conversation.append(messages, version);
      })(),
    );
  }

  /**
   * The turn is answered with `answer`: the conversation goes on after its
   * messages. A run that saved none (it saves its turn as it ends) leaves
   * its message and the answer, for the model of the next turn.
   */
  async answered(answer: unknown) {
    if (this.saved.length === 0) await this.unsaved(typeof answer === 'string' ? answer : JSON.stringify(answer));
    this.finished();
  }

  /**
   * End the turn, which the run did not save, with `text` (an answer, or
   * how it ended): the model of the next turn sees its message, the messages
   * steered to it, and `text`, in the conversation (not its tool calls,
   * whose results may be missing); clients see its messages so far, and
   * `text`.
   */
  private async unsaved(text: string) {
    const steered = this.entries
      .slice(1)
      .filter((e) => e.role === 'user')
      .map((e): Message => ({
        role: 'user',
        content: steeringNote(e.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')),
      }));
    await this.store([{ role: 'user', content: this.live.prompt }, ...steered, { role: 'assistant', content: text }]);
    // A tool call the turn cut off says how it ended, as every agent's does (`Cancelled: …`, `Ended: …`).
    const closed = this.entries.map((entry) =>
      entry.role === 'assistant' && entry.parts.some((p) => p.type === 'tool' && p.output === undefined)
        ? {
            ...entry,
            parts: entry.parts.map((p): Part =>
              p.type === 'tool' && p.output === undefined ? { ...p, output: text, error: true } : p,
            ),
          }
        : entry,
    );
    this.rewrite([...closed, { role: 'assistant', parts: [{ type: 'text', text }], answer: true }]);
  }

  /** The turn ended: the conversation goes on after its messages. */
  private finished() {
    this.meta.chats = this.live.from + this.entries.length;
    delete this.meta.live;
    this.ctx.set(META, this.meta);
  }

  /** The turn ends without an answer of the model's: `note` says how (stopped, refused, failed...). */
  async close(note: string) {
    if (this.saved.length === 0) await this.unsaved(note);
    else this.rewrite([...this.entries, { role: 'assistant', parts: [{ type: 'text', text: note }], answer: true }]);
    this.finished();
  }
}

/**
 * The messages steered to the turn, as it learns of them at its publishes
 * (the companion's answer), handed to agentlib's run as its steering
 * (`controls.steering`): all those waiting, at once, as one update, at the
 * run's next event once it asks for more.
 */
class Steering {
  private next?: Channel<string | SteeringUpdate>;
  private waiting: Steer[] = [];
  private readonly handed = new Set<string>();

  /** agentlib's `controls.steering`: the next update, once there is one. */
  readonly source = (): Future<string | SteeringUpdate> => {
    this.next = channel<string | SteeringUpdate>();
    return this.next.receive;
  };

  /** What a publish answered: the messages steered to the turn that it has not taken yet. */
  saw(published: Published | undefined) {
    for (const steer of published?.steering ?? []) {
      if (!this.handed.has(steer.id) && !this.waiting.some((s) => s.id === steer.id)) this.waiting.push(steer);
    }
  }

  /** Hand the run the messages waiting, if it asks for more. */
  *hand(): Operation<void> {
    const next = this.next;
    if (!next || this.waiting.length === 0) return;
    const batch = this.waiting.splice(0);
    for (const { id } of batch) this.handed.add(id);
    this.next = undefined;
    yield* next.send({ message: batch.map((s) => s.text).join('\n\n'), data: { steer: batch.map((s) => s.id) } });
  }
}

/** The ids of the messages an event of `steering` took (see {@link Steering.hand}). */
const steerIds = (event: ProgressEvent): string[] => {
  if (event.type !== 'steering') return [];
  const ids = (event.data as { steer?: unknown } | undefined)?.steer;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
};

/** The answer of a run: its output, or else what it says of why it stopped. */
const answerOf = <O>(result: RunResult<O>): O | string =>
  result.status === 'completed'
    ? result.output
    : (result.output ?? `Stopped: ${'reason' in result ? result.reason : ''}`);

/** How a turn that failed for good ends, as its note says. */
const noteOf = (error: restate.TerminalError) =>
  error instanceof restate.CancelledError
    ? CANCELLED
    : error.code === REFUSED
      ? UNANSWERED
      : `Failed: ${error.message}`;

/** What the views read of the state, with a call of the agent's own handler `handler` (`messages`, `erase`). */
const own = <T>(ctx: restate.ObjectSharedContext | restate.ObjectContext, handler: string, parameter?: unknown) =>
  ctx.genericCall<unknown, T>({
    service: ctx.request().target.service,
    method: handler,
    key: ctx.key,
    parameter,
    inputSerde: restate.serde.json,
    outputSerde: restate.serde.json,
  });

/** How many messages a read of `messages` asks for at once. */
const BATCH = 25;

/** The entries of `ids`, read at once (each may be gone: `null`). */
const entriesAt = (ctx: restate.ObjectSharedContext, ids: number[]) =>
  restate.RestatePromise.all(
    ids.map((id) => ctx.get<Entry>(entryKey(id)) as unknown as restate.RestatePromise<Entry | null>),
  );

/** The ids from `from` down to `to` (included), newest first, a batch at a time. */
function* batches(from: number, to: number): Generator<number[]> {
  for (let id = from; id >= to; id -= BATCH) {
    yield Array.from({ length: Math.min(BATCH, id - to + 1) }, (_, i) => id - i);
  }
}

/** Entry `id` as clients read it. */
const shown = (id: number, { role, parts }: Entry): ChatMessage => ({ id, role, parts });

/** The conversation, a page at a time, or what changed since a cursor, as `messages` gives it. */
async function page(ctx: restate.ObjectSharedContext, request: MessagesRequest = {}): Promise<Messages> {
  const meta = (await ctx.get<Meta>(META)) ?? emptyMeta();
  const end = meta.chats + (meta.live?.n ?? 0);
  const first = meta.first ?? 0;
  const liveFrom = meta.live?.from ?? end;
  const limit = request.limit ?? 50;
  const kept = (e: Entry) => request.view !== 'summary' || e.prompt === true || e.answer === true;
  const cleared = meta.first === undefined ? {} : { first };
  if (request.cursor !== undefined) {
    // Each turn's messages take increasing cursors once it ends: older ones changed before them.
    const changed: [number, Entry][] = [];
    scan: for (const ids of batches(end - 1, first)) {
      const entries = await entriesAt(ctx, ids);
      for (const [i, id] of ids.entries()) {
        const entry = entries[i];
        if (!entry) continue;
        if (entry.at > request.cursor) changed.push([id, entry]);
        else if (id < liveFrom) break scan;
      }
    }
    const all = changed.toSorted(([, a], [, b]) => a.at - b.at).filter(([, e]) => kept(e));
    const pageOf = all.slice(0, limit);
    const more = all.length > limit;
    return {
      messages: pageOf.map(([id, e]) => shown(id, e)),
      more,
      cursor: more ? pageOf.at(-1)![1].at : meta.cursor,
      ...cleared,
    };
  }
  const messages: ChatMessage[] = [];
  // The oldest id read so far: older ones are left, if there are any.
  let oldest = Math.min(request.before ?? end, end);
  page: for (const ids of batches(oldest - 1, first)) {
    const entries = await entriesAt(ctx, ids);
    for (const [i, id] of ids.entries()) {
      if (messages.length >= limit) break page;
      oldest = id;
      const entry = entries[i];
      if (entry && kept(entry)) messages.push(shown(id, entry));
    }
  }
  return { messages: messages.toReversed(), more: oldest > first, cursor: meta.cursor, ...cleared };
}

/**
 * An agent of agentlib: a virtual object `name` of the classic Restate SDK,
 * one conversation per key, in its state. `chat` answers a message with
 * agentlib's run of the agent, journaled: a crash replays it, and asks the
 * model, or runs a tool, no second time. It has every agent's views, and its
 * companion, which `serve` serves beside it.
 *
 * A tool call that needs approval (agentlib's `needsApproval`) waits for the
 * signal `approval`, as {@link signal}'s tools do: `pending` lists it, and
 * `signal` approves it (`true`, `"approved"`, `{ "approved": true }`) or
 * denies it (anything else).
 */
export function agent<P extends string, O = string>({
  name,
  description,
  background = false,
  options: objectOptions,
  metadata,
  model,
  system,
  tools,
  history,
  ...options
}: Options<O> & Definition<P>) {
  // agentlib's terminal errors must be the SDK's own, which the turn tells from a retry: one copy of the SDK.
  if (Object.getPrototypeOf(GuardrailError) !== restate.TerminalError) {
    throw new Error(
      `${name}: @restatedev/agentlib runs on another copy of @restatedev/restate-sdk than @restatedev/sessions: ` +
        'install @restatedev/restate-sdk@1.18.2 (the version @restatedev/sessions pins) beside them, so that there is one',
    );
  }
  const loadModel = modelOf(name, model);
  // agentlib checks `history`'s bounds only as a turn compacts, with an error that is no terminal one: here.
  if (history) checkHistory(name, history);
  // Each tool by its name, Restate's made agentlib's: two of one name fail here.
  const named = tools === undefined ? undefined : toolsOf(name, tools);
  let made: Promise<{ lib: LibAgent<AgentlibContext, O>; summarizer: Model }> | undefined;
  const make = async () => {
    const loaded = refusing(await loadModel());
    // A summarizer of its own refuses as the agent's model does (424).
    const summarizer = history === false || history?.model === undefined ? loaded : refusing(history.model);
    return { lib: lib(loaded), summarizer };
  };
  const lib = (loaded: Model) =>
    agentlibAgent<AgentlibContext, O>({
      ...options,
      name,
      model: loaded,
      ...(system === undefined ? {} : { instructions: system }),
      ...(tools === undefined ? {} : { tools: named }),
      *onHumanApproval(request, { context }) {
        // A call may ask more than once: agentlib names each ask (`<agent>:approval:<call>:<n>`).
        const { call, question, signalName } = request;
        const asked = { tool: call.name, input: call.input, ...(question === undefined ? {} : { question }) };
        return approves(yield* waitFor(context.ctx, signalName, 'approval', asked));
      },
    });

  /** Answer `text`: a turn of the agent, from its start to its close at the companion. */
  async function answer(ctx: restate.ObjectContext, text: string): Promise<O | string> {
    const invocationId = ctx.request().id;
    const companion = companionAt(ctx);
    const steering = new Steering();
    const since = new Date(await ctx.date.now()).toISOString();
    steering.saw(
      await companion.start({ invocationId, since, steers: !background, ...(background ? {} : { publishes: true }) }),
    );
    const turn = await Turn.start(ctx, text);
    let agentlib: LibAgent<AgentlibContext, O>;
    try {
      const { lib: ready, summarizer } = await (made ??= make());
      agentlib = ready;
      if (history !== false) {
        const { model: _model, ...policy } = history ?? {};
        turn.compactor = conversationOf(ctx, { model: summarizer, policy });
      }
    } catch (error) {
      made = undefined;
      const unusable =
        error instanceof restate.TerminalError ? error : new ModelError(`${name}: its model: ${String(error)}`);
      await turn.close(UNANSWERED);
      await companion.close(invocationId);
      throw unusable;
    }
    let result: RunResult<O>;
    try {
      result = await execute(
        ctx,
        agentlib.run(text, {
          name,
          context: { ctx },
          conversation: turn,
          ...(background ? {} : { controls: { steering: steering.source } }),
          *onProgress(event) {
            const taken = steerIds(event);
            if (taken.length > 0) {
              ctx.set(TAKEN, [...((yield* read<string[]>(ctx, TAKEN)) ?? []), ...taken]);
              ctx.objectSendClient(companionFor(name), ctx.key).taken(taken);
            }
            if (!turn.progress(event) || background) return;
            steering.saw(yield* adopt(companion.publish()));
            yield* steering.hand();
          },
        }),
      );
    } catch (error) {
      // Any other error fails the attempt: Restate retries it, and replays the run.
      if (!(error instanceof restate.TerminalError)) throw error;
      await turn.close(noteOf(error));
      await companion.close(invocationId);
      throw error;
    }
    // Cancelled once answered: the answer stands, and the turn closes all the same.
    const answered = answerOf(result);
    await standing(() => turn.answered(answered));
    await standing(() => companion.close(invocationId));
    return answered;
  }

  const object = restate.object({
    name,
    description,
    metadata,
    handlers: {
      /** Answer a message, as plain text or a JSON string. */
      chat: restate.handlers.object.exclusive(
        { input: messageSerde, accept: '*/*' },
        async (ctx: restate.ObjectContext, text: string) => answer(ctx, text),
      ),

      /** @internal A message steered to a turn (`steer`): a turn of its own, unless the turn took it. */
      steered: restate.handlers.object.exclusive(
        { ingressPrivate: true },
        async (ctx: restate.ObjectContext, { id, text }: Steer) => {
          const taken = (await ctx.get<string[]>(TAKEN)) ?? [];
          if (taken.includes(id)) {
            const left = taken.filter((t) => t !== id);
            if (left.length > 0) ctx.set(TAKEN, left);
            else ctx.clear(TAKEN);
            return;
          }
          await answer(ctx, text);
        },
      ),

      /** @internal `clear`'s work, once the messages before it are answered: forget the conversation, its ids going on. */
      erase: restate.handlers.object.exclusive({ ingressPrivate: true }, async (ctx: restate.ObjectContext) => {
        const meta = (await ctx.get<Meta>(META)) ?? emptyMeta();
        const next = meta.chats + (meta.live?.n ?? 0);
        ctx.clearAll();
        ctx.set(META, { chats: next, cursor: meta.cursor + 1, first: next } satisfies Meta);
        await companionAt(ctx).reset();
      }),

      /** The conversation, a page at a time, or what is new or changed since a cursor. */
      messages: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext, request?: MessagesRequest) =>
        page(ctx, request ?? {}),
      ),

      /** What the agent is doing: the message it answers, its waits, and the messages steered to it. */
      status: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext): Promise<Status> =>
        companionAt(ctx).status(),
      ),

      /** The waits of its tools. */
      pending: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext): Promise<Waiting[]> =>
        companionAt(ctx).pending(),
      ),

      /** Resolve the wait of an id, or else the oldest for a name. */
      signal: restate.handlers.object.shared(
        async (ctx: restate.ObjectSharedContext, wanted: Signal): Promise<Resolved> => companionAt(ctx).resolve(wanted),
      ),

      /** Cancel the invocation of the message being answered. */
      stop: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext): Promise<Stopped> => stopped(ctx)),

      /** Stop the message being answered, then forget the conversation. */
      clear: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext): Promise<Stopped> => {
        const stop = await stopped(ctx);
        await own(ctx, 'erase');
        return stop;
      }),

      /** Send a message while a turn is answered: the turn takes it at its next step, or it is a turn of its own. */
      steer: restate.handlers.object.shared(
        { input: messageSerde, accept: '*/*' },
        async (ctx: restate.ObjectSharedContext, text: string): Promise<Steered> =>
          companionAt(ctx).steer({ id: ctx.request().id, text }),
      ),

      /** The revision of the conversation. */
      notifications: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext): Promise<Notifications> =>
        companionAt(ctx).notifications(),
      ),

      /** The revision, once there is one newer than `revision`, or at the timeout. */
      watch: restate.handlers.object.shared(
        async (ctx: restate.ObjectSharedContext, watch: Watch): Promise<Notifications> => companionAt(ctx).watch(watch),
      ),

      /** The conversation since a cursor, the status and the revision; with `revision`, once there is a newer one. */
      sync: restate.handlers.object.shared(
        async (ctx: restate.ObjectSharedContext, wanted?: SyncRequest | null): Promise<Synced> => {
          const { cursor = 0, revision, timeoutSeconds = 50, limit = 100, view } = wanted ?? {};
          if (revision !== undefined) await companionAt(ctx).watch({ revision, timeoutSeconds });
          // The revision first, then the rest: a change after it shows in the next sync.
          const now = await companionAt(ctx).notifications();
          const status = await companionAt(ctx).status();
          const request: MessagesRequest = { cursor, limit, ...(view ? { view } : {}) };
          const messages = await own<Messages>(ctx, 'messages', request);
          return { revision: now.revision, status, ...messages };
        },
      ),
    },
    options: { ...OPTIONS, ...objectOptions },
  });
  return withCompanion(object);
}

/**
 * Do `step` of a turn that is answered: a cancellation that comes meanwhile
 * (once, as Restate delivers it) does it again, rather than leave the turn
 * unclosed.
 */
async function standing(step: () => Promise<void>) {
  try {
    await step();
  } catch (error) {
    if (!(error instanceof restate.CancelledError)) throw error;
    await step();
  }
}

/** Cancel the invocation of the message being answered, if any, and say which. */
async function stopped(ctx: restate.ObjectSharedContext): Promise<Stopped> {
  const turn = (await companionAt(ctx).status()).answering;
  if (turn) ctx.cancel(restate.InvocationIdParser.fromString(turn.invocationId));
  return { stopped: turn?.invocationId ?? null };
}
