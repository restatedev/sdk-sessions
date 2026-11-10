// OpenCode on the object's database: `openOpenCode(db, fence, options)` boots
// OpenCode 2.2's embedded host (@opencode/sdk) with its database in a SQL
// session, `ctx.db`.
//
// The host is OpenCode's workerd profile, the one it boots in a Cloudflare
// Durable Object: no local filesystem, shell, terminal, npm or version
// control, config given inline, plugins given in code. Only its database
// differs. The workerd profile reads a Durable Object's SQLite, whose `exec`
// is synchronous; here OpenCode gets an Effect SqlClient instead, which is
// asynchronous, through `Database.configuredClient` (OpenCode's), the seam
// OpenCode keeps for an injected client. Each transaction is an SQL
// transaction, and the session runs statements one at a time, as OpenCode's
// own clients do.
//
// `fence.closed` refuses every statement from then on: an attempt that is
// giving up stores nothing more, as Restate fences an attempt that a newer
// one replaced.
//
// At boot, OpenCode sweeps the turns a previous process left claimed
// (`SessionRestart`): `restart` says what this boot does with them (see
// {@link Restart}), and `Host.swept` settles once the sweep is done.
//
// Step 0 of docs/opencode.md (the spike) found its seams; `./opencode/db` exports it.
import { Context, Deferred, Effect, Exit, Layer, Option, Scope } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { SqlClient, Statement } from 'effect/sql';
import { SqlError, UnknownError } from 'effect/sql/SqlError';
import type { Connection } from 'effect/sql/SqlConnection';
import { Bus } from '@opencode/core/bus';
import { Database as OpenCodeDatabase } from '@opencode/core/database/database';
import { fromPromise } from '@opencode/core/plugin/promise';
import { SessionEvent } from '@opencode/core/session/event';
import { SessionExecution } from '@opencode/core/session/execution';
import { SessionRestart } from '@opencode/core/session/execution/restart';
import { SessionStore } from '@opencode/core/session/store';
import { ConfigPluginSource } from '@opencode/core/config/plugin/source';
import { Pty } from '@opencode/core/pty';
import { Snapshot } from '@opencode/core/snapshot';
import { ServerWorkerd } from '@opencode/server/workerd';
import { OpenCode } from '@opencode/sdk/effect';
import type { Plugin } from '@opencode/plugin';
import type { DatabaseWriter, Database, SqlValue } from '@restatedev/sessions';

/** Closed: every later statement fails. */
export interface Fence {
  closed: boolean;
}

const error = (operation: string, cause: unknown) =>
  new SqlError({
    reason: new UnknownError({
      cause,
      message: cause instanceof Error ? cause.message : String(cause),
      operation,
    }),
  });

/** The connection inside a transaction, for statements of that transaction. */
const InTransaction = Context.Service<SqlClient.TransactionConnection, SqlClient.TransactionConnection.Service>(
  '@restatedev/agents/OpenCodeTransaction',
);

/** A statement that writes. */
const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;

/**
 * A connection whose statements go to `target`: the session, which runs one
 * call at a time and holds them while a transaction runs, or that
 * transaction's database. Each is refused once `fence` closes; `wrote` is
 * told of each statement that writes.
 */
function connection(target: DatabaseWriter, fence: Fence, wrote: () => void = () => {}): Connection {
  // Effect binds what the compiler made of OpenCode's values: SQL values.
  const exec = <T>(read: (sql: string, params: SqlValue[]) => Promise<T>, sql: string, params: readonly unknown[]) =>
    Effect.tryPromise({
      try: async () => {
        if (fence.closed) throw new Error('the attempt is over');
        const result = await read(sql, params as SqlValue[]);
        if (WRITE.test(sql)) wrote();
        return result;
      },
      catch: (cause) => error('execute', cause),
    });
  const run = (sql: string, params: readonly unknown[] = []) => exec((s, p) => target.query(s, p), sql, params);
  const runValues = (sql: string, params: readonly unknown[] = []) => exec((s, p) => target.values(s, p), sql, params);
  const transformed: Connection['execute'] = (sql, params, transformRows) =>
    transformRows ? Effect.map(run(sql, params), transformRows) : run(sql, params);
  return {
    execute: transformed,
    executeRaw: (sql, params) => run(sql, params),
    executeValues: (sql, params) => runValues(sql, params),
    executeValuesUnprepared: (sql, params) => runValues(sql, params),
    executeUnprepared: transformed,
    executeStream: () => {
      throw new Error('executeStream is not supported');
    },
  };
}

