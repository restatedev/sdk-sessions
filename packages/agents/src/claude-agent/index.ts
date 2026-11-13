// Claude Code agents in Restate virtual objects: the Claude Agent SDK
// (@anthropic-ai/claude-agent-sdk), which runs Claude Code as a process of its
// own, for each attempt, with its transcript in the object's database.
//
//   const coder = claudeAgent.agent({ name: 'coder', workspace: (ctx) => `/work/${ctx.key}` });
//
// or a handler of an object of your own: `handlers: { chat: claudeAgent.chat() }`,
// with options for each invocation: `claudeAgent.chat(async (ctx) => ({ workspace }))`.
//
// Not the `claude` integration (../claude): that one is the Anthropic SDK's
// tool runner, in the handler's process, with the tools you give it; this
// one is Claude Code, a process of its own, with its own loop, its tools
// (read, write, edit, bash...) and its own history.
//
// Claude Code keeps the model's history in its transcript, a JSONL file it
// resumes from. Its `sessionStore` (the SDK's) mirrors each line of it to us
// as it is written, and loads it back before a resumed process starts, in a
// fresh config directory: here every line is a row of `ctx.db`
// (`restate_agents_claude_agent_entries`), and the same transaction copies
// what is new of the turn (the model's replies, the tools' results, a message
// steered to the turn) into the conversation of turns (../conversation.ts):
// what clients read, and how turns end. One store, no second database.
//
// A tool runs only once its call is stored: Claude Code starts a tool before
// the mirror has its call, so a `PreToolUse` hook, which Claude Code awaits
// before every tool, waits until the call is committed in `ctx.db`.
//
// A message is answered once per invocation (`answerOnce`). A retried attempt:
// - of a turn whose final reply is stored, answers with it, and starts nothing;
// - of a prompt that never reached the transcript, submits it;
// - of a turn that did, resumes it: each call it cut off gets a result first,
//   stored in the transcript and the turn (a tool of ours is run again under
//   the same call id, so its Restate calls are made once; a tool of Claude
//   Code's own gets Claude Code's "interrupted" note), and Claude Code goes on
//   with the turn without a new prompt (`CLAUDE_CODE_RESUME_INTERRUPTED_TURN`,
//   which Anthropic's own runner sets on a restart).
//
// A turn another invocation left (killed) is closed in the conversation only;
// the next prompt resumes the transcript, whose open calls Claude Code closes
// itself, and tells the model how the turn before ended. `stop` interrupts
// Claude Code (no model request), and closes the turn cancelled. An attempt
// that ends kills its process at once: one that closed only its input would
// finish the turn alone.
import * as restate from '@restatedev/sessions';
import type { DatabaseReader } from '@restatedev/sessions';
import { Schema } from '@restatedev/sessions/internal';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSdkMcpServer,
  query,
  tool as mcpTool,
  type CanUseTool,
  type EffortLevel,
  type HookCallback,
  type Options as SdkOptions,
  type Query,
  type SandboxSettings,
  type SDKResultMessage,
  type SDKUserMessage,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
  type SpawnedProcess,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
import type { z } from 'zod';
import {
  AttemptEnded,
  chatHandler,
  CHECK_MODEL,
  type Check,
  type Configure,
  configured,
  inboxOf,
  publish,
  REFUSED,
  RETURNED_UNRECORDED,
  stopSignalOf,
  toolCallStarted,
} from '../common.ts';
import {
  answerOnce,
  type Call,
  type Conversation,
  type Items,
  type Parsed,
  STEPS,
  type Turn,
} from '../conversation.ts';
import { conversationView } from '../messages.ts';
import { tookSteers } from '../steering.ts';
import { type Definition, sessionObject } from '../object.ts';
import { type Answer, withChecked } from '../output.ts';
import { type Tool as AnyTool, waitFor } from '../tools.ts';
import { spawnTied } from './process.ts';

// The items: Claude Code's transcript, as the conversation keeps it.

/** A tool call's result, as an item holds it. */
interface ItemResult {
  id: string;
  name: string;
  output: string;
  error?: boolean;
}

/**
 * An item of the conversation: a message of the user (one steered to the
 * turn), a reply of the model (one message of the API: its text, and its
 * tool calls), or tool calls' results. One copied from the transcript has
 * `from`: the API message's id, or the result's tool call id, by which it is
 * copied once.
 */
export type Item =
  | { type: 'user'; text: string; from?: string }
  | { type: 'assistant'; text: string; calls?: Call[]; from?: string }
  | { type: 'results'; results: ItemResult[]; from?: string };

const KINDS = new Set(['user', 'assistant', 'results']);

/** The current attempt's work on a turn, by turn: what closes it here, before the conversation does. */
const live = new WeakMap<object, (status: string) => Promise<void>>();

/** Claude Code's items: a reply says its text, with its tool calls; results are results. */
export const items: Items<Item> = {
  dump: (item) => JSON.stringify(item),
  load: (stored) => {
    const item = JSON.parse(stored) as Item;
    if (typeof item !== 'object' || item === null || !KINDS.has(item.type)) {
      throw new Error('not a Claude Code item (a user, assistant or results item)');
    }
    return item;
  },
  prompt: (text) => ({ type: 'user', text }),
  reply: (text) => ({ type: 'assistant', text }),
  results: (results) =>
    [
      {
        type: 'results',
        results: results.map(([call, output]) => ({
          id: call.id,
          name: call.name,
          output,
          ...(output === RETURNED_UNRECORDED ? {} : { error: true }),
        })),
      },
    ] satisfies Item[],
  read: (item): Parsed => {
    if (item.type === 'user') return { said: ['user', item.text] };
    if (item.type === 'assistant') return { said: ['assistant', item.text], calls: item.calls ?? [] };
    return { results: item.results.map(({ id, output, error }) => ({ id, output, error })) };
  },
  // A turn this attempt runs stops Claude Code first (a stop interrupts it); one another invocation left is the
  // conversation's alone: its transcript's open calls are Claude Code's to close, at the next prompt.
  settleOwn: async (_ctx, turn, status) => {
    await live.get(turn)?.(status);
  },
};

