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
  prewarm,
  query,
  tool as mcpTool,
  type CanUseTool,
  type EffortLevel,
  type Options as SdkOptions,
  type Query,
  type SandboxSettings,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
  type SpawnedProcess,
  type SpawnOptions,
  type SpareProcess,
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
import { jsonSchemaOf, type Tool as AnyTool, waitFor } from '../tools.ts';
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
  isMeta?: boolean;
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

/**
 * The terminal error of a turn that ended with `stop` (its last reply's
 * stop reason) and `error` (Claude Code's API error, if it wrote one), `why`
 * its text: declined, refused for good (424), cut off; or none (an outage,
 * which the next attempt resumes).
 */
function failureOf(stop: string | null | undefined, error: string | undefined, why: string, model: string | undefined) {
  if (stop === 'refusal') return new restate.TerminalError(`the model declined to answer: ${why}`);
  if (error !== undefined && REFUSALS.has(error)) return refused(error, model);
  if (error === 'max_output_tokens' || stop === 'max_tokens') {
    return new restate.TerminalError(`the model's reply was cut off: ${why}`);
  }
  return undefined;
}

/** How a turn ended, as its transcript says (see {@link endingOf}). */
type Ending = { kind: 'resume' } | { kind: 'answered'; lines: Line[] } | { kind: 'failed'; error: Error };

/**
 * How the turn whose ask is the line `ask` ended, as the transcript `lines`
 * say: a turn whose messages end with a reply of the model that ends it
 * (`end_turn`, its text empty too) was answered; one that ends with a reply
 * cut off or declined, or with Claude Code's error of a request refused for
 * good, failed, as it did; one that ends with a message of the user (the
 * prompt, the results of its calls) or with an outage's error goes on
 * (Claude Code resumes it). Claude Code's own notes after a reply (to go
 * on, to its fallback model) are not the user's: the reply decides. Decided here, not by
 * Claude Code: a resume of a turn that ended has nothing to go on with, and
 * would wait for a prompt that never comes.
 */
function endingOf(lines: Line[], ask: string, model: string | undefined): Ending {
  const from = lines.findIndex((l) => l.uuid === ask);
  if (from < 0) return { kind: 'resume' };
  // Claude Code's own notes to the model (`isMeta`: to go on past the output limit, a refusal's to its fallback
  // model, "Continue from where you left off.") say nothing of how the turn ended: what came before them does.
  const said = lines
    .slice(from)
    .filter((l) => !l.isSidechain && (l.type === 'assistant' || (l.type === 'user' && l.isMeta !== true)));
  const last = said.at(-1);
  if (last?.type !== 'assistant') return { kind: 'resume' };
  const text = blocksOf(last)
    .flatMap((b) => (b.type === 'text' && b.text ? [b.text] : []))
    .join('');
  if (last.isApiErrorMessage || last.message?.model === '<synthetic>') {
    const error = typeof last.error === 'string' ? last.error : undefined;
    const failure = failureOf(last.message?.stop_reason, error, text, model);
    return failure ? { kind: 'failed', error: failure } : { kind: 'resume' };
  }
  // The reply's lines: the last ones, of its API message.
  let first = said.length - 1;
  while (first > 0 && said[first - 1]!.type === 'assistant' && said[first - 1]!.message?.id === last.message?.id)
    first--;
  const reply = said.slice(first);
  if (reply.some((l) => blocksOf(l).some((b) => b.type === 'tool_use'))) return { kind: 'resume' };
  const stop = last.message?.stop_reason;
  if (stop === 'end_turn') return { kind: 'answered', lines: reply };
  const failure = failureOf(stop, undefined, text, model);
  return failure ? { kind: 'failed', error: failure } : { kind: 'resume' };
}

