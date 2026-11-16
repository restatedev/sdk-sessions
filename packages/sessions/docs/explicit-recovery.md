# Attempts on the explicit recovery VM

Session objects run every attempt from the start and recover from the object's
state: nothing is replayed. shared-core has a state machine for exactly that,
`ExplicitRecoveryVM` ([sdk-shared-core#118]), and this is the record of moving
@restatedev/sessions onto it, and of the decisions taken on the way — including
the ones taken differently from [sdk-python#314], which does the same port.

[sdk-shared-core#118]: https://github.com/restatedev/sdk-shared-core/pull/118
[sdk-python#314]: https://github.com/restatedev/sdk-python/pull/314

## What it replaces

The published SDK drives each awaited promise with a loop of its own, and only
one of them may wait on the server at a time. Two state reads awaited together
fail the attempt with `awaitNext already pending`. So `selector.ts` replaced
the invocation's `promisesExecutor.doProgress` with one loop that asks the VM
about every pending promise at once — relying on five private fields of the
SDK's internals, and pinning `@restatedev/restate-sdk` to 1.18.2 for them.

Its own TODO says to drop it once an SDK release lets such a handler await
concurrently. The new VM is that: an action returns a handle, its result comes
back as a notification, and the SDK settles its own promises. No `do_progress`,
no single await point, no selector, no working run.

## Decisions

### 1. The VM is bound in this addon, not taken from the SDK

The SDK builds its own `WasmVM` per invocation, from its own copy of
shared-core. sessions already ships a napi addon for the database, so the VM is
bound there too (`native/src/vm.rs`) and the two share one shared-core.

### 2. The VM lives behind a `Mutex`

`CoreExplicitRecoveryVM` is `Send` but not `Sync` (shared-core asserts the
`Send` bound itself). Only JavaScript's thread touches it today, but a store in
Rust would reach it from the runtime's thread too, where a database call that
waits goes on (`node::answer`). So it lives behind a `Mutex` that every call
takes briefly and never holds across an await.

sdk-python needs none: the GIL serializes its binding.

### 3. The store stays in JavaScript for now

sdk-python#314 moved the database's store into Rust, where it awaits its own
handles and never troubles Python. That is the better end state, and it is
**deliberately not** the first step here, for two reasons.

The first is a race that the GIL hides in Python. Issuing a command and
registering a waiter for it are two separate lock acquisitions; a tick between
them routes the notification to the queue for JavaScript, and the waiter hangs
forever. Eager reads and writes that ask for no ack are ready the moment they
are issued, so the window is real. Moving the store into Rust must make the
issue-and-register one critical section.

The second is that keeping the store in JavaScript keeps the dispatcher,
`withStoreWrapper`, the fault-injection tests and the `invoke` fakes valid, and
keeps the VM on one thread while the driver is new.

The cost is one extra command per commit. The store moves into Rust as its own
later change.

### 4. `serve` now; `connect` once the SDK can

The SDK exports `.`, `./fetch`, `./lambda` and `./node`. The dispatch that
builds the VM is a module-private class, so a different VM cannot be
substituted through any supported seam. `serve` is ours to write, so session
objects run on the new VM there.

`connect` cannot: its tunnel builds the handler itself, from `services`.

```js
// endpoint/tunnel/engine.js
const sdkHandler = withOptions(new NodeEndpoint(), { services: options.services, ... })
  .handler({ bidirectional: resolvedOptions.bidirectional });
```

It would take patching `NodeEndpoint.prototype` — the same class the tunnel
constructs — which trades one fragile patch for another. Decided (by the
repository's owner, 2026-11-16) to leave `connect` on the selector until
`@restatedev/restate-sdk` can hand sessions the invocation, and to ask for that
upstream. Two paths meanwhile.

### 5. Fronting `serve` bypasses no identity verification, because it can set none

An earlier draft of this document claimed the router runs after the SDK's
verification. It does not: fronting the handler runs _before_ it. What makes
that safe is narrower, and worth stating exactly.

`restate.serve({ port, ...options })` passes `options.identityKeys` to
`withOptions`, which calls `withIdentityV1` only when keys are given. They come
from the caller, never from the environment. @restatedev/sessions' own `serve`
takes services and nothing else:

```ts
export const serve = (...services: Service[]) =>
  restate.serve({ services: served(services, process.env.RESTATE_SERVE_ONLY), port: ... });
```

So a deployment served by `sessions.serve` has no request signature verification
today, with or without this change, and fronting it takes nothing away.

Verification is for the user who builds their own endpoint with `served()` and
`withIdentityV1`. That endpoint is the SDK's throughout, so it keeps the SDK's
verification _and_ stays on the selector. If `serve` ever takes identity keys,
it must delegate to the SDK path whenever keys are set, or verify them itself.

### 6. A heartbeat while the handler works, and only then

The selector reported a working run so that Restate would not shut an attempt
down while the handler worked outside Restate — a model request, say. The VM
has no runs, and shuts an attempt down whenever its inactivity timeout passes
with nothing heard, so a model request longer than the timeout would restart
the attempt forever.

The rule here: heartbeat every 20 seconds while the handler runs **and nothing
of the attempt waits on Restate**. That is the working run's behaviour. When
something is waiting, a shutdown is the right outcome: Restate starts a new
attempt when the answer arrives, rather than holding a connection open.

sdk-python#314 heartbeats while an annotation is open instead. sessions has no
annotations, so there is nothing to hang that on; if it grows them, the rule
can narrow to match.

### 7. Cancellation: implicit fails the awaits, explicit only tells the handler

The VM has no notification for a cancel signal — `isCancelled()` is a flag the
tick reads. What follows from it is this package's choice, and it keeps what
the selector did:

- `explicitCancellation: true` — `cancelled(ctx)` resolves and nothing else
  happens. The handler stops its own work.
- otherwise — the calls in flight are cancelled, and every promise waiting on
  Restate rejects with the SDK's `TerminalError('cancelled', 409)`, as a
  cancelled invocation's awaits do. A call's invocation id still settles, since
  cancelling that call needs it.

**Behaviour change.** Nothing suspends on the cancel signal any more. The
selector had to ask for the cancellation together with the working run so that
Restate would not take it for the only thing the handler awaited; here the
attempt never reports what it waits for at all.

## What the server negotiates

restate-server 1.8.0, which this repository pins, negotiates
`application/vnd.restate.invocation.v7` with SDK 1.18.2 (whose manifest offers
5 to 8). Measured, not assumed.

The VM accepts V7 and V8 only. That matters in one place: on V8 a state value
the attempt does not know is read with an ephemeral get, and on V7 with a get
recorded in the journal. shared-core does both; the unit tests drive V8, and
the end-to-end tests V7.

## What the end-to-end run proves

`pnpm --filter e2e explicit-recovery` serves a session object through
`sessions.serve` against a real restate-server and checks, in order:

1. a handler runs on the VM and its commit is acked — **V7 does answer
   `CommandAck`**, which the whole sync design rests on, and which was the
   open question here until it was run;
2. nothing in the journal is a run: no `sync` run, and no `work` run;
3. the commit syncs with a clear of `v22/sync`;
4. two **calls** awaited at once both answer — two `ctx.db` reads would not
   show this, since the database runs its calls one at a time and they never
   wait on Restate together;
5. and work past the inactivity timeout answers **in one attempt**, which the
   handler proves by writing a row per attempt rather than by reading a retry
   count that may have no row.

The journal of (1), verbatim:

```
Input · GetLazyState(v22/head) · GetLazyState notification
      · SetState(v22/tail/1-…/0) · SetState(v22/head) · ClearState(v22/sync)
      · SetState(v22/tail/2-…/0) · SetState(v22/head) · ClearState(v22/sync)
      · Output
```

The read is a journaled `GetLazyState` rather than an ephemeral get, because
the server negotiated V7. Both are shared-core's; the unit tests drive V8 and
this drives V7.

### What else runs on it

`pnpm --filter e2e versions` also goes through `sessions.serve`, and passes in
full on the VM: a session object across two deployments, invocations pinned to
the deployment they started on, a schema step running once per key, a view of a
key only the older version wrote, and a rollback and roll-forward. It needs
Node 24, which the repository requires and this container does not default to.

**What does not run on it, and should before release.** Most of the e2e scripts
— `serve`, `steering`, `agentlib`, `restate-tools`, `crash`, `concurrency`,
`suspension`, `bench` — build their endpoint with the SDK's own
`restate.serve` or `restate.endpoint().listen()`, not this package's. They are
on the selector whatever this change does, so none of them exercises the new
path, and @restatedev/agents has never run on it. A deployment reaches the VM
only by calling `sessions.serve` or `sessions.http2Handler`.

That mattered most for agents: its handlers are session objects, and it
classifies cancellation on `restate.CancelledError` in a dozen places
(`tools.ts`, `companion.ts`, `agentlib/runtime.ts`, `pi/index.ts`). So
`pnpm --filter e2e steering` now serves its agents through this package, and
passes: pi agents with a scripted model, their companions, steering while a
tool runs, views, and a cancelled `wait`, against a real server.
`E2E_SDK_SERVE=1` builds the endpoint with the SDK instead and keeps them on
the selector; both pass. It is the agents library's only coverage of the VM.

The rest of the scripts are still SDK-served, and pointing them here is a
change to them, not to this package.

**Run the suites on Node 24**, which this repository requires. On Node 22 the
agents package reports 1172 passed with 2 files skipped; on Node 24 it is 1237
passed across 34 files. Sixty-five tests are silently skipped otherwise, and
several e2e scripts do not start at all (`@opencode/util` uses `await using`).

### 8. The heartbeat interval is configurable, because the timeout is

The first end-to-end run failed here. 20 seconds is well inside Restate's
default inactivity timeout of a minute, but the test shortens the timeout to 3
seconds to stay quick, and the first heartbeat would have come long after the
attempt was shut down. `RESTATE_SESSIONS_HEARTBEAT` (milliseconds) sets it; a
deployment that shortens
`RESTATE_WORKER__INVOKER__INACTIVITY_TIMEOUT` must shorten this with it.

### 9. A write of an attempt that ended is dropped, not thrown

The same run crashed the process. The database's store calls `setState` and
`clearState` from inside the addon, where a throw reaches no `catch` of ours.
An attempt that is over cannot send them anyway, and a new attempt writes them
again, so they are dropped. Reads still reject: they are promises, and the
caller is awaiting one.

## What this change adds to the public surface

- **`http2Handler(...services)`**, exported beside `serve` and `served`, for a
  server of your own. `serve` is written in terms of it. It exists because
  `serve` no longer delegates to the SDK's `listen`, and a user who built their
  own server with `endpoint().http2Handler()` would otherwise have no way onto
  the VM.
- **`RESTATE_SESSIONS_HEARTBEAT`** (milliseconds), see 8 above.

## What differs from the SDK's path, beyond the VM

- **`ctx.run` throws.** There are no runs on this VM, and a session object's
  journaled work belongs in a `restate.object` called with `ctx.rpc`. The error
  says so. On the SDK's path it was never reachable either — `SessionContext`
  has no `run` — but the context behind it did.
- **`asTerminalError` is honoured** (the handler option): an error it names
  ends the invocation instead of being retried, as the SDK does. It was dropped
  in the first draft of `serveSession`, which would have turned a terminal
  error into an endless retry.
- **A failed attempt logs nothing locally.** The SDK logs the error that failed
  an invocation before writing it to Restate; this path only writes it. The
  error reaches Restate either way, but `docker logs` is quieter.
- **Heartbeats stop while any handle is outstanding**, including the result of
  a call made with `start()` that nobody awaits. That is deliberate: the
  pathology a heartbeat prevents is an attempt with _nothing_ outstanding being
  shut down, since Restate then has no answer to resume it with and retries
  from the start forever. With a call outstanding, a shutdown is recoverable —
  Restate starts a new attempt when that call answers.

## The issue to open on sdk-typescript

Not opened from here: drafted for a person to send.

> **Let an SDK handler run on `ExplicitRecoveryVM`**
>
> shared-core has a state machine for handlers that are never replayed,
> `ExplicitRecoveryVM` (restatedev/sdk-shared-core#118). It is what
> `restate.internal.explicitRecovery()` handlers want: commands return
> notification handles, results come back in any order, and the SDK settles its
> own promises — so such a handler can await concurrently, with no journal and
> no single await point.
>
> @restatedev/sessions runs session objects on it today, but only for
> deployments it serves itself, because there is no supported way to give the
> SDK a different VM for an invocation:
>
> - the dispatch that constructs the VM is module-private, and the package
>   exports only `.`, `./fetch`, `./lambda` and `./node`;
> - `connect`'s tunnel builds its handler internally from `services`
>   (`endpoint/tunnel/engine.js`), so it cannot be handed one at all.
>
> So `sessions.serve` is on the new VM and `sessions.connect` is stuck on a
> selector that patches `promisesExecutor.doProgress` and five private fields,
> pinned to `@restatedev/restate-sdk` 1.18.2.
>
> Either of these would retire that patch:
>
> 1. the SDK runs `explicitRecovery()` handlers on `ExplicitRecoveryVM`
>    itself — the better end state, and it would serve every transport; or
> 2. `connect` accepts a request handler, the way `serve` effectively does
>    through `endpoint().http2Handler()`, so an SDK-built handler can be
>    wrapped.
>
> sdk-python did (1) in restatedev/sdk-python#314.

## Open

- **The `connect` path**, above.
- **foyer's debug print.** shared-core#117 pins foyer 0.22.6, whose
  `foyer-storage/src/io/device/file.rs:103` has a stray
  `println!("==========> {capacity}")`. Every process that opens a disk page
  cache prints it. 0.22.6 is the newest release, so there is no version to move
  to; it needs raising upstream, and it affects sdk-python#314 equally.