// The transcript in `ctx.db`.

/** The table of the conversation's Claude Code session: its id. One row. */
const SESSION = 'restate_agents_claude_agent';

/** The table of the transcript's lines, as Claude Code mirrors them: by subpath (a subagent's), in order. */
export const ENTRIES = 'restate_agents_claude_agent_entries';

/** The tables of the integration, in `ctx.db`. */
const TABLES = new Schema('restate_agents.claude_agent', [
  `CREATE TABLE ${SESSION} (row INTEGER PRIMARY KEY CHECK (row = 0), session TEXT NOT NULL)`,
  `CREATE TABLE ${ENTRIES} (seq INTEGER PRIMARY KEY, subpath TEXT NOT NULL, uuid TEXT, entry TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX ${ENTRIES}_uuid ON ${ENTRIES} (subpath, uuid)`,
]);

/** A UUID of `text`, the same every time: Claude Code takes UUIDs as ids. */
export const uuidOf = (text: string) => {
  const h = createHash('sha256').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** A line of the transcript, as far as the integration reads it. */
interface Line extends SessionStoreEntry {
  parentUuid?: string | null;
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: string | Block[];
    stop_reason?: string | null;
  };
  attachment?: { type?: string; prompt?: string; source_uuid?: string };
}

/** A content block of a transcript's message. */
interface Block {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | { type: string; text?: string }[];
  is_error?: boolean;
}

/** The blocks of `line`'s message. */
const blocksOf = (line: Line): Block[] => (Array.isArray(line.message?.content) ? line.message.content : []);

/** The text of a tool result's content. */
const textOf = (content: Block['content']) =>
  typeof content === 'string'
    ? content
    : (content ?? []).flatMap((c) => (c.type === 'text' && c.text !== undefined ? [c.text] : [])).join('');

/** Where an MCP tool call says its tool call id (`claudecode/toolUseId`). */
const META = '_meta';

/** The MCP server our tools are served by: the model sees `mcp__restate__<name>`. */
const SERVER = 'restate';
const PREFIX = `mcp__${SERVER}__`;

/** A tool's name as the conversation shows it: ours without the server's prefix. */
const shown = (name: string) => (name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name);

/**
 * What Claude Code gives a tool call that a session's end cut off, when it
 * resumes the session: a call of a tool of its own that the turn resumed
 * here cut off gets it too.
 */
export const INTERRUPTED =
  "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. Check whether it took effect before relying on it or running it again.]";

/** The lines of the transcript at `subpath`, in order. */
async function linesOf(db: DatabaseReader, subpath = ''): Promise<Line[]> {
  const rows = await db.values(`SELECT entry FROM ${ENTRIES} WHERE subpath = ? ORDER BY seq`, [subpath]);
  return rows.map(([entry]) => JSON.parse(String(entry)) as Line);
}

/** The conversation's Claude Code session id, if it has one. */
async function sessionOf(db: DatabaseReader): Promise<string | undefined> {
  const row = await db.get<{ session: string }>(`SELECT session FROM ${SESSION} WHERE row = 0`);
  return row?.session;
}

/**
 * The calls of the turn whose prompt is the line `ask` that have no result in
 * `lines` (main chain only): a crash cut them off.
 */
function cutOff(lines: Line[], ask: string): { calls: Block[]; last?: Line; lastReply?: Line } {
  const from = lines.findIndex((l) => l.uuid === ask);
  if (from < 0) return { calls: [] };
  const turn = lines.slice(from).filter((l) => !l.isSidechain);
  const answered = new Set(
    turn
      .filter((l) => l.type === 'user')
      .flatMap((l) => blocksOf(l).flatMap((b) => (b.tool_use_id ? [b.tool_use_id] : []))),
  );
  const calls = turn
    .filter((l) => l.type === 'assistant' && !l.isApiErrorMessage)
    .flatMap((l) => blocksOf(l).filter((b) => b.type === 'tool_use' && b.id !== undefined && !answered.has(b.id)));
  const chain = turn.filter((l) => l.uuid !== undefined && 'parentUuid' in l);
  return { calls, last: chain.at(-1), lastReply: turn.findLast((l) => l.type === 'assistant') };
}

/**
 * What of `lines`, new in the transcript, is the turn's: each reply of the
 * model once (by its API message's id), the tools' results whose calls the
 * turn has (not those Claude Code wrote for another turn's), and each message
 * steered to the turn (by the uuid it was given, `steers`). Not the prompt,
 * nor Claude Code's own notes, errors, attachments and metadata, nor a
 * subagent's lines.
 */
