// What an agentlib agent takes.
import type { AgentOptions as LibOptions, CompactionPolicy, Model } from '@restatedev/agentlib';
import type { sdk as restate } from '@restatedev/sessions/internal';
import type { AgentlibContext, Approval, Tools } from './tools.ts';

/** agentlib's options that the agent sets itself, or takes under another name. */
type Replaced = 'model' | 'name' | 'instructions' | 'tools' | 'onApproval' | 'onHumanApproval';

/**
 * The options of an agentlib agent. agentlib's other options (`maxSteps`,
 * `compaction`, `contextWindow`, `toolResults`, `skills`, `beforeTool`,
 * `afterRun`...) go to its `agent()` as they are.
 */
export interface Options<O = string> extends Omit<LibOptions<AgentlibContext, O>, Replaced> {
  /**
   * `provider/model-id` (`openai/…` or `anthropic/…`), else MODEL, else
   * `openai/gpt-6-sol`; or a model of agentlib (`aiModel` of
   * `@restatedev/agentlib/provider`, for any provider of the AI SDK).
   */
  model?: string | Model;

  /** The system prompt: a text, or agentlib's function of the run's context that returns one. */
  system?: LibOptions<AgentlibContext, O>['instructions'];

  /**
   * The tools: those of `@restatedev/agents` (`tool()`, `call`, `send`,
   * `workflow`, `signal`, `subagent`), and agentlib's own by the name the
   * model calls them, as in `[weather, { transfer: asyncTool(...) }]`.
   */
  tools?: Tools;

  /**
   * The tools of `@restatedev/agents` whose calls wait for a person's
   * approval before they run, by name, or a function of a call that says
   * whether it does. `pending` lists the wait, and `signal` approves it
   * (`true`, `"approved"`, `{ "approved": true }`) or denies it (anything
   * else). agentlib's own tools take `needsApproval` instead.
   */
  approval?: Approval;

  /**
   * How the model's conversation stays short from turn to turn. At a turn's
   * start, once its messages since the last summary pass `maxMessages`
   * (default 64) or `maxChars` (default 64 000), the earliest are summarized
   * by `model` (by default the agent's), and the latest `retainMessages`
   * (default 12) are kept. The summary is kept for the next turns. `false`
   * keeps the whole conversation. `messages` shows every turn either way.
   */
  history?: false | (CompactionPolicy & { model?: Model });
}

/** An agent's name, and what it is beside its options. */
export interface Definition<P extends string> {
  name: P;
  /** What it is: for the UI, and for the model of a parent that hands it tasks (`subagent`). */
  description?: string;
  /** It works unwatched (a sub-agent, say): its turn tells its companion at its end only. */
  background?: boolean;
  /** Options of the object, beside the ones the agent sets (its `retryPolicy`, say). */
  options?: restate.ObjectOptions;
  metadata?: Record<string, string>;
}
