// The agentlib agent's key/value state, and how its handlers reach that state,
// the agent's companion, and the agent itself.
import { internal, type Future, type Operation } from '@restatedev/restate-sdk-gen';
import { sdk as restate } from '@restatedev/sessions/internal';
import { companionFor } from '../companion.ts';

const { adopt } = internal;

type Context = restate.ObjectContext | restate.ObjectSharedContext;

/** The turn being answered: its invocation, its message, and where its messages are. */
export interface LiveTurn {
  /** The invocation id of the turn. */
  turn: string;
  /** The user's message that started it. */
  prompt: string;
  /** The id of the turn's first message. */
  from: number;
  /** How many messages the turn has so far. */
  n: number;
}

/** The bookkeeping of the messages that clients read, kept under {@link META}. */
export interface Meta {
  /** How many messages the answered turns have: the id the next turn starts at. */
  chats: number;
  /** The cursor of the latest change. Every message written takes the next one. */
  cursor: number;
  /** The id of the first message, once the conversation was cleared. */
  first?: number;
  /** The turn being answered, if any. */
  live?: LiveTurn;
}

export const META = 'meta';

/** The ids of steered messages that a turn took, so that their own `steered` turn does nothing. */
export const TAKEN = 'taken';

/** The model's conversation (agentlib's `LazyStateConversation`): chunks `t/<n>`, and `t/meta`. */
export const CONVERSATION = 't';
export const CONVERSATION_META = `${CONVERSATION}/meta`;

/** The key of the message `id`, as clients read it. */
export const entryKey = (id: number) => `c/${id}`;

export const emptyMeta = (): Meta => ({ chats: 0, cursor: 0 });

/** Reads state `key` inside an operation of the generator SDK. */
export function read<T>(ctx: restate.ObjectContext, key: string): Future<T | null> {
  // At runtime, `get` returns a RestatePromise, although its type says Promise.
  const value = ctx.get<T>(key) as unknown as restate.RestatePromise<T | null>;
  return adopt(value);
}

/** The agent's companion (`<agent>.prebuilt.restate`), at the agent's key. */
export function companionAt(ctx: Context) {
  const agent = ctx.request().target.service;
  return ctx.objectClient(companionFor(agent), ctx.key);
}

/** The agent's companion, for one-way sends. */
export function companionSendAt(ctx: restate.ObjectContext) {
  const agent = ctx.request().target.service;
  return ctx.objectSendClient(companionFor(agent), ctx.key);
}

/** Calls one of the agent's own handlers, at its own key, with JSON in and out. */
export function callOwn<T>(ctx: Context, handler: string, input?: unknown) {
  return ctx.genericCall<unknown, T>({
    service: ctx.request().target.service,
    method: handler,
    key: ctx.key,
    parameter: input,
    inputSerde: restate.serde.json,
    outputSerde: restate.serde.json,
  });
}

/**
 * Waits for the signal `name` and returns its value. The wait's id is
 * `<invocation id>:<id>`; `pending` lists it with `input`, and `signal`
 * resolves it.
 */
export function* waitForSignal(
  ctx: restate.ObjectContext,
  id: string,
  name: string,
  input?: unknown,
): Operation<unknown> {
  const wait = { id: `${ctx.request().id}:${id}`, name, input };
  return yield* adopt(companionAt(ctx).wait(wait));
}