function newItems(
  lines: Line[],
  turn: Turn<Item>,
  steers: ReadonlyMap<string, string>,
): { item: Item; reply?: boolean; steer?: string }[] {
  const have = new Set(turn.items.flatMap((e) => (e.item.from ? [e.item.from] : [])));
  const named = new Map(
    turn.items.flatMap((e) => (e.item.type === 'assistant' ? (e.item.calls ?? []).map((c) => [c.id, c.name]) : [])),
  );
  const held = new Set(turn.steered().map((e) => e.steer));
  const copied: { item: Item; reply?: boolean; steer?: string }[] = [];
  // The replies, by their API message: Claude Code writes a line per content block.
  const replies = new Map<string, { text: string[]; calls: Call[]; stop?: string | null }>();
  const order: (string | Item | { steer: string; text: string; from: string })[] = [];
  for (const line of lines) {
    if (line.isSidechain) continue;
    const message = line.message;
    if (line.type === 'assistant' && message?.id && !line.isApiErrorMessage && message.model !== '<synthetic>') {
      let reply = replies.get(message.id);
      if (!reply) {
        reply = { text: [], calls: [] };
        replies.set(message.id, reply);
        order.push(message.id);
      }
      for (const block of blocksOf(line)) {
        if (block.type === 'text' && block.text) reply.text.push(block.text);
        if (block.type === 'tool_use' && block.id) {
          reply.calls.push({ id: block.id, name: shown(block.name ?? ''), input: block.input ?? {} });
          named.set(block.id, shown(block.name ?? ''));
        }
      }
      reply.stop = message.stop_reason ?? reply.stop;
    } else if (line.type === 'user') {
      for (const block of blocksOf(line)) {
        if (block.type !== 'tool_result' || !block.tool_use_id) continue;
        const name = named.get(block.tool_use_id);
        if (name === undefined || have.has(`result:${block.tool_use_id}`) || turn.hasResult(block.tool_use_id))
          continue;
        const result: ItemResult = {
          id: block.tool_use_id,
          name,
          output: textOf(block.content),
          ...(block.is_error ? { error: true } : {}),
        };
        order.push({ type: 'results', results: [result], from: `result:${block.tool_use_id}` });
        have.add(`result:${block.tool_use_id}`);
      }
    } else if (line.type === 'attachment' && line.attachment?.type === 'queued_command') {
      const steer = steers.get(line.attachment.source_uuid ?? '');
      if (steer !== undefined && !held.has(steer) && line.uuid) {
        order.push({ steer, text: line.attachment.prompt ?? '', from: line.uuid });
        held.add(steer);
      }
    }
  }
  for (const entry of order) {
    if (typeof entry === 'string') {
      const reply = replies.get(entry)!;
      if (have.has(entry)) continue;
      const text = reply.text.join('');
      // A reply that ends the turn is one of its text; one cut off, refused or failed is none.
      if (reply.calls.length === 0 && (reply.stop !== 'end_turn' || !text.trim())) continue;
      copied.push({ item: { type: 'assistant', text, calls: reply.calls, from: entry }, reply: true });
      have.add(entry);
    } else if ('steer' in entry) {
      copied.push({ item: { type: 'user', text: entry.text, from: entry.from }, steer: entry.steer });
    } else {
      copied.push({ item: entry });
    }
  }
  return copied;
}

// The options.

/** How Claude Code asks the model again after a request failed for a reason that passes (an outage, a rate limit). */
export interface RetryPolicy {
  /** Whether it asks again at all. */
  enabled: boolean;
  /** How often it asks again, at most (Claude Code's `CLAUDE_CODE_MAX_RETRIES`: 10 by default, 15 at most). */
  maxRetries: number;
}

/** An agent's options: `chat`, `prompt` and `withClaudeAgent` take them. */
export interface Options<O extends z.ZodObject | undefined = z.ZodObject | undefined> {
  /** The Claude model: `model`, else MODEL, else Claude Code's default. `anthropic/` before it is left out. */
  model?: string;
  /** The system prompt: who the agent is, and how it answers (with a workspace, added to Claude Code's own). */
  system?: string;
  /** The agent's tools: `tool()`s and Restate's (`call`, `signal`...), served to Claude Code from this process. */
  tools?: AnyTool[];
  /**
   * A directory of the local machine, made if missing: Claude Code works in
   * it, with its own tools (Read, Write, Edit, Bash, Glob, Grep), besides
   * `tools`. Or a function of the invocation's context that gives one.
   * Without one, the agent has only `tools`.
   */
  workspace?: string | ((ctx: restate.SessionContext) => string | Promise<string>);
  /**
   * With a workspace, Claude Code's own tools run without asking, but what
   * its permission rules ask about (a path outside the workspace, say) is
   * denied, as nobody is present to answer. With `approval`, every call of
   * Claude Code's own tools waits for the signal {@link APPROVAL} to the
   * agent instead (`true`, or a text such as "approved", allows it).
   */
  approval?: boolean;
  /** How Claude Code asks the model again after an outage: see {@link RetryPolicy}. */
  retry?: Partial<RetryPolicy>;
  /** How much effort the model puts into each reply. */
  effort?: EffortLevel;
  /** The most model requests of a turn: past them, the turn fails. */
  maxTurns?: number;
  /** Claude Code's sandbox for its shell (see the SDK's `sandbox`). */
  sandbox?: SandboxSettings;
  /** Environment variables for Claude Code, over the process's own. */
  env?: Record<string, string>;
  /**
   * The answer as data: a zod object, whose JSON the agent replies with
   * (checked), and `chat` and `prompt` answer with (see output.ts).
   */
  output?: O;
}

/** The signal that a call of Claude Code's own tools waits for, with `approval`. */
export const APPROVAL = 'approval';

/** The texts that approve, whatever their case. */
const APPROVED: ReadonlySet<string> = new Set(['approved', 'approve', 'yes', 'ok', 'allow', 'allowed']);

/** What the value of an {@link APPROVAL} signal decides (as OpenCode's). */
function decided(value: unknown): { allowed: true } | { allowed: false; reason?: string } {
  if (value === true) return { allowed: true };
  if (typeof value === 'string') {
    const text = value.trim();
    return APPROVED.has(text.toLowerCase()) ? { allowed: true } : { allowed: false, ...(text ? { reason: text } : {}) };
  }
  if (typeof value === 'object' && value !== null) {
    const { approved, reason } = value as { approved?: unknown; reason?: unknown };
    if (approved === true) return { allowed: true };
    return { allowed: false, ...(typeof reason === 'string' && reason.trim() ? { reason: reason.trim() } : {}) };
  }
  return { allowed: false };
}

/** Claude Code's own tools with a workspace. */
const BUILTINS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'];

/**
 * Claude Code's own tools that run without asking, without `approval`: its
 * edits run without asking only in the workspace (`acceptEdits`), and its
 * reads as its rules say (in the workspace).
 */