/**
 * An Effect SqlClient over `db`, with its statements refused once `fence`
 * closes. `committed` runs after each write is committed: a transaction that
 * wrote, or a statement that writes outside one.
 */
export function sqlClient(
  db: Database,
  fence: Fence,
  committed: () => void = () => {},
): Layer.Layer<SqlClient.SqlClient> {
  // `effect` as one SQL transaction: it commits when `effect` succeeds
  // and rolls back when it fails. Its statements go to the transaction's
  // database.
  const withTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.withFiber<A, E | SqlError, R>((fiber) => {
      if (Option.isSome(Context.getOption(fiber.context, InTransaction))) {
        return Effect.fail(error('transaction', new Error('nested transactions are not supported')));
      }
      return Effect.callback<A, E | SqlError, R>((resume) => {
        const rollback = new Error('rollback');
        let interrupted = false;
        let resumed = false;
        let wrote = false;
        // Settles when the transaction has committed, or rejects: with
        // `rollback` once `effect` failed, or with the error of BEGIN or COMMIT.
        const ended: Promise<void> = db.transaction(
          (tx) =>
            new Promise<void>((resolve, reject) => {
              if (interrupted) return reject(rollback);
              const inner = Effect.provideContext(
                effect,
                Context.add(fiber.context, InTransaction, [connection(tx, fence, () => (wrote = true)), 0]),
              );
              resumed = true;
              resume(
                // A finalizer, so that the body settles however `effect`
                // ends, an interruption included: otherwise the transaction
                // would hold the session for good.
                Effect.onExit(inner, (exit) => {
                  if (Exit.isSuccess(exit)) {
                    resolve();
                    return Effect.void;
                  }
                  reject(rollback);
                  return Effect.promise(() => settled);
                }).pipe(
                  // The commit is part of the transaction: if it fails, so
                  // does the transaction.
                  Effect.flatMap((value) =>
                    Effect.as(Effect.tryPromise({ try: () => ended, catch: (e) => error('commit', e) }), value),
                  ),
                ),
              );
            }),
        );
        ended.then(
          () => (wrote ? committed() : undefined),
          () => undefined,
        );
        const settled = ended.catch((cause: unknown) => {
          // BEGIN failed: `effect` never ran.
          if (!resumed && cause !== rollback) resume(Effect.fail(error('transaction', cause)));
        });
        return Effect.suspend(() => {
          interrupted = true;
          return Effect.promise(() => settled);
        });
      });
    });

  const make = Effect.gen(function* () {
    const client = yield* SqlClient.make({
      // Outside a transaction, a statement commits as it runs.
      acquirer: Effect.succeed(connection(db, fence, committed)),
      compiler: Statement.makeCompilerSqlite(),
      driver: 'sqlite-restate',
      spanAttributes: [['db.system.name', 'sqlite']],
      transactionService: InTransaction,
    });
    return Object.assign(client, { withTransaction, transactionStatements: false });
  });
  return Layer.effect(SqlClient.SqlClient, make).pipe(Layer.provide(Reactivity.layer));
}

/**
 * What a boot does with the turns a previous process left claimed (OpenCode's
 * execution claims), before any prompt of its own:
 *
 * - `resume`: OpenCode's own restart, however often the turn was resumed
 *   before (Restate's retry policy decides): a synthetic "Continue" message,
 *   its running tool calls failed, and a new step. A crashed attempt's turn
 *   goes on.
 * - `close`: each is closed without asking the model: an idle marker
 *   (`Execution.Failed`) and the claim released. A killed invocation's turn
 *   is over. How, `closer` says.
 * - `none`: nothing; the claims stay. A reader beside a running turn.
 */
