// An attempt's database: the session's database, kept in the object's state
// (database.ts), opened as an exclusive attempt starts (a view's on its first
// read) and saved when the handler ends; and its transactions, with the sends
// each commits with (`tx.send`): on the VM, inside the commit's atomic group.
import type * as restate from '@restatedev/restate-sdk';
import { CancelledError, serde, TerminalError } from '@restatedev/restate-sdk';
import { millisOrDurationToMillis, type Serde } from '@restatedev/restate-sdk-core';
import {
  open,
  openOnVm,
  type Row,
  sqlOver,
  SqlError,
  type Connection,
  type DatabaseWriter,
  type SqlParam,
  type DatabaseReader,
  type SqlValue,
  type Store,
  type ConnectionTransaction,
  type Working,
} from './database.ts';
import type { Vm, VmGroupSend } from './vm.ts';
import { Link } from './link.ts';
import { apply, dropAll, ensureOf, ensuring, type Schema } from './schema.ts';
import { type Send, sendOf } from './calls.ts';

export type { DatabaseReader, DatabaseWriter, Row, SqlParam, SqlValue };

/**
 * The session's database, `ctx.db`, for the whole handler: each statement
 * outside {@link transaction} is its own transaction. Calls run one at a
 * time, in call order.
 */
export interface Database extends DatabaseWriter {
  /**
   * Run `body` as one transaction: it commits when `body` resolves, and rolls
   * back when it rejects. It holds the database: other calls wait until it
   * ends, and a call to the database from inside `body` is refused, as it
   * would wait for `body`. So `body` uses the `tx` it gets, which is invalid
   * once `body` settles.
   */
  transaction<T>(body: (tx: Transaction) => Promise<T>): Promise<T>;
}

/** One transaction of a {@link Database}: its SQL, and the sends it commits with. */
export interface Transaction extends DatabaseWriter {
  /**
   * Sends that commit with the transaction, and never if it rolls back: on
   * Restate, in the commit's atomic group, so the rows and the sends are
   * stored together or not at all.
   */
  readonly send: Send;
  /**
   * Settles, and never rejects, once another call to `ctx.db` waits for this
   * transaction to end. A body that keeps the transaction open for more work
   * can return when it settles, so that the other call waits for one commit
   * and no more.
   */
  readonly queued: Promise<void>;
}

/** What the session needs of the handler's context. */
export interface SqlHost {
  /** A shared handler's: it reads beside the exclusive one, and stores nothing. */
  readonly shared: boolean;
  readonly key: string;
  /** Rejects when the attempt ends (suspended, or aborted). */
  readonly invocationEndPromise: { readonly promise: Promise<unknown> };
  // oxlint-disable-next-line typescript/no-explicit-any
  readonly defaultSerde: Serde<any>;
  request(): { readonly id: string; readonly target: { readonly service: string } };
  get(name: string, serde: Serde<Uint8Array>, options: restate.EntryOptions): PromiseLike<Uint8Array | null>;
  set(name: string, value: Uint8Array, serde: Serde<Uint8Array>, options: restate.EntryOptions): void;
  clear(name: string, options: restate.EntryOptions): void;
  /** The object's state keys. */
  stateKeys(): PromiseLike<string[]>;
  run(name: string, action: () => void): PromiseLike<void>;
  /**
   * The attempt's VM, when it has one: the addon then reads and writes the
   * object's state as the VM's own commands, and none of it crosses into
   * JavaScript (see `openOnVm`).
   */
  readonly vm?: Vm;
  /**
   * Whether a cancellation is owed to the handler's next await, taking it:
   * the attempt's driver has one when a cancellation arrived that failed
   * nothing the handler awaits. Absent where the SDK's context serves the
   * attempt, whose own awaits fail with it.
   */
  readonly takeCancellation?: () => boolean;
  /**
   * Keeps the attempt alive while a call of the database runs: the VM's
   * attempt has it (`driver.ts`), the SDK's context does not.
   */
  readonly working?: Working;
  /**
   * Run `fn` inside a span `name`, shown in Restate's UI, with the actions it
   * makes nested under it: the VM's attempt has it (`driver.ts`).
   */
  readonly span?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  /** The span the code running now is inside of, if any: the VM's attempt has it. */
  readonly currentSpan?: () => number | undefined;
  genericSend(send: restate.GenericSend<Uint8Array>): unknown;
}

/** What a session object gives its attempts: its schema, and a wrapper of its store (fault injection, in tests). */
export interface ObjectConfig {
  /** The object's own schema, which each of its databases is made by. */
  readonly schema?: Schema;
  wrapStore?: (store: Store) => Store;
}

