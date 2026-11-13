// How an agentlib agent answers a message: a turn, from its start at the
// companion, through agentlib's run (journaled), to its end.
import {
  agent as agentlibAgent,
  type Agent as LibAgent,
  type AgentOptions as LibOptions,
  type ApprovalRequest,
  type CompactionPolicy,
  type Model,
  type ProgressEvent,
  type RunOptions,
  type RunResult,
  type ToolContext,
} from '@restatedev/agentlib';
import { execute, internal, type Operation } from '@restatedev/restate-sdk-gen';
import { sdk as restate } from '@restatedev/sessions/internal';
import { approves, CANCELLED, ModelError, REFUSED, UNANSWERED } from '../common.ts';
import type { Started } from '../companion.ts';
import { checkHistory, modelLoader, refusing } from './model.ts';
import type { Options } from './options.ts';
import { Steering, takenIds } from './steering.ts';
import { companionAt, companionSendAt, read, TAKEN, waitForSignal } from './state.ts';
import { type AgentlibContext, type AgentlibTool, toolsOf } from './tools.ts';
import { conversationOf, Turn } from './turn.ts';

const { adopt } = internal;

/** agentlib's agent, once its model is loaded, and the model that summarizes its conversation. */
interface Loaded<O> {
  lib: LibAgent<AgentlibContext, O>;
  summarizer: Model;
}

/**
 * One agentlib agent's turns. Its model, and with it agentlib's agent, load
 * on the first turn (a missing provider package fails that turn, not the
 * process); everything else is checked when the agent is defined.
 */
export class Runtime<O> {
  private readonly name: string;
  private readonly background: boolean;
  private readonly libOptions: Omit<
    Options<O>,
    'model' | 'system' | 'tools' | 'approval' | 'history'
  >;
  private readonly system: Options<O>['system'];
  private readonly tools?: Record<string, AgentlibTool>;
  private readonly history: Options<O>['history'];
  private readonly loadModel: () => Promise<Model>;
  private loading?: Promise<Loaded<O>>;

  constructor(name: string, background: boolean, options: Options<O>) {
    const { model, system, tools, approval, history, ...libOptions } = options;
    this.name = name;
    this.background = background;
    this.libOptions = libOptions;
    this.system = system;
    this.history = history;
    this.loadModel = modelLoader(name, model);
    if (history) checkHistory(name, history);
    // Restate's tools become agentlib's here, so that a mistake fails now: two tools of one
    // name, or an approval of a tool the agent does not have (with no tools at all, too).
    const named = toolsOf(name, tools ?? [], approval);
    if (tools !== undefined) this.tools = named;
  }

  /** Answers `text` in the turn of `ctx`'s invocation. */
  async answer(ctx: restate.ObjectContext, text: string): Promise<O | string> {
    const steering = new Steering();
    steering.saw(await companionAt(ctx).start(await this.started(ctx)));
    const turn = await Turn.start(ctx, text);

    let lib: LibAgent<AgentlibContext, O>;
    try {
      lib = await this.prepare(ctx, turn);
    } catch (error) {
      await this.end(ctx, turn, UNANSWERED);
      if (error instanceof restate.TerminalError) throw error;
      throw new ModelError(`${this.name}: its model: ${String(error)}`);
    }

    let result: RunResult<O>;
    try {
      result = await execute(ctx, lib.run(text, this.runOptions(ctx, turn, steering)));
    } catch (error) {
      // Only a terminal error ends the turn. Any other error fails the attempt:
      // Restate retries it, and replays the run from its journal.
      if (!(error instanceof restate.TerminalError)) throw error;
      await this.end(ctx, turn, noteOf(error));
      throw error;
    }

    const answer = answerOf(result);
    // A cancellation that comes after the answer does not undo it: the turn still ends.
    await despiteCancellation(() => turn.answered(answer));
    await despiteCancellation(() => companionAt(ctx).close(ctx.request().id));
    return answer;
  }

  /** What the companion learns as the turn starts. */
  private async started(ctx: restate.ObjectContext): Promise<Started> {
    const since = new Date(await ctx.date.now()).toISOString();
    const started: Started = { invocationId: ctx.request().id, since, steers: !this.background };
    // A watched turn's start is its first publish, which returns the
    // messages already steered to it.
    if (!this.background) started.publishes = true;
    return started;
  }

  /** Loads the agent (once), and gives the turn what summarizes its conversation. */
  private async prepare(
    ctx: restate.ObjectContext,
    turn: Turn,
  ): Promise<LibAgent<AgentlibContext, O>> {
    this.loading ??= this.load();
    let loaded: Loaded<O>;
    try {
      loaded = await this.loading;
    } catch (error) {
      // The next turn tries again.
      this.loading = undefined;
      throw error;
    }
    if (this.history !== false) {
      const policy = policyOf(this.history);
      turn.compactor = conversationOf(ctx, { model: loaded.summarizer, policy });
    }
    return loaded.lib;
  }