export type Restart = 'resume' | 'close' | 'none';

/**
 * How `restart: 'close'` closes a claimed turn:
 *
 * - `own`: a `SessionRestart` of ours. Each streaming or running tool call
 *   fails with `cutOff(toolCallId, name)` as its result, then the turn with
 *   `ended`, the claim released in the same transaction.
 * - `budget`: OpenCode's own restart with no resumes left
 *   (`maxAttempts: 0`): the idle marker with OpenCode's text, the claim
 *   released; the running tool calls stay running until the next drain fails
 *   them ("Tool execution interrupted").
 */
export type Closer = 'own' | 'budget';

export interface OpenOptions {
  /** OpenCode plugins: models, tools, agents. */
  plugins?: Plugin.Plugin[];
  /** OpenCode's config (opencode.json), inline. */
  config?: Record<string, unknown>;
  /**
   * OpenCode's own filesystem, search and shell, on the local machine, for
   * its built-in tools (read, write, edit, bash, glob, grep...) in a
   * session's directory. Without it, the workerd profile has none.
   */
  local?: boolean;
  /** What this boot does with the turns left claimed (default `resume`). */
  restart?: Restart;
  /** How `close` closes them (default `budget`: the spike found ours buys little over it). */
  closer?: Closer;
  /** The result of a tool call that a closed turn left running (`own` only). */
  cutOff?: (toolCallId: string, name: string) => string;
  /** The error a closed turn ends with (`own` only). */
  ended?: string;
  /** Runs after each of OpenCode's writes is committed: for a copy of what it wrote. */
  committed?: () => void;
}

/** A booted OpenCode: `call` runs one of `client`'s calls (which return Effects); `close` shuts it down. */
export interface Host {
  client: OpenCode.Interface;
  call<A, E, R>(effect: Effect.Effect<A, E, R>): Promise<A>;
  /**
   * Settles once the boot's sweep of claimed turns is done: closed, for
   * `close`; their resumes started, for `resume`. The host forks the sweep, so
   * a prompt submitted before it settles may join a claimed turn.
   */
  swept: Promise<void>;
  close(): Promise<void>;
}

/** The result `own` gives a running tool call of a closed turn, by default. */
const CUT_OFF = 'The turn ended before this call returned: it may or may not have happened.';
/** The error `own` closes a turn with, by default. */
const ENDED = 'Ended: the turn was killed before it finished.';

/**
 * A `SessionRestart` that closes each claimed top-level session this process
 * does not run: OpenCode's budget's events (`Execution.Failed`, the release
 * as its commit), and before them a `Tool.Failed` of our result for each
 * streaming or running tool part. No synthetic message, no drain, no model.
 */
const closing = (cutOff: (toolCallId: string, name: string) => string, ended: string) =>
  Layer.effect(
    SessionRestart.Service,
    Effect.gen(function* () {
      const store = yield* SessionStore.Service;
      const execution = yield* SessionExecution.Service;
      const bus = yield* Bus.Service;
      const close = Effect.fnUntraced(function* (sessionID: Parameters<typeof store.release>[0]) {
        for (const message of yield* Effect.orDie(store.context(sessionID))) {
          if (message.type !== 'assistant') continue;
          for (const part of message.content) {
            if (part.type !== 'tool') continue;
            if (part.state.status !== 'streaming' && part.state.status !== 'running') continue;
            yield* bus.publish(SessionEvent.Tool.Failed, {
              sessionID,
              assistantMessageID: message.id,
              id: part.id,
              error: { type: 'aborted', message: cutOff(part.id, part.name) },
              executed: part.executed === true,
            });
          }
        }
        yield* bus.publish(
          SessionEvent.Execution.Failed,
          { sessionID, error: { type: 'aborted', message: ended } },
          { commit: () => store.release(sessionID) },
        );
      });
      return SessionRestart.Service.of({
        resumeSuspendedSessions: Effect.gen(function* () {
          const active = yield* execution.active;
          // Child sessions' claims: v1 has no background subagents to recover.
          yield* store.releaseChildClaims([]);
          const claimed = (yield* store.listSuspended()).filter((id) => !active.has(id));
          yield* Effect.forEach(claimed, close, { discard: true });
        }),
      });
    }),
  );

