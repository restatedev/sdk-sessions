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

### 0. shared-core 8.7.0, from the registry

`ExplicitRecoveryVM` was unreleased while this was written, so the addon was
pinned to a git revision, which could not ship. 8.7.0 carries it, and the
addon takes it as an ordinary version.

8.7.0 also undoes the one problem the bump brought with it (see below).

### 1. The VM is bound in this addon, not taken from the SDK

The SDK builds its own `WasmVM` per invocation, from its own copy of
shared-core. sessions already ships a napi addon for the database, so the VM is
bound there too (`native/src/vm.rs`) and the two share one shared-core.

### 2. The VM lives behind a `Mutex`

`CoreExplicitRecoveryVM` is `Send` but not `Sync` (shared-core asserts the
`Send` bound itself), and two threads reach it: JavaScript's, which ticks it,
and the runtime's, where a database call that waits for the store goes on
(`node::answer`). So it lives behind a `Mutex` that every call takes briefly
and never holds across an await, and a call from the runtime's thread asks
JavaScript for a tick once it lets the lock go.

sdk-python needs none: the GIL serializes its binding.

### 3. The store is in Rust, on the VM

The database's store reads and writes the object's state as the VM's own
commands, in the addon (`VmStore` in `native/src/node.rs`), and awaits their
notifications there.

**Why: hops between event loops, and moving bytes.** A session's pages are the
hot path, and on the JavaScript store each page crossed the addon boundary
twice and was copied twice:

| per page             | JavaScript store                                                      | on the VM |
| -------------------- | --------------------------------------------------------------------- | --------- |
| thread hops          | 2 (out to JavaScript, back)                                           | 0         |
| copies of the value  | 2 (`Buffer::from(value.to_vec())` out, `Bytes::copy_from_slice` back) | 0         |
| promises, JS objects | one per operation                                                     | none      |

`Bytes` now moves from the SQL layer into the VM's command and back without
being copied or leaving the thread. What remains on the boundary is the
protocol's own framing — the request body in, the response out — which is per
frame, not per page.

Two hops per _write_ survived the first cut, and both are gone:

- the scheduler asked JavaScript to tick after every act, so a commit woke the
  other thread once per write; one tick is now asked for at a time
  (`asked_to_tick`), which is all a tick can do anyway;
- a write that asks for no ack is answered by the VM at once, and that
  notification was queued for JavaScript, turned into an object and dropped.
  Such handles are marked and dropped in Rust (`issue_and_discard`).

A read the VM can answer locally is routed under the lock that issued it, so it
never costs a turn of the event loop either.

**Why it is in Rust at all.** Every page the store moves through JavaScript
costs two thread hops and two copies: the runtime's thread to the event loop
and back, and the bytes marshalled each way. On a flush with many pages in
flight those compound, which is the case the store is built for. Keeping the
store on the VM removes them.

**The race the GIL hides.** sdk-python#314 issues a command and registers the
waiter for its handle in two separate borrows of the VM. That is safe there
only because the GIL will not run its tick in between. Behind a `Mutex` it is
not: a notification that is ready the moment the command is issued — an eager
state read, a write that asks for no ack — would be routed to JavaScript by a
tick between the two, and the waiter would wait for something that had already
gone elsewhere. So [`Vm::issue_and_wait`] does both under one lock.

**The flush.** The store runs on the runtime's thread (`node::answer`), where
nothing writes the response. `Vm::set_scheduler` takes the driver's tick, and
every act of the store asks for one once the lock is released, so what it sent
is written and what it waits for is routed.

**A commit's sync is its head write.** shared-core's `KvStore::put_and_sync`
lets a flush write its head and sync in one: Restate acks a write only after
the writes before it, so that ack _is_ the sync. The `v22/sync` clear is gone,
and a commit is one command shorter than the store in JavaScript made it:

```
SetState(v22/tail/1-…/0) · SetState(v22/head, requested_ack)
```

**JavaScript is still called at one point.** A committing transaction's sends
are made between the commit's head write and the wait for its ack. That is the
store's `sync`, which `database.ts`'s boundary uses to run what the transaction
gave `withCommit` — the same hook sdk-python#314 spends its `COMMIT` op on.

**When the JavaScript store is still used.** `open` is unchanged and still
takes one, for the tests that bring their own (fault injection through
`withStoreWrapper`, the in-memory stores of `database.test.ts`) and for an
attempt with no VM. An attempt _with_ a VM always takes the VM path. Wrapping
the store of one is refused rather than quietly served by the JavaScript store,
which would test the other path under the name of this one; the tests that wrap
give their attempts no VM.

