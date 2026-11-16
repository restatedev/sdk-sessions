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

## Open

- **Does V7 on server 1.8.0 answer `CommandAck`?** A commit's sync is a write
  that asks to be acked, so the design rests on it. sdk-python#314 ran against
  1.8.1. Verified end to end before the store's sync depends on it.
- **The `connect` path**, above.
- **foyer's debug print.** shared-core#117 pins foyer 0.22.6, whose
  `foyer-storage/src/io/device/file.rs:103` has a stray
  `println!("==========> {capacity}")`. Every process that opens a disk page
  cache prints it. 0.22.6 is the newest release, so there is no version to move
  to; it needs raising upstream, and it affects sdk-python#314 equally.