/** The end of the transcript `lines`, as a short text: what a resume that did not go on found. */
const tailOf = (lines: Line[]) =>
  lines
    .slice(-8)
    .map((l) => {
      const blocks = blocksOf(l).map((b) => b.type);
      const what = l.type === 'attachment' ? l.attachment?.type : (l as { operation?: string }).operation;
      return [l.type, what, l.message?.stop_reason, blocks.join('+'), l.isApiErrorMessage ? 'api-error' : '']
        .filter(Boolean)
        .join(' ');
    })
    .join(' | ');

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
  // The replies: Claude Code writes a line per content block of an API message, one after another. A reply is
  // copied once, by its message's id and its first line's uuid (the API's ids are unique, but a reply must not
  // be left out for an id the turn has: it would be stored in the transcript, and missing in the turn).
  const replies = new Map<string, { text: string[]; calls: Call[]; stop?: string | null }>();
  const order: (string | Item | { steer: string; text: string; from: string })[] = [];
  let current: { id: string; key: string } | undefined;
  for (const line of lines) {
    if (line.isSidechain) continue;
    const message = line.message;
    if (line.type !== 'assistant') current = undefined;
    if (line.type === 'assistant' && message?.id && !line.isApiErrorMessage && message.model !== '<synthetic>') {
      if (current?.id !== message.id) {
        current = { id: message.id, key: `${message.id}/${line.uuid ?? ''}` };
        replies.set(current.key, { text: [], calls: [] });
        order.push(current.key);
      }
      const reply = replies.get(current.key)!;
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
      // A reply that ends the turn is one of its text, empty too; one cut off, refused or failed is none.
      if (reply.calls.length === 0 && reply.stop !== 'end_turn') continue;
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
  /**
   * Whether a Claude Code process is kept between the turns of a key (by
   * default, for 60 s, 16 at most): the next turn of the key in this process
   * uses it, if it holds the transcript exactly as the store has it, rather
   * than start one (~0.4 s). `false` starts one for every turn, as on a
   * platform that freezes a process between requests. `spares` keeps that
   * many started for keys' first turns.
   */
  reuse?: false | Partial<Reuse>;
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

/**
 * Timings, and how a steered message is given: for tests (a shorter wait, a
 * message Claude Code takes late), not options.
 *
 * - `idleMs`: how long a resumed Claude Code may write nothing to its
 *   transcript (it writes as it sends the turn's request) before the attempt
 *   fails;
 * - `queueMs`: how long a tool call's end waits for Claude Code to queue a
 *   message steered to the turn;
 * - `steerPriority`: how a steered message is given (`'next'`: at the next
 *   step; `'later'`, for tests: after the turn).
 */
export const tuning = { idleMs: 60_000, queueMs: 2_000, steerPriority: 'next' as 'next' | 'later' };

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
const said = (text: string, uuid: string, priority?: 'next' | 'later'): SDKUserMessage => ({
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

/** How Claude Code processes are reused between the turns of a key: see {@link Options.reuse}. */
export interface Reuse {
  /** How long an idle process waits for its key's next turn before it is closed (default 60 s). */
  idleMs: number;
  /** How many idle processes this process keeps at most, the least recently used closed first (default 16). */
  maxIdle: number;
  /** How many started processes wait for a key's first turn, for each set of options (default 0). */
  spares: number;
}

/** The defaults of {@link Reuse}. */
const REUSE: Reuse = { idleMs: 60_000, maxIdle: 16, spares: 0 };

/** The reuse of `options`, or none. */
const reuseOf = (options: Options): Reuse | undefined =>
  options.reuse === false ? undefined : { ...REUSE, ...options.reuse };

/**
 * A Claude Code process: its query and its input, and the callbacks it was
 * started with (the store, the hooks, the tools, `canUseTool`), which reach
 * the run that holds it now, as a process kept between turns outlives the
 * run that started it: each run that takes it holds it (`run`), and lets go
 * once it ends.
 */
class Claude {
  /** The run that holds the process, if any: the callbacks reach it. */
  run: Run | undefined;
  readonly input = new Input();
  query: Query | undefined;
  #iterator: AsyncIterator<SDKMessage, void> | undefined;
  #child: ChildProcess | undefined;
  stderr = '';
  /** The mirror's appends, one after another. */
  appending: Promise<unknown> = Promise.resolve();
  /** The uuid of the last line of the main transcript the process mirrored, once committed. */
  lastUuid: string | undefined;
  /** Whether the process is gone, or must not be used again. */
  dead = false;
  /** The pool's timer that closes the process once idle too long. */
  idle: NodeJS.Timeout | undefined;
  /** Whether it may be kept for the key's next turn: not one started to resume a cut-off turn. */
  reusable = true;

  /** A spare's parked process, until its claim. */
  parked: SpareProcess | undefined;

  fingerprint: string;
  home: string;

  constructor(fingerprint: string, home: string) {
    this.fingerprint = fingerprint;
    this.home = home;
  }

  /** The run that holds the process: a callback without one is a process's own, between turns, which we refuse. */
  #held(): Run {
    if (!this.run || this.dead) throw new Error('no turn holds this Claude Code process');
    return this.run;
  }

  /** The next message of Claude Code's. */
  next(): Promise<IteratorResult<SDKMessage, void>> {
    this.#iterator ??= this.query![Symbol.asyncIterator]();
    return this.#iterator.next();
  }

  /** The session store: the transcript in `ctx.db`, and the turn's copy of it, through the run that holds the process. */
  readonly store: SessionStore = {
    append: (key: SessionKey, entries: SessionStoreEntry[]) => {
      const next = this.appending.then(() => this.#append(key, entries as Line[]));
      this.appending = next.catch(() => {});
      return next;
    },
    load: async (key: SessionKey) => {
      const lines = await linesOf(this.#held().ctx.db, key.subpath ?? '');
      return lines.length > 0 ? lines : null;
    },
    listSubkeys: async () => {
      const rows = await this.#held().ctx.db.values(`SELECT DISTINCT subpath FROM ${ENTRIES} WHERE subpath <> ''`);
      return rows.map(([subpath]) => String(subpath));
    },
  };

  async #append(key: SessionKey, entries: Line[]) {
    const run = this.run;
    const subpath = key.subpath ?? '';
    if (!run || run.fence.closed) {
      // Metadata a process writes as it closes (no uuid) is nobody's; a line of the transcript nobody stores
      // leaves the process ahead of the store: it is not used again.
      if (entries.some((e) => e.uuid)) {
        this.kill();
        throw new Error('the attempt ended: nothing more is stored');
      }
      return;
    }
    await run.append(subpath, entries);
    const last = subpath === '' ? entries.findLast((e) => e.uuid) : undefined;
    if (last) this.lastUuid = last.uuid;
  }

  /** The hooks: each reaches the run that holds the process. */
  readonly hooks: SdkOptions['hooks'] = {
    PreToolUse: [{ hooks: [async (input) => this.#held().preToolUse(input)] }],
    PostToolUse: [{ hooks: [async (input) => this.#held().postToolUse(input)] }],
    PostToolUseFailure: [{ hooks: [async () => (this.run && (this.run.running -= 1), {})] }],
  };

  readonly canUseTool: CanUseTool = async (name, input, options) => this.#held().canUseTool(name, input, options);

  /** Our tools, as an in-process MCP server: each call reaches the run that holds the process, and its tool. */
  mcpServer(tools: readonly AnyTool[]) {
    return createSdkMcpServer({
      name: SERVER,
      version: '1.0.0',
      tools: tools.map((t) =>
        mcpTool(t.name, t.description, t.input.shape, async (args: unknown, extra: unknown) =>
          this.#held().callTool(t.name, args, extra),
        ),
      ),
    });
  }

  /** Claude Code's process: killed at once when its run ends, tied to this process's life where it can be. */
  readonly spawn = (options: SpawnOptions): SpawnedProcess => {
    const child = spawnTied(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
    });
    child.stderr?.on('data', (data: Buffer) => {
      this.stderr = (this.stderr + data.toString()).slice(-4000);
    });
    child.once('exit', () => (this.dead = true));
    this.#child = child;
    return child as unknown as SpawnedProcess;
  };

  /** Kill Claude Code, at once: a process left alone would go on with its turn. */
  kill() {
    if (this.idle) clearTimeout(this.idle);
    this.dead = true;
    this.input.end();
    try {
      this.#child?.kill('SIGKILL');
    } catch {
      // gone already
    }
    if (this.home) void rm(this.home, { recursive: true, force: true }).catch(() => {});
    for (const [key, kept] of idle) if (kept === this) idle.delete(key);
  }
}

/**
 * How many Claude Code processes this process started for turns, how many
 * turns took a kept one instead, how many took a spare, and how many turns
 * Claude Code began on its own (with a message given to a turn that it did
 * not take) were dropped, their process killed.
 */
export const processes = { started: 0, reused: 0, spared: 0, dropped: 0 };

/** The idle processes, by agent and key: each holds the key's transcript as far as the store has it. */
const idle = new Map<string, Claude>();

/** The started processes that wait for a key's first turn, by the options they were started with. */
const spares = new Map<string, Claude[]>();

process.once('exit', () => {
  for (const kept of idle.values()) kept.kill();
  for (const list of spares.values()) for (const spare of list) spare.kill();
});

/**
 * The idle process of `key` for a turn of `ctx`, if one can be used: started
 * with the same options, alive, and holding the transcript exactly as the
 * store has it (its last line the store's last, the same session). Any
 * other is killed: another process (another replica, a crashed attempt)
 * wrote the transcript since, or it is not what the options ask for.
 */
async function take(key: string, fingerprint: string, ctx: restate.SessionContext): Promise<Claude | undefined> {
  const kept = idle.get(key);
  if (!kept) return undefined;
  idle.delete(key);
  clearTimeout(kept.idle);
  if (kept.dead || kept.fingerprint !== fingerprint) {
    kept.kill();
    return undefined;
  }
  const last = await ctx.db.get<{ uuid: string }>(
    `SELECT uuid FROM ${ENTRIES} WHERE subpath = '' AND uuid IS NOT NULL ORDER BY seq DESC LIMIT 1`,
  );
  if (last?.uuid !== kept.lastUuid || kept.dead) {
    kept.kill();
    return undefined;
  }
  return kept;
}

/** Keep `claude`, idle, for the next turn of `key`: closed after `idleMs`, or as the least recently kept of `maxIdle`. */
function keep(key: string, claude: Claude, { idleMs, maxIdle }: Reuse) {
  idle.get(key)?.kill();
  idle.set(key, claude);
  claude.idle = setTimeout(() => claude.kill(), idleMs);
  claude.idle.unref();
  while (idle.size > maxIdle) idle.values().next().value!.kill();
}

/**
 * The fingerprint of the options a process is started with, and is kept
 * for: a process started with others is not used for a turn.
 */
const fingerprintOf = (options: Options, cwd: string | undefined, model: string | undefined) =>
  JSON.stringify({
    cwd,
    model,
    system: options.system ?? null,
    tools: (options.tools ?? []).map((t) => [t.name, t.description, jsonSchemaOf(t)]),
    approval: options.approval ?? false,
    retry: options.retry ?? null,
    effort: options.effort ?? null,
    maxTurns: options.maxTurns ?? null,
    sandbox: options.sandbox ?? null,
    env: options.env ?? null,
  });

/**
 * The options Claude Code is started with: for a turn of a key (`cwd`,
 * `session`), or for a spare (none: its claim gives the cwd).
 */
function sdkOptionsOf(
  claude: Claude,
  options: Options,
  { cwd, workspace, model, interrupted }: { cwd?: string; workspace: boolean; model?: string; interrupted: boolean },
): SdkOptions {
  const ours = (options.tools ?? []).map((t) => `${PREFIX}${t.name}`);
  const retry = options.retry ?? {};
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: claude.home,
    CLAUDE_CONFIG_DIR: claude.home,
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
  return {
    ...(cwd ? { cwd } : {}),
    env,
    settingSources: [],
    strictMcpConfig: true,
    persistSession: true,
    sessionStore: claude.store,
    sessionStoreFlush: 'eager',
    ...(model ? { model } : {}),
    ...(workspace
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
    tools: workspace ? BUILTINS : [],
    disallowedTools: LEFT_OUT,
    // Without `approval`: edits in the workspace (`acceptEdits`), reads and searches, and the shell, without asking.
    allowedTools: options.approval || !workspace ? ours : [...ours, ...UNASKED],
    ...((options.tools ?? []).length > 0 ? { mcpServers: { [SERVER]: claude.mcpServer(options.tools ?? []) } } : {}),
    hooks: claude.hooks,
    ...(options.approval
      ? { permissionMode: 'default', canUseTool: claude.canUseTool }
      : { permissionMode: 'acceptEdits', permissionPrompts: 'none' }),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
    ...(options.sandbox ? { sandbox: options.sandbox } : {}),
    spawnClaudeCodeProcess: claude.spawn,
  };
}

/** Start spares for `options` until there are `count`, in the background. */
function refill(fingerprint: string, options: Options, workspace: boolean, count: number) {
  const list = spares.get(fingerprint) ?? [];
  spares.set(fingerprint, list);
  while (list.filter((s) => !s.dead).length < count) {
    const spare = new Claude(fingerprint, '');
    list.push(spare);
    void (async () => {
      try {
        spare.home = await mkdtemp(join(tmpdir(), 'restate-claude-'));
        const parked = await prewarm({ options: sdkOptionsOf(spare, options, { workspace, interrupted: false }) });
        spare.parked = parked;
        void parked.exited.then(() => spare.kill());
      } catch {
        spare.kill();
      }
    })();
  }
}

/** A started spare of `fingerprint`, if one waits: taken from the spares. */
function spareOf(fingerprint: string): Claude | undefined {
  const list = spares.get(fingerprint) ?? [];
  const at = list.findIndex((s) => !s.dead && s.parked !== undefined);
  if (at < 0) return undefined;
  return list.splice(at, 1)[0];
}

/**
 * One run of a turn with Claude Code: the mirror of its transcript into
 * `ctx.db` and the turn, the gate of its tool calls, its steered messages,
 * and how it ends, with the process that holds it ({@link Claude}).
 */
class Run {
  readonly ctx: restate.SessionContext;
  readonly #turn: Turn<Item>;
  readonly #tools: Map<string, AnyTool>;
  /** Nothing more is stored once closed: the attempt ended, or the turn is being closed. */
  readonly fence = { closed: false };
  /** Once the turn is stopped, the turn takes no copy: its close says how it ended. */
  #stopping = false;
  /** The tool calls whose calls are committed, and the gates waiting for one. */
  readonly #committed = new Set<string>();
  readonly #gates = new Map<string, () => void>();
  /** Each message steered to the turn that this run gave Claude Code, by the uuid it was given. */
  readonly #steers = new Map<string, string>();
  /** The outputs our tools returned, by call id: copied as a tool call returns, before the transcript has them. */
  readonly #returned = new Map<string, string>();
  /** The messages given to Claude Code that it has not queued yet, by their text: see {@link Run.#steer}. */
  readonly #queueing = new Map<string, () => void>();
  /** How many tool calls run now: a steered message is given only while one does. */
  running = 0;
  /** The process that holds the run. */
  claude: Claude | undefined;
  readonly #failed = Promise.withResolvers<never>();
  /** The last error Claude Code's assistant messages carried (an API error). */
  #apiError: string | undefined;
  /** The end of the transcript a resumed turn found, for its error should it not go on. */
  tail = '';
  /** Told of each line of the transcript Claude Code writes: a resumed turn went on. */
  #wrote: (() => void) | undefined;
  /** Whether Claude Code began a turn of its own after this one (a message given, not taken): nothing more of it is stored. */
  #foreign = false;

  constructor(ctx: restate.SessionContext, turn: Turn<Item>, options: Options) {
    this.ctx = ctx;
    this.#turn = turn;
    this.#tools = new Map((options.tools ?? []).map((t) => [t.name, t]));
    this.#failed.promise.catch(() => {});
  }

  /** Fail the run, and the attempt: nothing more is stored, the process is killed. */
  fail(error: unknown): Promise<never> {
    this.fence.closed = true;
    this.claude?.kill();
    this.#failed.reject(error);
    return new Promise<never>(() => {});
  }

  /** The end of the attempt: nothing more is stored, and the process goes; the next attempt goes on with the turn. */
  ended() {
    this.fence.closed = true;
    this.claude?.kill();
  }

  // The mirror.

  /** Store `entries`, lines of the transcript at `subpath`, and copy what is new of the turn, in one transaction. */
  async append(subpath: string, written: Line[]) {
    this.#wrote?.();
    // A turn of Claude Code's own after this one (a message given to the turn, which Claude Code took after it)
    // is nobody's: none of it is stored, and the process is killed.
    if (this.#foreign) return;
    const at = subpath === '' ? written.findIndex((line) => this.#startsAnother(line)) : -1;
    const entries = at < 0 ? written : written.slice(0, at);
    if (at >= 0) {
      this.#foreign = true;
      processes.dropped += 1;
      this.claude?.kill();
    }
    const turn = this.#turn;
    let steps = false;
    const calls: string[] = [];
    try {
      await this.ctx.db.transaction(async (tx) => {
        const fresh: Line[] = [];
        for (const entry of entries) {
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
        // The session's id, as Claude Code names it (a spare's is its own), once.
        const session = fresh.map((e) => e.sessionId).find((id): id is string => typeof id === 'string');
        if (subpath === '' && session) {
          await tx.execute(`INSERT OR IGNORE INTO ${SESSION} (row, session) VALUES (0, ?)`, [session]);
        }
        if (subpath !== '' || this.#stopping || !turn.writable) return;
        const copied = newItems(fresh, turn, this.#steers);
        if (copied.length === 0 || !(await turn.copyIn(tx, copied))) return;
        tookSteers(
          this.ctx,
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

  /**
   * Whether `line` is the prompt of a turn Claude Code starts after this one:
   * a message given to this turn (by its uuid) that Claude Code did not place
   * at a step, and runs as a prompt of its own once the turn ended.
   */
  #startsAnother(line: Line) {
    if (line.type !== 'user' || !line.uuid || !this.#steers.has(line.uuid) || line.isSidechain) return false;
    return !blocksOf(line).some((b) => b.type === 'tool_result');
  }

  /** Whether a message given to Claude Code for this turn was not taken by it: Claude Code holds it still. */
  untaken() {
    const held = new Set(this.#turn.steered().map((e) => e.steer));
    return [...this.#steers.values()].some((id) => !held.has(id));
  }

  /** Wait until tool call `id` is committed: a tool runs only once its call is stored. */
  async #gate(id: string) {
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
  }

  // The hooks and tools.

  async preToolUse(input: unknown) {
    const { tool_use_id: id } = input as { tool_use_id: string };
    await this.#gate(id);
    this.running += 1;
    return {};
  }

  /**
   * A tool call returned: in a turn that takes steered messages, its result
   * (ours, as it returned) is copied, published, and each message steered to
   * the turn since is given to Claude Code, which places it at its next step,
   * after the round's results. Claude Code awaits this before it goes on.
   */
  async postToolUse(input: unknown) {
    this.running -= 1;
    const { tool_use_id: id } = input as { tool_use_id: string };
    if (!inboxOf(this.ctx) || this.fence.closed || this.#stopping) return {};
    try {
      const output = this.#returned.get(id);
      const name = this.#turn.openCalls().find((c) => c.id === id)?.name;
      let copied = false;
      if (output !== undefined && name !== undefined && this.#turn.writable) {
        copied = await this.ctx.db.transaction((tx) =>
          this.#turn.copyIn(tx, [{ item: { type: 'results', results: [{ id, name, output }], from: `result:${id}` } }]),
        );
      }
      if (copied) await this.#turn.stepsCommitted();
      else await publish(this.ctx);
      await this.#steer();
    } catch (error) {
      await this.fail(error);
    }
    return {};
  }

  /**
   * Give Claude Code each message steered to the turn that it has not been
   * given, while a tool call runs (its `PostToolUse`), and wait until Claude
   * Code queued it (its transcript says so): it then places it at its next
   * step, after the round's results. One it does not queue in time is placed
   * later, or else answered as a turn of its own.
   */
  async #steer() {
    const inbox = inboxOf(this.ctx);
    if (!inbox || this.#stopping || this.fence.closed || stopSignalOf(this.ctx)?.aborted) return;
    const held = new Set(this.#turn.steered().map((e) => e.steer));
    const given = new Set(this.#steers.values());
    const queued: Promise<void>[] = [];
    for (const { id, text } of inbox.messages) {
      if (held.has(id) || given.has(id)) continue;
      const uuid = uuidOf(`steer:${id}`);
      this.#steers.set(uuid, id);
      queued.push(new Promise<void>((resolve) => this.#queueing.set(text, resolve)));
      this.claude?.input.push(said(text, uuid, tuning.steerPriority));
    }
    if (queued.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(queued), new Promise((resolve) => (timer = setTimeout(resolve, tuning.queueMs)))]);
    clearTimeout(timer);
  }

  /** A call of our tool `name`, from Claude Code's MCP server. */
  async callTool(name: string, args: unknown, extra: unknown) {
    const meta = (extra as Record<string, Record<string, unknown> | undefined>)[META];
    const id = meta?.['claudecode/toolUseId'];
    const callId = typeof id === 'string' ? id : '';
    try {
      const t = this.#tools.get(name);
      if (!t) throw new Error(`no tool ${name} in this turn`);
      await toolCallStarted(this.ctx);
      const output = await t.run(args, { ctx: this.ctx, callId });
      this.#returned.set(callId, output);
      return { content: [{ type: 'text' as const, text: output }] };
    } catch (error) {
      // A tool's error fails the attempt (a terminal one is its answer, which `tool()` gives); the next resumes the turn.
      return this.fail(error);
    }
  }

  /** Each call of Claude Code's own tools waits for a person's approval (`approval`). */
  readonly canUseTool: CanUseTool = async (name, input, { toolUseID, title, decisionReason }) => {
    let value: unknown;
    try {
      value = await waitFor(
        this.ctx,
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

  /** Run the turn on `claude`, which holds it: `prompt` given (unless the turn goes on without one), until its result. */
  async run(claude: Claude, prompt: SDKUserMessage | undefined, model: string | undefined, interrupted: boolean) {
    this.claude = claude;
    claude.run = this;
    if (prompt) claude.input.push(prompt);
    return Promise.race([this.#answer(claude, model, interrupted), this.#failed.promise]);
  }

  /** Read Claude Code's messages until it ends its turn: its answer, or why it gave none. */
  async #answer(claude: Claude, model: string | undefined, interrupted: boolean): Promise<string> {
    let idleTimer: NodeJS.Timeout | undefined;
    const busy = () => {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    };
    if (interrupted) {
      // A resumed turn writes its transcript as it sends its request: one that writes nothing, Claude Code did not resume.
      this.#wrote = busy;
      idleTimer = setTimeout(
        () =>
          void this.fail(
            new Error(
              `the resumed turn did not go on within ${tuning.idleMs / 1000} s (the transcript ends: ${this.tail}): ${claude.stderr.slice(-500)}`,
            ),
          ),
        tuning.idleMs,
      );
    }
    try {
      for (;;) {
        const { value: message, done } = await claude.next();
        if (done) break;
        if (message.type === 'assistant') {
          busy();
          if (message.error && !message.parent_tool_use_id) this.#apiError = message.error;
        } else if (message.type === 'system' && message.subtype === 'api_retry') {
          busy();
          // Refused for good (a wrong key): Claude Code would ask again, for minutes.
          if (REFUSALS.has(message.error)) throw refused(message.error, model);
        } else if (message.type === 'result') {
          return await this.#ended(claude, message, model);
        }
      }
    } catch (error) {
      if (this.fence.closed) return new Promise<never>(() => {});
      if (error instanceof restate.TerminalError) throw error;
      throw new Error(`Claude Code failed: ${String(error)} ${claude.stderr.slice(-500)}`, { cause: error });
    } finally {
      busy();
    }
    if (this.fence.closed) return new Promise<never>(() => {});
    throw new Error(`Claude Code ended without a result: ${claude.stderr.slice(-500)}`);
  }

  /** The answer of Claude Code's turn, which ended with `result`. */
  async #ended(claude: Claude, result: SDKResultMessage, model: string | undefined) {
    if (this.#stopping) return new Promise<never>(() => {});
    if (result.subtype === 'success' && !result.is_error) {
      // The final reply's lines reach the mirror around the result: the turn answers with what it stored.
      await claude.appending;
      for (let waited = 0; this.#turn.finalReply() === undefined && waited < 5_000; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        await claude.appending;
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
    const failure = failureOf(result.stop_reason, this.#apiError, why, model);
    if (failure) throw failure;
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
    const claude = this.claude;
    if (status === 'cancelled' && claude?.query && !this.fence.closed) {
      const done = (async () => {
        await claude.query!.interrupt().catch(() => {});
        await claude.appending;
      })();
      await Promise.race([done, new Promise((resolve) => setTimeout(resolve, STOP_MS))]);
    }
    await claude?.appending;
    this.fence.closed = true;
    claude?.kill();
  }

  /** Answer with the final reply of `lines`, the turn's last in the transcript: copied into the turn first, if missing. */
  async answerFrom(lines: Line[]) {
    const turn = this.#turn;
    await this.ctx.db.transaction(async (tx) => {
      const copied = newItems(lines, turn, this.#steers);
      if (copied.length > 0) await turn.copyIn(tx, copied);
    });
    return (
      turn.finalReply() ??
      lines.flatMap((l) => blocksOf(l).flatMap((b) => (b.type === 'text' && b.text ? [b.text] : []))).join('')
    );
  }

  /**
   * Give each call the transcript cut off a result, stored in the
   * transcript and in the turn, in one transaction, before the process
   * starts: a call of ours is run again (by its id: its Restate calls are
   * made once), or has the result the turn copied as it returned; one of
   * Claude Code's own tools gets Claude Code's note, as it gives one.
   */
  async closeCutOff(session: string, ask: string) {
    const ctx = this.ctx;
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

/**
 * The Claude Code process for a turn of `ctx`: the key's idle one if it
 * holds the store's transcript, else a spare for a key's first turn, else a
 * new one, which resumes the transcript (`resume`) or starts the session.
 */
async function claudeFor(
  ctx: restate.SessionContext,
  options: Options,
  run: Run,
  {
    session,
    resumes,
    interrupted,
    cwd,
    workspace,
    model,
    fresh,
  }: {
    session: string;
    resumes: boolean;
    interrupted: boolean;
    cwd: string;
    workspace: boolean;
    model: string | undefined;
    fresh: boolean;
  },
): Promise<{ claude: Claude; claimed?: SpareProcess }> {
  const reuse = reuseOf(options);
  const key = `${ctx.request.target.service}/${ctx.key}`;
  const fingerprint = fingerprintOf(options, cwd, model);
  if (reuse && !interrupted) {
    const kept = await take(key, fingerprint, ctx);
    if (kept) {
      processes.reused += 1;
      return { claude: kept };
    }
    const spareKey = fingerprintOf(options, workspace ? 'workspace' : undefined, undefined);
    if (reuse.spares > 0) {
      const spare = fresh ? spareOf(spareKey) : undefined;
      refill(spareKey, options, workspace, reuse.spares);
      if (spare) {
        // Kept, once it answered, for the key's next turns, as a process started for them is.
        spare.fingerprint = fingerprint;
        processes.spared += 1;
        return { claude: spare, claimed: spare.parked };
      }
    }
  }
  const claude = new Claude(fingerprint, await mkdtemp(join(tmpdir(), 'restate-claude-')));
  claude.reusable = !interrupted;
  processes.started += 1;
  // Held from its start: a resumed process loads the transcript through the run's `ctx.db`.
  claude.run = run;
  run.claude = claude;
  claude.query = query({
    prompt: claude.input,
    options: {
      ...sdkOptionsOf(claude, options, { cwd, workspace, model, interrupted }),
      ...(resumes ? { resume: session } : { sessionId: session }),
    },
  });
  return { claude };
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
  const resumes = (await ctx.db.get(`SELECT 1 AS one FROM ${ENTRIES} WHERE subpath = '' LIMIT 1`)) !== undefined;
  // Whether the transcript has this ask: then Claude Code was cut off in this turn, and goes on with it.
  const interrupted =
    resumes &&
    (await ctx.db.get(`SELECT 1 AS one FROM ${ENTRIES} WHERE subpath = '' AND uuid = ?`, [askUuid])) !== undefined;
  const where = typeof options.workspace === 'function' ? await options.workspace(ctx) : options.workspace;
  const cwd = where ?? homeOf(ctx);
  await mkdir(cwd, { recursive: true });
  const model = modelOf(options.model);
  const run = new Run(ctx, turn, options);
  live.set(turn, (status) => run.close(status));
  const stop = stopSignalOf(ctx);
  // An attempt that ends stores nothing more, and its process goes: the next goes on with the turn.
  const onStop = () => {
    if (stop?.reason instanceof AttemptEnded) run.ended();
  };
  stop?.addEventListener('abort', onStop, { once: true });
  let claude: Claude | undefined;
  let answered = false;
  try {
    // A session that has a transcript resumes it; a new one's id is the first turn's (or a spare's own).
    const fresh = known === undefined && !resumes;
    const session = known ?? uuidOf(`session:${turn.id}`);
    if (interrupted) {
      await run.closeCutOff(session, askUuid);
      const lines = await linesOf(ctx.db);
      // A turn that ended in the transcript is answered, or fails, as it did: Claude Code is not started.
      const ending = endingOf(lines, askUuid, model);
      if (ending.kind === 'failed') throw ending.error;
      if (ending.kind === 'answered') return await run.answerFrom(ending.lines);
      run.tail = tailOf(lines);
    }
    let prompt: SDKUserMessage | undefined;
    if (!interrupted) {
      const text = items.read(ask.item).said?.[1] ?? '';
      // The model is told how the turn before this one ended, if its run did not answer it.
      const before = conversation.transcript.at(-2);
      const note = !again && before ? await noteOf(ctx, before) : '';
      prompt = said(note + text + (again ? '' : (turn.reminder ?? '')), askUuid);
    }
    const started = await claudeFor(ctx, options, run, {
      session,
      resumes,
      interrupted,
      cwd,
      workspace: where !== undefined,
      model,
      fresh,
    });
    claude = started.claude;
    if (started.claimed) {
      // A spare: the claim starts the session, under an id of Claude Code's own (stored with its first lines).
      claude.query = started.claimed.claim({ prompt: claude.input, options: { cwd, ...(model ? { model } : {}) } });
    } else if (!known) {
      await ctx.db.execute(`INSERT OR IGNORE INTO ${SESSION} (row, session) VALUES (0, ?)`, [session]);
    }
    const answer = await run.run(claude, prompt, model, interrupted);
    answered = true;
    return answer;
  } finally {
    stop?.removeEventListener('abort', onStop);
    live.delete(turn);
    if (claude) {
      claude.run = undefined;
      const reuse = reuseOf(options);
      // Kept for the key's next turn only once it answered, every line it wrote stored, and nothing given to it
      // that it has not taken: it would answer that as a turn of its own.
      if (answered && reuse && claude.reusable && !claude.dead && !run.fence.closed && !run.untaken()) {
        await claude.appending;
        if (!claude.dead) keep(`${ctx.request.target.service}/${ctx.key}`, claude, reuse);
      } else claude.kill();
    }
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