### 4. One seam: `NodeEndpoint.prototype`, so every transport runs on the VM

~~Superseded.~~ This decision first read "`serve` now; `connect` once the SDK
can", and left `connect` on the selector because its tunnel builds the handler
itself, from `services`:

```js
// endpoint/tunnel/engine.js
const sdkHandler = withOptions(new NodeEndpoint(), { services: options.services, ... })
  .handler({ bidirectional: resolvedOptions.bidirectional });
```

The conclusion drawn from that — leave `connect` on the selector — was wrong in
one respect that matters: the tunnel constructs `NodeEndpoint`, so patching
that prototype reaches it. `endpoint.ts` wraps `handler`, `http2Handler`,
`http1Handler` and `listen` on it, which is the one place every transport
passes through. `restate.endpoint()`, `restate.serve` and `connect` all run a
session object's invocation on the VM now, and the selector is what is left
over rather than what anything depends on.

`handler` dispatches per request rather than per build, so the bidirectional
rule is taken per request from `httpVersionMajor`: HTTP/2 unless told
otherwise, HTTP/1.1 only when asked, which is what the SDK's own two handlers
mean.

### 5. This package verifies the request signature itself

~~Superseded.~~ This decision first read "fronting `serve` bypasses no identity
verification, because it can set none". That held only while `sessions.serve`
was the one way onto the VM and took no identity keys. Decision 4 put every
transport on the VM, `connect` with them — and a `connect` deployment _always_
verifies: its connect key carries the signing key, and the SDK refuses a key
that does not (`connect/env.js`). Fronting the SDK's handler would then skip
the verification the SDK does inside it, and a signature would go unchecked.

So this package verifies before it dispatches, with the verifier shared-core
already has — the same one the server's own SDKs use. `native/src/vm.rs` binds
it as `Identity` (shared-core's `request_identity` and `rust_crypto`
features); `endpoint.ts` builds one from `endpoint.builder.keySet` and refuses
an invocation it will not verify with a 401, before the handler runs. An
invocation of a journaled object is handed to the SDK untouched, signature and
all, so the SDK goes on verifying what it serves.

The path is passed whole: shared-core's `normalise_path` strips a deployment
prefix itself, so a deployment registered under one verifies the same.

**The trap, and why the first test passed for the wrong reason.** `verify`
returns `Option<String>` — the reason it refused, or nothing. Across napi,
`None` is **`null`**, not `undefined`, so an `unsigned !== undefined` check was
true for every request and refused all of them, signed or not. The first
version of the check only asserted that an _unsigned_ request gets a 401, and
an unsigned request is refused before any signature is read, so it passed
against a deployment that would have answered 401 to everything — `connect`
included. `packages/e2e/identity.ts` now signs with a key made for the run and
asserts the half that can only pass for the right reason: a signed invocation
runs and answers. A refusal-only test of a verifier proves nothing.

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
  Restate rejects with the SDK's `CancelledError`, as a cancelled invocation's
  awaits do. A call's invocation id still settles, since cancelling that call
  needs it. The database's waits are in the addon, so the VM fails those
  (`cancel_state_waits`) and `database.ts` restores the class from the text.
- A cancellation that finds **nothing** waiting is carried to the next wait,
  once. A retry of a cancelled invocation learns of it before the handler
  starts, and the selector's path fails its first call all the same
  (`cancellation.test.ts`, "a retry of a cancelled invocation").

What is awaited _after_ a cancellation is not cancelled, on either path; the
selector says so in those words.

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
3. the commit's head write carries its own sync, and there is no
   `v22/sync` clear;
4. two **calls** awaited at once both answer — two `ctx.db` reads would not
   show this, since the database runs its calls one at a time and they never
   wait on Restate together;
5. and work past the inactivity timeout answers **in one attempt**, which the
   handler proves by writing a row per attempt rather than by reading a retry
   count that may have no row.

The journal of (1), verbatim:

```
Input · GetLazyState(v22/head) · GetLazyState notification
      · SetState(v22/tail/1-…/0) · SetState(v22/head)
      · SetState(v22/tail/2-…/0) · SetState(v22/head)
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

**The recovery acceptance tests.** `concurrency` runs on both paths now
(`E2E_SDK_SERVE=1` for the selector), and passes on each: statements and calls
at once, transactions queueing, a transaction's sends, a cancellation failing
one await once with the handler compensating after it, and a terminal SQL
error. The other two cannot follow it yet:

- **`suspension` is a selector test by construction.** It drives
  `failpoints`, the hooks inside `PromiseSelector`, to close the input or
  deliver a cancel signal between two passes of that loop. There is no such
  loop on the VM. It has no VM variant until the selector goes, and should be
  rewritten or dropped then.
- **`crash` serves through `e2e/serve.ts`, which wraps its stores with
  `withFaults`.** A session on the VM has no JavaScript store to wrap, and
  refuses rather than quietly serving one. Fault injection needs a route into
  `VmStore` — a hook the addon consults per operation — before `crash` can run
  on this path, and that is worth designing rather than bolting on.

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

- **Nothing, for getting onto the VM.** An earlier draft exported an
  `http2Handler(...services)` beside `serve` and `served`, because `serve` had
  stopped delegating to the SDK's `listen`. Decision 4 removed the need: the
  seam is on `NodeEndpoint.prototype`, so a server built with
  `endpoint().http2Handler()` is already on the VM and `serve` delegates to the
  SDK again.
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

Not opened from here: drafted for a person to send. It is no longer a blocker —
decision 4 found a seam — but the seam is a prototype patch, and the SDK doing
this itself is the better end state.

> **Let an SDK handler run on `ExplicitRecoveryVM`**
>
> shared-core has a state machine for handlers that are never replayed,
> `ExplicitRecoveryVM` (restatedev/sdk-shared-core#118). It is what
> `restate.internal.explicitRecovery()` handlers want: commands return
> notification handles, results come back in any order, and the SDK settles its
> own promises — so such a handler can await concurrently, with no journal and
> no single await point.
>
> @restatedev/sessions runs session objects on it today, but there is no
> supported way to give the SDK a different VM for an invocation: the dispatch
> that constructs the VM is module-private, and the package exports only `.`,
> `./fetch`, `./lambda` and `./node`. So the package patches
> `NodeEndpoint.prototype` — the class `restate.endpoint()`, `restate.serve`
> and `connect`'s tunnel all build theirs from — and routes a session object's
> invocation ahead of the SDK's handler. That works, and it is still a patch on
> a class the SDK is free to change.
>
> Two things would retire it:
>
> 1. the SDK runs `explicitRecovery()` handlers on `ExplicitRecoveryVM`
>    itself — the better end state, and it would serve every transport; or
> 2. an endpoint accepts a handler for an invocation it does not want to serve
>    itself, so no prototype needs patching.
>
> sdk-python did (1) in restatedev/sdk-python#314.
>
> Routing ahead of the SDK's handler also moves request signature verification
> out of it, so the package has to verify itself (shared-core's
> `IdentityVerifier`, which it already depends on). (1) would make that
> unnecessary too.

## Open

- ~~**The `connect` path.**~~ Fixed by decision 4: `connect` runs session
  objects on the VM through the same seam as every other transport.
- **The selector is still in the tree.** Nothing routes onto it any more, and
  it is to be deleted with what only exists to drive it: `src/selector.ts`,
  `hookSelector` in `object.ts` and its exports from `internal.ts`,
  `test/selector.test.ts`, `e2e/suspension.ts` (it drives the selector's
  `failpoints`), the `E2E_SDK_SERVE` and `BENCH_VM` switches and their CI
  lines. `wire.ts`'s `attempt()` still builds a fetch endpoint through
  `createEndpointHandler`, which the prototype patch does not cover, so
  `suspension-wire.test.ts` exercises the selector until it moves to the
  patched class. Deleting it also unpins `@restatedev/restate-sdk` 1.18.2.
- **`crash` has no VM variant.** `e2e/serve.ts` injects faults with
  `withFaults`, and a VM attempt refuses a wrapped store (decision 3), so the
  fault injection has to reach `VmStore` before that e2e covers this path.
- ~~**foyer's debug print.**~~ Fixed. shared-core#117 pinned foyer 0.22.6,
  whose `foyer-storage/src/io/device/file.rs:103` had a stray
  `println!("==========> {capacity}")`, so every process that opened a disk
  page cache printed it; 0.22.6 was the newest release, so there was no version
  to move to. shared-core 8.7.0 went back to foyer 0.22.3 for exactly this
  reason, and the line is gone from the suites and the end-to-end run.