/** The sweep's service for `restart` and `closer`. */
const restarts = (
  restart: Restart,
  closer: Closer,
  cutOff: (toolCallId: string, name: string) => string,
  ended: string,
): Layer.Layer<SessionRestart.Service, never, unknown> => {
  if (restart === 'none') return Layer.succeed(SessionRestart.Service, { resumeSuspendedSessions: Effect.void });
  if (restart === 'resume') return SessionRestart.layer({ maxAttempts: Infinity });
  return closer === 'budget' ? SessionRestart.layer({ maxAttempts: 0 }) : closing(cutOff, ended);
};

/** `service`, whose sweep completes `done` as it ends, however it ends. */
const observed = (
  layer: Layer.Layer<SessionRestart.Service, never, unknown>,
  done: Deferred.Deferred<void, unknown>,
): Layer.Layer<SessionRestart.Service, never, unknown> =>
  Layer.effect(
    SessionRestart.Service,
    Effect.map(SessionRestart.Service, (inner: SessionRestart.Interface) =>
      SessionRestart.Service.of({
        resumeSuspendedSessions: inner.resumeSuspendedSessions.pipe(
          Effect.onExit((exit) => Effect.asVoid(Deferred.done(done, Exit.asVoid(exit)))),
        ),
      }),
    ),
  ).pipe(Layer.provide(layer));

/** What a replacement replaces: `LayerNode`'s own record of it (its source node). */
const sourceOf = (replacement: ReturnType<typeof ServerWorkerd.replacements>[number]): unknown => {
  const key = Object.getOwnPropertySymbols(replacement).find((s) => s.description === 'LayerNode.Replacement');
  return key && (replacement as unknown as Record<symbol, { source: unknown }>)[key]?.source;
};

/**
 * Boot OpenCode with its database in `db`; the boot sweeps the turns left
 * claimed as `restart` says. Close the host when done.
 */
export async function openOpenCode(
  db: Database,
  fence: Fence,
  {
    plugins = [],
    config = {},
    local = false,
    restart = 'resume',
    closer = 'budget',
    committed,
    cutOff = () => CUT_OFF,
    ended = ENDED,
  }: OpenOptions,
): Promise<Host> {
  // The workerd profile, but for its database, which comes first. (The
  // Promise API's OpenCode.create takes no replacements; the Effect API's does.)
  const profile = { storage: undefined as never, models: { fetch: false } };
  // Taken by the node each replaces, not by position (2.1 added Npm's). Local
  // keeps the stubs of snapshots, the pty and plugin discovery only.
  const kept = local ? new Set<unknown>([Snapshot.node, Pty.node, ConfigPluginSource.node]) : undefined;
  const rest = ServerWorkerd.replacements(profile).filter((r: Parameters<typeof sourceOf>[0]) => {
    const source = sourceOf(r);
    if (source === undefined) throw new Error('OpenCode: a workerd replacement of unknown node');
    return source !== OpenCodeDatabase.node && (kept === undefined || kept.has(source));
  });
  const scope = Scope.makeUnsafe();
  const done = Deferred.makeUnsafe<void, unknown>();
  const sweep = observed(restarts(restart, closer, cutOff, ended), done);
  const client = await Effect.runPromise(
    OpenCode.create(
      {
        ...ServerWorkerd.serverOptions({ ...profile, config: { content: JSON.stringify(config) } }),
        plugins: plugins.map(fromPromise),
      },
      {
        overrides: [
          OpenCodeDatabase.node.replace(OpenCodeDatabase.configuredClient(sqlClient(db, fence, committed))),
          ...rest,
          SessionRestart.node.replace(SessionRestart.node.mapLayer(() => sweep as never)),
        ],
      },
    ).pipe(Scope.provide(scope)),
  );
  return {
    client,
    // The client's calls need nothing more: OpenCode provided it all.
    call: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(effect as Effect.Effect<A, E>),
    swept: Effect.runPromise(Deferred.await(done)),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}