const UNASKED = ['Glob', 'Grep', 'Bash'];

/** Claude Code's tools of background work and of a person present, left out: their recovery is not mapped onto turns. */
const LEFT_OUT = [
  'Agent',
  'Task',
  'Workflow',
  'ListAgents',
  'ScheduleWakeup',
  'AskUserQuestion',
  'ReportFindings',
  'Skill',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'EnterPlanMode',
  'ExitPlanMode',
];

/** The model of `options`: `anthropic/` before it left out; none for Claude Code's default. */
export const modelOf = (model: string | undefined) => {
  const named = model || process.env.MODEL || undefined;
  return named?.startsWith('anthropic/') ? named.slice('anthropic/'.length) : named;
};

/** The errors of a request that a retry does not change: the model's provider refused it. */
const REFUSALS = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
  'model_not_found',
  'invalid_request',
  'cloud_credential_error',
]);

/** The error of a turn its provider refused: 424, terminal. */
const refused = (why: string, model: string | undefined) =>
  new restate.TerminalError(
    `the model's provider refused the request (${why}${model ? `, model ${model}` : ''}): ${CHECK_MODEL}`,
    { errorCode: REFUSED },
  );

/** How long a tool waits for its call to be committed before the attempt fails. */
const GATE_MS = 60_000;

/** How long a resumed turn may do nothing (no model request, no tool) before the attempt fails. */
const IDLE_MS = 60_000;

/** How long a tool call's end waits for Claude Code to queue a message steered to the turn. */
const QUEUE_MS = 2_000;

/** How long a stop waits for Claude Code to end its turn before the process is killed. */
const STOP_MS = 5_000;

/** The note that tells the model how the turn before ended, if its run did not answer it (as OpenCode's). */
async function noteOf(ctx: restate.SessionContext, before: { n: number; answer?: string; status?: string }) {
  if (!before.answer || before.status === 'answered' || before.status === undefined) return '';
  if (before.status !== 'ended') return `(${before.answer})\n\n`;
  const rows = await ctx.db.values(`SELECT item FROM ${STEPS} WHERE turn = ? ORDER BY n`, [before.n]);
  const happened = rows.flatMap(([stored]) => {
    const item = items.load(String(stored));
    return item.type === 'results' ? item.results.filter((r) => r.output === RETURNED_UNRECORDED) : [];
  });
  const calls = happened.map((r) => `${r.name} (${r.id})`).join(', ');
  return `(${before.answer}${calls ? ` These calls did happen: ${calls}.` : ''})\n\n`;
}

/** A queue of the user's messages, as Claude Code's streaming input reads them. */
class Input implements AsyncIterable<SDKUserMessage> {
  #queue: SDKUserMessage[] = [];
  #wake: (() => void) | undefined;
  #ended = false;

  push(message: SDKUserMessage) {
    this.#queue.push(message);
    this.#wake?.();
  }

  end() {
    this.#ended = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      const next = this.#queue.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((resolve) => (this.#wake = resolve));
      this.#wake = undefined;
    }
  }
}

/** A message of the user, as Claude Code's input takes it. */
const said = (text: string, uuid: string, priority?: 'next'): SDKUserMessage => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
  uuid: uuid as SDKUserMessage['uuid'],
  ...(priority ? { priority } : {}),
});

/** The working directory of a key without a workspace: empty, the same path on every machine. */
const homeOf = (ctx: restate.SessionContext) =>
  join(
    tmpdir(),
    'restate-agents-claude',
    createHash('sha256').update(`${ctx.request.target.service}/${ctx.key}`).digest('hex').slice(0, 32),
  );

/**
 * One run of a turn with Claude Code: its process, the mirror of its
 * transcript into `ctx.db` and the turn, the gate of its tool calls, and how
 * the run ends.
 */
class Run {
  readonly #ctx: restate.SessionContext;
  readonly #turn: Turn<Item>;
  readonly #options: Options;
  readonly #tools: Map<string, AnyTool>;
  /** Nothing more is stored once closed: the attempt ended, or the turn is being closed. */
  readonly fence = { closed: false };
  /** Once the turn is stopped, the turn takes no copy: its close says how it ended. */
  #stopping = false;
  /** The tool calls whose calls are committed, and the gates waiting for one. */
  readonly #committed = new Set<string>();
  readonly #gates = new Map<string, () => void>();
  /** The mirror's appends, one after another. */
  #appending: Promise<unknown> = Promise.resolve();
  /** Each message steered to the turn that this run gave Claude Code, by the uuid it was given. */
  readonly #steers = new Map<string, string>();
  /** The outputs our tools returned, by call id: copied as a tool call returns, before the transcript has them. */
  readonly #returned = new Map<string, string>();
  /** The messages given to Claude Code that it has not queued yet, by their text: see {@link Run.#steer}. */
  readonly #queueing = new Map<string, () => void>();
  /** How many tool calls run now: a steered message is given only while one does. */
  #running = 0;
  #query: Query | undefined;
  #child: ChildProcess | undefined;
  readonly #input = new Input();
  readonly #failed = Promise.withResolvers<never>();
  /** The last error Claude Code's assistant messages carried (an API error), and its result. */
  #apiError: string | undefined;
  #home: string | undefined;
  #stderr = '';

  constructor(ctx: restate.SessionContext, turn: Turn<Item>, options: Options) {
    this.#ctx = ctx;
    this.#turn = turn;
    this.#options = options;
    this.#tools = new Map((options.tools ?? []).map((t) => [t.name, t]));
    this.#failed.promise.catch(() => {});
  }

  /** Fail the run, and the attempt: nothing more is stored, the process is killed. */
  fail(error: unknown): Promise<never> {
    this.fence.closed = true;
    this.kill();
    this.#failed.reject(error);
    return new Promise<never>(() => {});
  }