  /** Loads the model, and makes agentlib's agent with it. */
  private async load(): Promise<Loaded<O>> {
    const model = refusing(await this.loadModel());
    const options: LibOptions<AgentlibContext, O> = {
      ...this.libOptions,
      name: this.name,
      model,
      onHumanApproval: askForApproval,
    };
    if (this.system !== undefined) options.instructions = this.system;
    if (this.tools !== undefined) options.tools = this.tools;

    // A summarizer of its own refuses with a 424, as the agent's model does.
    const custom = this.history ? this.history.model : undefined;
    const summarizer = custom ? refusing(custom) : model;
    return { lib: agentlibAgent<AgentlibContext, O>(options), summarizer };
  }

  /** The options of agentlib's run of the turn. */
  private runOptions(
    ctx: restate.ObjectContext,
    turn: Turn,
    steering: Steering,
  ): RunOptions<AgentlibContext> {
    const options: RunOptions<AgentlibContext> = {
      name: this.name,
      context: { ctx },
      conversation: turn,
      onProgress: (event) => this.onProgress(ctx, turn, steering, event),
    };
    if (!this.background) options.controls = { steering: steering.source };
    return options;
  }

  /**
   * Records a progress event of the run. A change that clients see is
   * published to the companion, whose answer says which messages are steered
   * to the turn; the run gets them at its next event.
   */
  private *onProgress(
    ctx: restate.ObjectContext,
    turn: Turn,
    steering: Steering,
    event: ProgressEvent,
  ): Operation<void> {
    yield* recordTaken(ctx, event);
    const changed = turn.progress(event);
    if (!changed || this.background) return;

    steering.saw(yield* adopt(companionAt(ctx).publish()));
    yield* steering.hand();
  }

  /** Ends a turn that has no answer, with `note`, at the agent and at its companion. */
  private async end(ctx: restate.ObjectContext, turn: Turn, note: string) {
    await turn.close(note);
    await companionAt(ctx).close(ctx.request().id);
  }
}

/**
 * Waits for the signal `approval` for a tool call that needs one (agentlib's
 * `needsApproval`, its `humanApprovalTool`, a tool's `approve`). `pending`
 * lists the wait, with the tool and its input; `signal` decides it.
 */
function* askForApproval(
  request: ApprovalRequest,
  { context }: ToolContext<AgentlibContext>,
): Operation<boolean> {
  const { call, question } = request;
  const input: Record<string, unknown> = { tool: call.name, input: call.input };
  if (question !== undefined) input.question = question;
  // A call may ask more than once: agentlib names each ask (`<agent>:approval:<call>:<n>`).
  const value = yield* waitForSignal(context.ctx, request.signalName, 'approval', input);
  return approves(value);
}

/**
 * Remembers the steered messages that the run took, so that their own
 * `steered` turns do nothing, and tells the companion.
 */
function* recordTaken(ctx: restate.ObjectContext, event: ProgressEvent): Operation<void> {
  const ids = takenIds(event);
  if (ids.length === 0) return;
  const taken = (yield* read<string[]>(ctx, TAKEN)) ?? [];
  ctx.set(TAKEN, [...taken, ...ids]);
  companionSendAt(ctx).taken(ids);
}

/** The bounds of the agent's `history`, without its model. */
function policyOf(history: Options['history']): CompactionPolicy {
  if (!history) return {};
  const { maxMessages, maxChars, retainMessages } = history;
  return { maxMessages, maxChars, retainMessages };
}

/** The answer of a run: its output, or else why it stopped. */
function answerOf<O>(result: RunResult<O>): O | string {
  if (result.status === 'completed') return result.output;
  if (result.output !== undefined) return result.output;
  return `Stopped: ${result.reason}`;
}

/** The note that says how a turn that failed for good ended. */
function noteOf(error: restate.TerminalError): string {
  if (error instanceof restate.CancelledError) return CANCELLED;
  if (error.code === REFUSED) return UNANSWERED;
  return `Failed: ${error.message}`;
}

/**
 * Runs `step` of a turn that has its answer. Restate delivers a cancellation
 * once: if it interrupts the step, the step runs again.
 */
async function despiteCancellation(step: () => Promise<unknown>) {
  try {
    await step();
  } catch (error) {
    if (!(error instanceof restate.CancelledError)) throw error;
    await step();
  }
}
