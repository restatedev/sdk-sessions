# Packaging an app: units, images and a CLI

**Status: a design, nothing built.** It proposes a directory layout for an
application built on `@restatedev/sessions` and `@restatedev/agents`, where a
directory is the unit of deployment: its own image, its own secrets, its own
place to run. And a CLI that reads the tree and does the boring parts.

It needs one small change in `@restatedev/sessions` first, which is a bug fix
either way ([What the libraries need first](#what-the-libraries-need-first)).

## The app today

An app is a file you run with Node:

```ts
await serve(orders, refund, support);          // examples/intermediate/support.ts
await serve(boss, worker, senior, reviewer);   // examples/advanced/foreman/foreman.ts
```

One process, one image, one Restate deployment. Everything in it shares the
machine, the dependencies, the secrets and the scaling shape. For the
tutorial and for a small app that is exactly right, and nothing here changes
it.

## What pushes it apart

| Pressure                  | Where it shows                                                                                                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A coding agent runs commands** | Every coding-tool README says "use a sandbox" and stops there: `src/pi/README.md`, `src/opencode/README.md`, and the four advanced examples. The model's `bash` runs in the same process as the Linear token |
| **The images diverge**    | `@restatedev/agents` has **37 optional peer dependencies** across six frameworks. OpenCode wants its binary and a toolchain; a triage agent on pi wants none of it. One image carries all of it                 |
| **The secrets diverge**   | The factory holds `LINEAR_API_KEY`, `GITHUB_TOKEN` and a model key in one environment. A coder needs a push token; it has no business reading the Linear key                                                    |
| **The shape diverges**    | A webhook receiver is stateless and bursty. A coder holds a workspace and wants a container to itself. A reviewer is API-bound and idle most of the time                                                        |

## What already works

Three pieces are in place, which is why this is a convention and a CLI, not
new runtime machinery:

- **Services call each other by name, through Restate.** `call(orders,
  'status', …)`, `workflow(refund, …)` and `subagent(…)` do not care whether
  the target is in this process or another image. Splitting a program costs
  nothing in the code.
- **`RESTATE_SERVE_ONLY`** already serves a named subset: "one program (or
  image), deployed in parts" (`sessions/src/serve.ts`).
- **`needing`** keeps an agent's companion (`<agent>.prebuilt.restate`) with
  its agent, so any subset is complete. You never name it, and it cannot be
  left behind by a split.

So: a unit is a set of service names, `RESTATE_SERVE_ONLY` is how a process
takes its share, and `served()` makes the share whole. The design adds a place
to write the split down, and something to run it.

## The unit

**A unit is a directory that becomes one image, one process and one Restate
deployment.** Its contract is one file:

```ts
// coders/index.ts — what this unit serves.
import { coder } from './agents/coder.ts';
import { workspace } from './services/workspace.ts';

export default [workspace, coder];
```

That is the whole interface. No scanning, no decorators, no registry: a unit
is a list of services, which is what `serve` already takes. (Discovery by
scanning files would have to import each one, and a module like
`examples/advanced/factory/env.ts` does real work at import time — it opens
MCP connections. An explicit list is honest and type-checked.)

Rules, all of them consequences of that:

- **One unit serves a service name.** Two deployments claiming one name means
  the last registration wins — the same failure as the shared `signals`
  object, one layer up.
- **A unit never imports another unit's directory.** To call across units,
  import the interface from `shared/` and the call goes through Restate. The
  Restate SDK already prescribes this: `iface.service(…)` declares names and
  schemas without an implementation, "in a shared package that both the server
  (via `implement()`) and callers import".
- **A tool is a function, so it runs where it is imported.** A tool is not
  deployable on its own. A tool that must run elsewhere — it needs the
  sandbox, or a secret this unit does not have — becomes a handler in another
  unit, reached with `call(…)`. That is `examples/advanced/gateway/` already.
- **A companion travels with its agent,** by `needing`. Nothing to declare.

## The layout

The factory, split (`examples/advanced/factory/` is one process today):

```
factory/
  restate.json              the app: which units, where each runs
  shared/
    interfaces.ts           iface.service(…): what units call across the boundary
    prompts.ts  models.ts   imported by whichever units need them
  front/                    unit: the webhook, and the agents that talk to Linear
    index.ts                export default [webhook, triage, planner, reviewer]
    services/webhook.ts
    agents/triage.ts  agents/planner.ts  agents/reviewer.ts
    tools/linear.ts         MCP tools, signed per agent
    main.ts                 4 lines; see below
  coders/                   unit: OpenCode, in its own image, with no Linear key
    Dockerfile              git, ripgrep, OpenCode's toolchain
    index.ts                export default [workspace, coder]
    agents/coder.ts
    services/workspace.ts   clone, branch, push: the handlers front/ calls
    tools/git.ts
    main.ts
```

Inside a unit, `agents/`, `services/` and `tools/` are convention and nothing
more: they are directories, the CLI does not read them, and a small unit can
keep its two files at the top. The names earn their place by saying what a
file is, the way `examples/advanced/foreman/tools/` already does.

`shared/` is the one directory that is not a unit. It holds what crosses the
boundary — interfaces, prompts, schemas — and it ships in every image that
imports it.

## Where a unit runs: the manifest

One file at the root, so there is one thing to read to understand the
deployment:

```json
{
  "name": "factory",
  "target": "modal",
  "units": {
    "front": {
      "image": { "node": "24" },
      "secrets": ["linear", "openai"],
      "containers": 1
    },
    "coders": {
      "image": { "dockerfile": "coders/Dockerfile" },
      "secrets": ["github-push", "anthropic"],
      "isolated": true,
      "workspace": { "per": "key" }
    }
  }
}
```

| Field        | What                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| `image`      | a base and what to add (`node`, `apt`, `run`), or a `dockerfile` of its own when the manifest cannot say enough |
| `secrets`    | which secrets this unit's process gets, and only this unit's                                                   |
| `containers` | how many, and whether it scales                                                                                |
| `isolated`   | the process is confined and reaches Restate by dialling out                                                    |
| `workspace`  | the unit's tools get a workspace, one per `key` or one per container                                           |

What a unit **serves** is not in the manifest: that is `index.ts`, and
duplicating it would let the two disagree. `restate-app units` prints the
resolved view.

## Two meanings of "sandbox"

Worth separating, because the same word covers two different mechanisms and
only one of them is packaging:

|              | **An isolated unit**                                     | **A workspace per key**                                      |
| ------------ | -------------------------------------------------------- | ------------------------------------------------------------ |
| What         | a whole process, confined                                 | a directory or VM that a tool runs commands in                |
| Created      | once, at deploy                                           | at runtime, when a key first needs one                        |
| It is        | a Restate deployment                                      | not a Restate anything                                        |
| Declared     | `"isolated": true`                                        | `"workspace": { "per": "key" }`                               |
| Buys you     | the Linear key is not in the coder's process              | the model's `bash` cannot touch the host or another key's work |
| Costs        | a second image and a second deployment                    | a cold start per key                                          |

A unit is one deployment, so per-key isolation cannot be per-deployment: a
sandbox per key would mean a deployment per key, every one of them claiming
the same service name, which is the collision in the first rule above. Hence
the split. The unit boundary moves the dangerous
process away from the secrets; the workspace moves the dangerous *command*
away from the unit. The factory already gestures at the second
(`advanced/factory/env.ts`: "a coder's sandbox starts cold, on each new
coder") and has no way to say the first.

An isolated unit works because of `connect`: the process dials out to Restate
Cloud, so it needs egress and no inbound address at all. Without that, a
confined process could not be a Restate deployment.

## The image

A unit declares its image in the manifest, and each target renders it:

- **On Modal** an image is Python (`modal.Image.from_registry(…).run_commands(…)`),
  so the manifest's fields become those calls; a unit with a `Dockerfile`
  becomes `modal.Image.from_dockerfile`.
- **On plain Docker** the manifest becomes a generated Dockerfile, or the
  unit's own is used as it is.

So "each will have a Dockerfile or something" lands as: the manifest covers
the ordinary cases (a Node base, a few `apt` packages), and a unit that needs
more drops in a `Dockerfile` and points the manifest at it. The escape hatch
is a file in the unit's directory, next to the code it builds.

## The CLI

**It does nothing you could not type yourself, and it prints what it runs.**
That is the constraint; everything below is a shortcut for a command in the
READMEs today.

| Command                    | What                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `restate-app dev`          | every unit in one process, a local Restate server beside it, registered, watching for edits |
| `restate-app serve <unit>` | one unit alone, as it runs in production (`RESTATE_SERVE_ONLY`), to check the split         |
| `restate-app units`        | each unit: what it serves, its image, where it runs, which secrets                          |
| `restate-app check`        | the invariants below, without building anything                                            |
| `restate-app build [unit]` | the image, or every unit's                                                                 |
| `restate-app deploy [unit]`| build, run, and register the deployment with Restate                                       |
| `restate-app logs [unit]`  | the target's logs                                                                          |
| `restate-app new <unit>`   | a unit directory, its `index.ts` and `main.ts`, and its entry in the manifest               |

A unit's `main.ts` is four lines, written once by `new` and committed, so that
what the container runs is a file you can read:

```ts
import { start } from '@restatedev/sessions';
import services from './index.ts';

await start(services, { name: 'coders' });
```

## What the split lets us check

`check` is cheap and only this structure makes it possible:

1. **One unit per service name.** Two units serving `triage` is a deployment
   that silently replaces another.
2. **No unit imports another unit's directory.** It would work in `dev` and
   quietly duplicate code — or a whole service — into the wrong image.
3. **Every call target is served by some unit.** A `call(orders, …)` whose
   `orders` nobody serves is a 404 at the first invocation, not at build time.
4. **Every secret a unit names exists** on the target, before the deploy, not
   when the container exits.

## Development stays one process

The property that must not regress: the tutorial's "a file you run with node".
`restate-app dev` imports every unit's `index.ts` and serves them together, on
one port, as one deployment. The split is a deploy-time fact. `serve <unit>`
is there for when you want to feel it.

## Targets

`target` in the manifest, one implementation to start with:

- **Modal**, because that is where `modal-template` already goes: one
  `modal.App` for the whole Restate app and one class per unit, so `modal app
  logs` shows everything; `connect` out to Restate Cloud, as the template's
  skill insists ("long-lived HTTP/2 connections from Restate Cloud to Modal
  sometimes get stuck ... Don't change it to a pushed deployment").
- **Local Docker** next, for an app that runs on one machine: a compose file
  per app, a service per unit, one Restate container.

The target interface is small: build an image, run it with secrets and a
shape, tell me its address or that it dials out, fetch logs.

## What the libraries need first

**`connect` does not bring an agent's companion.** `serve` routes through
`served()` (`sessions/src/serve.ts:27`), which is what adds each agent's
companion. `connect` is re-exported raw from the Restate SDK by `export *
from '@restatedev/restate-sdk'` and never sees it. So an app deployed to
Restate Cloud the way `modal-template` does it — `restate.connect({ services,
name: 'notes-v1' })` — registers its agents without their companions, and the
first tool that waits has nothing to wait on.

The workaround is one word, `connect({ services: served([...]), name })`, and
nothing says so: no test, and no line in either README. That `serve` is
careful about this and `connect` is not is the kind of difference you find in
production.

`modal-template` shows how it is felt. Its tutorial hand-lists the companion
in the service list:

```ts
  // What the agents need beside them: `signal` tools (14) are answered through it.
  signals,
```

That worked when every agent shared one `signals` object. As of
`@restatedev/agents` 0.6.0 each agent has its own
`<agent>.prebuilt.restate`, made inside `agent()` and attached through a
symbol, so there is nothing left to name: on upgrade that line has to become
`served(...)`, and a reader who does not know why will drop it instead.

This design wants `start(services, { name })` anyway: `connect` when
`RESTATE_CONNECT_KEY` is set, `serve` otherwise, always through `served()`.
That closes the gap, makes a unit's `main.ts` four lines, and retires the
switch the Modal skill has to warn about ("switch to `restate.serve` only for
a local server, and switch back before deploying").

Worth doing on its own, before any of the rest.

## Decisions for you

1. **The CLI's name.** `@restatedev/app`, command `restate-app`? It must not
   collide with `@restatedev/restate`, the Restate CLI the READMEs already use.
2. **Manifest in JSON or TypeScript.** JSON reads from Python (Modal's deploy
   file) and from the Python SDK; TypeScript is typed and can compute. The
   design assumes JSON for that reason.
3. **Where it lives:** a new `packages/app/` here, or in `modal-template`,
   which is where deployment already lives.
4. **How far to go now:** `dev`/`units`/`check` alone is already useful and is
   a week, not a month. `build`/`deploy` needs a target.
5. **Per-key workspaces** — a `Workspace` in `@restatedev/agents` (local
   directory in dev, a sandbox on the target), or left to each app as the
   examples do today?
6. **Whether units may carry their own `restate.json`** instead of the root
   listing them all. One file to read, against one place to edit per unit.

## The Python side

`restate.agents` in the Python SDK has the same companion and the same
cross-service calls, and `restate.serve` there takes an app rather than a list
with needs. The convention (a directory is a unit, `index`/`__init__` names
its services, a manifest says where it runs) carries over unchanged; the CLI
would need a Python runner beside the Node one. A JSON manifest is what lets
one CLI serve both, which is argument enough for decision 2.

## Considered and not taken

- **Scanning directories for services.** Importing every file to find them
  runs module-level work, and the factory's `env.ts` opens MCP connections at
  import. An explicit `index.ts` costs one line per service.
- **A unit per agent, always.** Most agents belong together: they share an
  image, a key and a scaling shape. A unit is a *boundary*, and a boundary you
  are made to draw everywhere stops meaning anything.
- **Generating `on_modal.py` per unit.** Generated deployment code drifts from
  the manifest the moment someone edits it. One file that reads the manifest
  can be read once and understood for every unit.
- **Putting the CLI in the production image** (`npx restate-app serve coders`).
  Then a CLI bug is a production bug, and the image carries the CLI's own
  dependencies. A committed four-line `main.ts` has neither problem.