  /** Kill Claude Code, at once: a process left alone would go on with the turn. */
  kill() {
    this.#input.end();
    try {
      this.#child?.kill('SIGKILL');
    } catch {
      // gone already
    }
  }

  // The mirror.

  /** The session store: the transcript in `ctx.db`, and the turn's copy of it, in one transaction. */
  readonly store: SessionStore = {
    append: (key: SessionKey, entries: SessionStoreEntry[]) => {
      const next = this.#appending.then(() => this.#append(key, entries));
      this.#appending = next.catch(() => {});
      return next;
    },
    load: async (key: SessionKey) => {
      const lines = await linesOf(this.#ctx.db, key.subpath ?? '');
      return lines.length > 0 ? lines : null;
    },
    listSubkeys: async () => {
      const rows = await this.#ctx.db.values(`SELECT DISTINCT subpath FROM ${ENTRIES} WHERE subpath <> ''`);
      return rows.map(([subpath]) => String(subpath));
    },
  };

  async #append(key: SessionKey, entries: SessionStoreEntry[]) {
    // A run that ended stores nothing more: its process is being killed.
    if (this.fence.closed) throw new Error('the attempt ended: nothing more is stored');
    const subpath = key.subpath ?? '';
    const turn = this.#turn;
    let steps = false;
    const calls: string[] = [];
    try {
      await this.#ctx.db.transaction(async (tx) => {
        const fresh: Line[] = [];
        for (const entry of entries as Line[]) {
          // A line Claude Code mirrors again (a retried batch) is stored once, by its uuid.
          if (
            entry.uuid &&
            (await tx.get(`SELECT 1 AS one FROM ${ENTRIES} WHERE subpath = ? AND uuid = ?`, [subpath, entry.uuid]))
          ) {
            continue;
          }
          await tx.execute(`INSERT INTO ${ENTRIES} (subpath, uuid, entry) VALUES (?, ?, ?)`, [
            subpath,
            entry.uuid ?? null,
            JSON.stringify(entry),
          ]);
          fresh.push(entry);
          for (const block of blocksOf(entry)) if (block.type === 'tool_use' && block.id) calls.push(block.id);
        }
        if (subpath !== '' || this.#stopping || !turn.writable) return;
        const copied = newItems(fresh, turn, this.#steers);
        if (copied.length === 0 || !(await turn.copyIn(tx, copied))) return;
        tookSteers(
          this.#ctx,
          tx,
          copied.flatMap(({ steer }) => (steer === undefined ? [] : [steer])),
        );
        steps = copied.some(
          ({ item }) => item.type === 'results' || (item.type === 'assistant' && (item.calls?.length ?? 0) > 0),
        );
      });
      // Followers read the calls as their tools start, the results before the model's next request.
      if (steps) await turn.stepsCommitted();
    } catch (error) {
      // The mirror failed: Claude Code would drop the batch, and the transcript would have a hole.
      if (!this.fence.closed) void this.fail(error);
      throw error;
    }
    for (const id of calls) {
      this.#committed.add(id);
      this.#gates.get(id)?.();
    }
    for (const entry of entries as (Line & { operation?: string; content?: unknown })[]) {
      if (entry.type === 'queue-operation' && entry.operation === 'enqueue' && typeof entry.content === 'string') {
        this.#queueing.get(entry.content)?.();
      }
    }
  }

