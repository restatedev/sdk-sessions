// The tools of @restatedev/agents (tools.ts) in an agentlib agent: each made
// agentlib's own, its calls the generator SDK's, journaled, on the classic
// SDK's context of the agent's invocation, rather than a session object's.
//
// Restate's tools (`call`, `send`, `workflow`, `signal`, `subagent`) make
// the same calls as in a session object, by the same typed definitions, the
// generator SDK's way: a call is journaled, so a crash replays its answer
// rather than make it again (no call records, no idempotency keys), and
// stopping the turn cancels it. A `tool()` runs as a journaled step (a
// `run`), as agentlib's `asyncTool` does: its `ctx` has `key` and `request`,
// and no database or calls of a session's (a classic object has none).
import {
  RunFailedError,
  ToolError as LibToolError,
  type JsonValue,
  type Tool as LibTool,
  type ToolContext as LibToolContext,
} from '@restatedev/agentlib';
import type * as sessions from '@restatedev/sessions';
import { call as callHandler, internal, run, send as sendTo, serde, type Operation } from '@restatedev/restate-sdk-gen';
import { sdk as restate } from '@restatedev/sessions/internal';
import { z } from 'zod';
import type { Configure } from '../common.ts';
import { companionFor } from '../companion.ts';
import {
  isTool,
  jsonSchemaOf,
  keyed,
  sentTo,
  specOf,
  type Target,
  type TargetOptions,
  text,
  type Tool,
  type ToolSpec,
} from '../tools.ts';

/**
 * What a run of an agentlib agent gets as its context (agentlib's
 * `RunContext.context`, a tool's `context.context`): the invocation's context
 * of the classic SDK, whose calls an operation awaits with `internal.adopt`
 * of @restatedev/restate-sdk-gen.
 */
export interface AgentlibContext {
  readonly ctx: restate.ObjectContext;
}

/** A tool of agentlib (`tool`, `asyncTool`, `serviceTool`, `agentTool`, MCP's...). */
// oxlint-disable-next-line typescript/no-explicit-any -- a tool of any context: the agent's is `AgentlibContext`
export type AgentlibTool = LibTool<any>;

/**
 * An agentlib agent's tools: the tools of `@restatedev/agents` (`tool()`,
 * `call`, `send`, `workflow`, `signal`, `subagent`), each by its name, and
 * agentlib's own, by their keys, in a list, or by name.
 */
export type Tools = ReadonlyArray<Tool | Record<string, AgentlibTool>> | Record<string, AgentlibTool | Tool>;

const { adopt } = internal;

/** What a `tool()`'s context lacks in an agentlib agent: its error's message starts so. */
const MISSING = 'not in an agentlib agent:';

/** What a `tool()` reached for that an agentlib agent lacks (`what`), and what to use `instead`. */
const missing = (what: string, instead: string): never => {
  throw new restate.TerminalError(`${MISSING} ${what}: ${instead}`);
};

/**
 * A session object's context, as a `tool()` of an agentlib agent gets it:
 * the key and the request, and no database or calls (a classic object has
 * no session), which fail the turn, saying what to use instead.
 */
function sessionOf(ctx: restate.ObjectContext): sessions.SessionContext {
  const request = ctx.request();
  const calls = "give the agent Restate's tools (call, send, workflow, subagent) or agentlib's own";
  return Object.freeze({
    key: ctx.key,
    request,
    get db(): never {
      return missing('ctx.db', 'an agentlib agent keeps its conversation in its state, and has no SQL database');
    },
    get rpc(): never {
      return missing('ctx.rpc', calls);
    },
    get send(): never {
      return missing('ctx.send', calls);
    },
    get cancel(): never {
      return missing('ctx.cancel', calls);
    },
  });
}

/** `value`, or what a function of a session's context gives (a key, say), as a journaled step: see {@link sessionOf}. */
function* configuredOp<T>(value: Configure<T>, ctx: restate.ObjectContext, name: string): Operation<T> {
  if (typeof value !== 'function') return value;
  const session = sessionOf(ctx);
  return yield* run(async () => (value as (ctx: sessions.SessionContext) => T | Promise<T>)(session), { name });
}

/** The key, and the handler's input, of a tool call's input (`split` of tools.ts). */
function* split(
  target: Target,
  options: TargetOptions<z.ZodObject | undefined>,
  all: Record<string, unknown>,
  ctx: restate.ObjectContext,
  name: string,
): Operation<{ key: string | undefined; parameter: unknown }> {
  if (!keyed(target)) return { key: undefined, parameter: options.input ? all : undefined };
  if (options.key !== undefined) {
    return { key: yield* configuredOp(options.key, ctx, `${name}: key`), parameter: options.input ? all : undefined };
  }
  const { key, ...rest } = all as { key: string };
  return { key, parameter: options.input ? rest : undefined };
}

/** A call of `method` of `service` (at `key`), with JSON in and out: journaled, and cancelled with the turn. */
const callOf = (service: string, method: string, key: string | undefined, parameter: unknown) =>
  callHandler<unknown, unknown>({
    service,
    method,
    key,
    parameter,
    inputSerde: serde.json,
    outputSerde: serde.json,
  });

/**
 * Run workflow `service` (its `run`) with id `key` and `parameter` to its
 * end, and its result (`runWorkflow` of tools.ts): a call of it, whose
 * invocation id is the run's even when Restate refuses it (a `run` runs once
 * per id), and a wait for that invocation. A fixed id that ran before gets
 * its run's result. A call, not a send: stopping the turn cancels the run.
 */
