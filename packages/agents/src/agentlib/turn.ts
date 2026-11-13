// A turn of the agentlib agent: its messages as clients read them, written as
// the run goes, and the model's conversation, which the run loads and saves.
import {
  LazyStateConversation,
  type CompactionPolicy,
  type Conversation,
  type ConversationCompactionStatus,
  type ConversationSnapshot,
  type JsonValue,
  type Message,
  type Model,
  type ProgressEvent,
} from '@restatedev/agentlib';
import { execute, type Operation } from '@restatedev/restate-sdk-gen';
import type { sdk as restate } from '@restatedev/sessions/internal';
import { ENDED, type Part } from '../common.ts';
import { type Entry, outputOf, render, type Rendered, steeringNote } from './messages.ts';
import {
  CONVERSATION,
  CONVERSATION_META,
  emptyMeta,
  entryKey,
  type LiveTurn,
  META,
  type Meta,
  read,
} from './state.ts';

type ToolPart = Extract<Part, { type: 'tool' }>;

/** How the model's conversation is summarized at a turn's start (see the agent's `history`). */
export interface Compaction {
  model: Model;
  policy?: CompactionPolicy;
}

/**
 * The model's conversation, in the state of the object of `ctx`: agentlib's
 * `LazyStateConversation` over that state, its reads journaled. With
 * `compaction`, it summarizes its earliest messages when they grow too many.
 */
export function conversationOf(
  ctx: restate.ObjectContext,
  compaction?: Compaction,
): LazyStateConversation {
  const store = {
    *get<T>(key: string) {
      const value = yield* read<T>(ctx, key);
      return value ?? undefined;
    },
    // A state write takes effect at once (and is journaled): nothing to wait for.
    // oxlint-disable-next-line require-yield
    *set(key: string, value: unknown) {
      ctx.set(key, value);
    },
  };
  return new LazyStateConversation({
    stateKey: CONVERSATION,
    metaKey: CONVERSATION_META,
    store,
    ...(compaction && { compaction }),
  });
}

/** The text of a rendered message's text parts. */
function textOf(entry: Rendered): string {
  const texts = entry.parts.map((part) => (part.type === 'text' ? part.text : ''));
  return texts.join('');
}

/**
 * A turn being answered. It keeps the turn's messages as clients read them
 * (one state key each), and is the run's `Conversation`: agentlib loads the
 * model's conversation through it, and saves the turn through it when the
 * run ends. Its messages are then rewritten from what the run saved, under
 * the same ids.
 */
export class Turn implements Conversation {
  readonly live: LiveTurn;
  /** Summarizes the model's conversation at the run's start, if the agent's `history` says to. */
  compactor?: LazyStateConversation;

  private readonly ctx: restate.ObjectContext;
  private readonly meta: Meta;
  private readonly conversation: LazyStateConversation;
  /** The turn's messages, as clients read them. Message `i` has id `live.from + i`. */
  private entries: Rendered[] = [];
  /** The index in {@link entries} of each step's reply, by step. */
  private readonly replies = new Map<number, number>();
  private step = 0;
  /** The conversation's version, once loaded or appended to. */
  private version?: number;
  /** The turn's messages of agentlib, once the run saved them. */
  private saved: Message[] = [];

  private constructor(ctx: restate.ObjectContext, meta: Meta, live: LiveTurn) {
    this.ctx = ctx;
    this.meta = meta;
    this.live = live;
    this.conversation = conversationOf(ctx);
  }

  /**
   * Starts the turn that answers `prompt`. A turn before it that never ended
   * (its invocation was killed) ends first.
   */
  static async start(ctx: restate.ObjectContext, prompt: string): Promise<Turn> {
    const meta = (await ctx.get<Meta>(META)) ?? emptyMeta();
    if (meta.live) await Turn.endKilled(ctx, meta, meta.live);

    const turn = new Turn(ctx, meta, { turn: ctx.request().id, prompt, from: meta.chats, n: 0 });
    meta.live = turn.live;
    turn.entries.push({ role: 'user', parts: [{ type: 'text', text: prompt }], prompt: true });
    turn.write(0);
    return turn;
  }

  /** Ends the turn `live`, whose invocation was killed, with the note {@link ENDED}. */
  private static async endKilled(ctx: restate.ObjectContext, meta: Meta, live: LiveTurn) {
    const turn = new Turn(ctx, meta, live);
    for (let i = 0; i < live.n; i++) {
      const entry = await ctx.get<Entry>(entryKey(live.from + i));
      if (!entry) continue;
      const rendered: Rendered = { role: entry.role, parts: entry.parts };
      if (entry.prompt) rendered.prompt = true;
      turn.entries.push(rendered);
    }
    await turn.close(ENDED);
  }

  // The run's progress, as clients see it.