  /** Wait until tool call `id` is committed: a tool runs only once its call is stored. */
  #gate = async (id: string) => {
    if (this.#committed.has(id)) return;
    const committed = new Promise<void>((resolve) => this.#gates.set(id, resolve));
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`tool call ${id}: its call was not stored within ${GATE_MS / 1000} s`)),
        GATE_MS,
      );
    });
    try {
      await Promise.race([committed, late, this.#failed.promise]);
    } catch (error) {
      await this.fail(error);
    } finally {
      clearTimeout(timer);
    }
  };

  // The hooks and tools.

  readonly #preToolUse: HookCallback = async (input) => {
    const { tool_use_id: id } = input as { tool_use_id: string };
    await this.#gate(id);
    this.#running += 1;
    return {};
  };

  /**
   * A tool call returned: in a turn that takes steered messages, its result
   * (ours, as it returned) is copied, published, and each message steered to
   * the turn since is given to Claude Code, which places it at its next step,
   * after the round's results. Claude Code awaits this before it goes on.
   */
  readonly #postToolUse: HookCallback = async (input) => {
    this.#running -= 1;
    const { tool_use_id: id } = input as { tool_use_id: string };
    if (!inboxOf(this.#ctx) || this.fence.closed || this.#stopping) return {};
    try {
      const output = this.#returned.get(id);
      const name = this.#turn.openCalls().find((c) => c.id === id)?.name;
      let copied = false;
      if (output !== undefined && name !== undefined && this.#turn.writable) {
        copied = await this.#ctx.db.transaction((tx) =>
          this.#turn.copyIn(tx, [{ item: { type: 'results', results: [{ id, name, output }], from: `result:${id}` } }]),
        );
      }
      if (copied) await this.#turn.stepsCommitted();
      else await publish(this.#ctx);
      await this.#steer();
    } catch (error) {
      await this.fail(error);
    }
    return {};
  };

  /**
   * Give Claude Code each message steered to the turn that it has not been
   * given, while a tool call runs (its `PostToolUse`), and wait until Claude
   * Code queued it (its transcript says so): it then places it at its next
   * step, after the round's results. One it does not queue in time is placed
   * later, or else answered as a turn of its own.
   */
  async #steer() {
    const inbox = inboxOf(this.#ctx);
    if (!inbox || this.#stopping || this.fence.closed || stopSignalOf(this.#ctx)?.aborted) return;
    const held = new Set(this.#turn.steered().map((e) => e.steer));
    const given = new Set(this.#steers.values());
    const queued: Promise<void>[] = [];
    for (const { id, text } of inbox.messages) {
      if (held.has(id) || given.has(id)) continue;
      const uuid = uuidOf(`steer:${id}`);
      this.#steers.set(uuid, id);
      queued.push(new Promise<void>((resolve) => this.#queueing.set(text, resolve)));
      this.#input.push(said(text, uuid, 'next'));
    }
    if (queued.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(queued), new Promise((resolve) => (timer = setTimeout(resolve, QUEUE_MS)))]);
    clearTimeout(timer);
  }

  /** A tool of ours, as an in-process MCP tool of Claude Code's. */
  #mcpTool(t: AnyTool) {
    return mcpTool(t.name, t.description, t.input.shape, async (args: unknown, extra: unknown) => {
      const meta = (extra as Record<string, Record<string, unknown> | undefined>)[META];
      const id = meta?.['claudecode/toolUseId'];
      const callId = typeof id === 'string' ? id : '';
      try {
        await toolCallStarted(this.#ctx);
        const output = await t.run(args, { ctx: this.#ctx, callId });
        this.#returned.set(callId, output);
        return { content: [{ type: 'text' as const, text: output }] };
      } catch (error) {
        // A tool's error fails the attempt (a terminal one is its answer, which `tool()` gives); the next resumes the turn.
        return this.fail(error);
      }
    });
  }

  /** Each call of Claude Code's own tools waits for a person's approval (`approval`). */
  readonly #canUseTool: CanUseTool = async (name, input, { toolUseID, title, decisionReason }) => {
    let value: unknown;
    try {
      value = await waitFor(
        this.#ctx,
        toolUseID,
        APPROVAL,
        { tool: name, input, ...(title ? { title } : {}), ...(decisionReason ? { reason: decisionReason } : {}) },
        { approval: true, rejoin: true },
      );
    } catch (error) {
      return this.fail(error);
    }
    const decision = decided(value);
    if (decision.allowed) return { behavior: 'allow', updatedInput: input };
    return {
      behavior: 'deny',
      message: `The user denied tool "${name}"${decision.reason ? `: ${decision.reason}` : ''}`,
    };
  };

  // The process.

  /** Claude Code's process, killed at once when the run ends: tied to this process's life, where it can be. */
  readonly #spawn = (options: SpawnOptions): SpawnedProcess => {
    const child = spawnTied(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
    });
    child.stderr?.on('data', (data: Buffer) => {
      this.#stderr = (this.#stderr + data.toString()).slice(-4000);
    });
    this.#child = child;
    return child as unknown as SpawnedProcess;
  };

  /**
   * Run the turn: submit `prompt` (or, with `resume`, go on with the turn
   * Claude Code was cut off in), and answer once Claude Code ends its turn.
   */
  async run({
    prompt,
    session,
    resumes,
    interrupted,
  }: {
    prompt?: SDKUserMessage;
    session: string;
    resumes: boolean;
    interrupted: boolean;
  }) {
    const ctx = this.#ctx;
    const options = this.#options;
    const where = typeof options.workspace === 'function' ? await options.workspace(ctx) : options.workspace;
    const cwd = where ?? homeOf(ctx);
    await mkdir(cwd, { recursive: true });
    this.#home = await mkdtemp(join(tmpdir(), 'restate-claude-'));
    const ours = (options.tools ?? []).map((t) => `${PREFIX}${t.name}`);
    const builtins = where !== undefined ? BUILTINS : [];
    const retry = options.retry ?? {};
    const model = modelOf(options.model);
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: this.#home,
      CLAUDE_CONFIG_DIR: this.#home,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'restatedev-agents',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      CLAUDE_CODE_MAX_RETRIES: String(retry.enabled === false ? 0 : (retry.maxRetries ?? 10)),
      ...(interrupted
        ? {
            // Go on with the turn the transcript ends in, rather than wait for a prompt; however long ago it began.
            CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '1',
            CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS: String(30 * 24 * 3_600_000),
          }
        : {}),
      ...options.env,
    };
    const system = options.system;
    const sdkOptions: SdkOptions = {
      cwd,
      env,
      settingSources: [],
      strictMcpConfig: true,
      persistSession: true,
      sessionStore: this.store,
      sessionStoreFlush: 'eager',
      ...(resumes ? { resume: session } : { sessionId: session }),
      ...(model ? { model } : {}),
      ...(where !== undefined
        ? {
            systemPrompt: {
              type: 'preset',
              preset: 'claude_code',
              ...(system ? { append: system } : {}),
              snapshot: false,
            },
          }
        : system
          ? { systemPrompt: { type: 'custom', prompt: system, snapshot: false } }
          : {}),
      tools: builtins,
      disallowedTools: LEFT_OUT,
      // Without `approval`: edits in the workspace (`acceptEdits`), reads and searches, and the shell, without asking.
      allowedTools: options.approval || where === undefined ? ours : [...ours, ...UNASKED],
      ...(this.#tools.size > 0
        ? {
            mcpServers: {
              [SERVER]: createSdkMcpServer({
                name: SERVER,
                version: '1.0.0',
                tools: [...this.#tools.values()].map((t) => this.#mcpTool(t)),
              }),
            },
          }
        : {}),
      hooks: {
        PreToolUse: [{ hooks: [this.#preToolUse] }],
        PostToolUse: [{ hooks: [this.#postToolUse] }],
        PostToolUseFailure: [{ hooks: [async () => ((this.#running -= 1), {})] }],
      },
      ...(options.approval
        ? { permissionMode: 'default', canUseTool: this.#canUseTool }
        : { permissionMode: 'acceptEdits', permissionPrompts: 'none' }),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
      ...(options.sandbox ? { sandbox: options.sandbox } : {}),
      spawnClaudeCodeProcess: this.#spawn,
    };
    if (prompt) this.#input.push(prompt);
    const q = query({ prompt: this.#input, options: sdkOptions });
    this.#query = q;
    return Promise.race([this.#answer(q, model, interrupted), this.#failed.promise]);
  }

  /** Read Claude Code's messages until it ends its turn: its answer, or why it gave none. */
  async #answer(q: Query, model: string | undefined, interrupted: boolean): Promise<string> {
    let idle: NodeJS.Timeout | undefined;
    const busy = () => {
      clearTimeout(idle);
      idle = undefined;
    };
    if (interrupted) {
      // A resumed turn starts at once: one that does nothing, Claude Code did not resume.
      idle = setTimeout(
        () =>
          void this.fail(
            new Error(`the resumed turn did not go on within ${IDLE_MS / 1000} s: ${this.#stderr.slice(-500)}`),
          ),
        IDLE_MS,
      );
    }
    try {
      for await (const message of q) {
        if (message.type === 'assistant') {
          busy();
          if (message.error && !message.parent_tool_use_id) this.#apiError = message.error;
        } else if (message.type === 'system' && message.subtype === 'api_retry') {
          busy();
          // Refused for good (a wrong key): Claude Code would ask again, for minutes.
          if (REFUSALS.has(message.error)) throw refused(message.error, model);
        } else if (message.type === 'result') {
          this.#input.end();
          return await this.#ended(message, model);
        }
      }
    } catch (error) {
      if (this.fence.closed) return new Promise<never>(() => {});
      if (error instanceof restate.TerminalError) throw error;
      throw new Error(`Claude Code failed: ${String(error)} ${this.#stderr.slice(-500)}`, { cause: error });
    } finally {
      busy();
    }
    if (this.fence.closed) return new Promise<never>(() => {});
    throw new Error(`Claude Code ended without a result: ${this.#stderr.slice(-500)}`);
  }

  /** The answer of Claude Code's turn, which ended with `result`. */
  async #ended(result: SDKResultMessage, model: string | undefined) {
    if (this.#stopping) return new Promise<never>(() => {});
    if (result.subtype === 'success' && !result.is_error) {
      // The final reply's lines reach the mirror around the result: the turn answers with what it stored.
      await this.#appending;
      for (let waited = 0; this.#turn.finalReply() === undefined && waited < 5_000; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await this.#appending;
      }
      return this.#turn.finalReply() ?? result.result;
    }
    const why =
      'errors' in result && result.errors?.length
        ? result.errors.join('; ')
        : ((result as { result?: string }).result ?? result.subtype);
    if (result.subtype === 'error_max_turns') throw new restate.TerminalError(`the turn reached maxTurns: ${why}`);
    if (result.subtype === 'error_max_budget_usd')
      throw new restate.TerminalError(`the turn reached its budget: ${why}`);
    if (result.stop_reason === 'refusal') throw new restate.TerminalError(`the model declined to answer: ${why}`);
    if (this.#apiError !== undefined && REFUSALS.has(this.#apiError)) throw refused(this.#apiError, model);
    if (this.#apiError === 'max_output_tokens')
      throw new restate.TerminalError(`the model's reply was cut off: ${why}`);
    // An outage past Claude Code's retries, or a failure of its own: the attempt fails, and the next resumes the turn.
    throw new Error(`Claude Code's turn failed: ${why}`);
  }

  /**
   * The turn is being closed here (stopped, refused, failed): a stop
   * interrupts Claude Code, which ends its turn without the model and
   * records how, in the transcript; the turn takes no copy from then on, and
   * the process is killed.
   */
  async close(status: string) {
    this.#stopping = true;
    if (status === 'cancelled' && this.#query && !this.fence.closed) {
      const done = (async () => {
        await this.#query!.interrupt().catch(() => {});
        await this.#appending;
      })();
      await Promise.race([done, new Promise((resolve) => setTimeout(resolve, STOP_MS))]);
    }
    await this.#appending;
    this.fence.closed = true;
    this.kill();
  }

  /** Clean up: the process killed, its config directory removed. */
  async end() {
    this.kill();
    if (this.#home) await rm(this.#home, { recursive: true, force: true }).catch(() => {});
  }

  /**
   * Give each call the transcript cut off a result, stored in the
   * transcript and in the turn, in one transaction, before the process
   * starts: a call of ours is run again (by its id: its Restate calls are
   * made once), or has the result the turn copied as it returned; one of
   * Claude Code's own tools gets Claude Code's note, as it gives one.
   */
  async closeCutOff(session: string, ask: string) {
    const ctx = this.#ctx;
    const lines = await linesOf(ctx.db);
    const { calls, last, lastReply } = cutOff(lines, ask);
    if (calls.length === 0 || !last?.uuid) return;
    const results: Block[] = [];
    for (const call of calls) {
      const id = call.id!;
      const ours = call.name?.startsWith(PREFIX) ? this.#tools.get(call.name.slice(PREFIX.length)) : undefined;
      const copied = this.#turn.items.findLast(
        (e) => e.item.type === 'results' && e.item.results.some((r) => r.id === id),
      )?.item as Extract<Item, { type: 'results' }> | undefined;
      const had = copied?.results.find((r) => r.id === id);
      if (had)
        results.push({
          type: 'tool_result',
          tool_use_id: id,
          content: had.output,
          ...(had.error ? { is_error: true } : {}),
        });
      else if (ours) {
        await toolCallStarted(ctx);
        const output = await ours.run(call.input ?? {}, { ctx, callId: id });
        results.push({ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: output }] });
      } else results.push({ type: 'tool_result', tool_use_id: id, content: INTERRUPTED, is_error: true });
    }
    const entry: Line = {
      parentUuid: last.uuid,
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: results },
      uuid: uuidOf(`results:${session}:${calls.map((c) => c.id).join(',')}`),
      timestamp: new Date().toISOString(),
      sessionId: session,
      userType: 'external',
      cwd: (last as { cwd?: string }).cwd,
      version: (last as { version?: string }).version,
      ...(lastReply?.uuid ? { sourceToolAssistantUUID: lastReply.uuid } : {}),
    };
    const turn = this.#turn;
    let steps = false;
    await ctx.db.transaction(async (tx) => {
      await tx.execute(`INSERT OR IGNORE INTO ${ENTRIES} (subpath, uuid, entry) VALUES ('', ?, ?)`, [
        entry.uuid!,
        JSON.stringify(entry),
      ]);
      const copied = newItems([entry], turn, this.#steers);
      steps = copied.length > 0 && (await turn.copyIn(tx, copied));
    });
    if (steps) await turn.stepsCommitted();
  }
}

/** What `work` gets: `prompt(text)`, a turn of the conversation answered with Claude Code. */
export interface ClaudeAgentSession {
  /**
   * Answer `text`, once: a turn of the object's conversation (each prompt of
   * an invocation has an id of its own, the same on every attempt). With
   * `check`, a reply it returns a message for is asked again within the turn,
   * once. With `reminder`, the model is told it after the prompt, which the
   * conversation keeps as it was asked.
   */
  prompt: (text: string, check?: Check, reminder?: string) => Promise<string>;
}

/** Run the turn of `conversation` with Claude Code, with `options`. */
const runOf = (ctx: restate.SessionContext, options: Options) => async (conversation: Conversation<Item>) => {
  const turn = conversation.turn;
  // A stored final reply is the answer: the model is not asked for it again.
  const stored = turn.finalReply();
  if (stored !== undefined) return stored;
  const ask = turn.latestAsk();
  const again = ask !== turn.prompt;
  const askUuid = uuidOf(`${again ? 'again' : 'prompt'}:${turn.id}`);
  const known = await sessionOf(ctx.db);
  const session = known ?? uuidOf(`session:${turn.id}`);
  if (!known) await ctx.db.execute(`INSERT OR REPLACE INTO ${SESSION} (row, session) VALUES (0, ?)`, [session]);
  const resumes = (await ctx.db.get(`SELECT 1 AS one FROM ${ENTRIES} WHERE subpath = '' LIMIT 1`)) !== undefined;
  // Whether the transcript has this ask: then Claude Code was cut off in this turn, and goes on with it.
  const interrupted =
    resumes &&
    (await ctx.db.get(`SELECT 1 AS one FROM ${ENTRIES} WHERE subpath = '' AND uuid = ?`, [askUuid])) !== undefined;
  const run = new Run(ctx, turn, options);
  live.set(turn, (status) => run.close(status));
  const stop = stopSignalOf(ctx);
  const onStop = () => {
    // An attempt that ends stores nothing more, and its process goes: the next goes on with the turn.
    if (stop?.reason instanceof AttemptEnded) {
      run.fence.closed = true;
      run.kill();
    }
  };
  stop?.addEventListener('abort', onStop, { once: true });
  try {
    if (interrupted) {
      await run.closeCutOff(session, askUuid);
      return await run.run({ session, resumes, interrupted });
    }
    const text = items.read(ask.item).said?.[1] ?? '';
    // The model is told how the turn before this one ended, if its run did not answer it.
    const before = conversation.transcript.at(-2);
    const note = !again && before ? await noteOf(ctx, before) : '';
    const asked = note + text + (again ? '' : (turn.reminder ?? ''));
    return await run.run({ prompt: said(asked, askUuid), session, resumes, interrupted });
  } finally {
    stop?.removeEventListener('abort', onStop);
    live.delete(turn);
    await run.end();
  }
};

/**
 * Run `work` with Claude Code over the object's database: `prompt(text)`
 * answers a turn of the conversation, with `options`.
 */
export const withClaudeAgent = async <T>(
  ctx: restate.SessionContext,
  options: Options,
  work: (session: ClaudeAgentSession) => Promise<T>,
): Promise<T> =>
  work({
    prompt: (text, check, reminder) =>
      answerOnce(ctx, text, items, runOf(ctx, options), { check, reminder, ownHistory: true, schemas: [TABLES] }),
  });

/**
 * Answer `text`, once: a retried attempt resumes the same prompt. Each prompt
 * of an invocation is a prompt of its own. With `output`, it answers with the
 * value the agent replies with (see output.ts), not its text.
 */
export const prompt = <O extends z.ZodObject | undefined = undefined>(
  ctx: restate.SessionContext,
  text: string,
  options: Options<O> = {},
): Promise<Answer<O>> =>
  withChecked(text, options, (t, o, check, reminder) =>
    withClaudeAgent(ctx, o, (session) => session.prompt(t, check, reminder)),
  ) as Promise<Answer<O>>;

/**
 * A chat handler: each message an invocation, the transcript in the object's
 * database, with `options`, or the options a function of the invocation's
 * context gives (each user's workspace, say). It takes the message as plain
 * text (`curl -d 'Hi'`) or as a JSON string (`curl --json '"Hi"'`).
 */
export const chat = <O extends z.ZodObject | undefined = undefined>(options: Configure<Options<O>> = {}) =>
  chatHandler(async (ctx, message) => prompt(ctx, message, await configured(options, ctx)), { steers: true });

/**
 * A view of the conversation as clients read it: a page at a time, or what
 * is new or changed since a cursor; `view: 'summary'` for each turn's
 * message and answer. It answers while a message is answered.
 */
export const messages = () => conversationView(items);

/** An agent: a virtual object `name`, one per key, whose `chat` handler is {@link chat}, and `messages` {@link messages}. */
export const agent = <P extends string, O extends z.ZodObject | undefined = undefined>({
  name,
  description,
  schema,
  background,
  window,
  budget,
  ...options
}: Options<O> & Definition<P>) =>
  sessionObject({
    name,
    description,
    schema,
    background,
    window,
    budget,
    handlers: { chat: chat(options) },
    views: { messages: messages() },
  });