/** The end of an attempt, as `invocationEndPromise` rejects with it, for the requests that would otherwise wait for it. */
class AttemptEnd {
  private ended: Error | undefined;
  /** The rejections of the requests waiting. */
  private readonly waiting = new Set<(error: Error) => void>();
  private readonly listeners = new Set<() => void>();

  constructor(end: Promise<unknown>) {
    end.catch((error: unknown) => {
      const ended = error instanceof Error ? error : new Error(String(error));
      this.ended = ended;
      for (const reject of this.waiting) reject(ended);
      this.waiting.clear();
      for (const listener of this.listeners) listener();
      this.listeners.clear();
    });
  }

  /**
   * `promise`, or a rejection once the attempt ends: an attempt that is
   * suspended or aborted never settles what it was waiting for.
   */
  race<T>(promise: PromiseLike<T>): Promise<T> {
    if (this.ended) return Promise.reject(this.ended);
    return new Promise<T>((resolve, reject) => {
      this.waiting.add(reject);
      void Promise.resolve(promise)
        .finally(() => this.waiting.delete(reject))
        .then(resolve, reject);
    });
  }

  /** Call `listener` when the attempt ends; the returned function cancels it. */
  onEnd(listener: () => void): () => void {
    if (this.ended) {
      listener();
      return () => {};
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

// A state command is named after its key, so that tooling can hide the
// database's head, tail and packs by name (`dev.restate.tooling.journal.hidden.name.prefix`).
const named = (key: string): restate.EntryOptions => ({ name: key });

// A shared handler's reader writes nothing.
const refusedWrite = () => {
  throw new Error('a shared handler writes no state');
};

/**
 * The keys of the database `name`, apart from the object's own: each of the
 * format's keys (`v22/head`, `v22/tail/...`, `v22/manifest/...`,
 * `v22/pack/...`) as `v22/db/<name>/head`, under the format's prefix still,
 * which tooling hides, and under none of the object's database's.
 */
const beside = (name: string) => (key: string) => {
  const at = key.indexOf('/') + 1;
  return `${key.slice(0, at)}db/${name}/${key.slice(at)}`;
};

/**
 * The format's key of a key of the database `name` (undoes {@link beside});
 * `undefined` for any other key of the object.
 */
const unbeside = (name: string) => (key: string) => {
  const at = key.indexOf('/') + 1;
  const prefix = `db/${name}/`;
  return at > 0 && key.startsWith(prefix, at) ? key.slice(0, at) + key.slice(at + prefix.length) : undefined;
};

/**
 * The object's state as an ordered store, over a context without the VM (a
 * test's): `get` is a state get, `set` and `clear` are state writes, which
 * return at once and which the context stores in order; `sync` is its `run`,
 * acknowledged after the writes before it. A `get` or `sync` the attempt's
 * end leaves waiting rejects, so the session that made it ends instead of
 * holding its lock for the life of the process. One cancelled fails as any
 * await does: the session it ends fails its calls with the CancelledError
 * (see `open`). On the VM the addon reads and writes the state itself
 * (`openOnVm`), and none of this is used.
 */
function objectStore(ctx: SqlHost, end: AttemptEnd, dbName: string | undefined): Store {
  const keyOf = dbName === undefined ? (key: string) => key : beside(dbName);
  const request = <T>(promise: PromiseLike<T>) => end.race(promise);
  // TODO: read with protocol v8's ephemeral get, left out of the journal, once
  // a Restate release ships v8 and the SDK lets a library make one. Restate 1.8
  // negotiates v7 at most: a journaled get.
  const get = async (key: string) => (await request(ctx.get(keyOf(key), serde.binary, named(keyOf(key))))) ?? undefined;
  if (ctx.shared) return { get, set: refusedWrite, clear: refusedWrite, sync: async () => {} };
  return {
    get,
    set: (key, value) => ctx.set(keyOf(key), value, serde.binary, named(keyOf(key))),
    clear: (key) => ctx.clear(keyOf(key), named(keyOf(key))),
    // The database's keys, for a garbage collection.
    keys: async () => {
      const keys = await request(ctx.stateKeys());
      if (dbName === undefined) return keys;
      const own = unbeside(dbName);
      return keys.flatMap((key) => own(key) ?? []);
    },
    sync: async () => {
      await request(ctx.run('sync', () => {}));
    },
  };
}

/**
 * What a failed call to the session fails the handler with: an
 * {@link SqlError}, which a retry would repeat, becomes a
 * {@link TerminalError}, its `cause` the SQL error. Anything else is as for
 * any handler: a storage error, which ends the session, or the handler's own
 * (a failed request to another service, say) is retried, unless it is a
 * TerminalError itself.
 */
function handlerError(error: unknown): unknown {
  if (!(error instanceof SqlError)) return error;
  const terminal = new TerminalError(error.message);
  terminal.cause = error;
  return terminal;
}

/** `call`'s result, or the error the handler fails with (see {@link handlerError}). */
function forHandler<T>(call: Promise<T>): Promise<T> {
  return call.catch((error: unknown) => {
    throw handlerError(error);
  });
}

/** {@link forHandler} of a call that answers with its value when it is ready: then it is the value, which only this package takes so. */
function forHandlerNow<T>(call: T | Promise<T>): T | Promise<T> {
  return call instanceof Promise ? forHandler(call) : call;
}

/** The SQL of a transaction's body: `tx`'s, failing as {@link forHandler} does. */
function forBody(tx: ConnectionTransaction): DatabaseWriter & { readonly queued: Promise<void> } {
  return {
    ...sqlOver((sql, params) => forHandlerNow(tx.queryColumnsNow(sql, params)), handlerError),
    queued: tx.queued,
  };
}

/** The connection's transaction behind a `tx` of a body, for the SQL it defers ({@link deferSql}). */
const DEFERRED = new Link<ConnectionTransaction>('deferred sql');

/**
 * Have `sql` (one statement, no parameters) run just before the next call of
 * the transaction `tx`, in the same crossing of the addon: the statement and
 * its order are those of a call made now, and what it spares is the call.
 * Its failure is the next call's (or the commit's, if none comes). Returns
 * false, queuing nothing, if the transaction cannot (a `tx` of another
 * kind, or an addon without it): run the statement with `tx.execute`.
 */
export function deferSql(tx: Transaction, sql: string): boolean {
  return DEFERRED.of(tx)?.defer(sql) ?? false;
}

/** Take back the last `sql` that {@link deferSql} queued on `tx` and no call has taken: it never runs. Whether it was taken back. */
export function undeferSql(tx: Transaction, sql: string): boolean {
  return DEFERRED.of(tx)?.undefer(sql) ?? false;
}

/**
 * `connection`, opened without the SDK (`open`), as a handler's `ctx.db`:
 * for a library's tests, and tools. Its transactions send nothing, and a
 * library's schema applies to it (`Schema.ensure`).
 */
export function asDatabase(connection: Connection): Database {
  const db: Database = {
    ...sqlOver((sql, params) => connection.queryColumnsNow(sql, params)),
    transaction: (body) => connection.transaction((tx) => body(DEFERRED.on({ ...forBody(tx), send: refusedSend }, tx))),
  };
  return ensuring(db, (schemas) => apply(connection, schemas));
}

/** How a transaction of `ctx.db` empties the database ({@link reset}). */
const RESET = new Link<() => Promise<void>>('reset');

/**
 * Empty the key's database in `tx`, a transaction of an exclusive handler's
 * `ctx.db`: every table, view, index and trigger is dropped, the schemas are
 * applied again (the object's, and the libraries' the attempt applied). It
 * commits with `tx`: what `tx` writes after it are the new database's first
 * rows, in the same commit, and its sends commit with it.
 */
export function reset(tx: Transaction): Promise<void> {
  const of = RESET.of(tx);
  if (of === undefined) throw new TerminalError("reset takes a transaction of an exclusive handler's ctx.db");
  return forHandler(of());
}

/**
 * A database that `opener` opens on its first call, as a handler's `ctx.db`
 * opens: for tests, which give each attempt one over the same state.
 */
export function lazyDatabase(opener: () => Promise<Database>): Database {
  let opened: Promise<Database> | undefined;
  const db = () => (opened ??= opener());
  const lazy: Database = {
    query: async (sql, params) => (await db()).query(sql, params),
    get: async (sql, params) => (await db()).get(sql, params),
    values: async (sql, params) => (await db()).values(sql, params),
    execute: async (sql, params) => (await db()).execute(sql, params),
    transaction: async (body) => (await db()).transaction(body),
  };
  return ensuring(lazy, async (schemas) => {
    const inner = await db();
    const ensure = ensureOf(inner);
    if (ensure === undefined)
      throw new TerminalError("lazyDatabase opens a handler's ctx.db, or a database of asDatabase");
    await ensure(schemas);
  });
}

/** The sends of a transaction that cannot send: a shared handler's, or another database's. */
const refusedSend: Send = () => {
  throw new TerminalError("a send of a transaction is an exclusive handler's, in the object's own database");
};

// A transaction's sends commit with it. On the VM they go in the commit's
// atomic group, after its writes (`commitWith`): Restate applies the rows and
// the sends together, or neither, so nothing has to remember them across a
// crash. A transaction that wrote nothing sends in a group of its own, and
// resolves once that is applied. Without the VM (a test's context), they are
// made right after the commit's writes, before its sync (`withCommit`).

/** A send of a transaction, its parameter serialized. */
interface PendingSend {
  service: string;
  handler: string;
  key?: string;
  parameter: Uint8Array;
  /** In milliseconds. */
  delay?: number;
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

function pendingSend(send: restate.GenericSend<unknown>): PendingSend {
  const { service, method, key, parameter, inputSerde, delay, idempotencyKey, headers } = send;
  return {
    service,
    handler: method,
    ...(key !== undefined ? { key } : {}),
    parameter: (inputSerde ?? serde.binary).serialize(parameter),
    ...(delay !== undefined ? { delay: millisOrDurationToMillis(delay) } : {}),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    ...(headers !== undefined ? { headers } : {}),
  };
}

/** `send` as the commit's atomic group makes it. */
const groupSend = (send: PendingSend): VmGroupSend => ({
  target: {
    service: send.service,
    handler: send.handler,
    ...(send.key !== undefined ? { key: send.key } : {}),
    ...(send.idempotencyKey !== undefined ? { idempotencyKey: send.idempotencyKey } : {}),
    ...(send.headers !== undefined
      ? { headers: Object.entries(send.headers).map(([key, value]) => ({ key, value })) }
      : {}),
  },
  input: send.parameter,
  ...(send.delay !== undefined ? { delay: send.delay } : {}),
  name: `${send.service}/${send.handler}`,
});

/** How a handler ended. */
type Outcome<T> = { value: T } | { error: unknown };

/** The attempt of a `ctx.db`: for {@link database}. */
const ATTEMPT = new Link<Attempt>('database');

/** A write that rides the next commit of a database, in that commit's transaction. */
type Rider = (tx: Transaction) => Promise<void>;

/** A pending {@link Rider}, and whether it may not wait for a commit that is not under way. */
interface Pending {
  write: Rider;
  urgent: boolean;
}

/**
 * Have `write` run in the next transaction of `db` that commits, before its
 * commit, rather than commit on its own: for bookkeeping that must be stored
 * with the next write, not before it. A write by `db.execute` outside a
 * transaction, made while a rider is pending, is that transaction; a read
 * (`get`, `values`, `query`) is not, and writes nothing. A transaction that
 * rolls back leaves the rider pending, and so does one that ends the handler
 * before it commits: {@link flushRiders} writes what is left.
 *
 * A database has one rider per `slot`: a later one replaces the earlier, and
 * `undefined` clears it. A rider registered while a commit that runs the
 * earlier one is under way is for the commit after. Returns false, registering
 * nothing, for a database that cannot (a view's, another kind of
 * `Database`): the caller writes at once.
 *
 * An `urgent` rider waits only for a transaction that is under way: if none
 * is at the end of the macrotask it was registered in (or of the one in which
 * a transaction ended and left it pending), it is written in a transaction of
 * its own. A transaction that is held open (a batch of commits) is under way,
 * and writes it when it commits. A write of its own that fails is not
 * retried and raises nothing: the rider stays pending for the next commit or
 * {@link flushRiders}. A rider that replaces an urgent one stays urgent.
 */
export function rideCommit(
  db: Database,
  slot: string,
  write: Rider | undefined,
  { urgent = false }: { urgent?: boolean } = {},
): boolean {
  return ATTEMPT.of(db)?.ride(slot, write, urgent) ?? false;
}

/**
 * Write what is pending ({@link rideCommit}) in a transaction of its own, and resolve once it is stored. A
 * transaction under way that commits first writes it, and this commits nothing; one that rolls back leaves
 * it, and this writes it. Nothing, if nothing is pending.
 */
export async function flushRiders(db: Database): Promise<void> {
  await ATTEMPT.of(db)?.flushRiders();
}

// A database's name (`database`).
const DATABASE_NAME = /^[\w.-]{1,64}$/;

/**
 * The database `name` of the key, apart from the object's own (`ctx.db`, of
 * the attempt whose session `db` is): for a library whose tables must be
 * alone in their database, such as OpenCode's. It opens on its first use,
 * and ends with the attempt, as `ctx.db` does. A name is 1 to 64 letters,
 * digits, `_`, `-` or `.`.
 */
export function database(db: Database, name: string): Database {
  if (!DATABASE_NAME.test(name)) throw new TerminalError(`database: ${JSON.stringify(name)} is not a database name`);
  const attempt = ATTEMPT.of(db);
  if (attempt === undefined) throw new TerminalError("database takes a handler's ctx.db");
  return attempt.database(name);
}

/** The sends of one transaction, as its body makes them (`tx.send`), until it ends. */
class Sends {
  private readonly sends: PendingSend[] = [];
  private open = true;
  readonly send: Send = sendOf((send) => {
    if (!this.open) throw new TerminalError('the transaction has ended: send from inside its body');
    this.sends.push(pendingSend(send));
  });

  /** The body ended: the transaction's sends. */
  close(): PendingSend[] {
    this.open = false;
    return this.sends;
  }
}

/**
 * One session of an attempt's database, from its open on. A failure ends it:
 * its open's, or a request's since. It closes as the attempt ends, unless the
 * attempt ends it first ({@link end}).
 */
class Session {
  readonly ready: Promise<Connection>;
  /** A call failed on it once a failure ended it: the next call opens another. */
  retired = false;
  private connection: Connection | undefined;
  /** Its connection, once its open settled. */
  get opened(): Connection | undefined {
    return this.connection;
  }
  private failed = false;
  private release: () => void = () => {};

  constructor(ready: Promise<Connection>, end: AttemptEnd) {
    this.ready = ready;
    void this.track(end);
  }

  /** Whether a failure ended it. */
  get ended(): boolean {
    return this.failed || this.connection?.isUsable() === false;
  }

  /** Its connection, or none if the open failed; the attempt's end no longer closes it. */
  async end(): Promise<Connection | undefined> {
    const db = await this.ready.catch(() => undefined);
    this.release();
    return db;
  }

  /** Close it now. */
  close(): void {
    void this.end()
      .then((db) => db?.close())
      .catch(() => {});
  }

  private async track(end: AttemptEnd) {
    try {
      const db = await this.ready;
      this.connection = db;
      // A handler still waiting for something else when the attempt ends (a
      // model request, say) keeps the session no longer: it closes once no
      // statement runs, and the handler's later calls fail.
      this.release = end.onEnd(() => void db.close().catch(() => {}));
    } catch {
      this.failed = true;
    }
  }
}

/**
 * An attempt's SQL session: opened on its first use, or as an exclusive
 * attempt starts ({@link openNow}), shared by everything the handler does,
 * and saved when the handler ends ({@link end}). With `name`, of the key's
 * database `name` ({@link database}), which has neither the object's schema
 * nor sends.
 */
export class Attempt {
  /** `ctx.db`. */
  readonly db: Database;
  private readonly ctx: SqlHost;
  /** Its object's: the key's other databases share its store's wrapper, and have none of its schema. */
  private readonly config: ObjectConfig;
  private readonly name: string | undefined;
  /** Whether it is the object's own database of an exclusive handler: the one whose transactions send. */
  private readonly sends: boolean;
  /** The key's other databases this attempt opened, by name. */
  private readonly databases = new Map<string, Attempt>();
  /** The session, from its first use on. */
  private session: Session | undefined;
  /** The calls made on the session that have not reached its connection yet: see {@link call}. */
  private unhanded = 0;
  /** The writes that ride the next commit, by slot ({@link rideCommit}). */
  private readonly riders = new Map<string, Pending>();
  /** The transactions asked for and not finished: one that is under way writes the riders. */
  private active = 0;
  /** The macrotask at the end of which an urgent rider is written alone, if one is set. */
  private urgentTimer: NodeJS.Immediate | undefined;
  /** The schemas this attempt's database has all the steps of. */
  private readonly ensured = new Map<string, Schema>();
  private ended = false;

  constructor(ctx: SqlHost, config: ObjectConfig = {}, name?: string) {
    this.ctx = ctx;
    this.config = config;
    this.name = name;
    this.sends = !ctx.shared && name === undefined;
    const base = sqlOver(
      (sql, params) => this.askedNow(() => this.callNow((db) => db.queryColumnsNow(sql, params))),
      handlerError,
    );
    this.db = {
      ...base,
      // A write while a rider is pending is the transaction it rides.
      execute: (statement, params) =>
        this.riders.size > 0
          ? this.asked(() => this.transaction((tx) => tx.execute(statement, params)))
          : base.execute(statement, params),
      // A transaction of the handler's is a span in Restate's UI, with its commit inside.
      transaction: (body) =>
        this.asked(() =>
          ctx.span === undefined ? this.transaction(body) : ctx.span('transaction', () => this.transaction(body)),
        ),
    };
    ensuring(this.db, (schemas) => this.asked(() => this.call((db) => this.ensureSchemas(db, schemas))));
    ATTEMPT.on(this.db, this);
  }

  /** The key's database `name`, in this attempt: see {@link database}. */
  database(name: string): Database {
    if (this.ended) throw new Error('the handler has ended: its SQL session is closed');
    let other = this.databases.get(name);
    if (other === undefined) this.databases.set(name, (other = new Attempt(this.ctx, this.config, name)));
    return other.db;
  }

  /** {@link rideCommit}. */
  ride(slot: string, write: Rider | undefined, urgent: boolean): boolean {
    if (this.ctx.shared || this.ended) return false;
    if (write === undefined) this.riders.delete(slot);
    else {
      this.riders.set(slot, { write, urgent: urgent || (this.riders.get(slot)?.urgent ?? false) });
      this.arm();
    }
    return true;
  }

  /** Have the urgent riders written at the end of this macrotask, if any is pending and none is set. */
  private arm() {
    if (this.urgentTimer !== undefined || this.ended) return;
    if (![...this.riders.values()].some((r) => r.urgent)) return;
    this.urgentTimer = setImmediate(() => {
      this.urgentTimer = undefined;
      // A transaction under way writes them, or re-arms as it ends.
      if (this.ended || this.active > 0) return;
      // A failure leaves them pending, for the next commit or the flush, and is not tried again by a timer. After a
      // success, one that came while it committed (its own timer found it under way) is set now.
      this.transaction(async () => {}, false).then(
        () => this.arm(),
        () => {},
      );
    });
  }

  /** {@link flushRiders}, as a transaction of `db`: its commit writes them. */
  async flushRiders() {
    if (this.riders.size === 0) return;
    // Queued behind a transaction under way, which writes them as it commits: then there is nothing to write,
    // and this one rolls back, which commits nothing.
    let nothing = false;
    try {
      await this.db.transaction(async () => {
        if (this.riders.size > 0) return;
        nothing = true;
        throw new Error('no rider is pending');
      });
    } catch (error) {
      if (!nothing) throw error;
    }
  }

  /**
   * `call`, which the handler asked for, unless a cancellation is owed to
   * it: then the call fails with the cancellation, and does nothing.
   *
   * This is where the database delivers a cancellation, and the only place.
   * What the handler asks for passes through here; what the session does for
   * itself does not — the open, the object's schema — and a cancellation
   * that failed one of those would be delivered to nobody. And it is
   * before the call issues anything, so a call that fails with
   * `CancelledError` wrote nothing and sent nothing: a call already under way
   * when the cancellation arrives runs to its end, and the cancellation goes
   * to what the handler awaits next.
   */
  private asked<T>(call: () => Promise<T>): Promise<T> {
    if (this.ctx.takeCancellation?.()) return Promise.reject(new CancelledError());
    return call();
  }

  /** {@link asked} for a call that answers with its value when it is ready ({@link callNow}). */
  private askedNow<T>(call: () => T | Promise<T>): T | Promise<T> {
    if (this.ctx.takeCancellation?.()) return Promise.reject(new CancelledError());
    return call();
  }

  /**
   * Open the session now, as the attempt starts, rather than on its first
   * call: its head is read, and the object's schema applied, while the
   * handler gets going.
   */
  openNow() {
    if (this.sends && this.session === undefined) this.current().ready.catch(() => {});
  }

  /**
   * The handler ended with `outcome`: the key's other databases end, then
   * this one ({@link endSession}).
   */
  async end<T>(outcome: Outcome<T>): Promise<T> {
    // The key's other databases end first, as the handler left them.
    const databases = await Promise.allSettled([...this.databases.values()].map((d) => d.end({ value: undefined })));
    const value = await this.endSession(outcome);
    const failed = databases.find((d) => d.status === 'rejected');
    if (failed) throw failed.reason;
    return value;
  }

  /**
   * `body` as one transaction. In the object's own database of an exclusive
   * handler, its sends commit with it: on the VM, inside the commit's atomic
   * group, after its writes (`commitWith`), so Restate stores them only if it
   * stores the commit; without it, right after the commit's writes and
   * before its sync (`withCommit`).
   */
  private async transaction<T>(body: (tx: Transaction) => Promise<T>, rearm = true): Promise<T> {
    this.active++;
    try {
      return await this.transacted(body);
    } finally {
      this.active--;
      // What it left pending (it rolled back, or the rider came after it ran them) is for the end of this macrotask.
      if (rearm) this.arm();
    }
  }

  private async transacted<T>(body: (tx: Transaction) => Promise<T>): Promise<T> {
    // The riders this transaction wrote: pending until it has committed.
    let rode: [string, Pending][] = [];
    const value = await this.call((db) =>
      db.transaction(async (handle) => {
        const sends = this.sends ? new Sends() : undefined;
        const tx: Transaction = { ...forBody(handle), send: sends?.send ?? refusedSend };
        // A view's writes stay in its session: it has nothing to reset.
        DEFERRED.on(tx, handle);
        if (!this.ctx.shared) RESET.on(tx, () => this.reset(handle));
        let made: PendingSend[] = [];
        let result: T;
        try {
          result = await body(tx);
        } finally {
          made = sends?.close() ?? [];
        }
        // After the body, which may have registered one (a transaction held open for more work), and before the commit.
        if (this.riders.size > 0) {
          rode = [...this.riders];
          for (const [, { write }] of rode) await write(tx);
        }
        this.commitSends(handle, made);
        return result;
      }),
    );
    // One registered since is for the next commit.
    for (const [slot, pending] of rode) if (this.riders.get(slot) === pending) this.riders.delete(slot);
    return value;
  }

  /** Have `handle`'s commit make `sends` (see {@link transaction}). */
  private commitSends(handle: ConnectionTransaction, sends: PendingSend[]) {
    if (this.ctx.vm !== undefined) {
      const parentSpan = this.ctx.currentSpan?.();
      handle.commitWith({ sends: sends.map(groupSend), ...(parentSpan !== undefined ? { parentSpan } : {}) });
      return;
    }
    if (sends.length === 0) return;
    handle.withCommit(() => {
      for (const { handler, parameter, ...send } of sends) {
        this.ctx.genericSend({ ...send, method: handler, parameter, inputSerde: serde.binary });
      }
    });
  }

  /**
   * `call` on the session, opening it on the first; its failure as the
   * handler fails with it. The call that fails on a session that a failure
   * ended is its last: the next opens another, which reads what is stored.
   * So the failure of an open made as the attempt started goes to the first
   * call, as it would had that call opened it.
   */
  private async call<T>(call: (db: Connection) => Promise<T>): Promise<T> {
    const session = this.current();
    // Counted until it reaches the connection, which orders it from there on.
    this.unhanded++;
    let counted = true;
    const handed = () => {
      if (counted) this.unhanded--;
      counted = false;
    };
    try {
      const db = await session.ready;
      handed();
      return await call(db);
    } catch (error) {
      handed();
      if (session.ended) session.retired = true;
      throw handlerError(error);
    }
  }

  /**
   * {@link call} for a call that answers with its value when it is ready: it
   * is the value, without a promise, which only this package takes so. That
   * is for a session that is open, and with no call before it still to reach
   * the connection (a call made before it, which waits for the session, must
   * run first): anything else is {@link call}.
   */
  private callNow<T>(call: (db: Connection) => T | Promise<T>): T | Promise<T> {
    const session = this.session;
    const db = session?.opened;
    if (this.unhanded > 0 || session === undefined || db === undefined || session.retired || this.ended) {
      return this.call(async (connection) => call(connection));
    }
    // As `call` fails: a session that a failure ended is retired by the call that fails on it.
    const failure = (error: unknown): unknown => {
      if (session.ended) session.retired = true;
      return handlerError(error);
    };
    let result: T | Promise<T>;
    try {
      result = call(db);
    } catch (error) {
      return Promise.reject(failure(error));
    }
    return result instanceof Promise
      ? result.catch((error: unknown) => {
          throw failure(error);
        })
      : result;
  }

  /** The session, opening one if there is none, or the one there is was retired. */
  private current(): Session {
    if (this.ended) throw new Error('the handler has ended: its SQL session is closed');
    if (this.session?.retired) this.session.close();
    if (this.session === undefined || this.session.retired) this.session = this.open();
    return this.session;
  }

  private open(): Session {
    const end = new AttemptEnd(this.ctx.invocationEndPromise.promise);
    return new Session(this.start(end), end);
  }

  private async start(end: AttemptEnd): Promise<Connection> {
    const ctx = this.ctx;
    // The page cache's: the key escaped, so that no key reads as another's
    // database (a name has no `/`).
    const key = `${ctx.request().target.service}/${encodeURIComponent(ctx.key)}`;
    const namespace = this.name === undefined ? key : `${key}/${this.name}`;
    const wrap = this.config.wrapStore;
    // With a VM, the addon reads and writes the state itself and nothing of
    // the store crosses into JavaScript. A wrapper (fault injection, through
    // `withStoreWrapper`) would then have nothing to wrap, and using the
    // JavaScript store instead would quietly test the other path: the tests
    // that wrap give their attempts no VM, so this says so rather than
    // choosing for them.
    if (ctx.vm !== undefined && wrap !== undefined) {
      throw new TerminalError(
        'withStoreWrapper wraps the store of an attempt served by the SDK; an attempt on the VM has none to wrap',
      );
    }
    const store = () => objectStore(ctx, end, this.name);
    const db =
      ctx.vm !== undefined
        ? await openOnVm(namespace, ctx.vm, { name: this.name, reader: ctx.shared, working: ctx.working })
        : await open(namespace, wrap ? wrap(store()) : store(), { reader: ctx.shared });
    try {
      // A view writes nothing: a write fails, rather than vanish with the attempt.
      if (ctx.shared) await db.execute('PRAGMA query_only = 1');
      // A view's too, whose writes are never stored: a key never written reads as empty tables.
      const own = this.ownSchema();
      if (own) await this.ensureSchemas(db, [own]);
    } catch (error) {
      await db.close();
      throw error;
    }
    return db;
  }

  /**
   * End the session, then settle as the handler did: an SQL error that
   * escaped it becomes terminal. The handler's error stands: what it
   * committed is stored, with its sends. A failure to end the session fails
   * a handler that succeeded, which a retry then ends (a transaction it left
   * open, say).
   */
  private async endSession<T>(outcome: Outcome<T>): Promise<T> {
    this.ended = true;
    if (this.urgentTimer !== undefined) clearImmediate(this.urgentTimer);
    this.urgentTimer = undefined;
    const failed = await this.close().then(
      () => undefined,
      (error: unknown) => ({ error }),
    );
    if ('error' in outcome) throw handlerError(outcome.error);
    if (failed !== undefined) throw handlerError(failed.error);
    return outcome.value;
  }

  /**
   * Close the session as the attempt ends. A view's closes: it read the
   * snapshot it opened on, and one that outlived 16 commits failed its read
   * ("is gone"), which is retried. Another is saved; one that a failure ended
   * closes, and what it committed is stored as it was.
   */
  private async close(): Promise<void> {
    if (this.session === undefined) return;
    const db = await this.session.end();
    if (this.ctx.shared) return db?.close();
    if (db?.isUsable()) return this.save(db);
    await db?.close().catch(() => {});
  }

  /** Save the session, which closes if that fails. */
  private async save(db: Connection) {
    try {
      await db.save();
    } catch (error) {
      await db.close().catch(() => {});
      throw error;
    }
  }

  /** The object's schema, which the key's other databases have none of. */
  private ownSchema(): Schema | undefined {
    return this.name === undefined ? this.config.schema : undefined;
  }

  /** Empty the database in the transaction `handle` ({@link reset}), and apply the schemas this attempt applied again. */
  private async reset(handle: ConnectionTransaction) {
    const own = this.ownSchema();
    const schemas = [...(own ? [own] : []), ...[...this.ensured.values()].filter((s) => s !== own)];
    await dropAll(handle, schemas);
  }

  /** Apply the steps of `schemas` that the database lacks, each schema once per attempt. */
  private async ensureSchemas(db: Connection, schemas: readonly Schema[]) {
    const lacking = schemas.filter((s) => !this.ensured.has(s.name));
    if (lacking.length === 0) return;
    await apply(db, lacking, { reader: this.ctx.shared });
    for (const s of lacking) this.ensured.set(s.name, s);
  }
}

/** Run `handler`, then end `attempt`'s SQL session, if it opened one (see {@link Attempt.end}). */
export async function withAttempt<T>(handler: () => Promise<T>, attempt: Attempt): Promise<T> {
  let outcome: Outcome<T>;
  try {
    outcome = { value: await handler() };
  } catch (error) {
    outcome = { error };
  }
  return attempt.end(outcome);
}