function* runWorkflow(service: string, key: string, parameter: unknown): Operation<unknown> {
  const called = callHandler<unknown>({
    service,
    method: 'run',
    key,
    parameter,
    inputSerde: serde.json,
    outputSerde: serde.binary,
  });
  const reference = yield* called.invocation;
  return yield* reference.attach(serde.json);
}

/** A wait for the signal `name` (with `input`, as `pending` lists it), as the agent's companion keeps it: its value. */
const waitFor = (ctx: restate.ObjectContext, wait: { id: string; name: string; input?: unknown }) =>
  adopt(ctx.objectClient(companionFor(ctx.request().target.service), ctx.key).wait(wait));

/** What tool `t`, of `spec`, does with `input` (checked against its own), for tool call `callId` of the turn of `ctx`. */
function* perform(
  t: Tool,
  spec: ToolSpec,
  input: Record<string, unknown>,
  ctx: restate.ObjectContext,
  callId: string,
): Operation<JsonValue> {
  switch (spec.kind) {
    case 'run': {
      const session = sessionOf(ctx);
      const context = { ctx: session, callId, idempotencyKey: `${ctx.request().id}:${callId}` };
      // A journaled step, as agentlib's asyncTool: no retry limit of its own, so a failure fails the attempt,
      // and Restate retries it, as in a session object; a terminal error is the tool's answer.
      return yield* run(
        async () => text(await (spec.run as (i: unknown, c: typeof context) => unknown)(input, context)),
        {
          name: t.name,
          retry: {},
        },
      );
    }
    case 'call': {
      const { target, handler, options } = spec;
      const { key, parameter } = yield* split(target, options, input, ctx, t.name);
      if ('workflow' in target && handler === 'run') return text(yield* runWorkflow(target.name, key!, parameter));
      return text(yield* callOf(target.name, handler, key, parameter));
    }
    case 'send': {
      const { target, handler, options } = spec;
      const { key, parameter } = yield* split(target, options, input, ctx, t.name);
      sendTo({
        service: target.name,
        method: handler,
        key,
        parameter,
        inputSerde: serde.json,
        ...(options.delay === undefined ? {} : { delay: options.delay }),
      });
      return sentTo(target.name, key, handler);
    }
    case 'workflow': {
      const { target, options } = spec;
      const key =
        options.key === undefined ? `${ctx.key}-${callId}` : yield* configuredOp(options.key, ctx, `${t.name}: key`);
      return text(yield* runWorkflow(target.name, key, options.input ? input : undefined));
    }
    case 'signal': {
      const id = `${ctx.request().id}:${callId}`;
      return text(yield* waitFor(ctx, { id, name: spec.name, ...(spec.shown ? { input } : {}) }));
    }
    case 'subagent': {
      const { name, task } = input as { name: string; task: string };
      return text(yield* callOf(spec.agent, spec.handler, `${ctx.key}.${name}`, task));
    }
    default:
      throw new Error(`the tool ${t.name} does what no agentlib agent knows`);
  }
}

/**
 * `t`, a tool of `@restatedev/agents`, as agentlib's: its name, description
 * and input (checked as in a session object: arguments that do not fit are
 * the model's to fix), and what it does, the generator SDK's way.
 */
export function fromTool(t: Tool): AgentlibTool {
  const spec = specOf(t);
  if (!spec) throw new Error(`the tool ${t.name} is no tool of @restatedev/agents' (tool(), call, send...)`);
  return {
    description: t.description,
    inputSchema: jsonSchemaOf(t),
    *execute(args: JsonValue, { context, callId }: LibToolContext<AgentlibContext>) {
      const parsed = t.input.safeParse(args);
      if (!parsed.success) {
        throw new LibToolError(`the arguments do not fit the tool's input: ${z.prettifyError(parsed.error)}`, 'input');
      }
      try {
        return yield* perform(t, spec, parsed.data, context.ctx, callId);
      } catch (error) {
        // A tool() that reached for what an agentlib agent lacks: a programming error, which fails the turn,
        // rather than an answer for the model to act on.
        if (error instanceof restate.TerminalError && error.message.startsWith(MISSING)) {
          throw new RunFailedError(`the tool ${t.name}: ${error.message}`);
        }
        throw error;
      }
    },
  };
}

/** `tools` (see {@link Tools}) by name, as agentlib takes them: two of one name are a mistake of agent `agent`'s. */
export function toolsOf(agent: string, tools: Tools): Record<string, AgentlibTool> {
  const named: Record<string, AgentlibTool> = {};
  const add = (name: string, t: AgentlibTool | Tool) => {
    if (name in named) throw new Error(`${agent}: two tools are named ${name}`);
    named[name] = isTool(t) ? fromTool(t) : t;
  };
  const addAll = (record: Record<string, AgentlibTool | Tool>) => {
    for (const [name, t] of Object.entries(record)) add(name, t);
  };
  if (Array.isArray(tools)) {
    for (const t of tools as ReadonlyArray<Tool | Record<string, AgentlibTool>>) {
      if (isTool(t)) add(t.name, t);
      else addAll(t);
    }
  } else addAll(tools as Record<string, AgentlibTool | Tool>);
  return named;
}