  /** Records what a progress event of the run changes. Returns whether clients see a change. */
  progress(event: ProgressEvent): boolean {
    switch (event.type) {
      case 'step':
        this.step = event.step;
        return false;
      case 'tool-start':
        this.toolPart(event.callId, event.name, event.input);
        return true;
      case 'tool-end': {
        const [index, part] = this.toolPart(event.callId, event.name);
        Object.assign(part, outputOf(event.result));
        this.write(index);
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
   * Returns the tool part of call `callId` and the index of its reply. A call
   * that started earlier (a background call can end steps later) is found
   * where it is; a new one is added to the current step's reply.
   */
  private toolPart(callId: string, name: string, input?: JsonValue): [number, ToolPart] {
    for (const [index, entry] of this.entries.entries()) {
      if (entry.role !== 'assistant') continue;
      const part = entry.parts.find((p): p is ToolPart => p.type === 'tool' && p.id === callId);
      if (part) return [index, part];
    }

    let index = this.replies.get(this.step);
    if (index === undefined) {
      index = this.entries.push({ role: 'assistant', parts: [] }) - 1;
      this.replies.set(this.step, index);
    }
    const part: ToolPart = { type: 'tool', id: callId, name, input: input ?? null };
    this.entries[index]!.parts.push(part);
    this.write(index);
    return [index, part];
  }

  // agentlib's Conversation: what the run loads, compacts and saves.

  *load(): Operation<ConversationSnapshot> {
    const snapshot = yield* this.conversation.load();
    this.version = snapshot.version;
    return snapshot;
  }

  *compact(): Operation<ConversationCompactionStatus> {
    if (!this.compactor) return 'skipped';
    return yield* this.compactor.compact();
  }

  /**
   * Saves the turn's messages. Clients then read the turn as it was saved,
   * with its replies' texts.
   */
  *append(messages: readonly Message[], expectedVersion: number): Operation<number> {
    this.version = yield* this.conversation.append(messages, expectedVersion);
    this.saved.push(...messages);
    this.rewrite(render(this.saved));
    return this.version;
  }

  // How the turn ends.

  /** Ends the turn with its answer. A run that saved nothing leaves the prompt and the answer. */
  async answered(answer: unknown) {
    if (this.saved.length === 0) {
      const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
      await this.endUnsaved(text);
    }
    this.finish();
  }

  /** Ends the turn without an answer: `note` says how (stopped, refused, failed, killed). */
  async close(note: string) {
    if (this.saved.length === 0) {
      await this.endUnsaved(note);
    } else {
      this.rewrite([...this.entries, answerEntry(note)]);
    }
    this.finish();
  }

  /**
   * Ends a turn that the run did not save, with `text`. The model's
   * conversation gets the prompt, the messages steered to the turn, and
   * `text`, but not the turn's tool calls, whose results may be missing.
   * Clients see each open tool call closed with `text`.
   */
  private async endUnsaved(text: string) {
    const steered = this.entries.slice(1).filter((entry) => entry.role === 'user');
    const messages: Message[] = [
      { role: 'user', content: this.live.prompt },
      ...steered.map((entry): Message => ({ role: 'user', content: steeringNote(textOf(entry)) })),
      { role: 'assistant', content: text },
    ];
    await this.appendOutsideRun(messages);

    const closed = this.entries.map((entry) => closeOpenCalls(entry, text));
    this.rewrite([...closed, answerEntry(text)]);
  }

  /** Appends `messages` to the model's conversation outside the run, in an operation of its own. */
  private async appendOutsideRun(messages: Message[]) {
    const conversation = this.conversation;
    const known = this.version;
    function* append(): Operation<number> {
      const version = known ?? (yield* conversation.load()).version;
      return yield* conversation.append(messages, version);
    }
    this.version = await execute(this.ctx, append());
  }

  /** Marks the turn ended: the next turn's messages start after its own. */
  private finish() {
    this.meta.chats = this.live.from + this.entries.length;
    delete this.meta.live;
    this.ctx.set(META, this.meta);
  }

  // Storing the turn's messages.

  /** Stores message `i` of the turn with the next cursor, and the turn's bookkeeping. */
  private write(i: number) {
    this.meta.cursor += 1;
    const entry: Entry = { ...this.entries[i]!, at: this.meta.cursor };
    this.ctx.set(entryKey(this.live.from + i), entry);
    this.live.n = Math.max(this.live.n, this.entries.length);
    this.ctx.set(META, this.meta);
  }

  /** Replaces the turn's messages with `entries`, each with a new cursor, in order. */
  private rewrite(entries: Rendered[]) {
    for (let i = entries.length; i < this.live.n; i++) {
      this.ctx.clear(entryKey(this.live.from + i));
    }
    this.entries = entries;
    this.live.n = entries.length;
    for (let i = 0; i < entries.length; i++) this.write(i);
  }
}

/** A reply that answers a turn with `text`. */
function answerEntry(text: string): Rendered {
  return { role: 'assistant', parts: [{ type: 'text', text }], answer: true };
}

/** Whether `part` is a tool call without an output yet. */
function isOpenCall(part: Part): part is ToolPart {
  return part.type === 'tool' && part.output === undefined;
}

/** Gives each tool call of `entry` that has no output yet `text` as its output, as an error. */
function closeOpenCalls(entry: Rendered, text: string): Rendered {
  if (entry.role !== 'assistant' || !entry.parts.some(isOpenCall)) return entry;
  const parts = entry.parts.map((part): Part => {
    if (!isOpenCall(part)) return part;
    return { ...part, output: text, error: true };
  });
  return { ...entry, parts };
}
