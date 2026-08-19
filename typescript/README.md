# finite-state-language

FSL (Finite State Language) is a tiny, readable language for describing
**finite state machines**, embedded in TypeScript and consumable from
plain JavaScript. It exists to build **stateful communication
frontends** — web phones, web chat, video relay, bot UIs — where the
interface must follow the life of a call: registering, ringing,
connected, failed, and every state in between.

- **Zero runtime dependencies.** Browser, Node ≥ 18, workers.
- **Actor-grade event model.** Events are queued and processed
  run-to-completion; an event the current state doesn't handle waits in
  a bounded, inspectable pending queue and is replayed on every state
  change — Erlang's selective receive, in the browser.
- **Typed everything.** State names, events and context are all
  checked: `goto("connectd")` doesn't compile — and JavaScript users
  get the same completions for free.
- **Async without races.** `fx.task` turns any promise into exactly one
  tagged event, with timeout and AbortSignal cancellation arbitrated in
  one place; `finite-state-language/http` does the same for `fetch`.
- **Sub-machines and cooperative shutdown**, with a grace period and
  ordered teardown.
- **Framework-thin.** `finite-state-language/react` is one hook on
  `useSyncExternalStore`; vanilla JS just subscribes.
- **Diagrams that match the code.** `finite-state-language/diagram`
  reads a machine's source and draws its real transition graph, so
  checked-in documentation cannot drift away from the machine.

FSL is the TypeScript sibling of the DSL at the heart of
[Elixip](https://github.com/neutrino38/elixip), an Elixir SIP framework
where call scenarios are written as explicit, readable state machines.

## Install

```sh
npm install finite-state-language
```

## A taste

```ts
import { defineMachine, goto, loop, failure } from "finite-state-language";

interface Ctx {
  session?: SipSession;
}
type Ev =
  | { type: "sip:registered" }
  | { type: "sip:progress" }
  | { type: "sip:accepted" }
  | { type: "ui:hangup" };

const Call = defineMachine<Ctx, Ev>()({
  name: "Call",
  context: () => ({}),
  states: {
    initial_state: {
      enter() {
        return goto("registering");
      },
    },
    registering: {
      on: { "sip:registered": () => goto("calling", "REGISTER OK") },
      after: { delay: 30_000, then: () => failure("registrar silent") },
    },
    calling: {
      on: {
        "sip:progress": () => loop("ringing"),
        "sip:accepted": () => goto("connected", "200 OK"),
      },
    },
    connected: {
      on: { "ui:hangup": () => goto("registering", "call ended") },
    },
  },
});

const call = Call.start({ debug: true });
call.subscribe(({ state }) => render(state));
call.send({ type: "sip:registered" });
```

React:

```tsx
import { useMachine } from "finite-state-language/react";

function Phone() {
  const { state, send } = useMachine(Call);
  return (
    <button
      disabled={state !== "connected"}
      onClick={() => send({ type: "ui:hangup" })}
    >
      Hang up
    </button>
  );
}
```

Plain JavaScript, with full type checking through JSDoc:

```js
// @ts-check
/** @typedef {{ type: "go" } | { type: "quit" }} Ev */
/** @typedef {{ attempts: number }} Ctx */
const define = /** @type {typeof defineMachine<Ctx, Ev>} */ (defineMachine);
const M = define()({/* state names, events and context are all checked */});
```

## Service building blocks

A sequence you write once and call from anywhere — establish a call, run
a menu, collect credentials — is a **block**: a fragment of a state
machine behind a callable face.

`fx.spawn` starts a second machine, with state of its own. `fx.sbb` calls
a subroutine: same machine, same context, same mailbox, suspended at the
call site until the block returns.

A block declares the vocabulary it talks back with — a **namespace** and
one line per **outcome** — and every return is
`{ type: "namespace:outcome", data }`. Three slots, fixed: a block that
learns to report one more thing adds a key to `data`, which is invisible
to a host that does not read it.

```ts
type Chosen =
  | SbbReturn<"menu", "choice", { key: string }>
  | SbbReturn<"menu", "timeout", { block: string }>;

const Menu = defineSbb<{ lang: string }, MenuEv, { tries: number }, Chosen>()({
  name: "Menu",
  // the vocabulary: what this block says, and what each word means
  namespace: "menu",
  returns: {
    choice: "the caller pressed a key — {key}",
    timeout: "nobody pressed anything in time — {block}",
  },
  // the block's own scratch space, fresh on every call
  data: () => ({ tries: 0 }),
  // its own deadline: the host's is suspended while it runs. Without a
  // `then`, expiry is an outcome like any other — `menu:timeout`.
  timeout: { delay: 30_000 },
  states: {
    initial_state: {
      enter: (ctx, fx) => play(prompt(ctx.lang, fx.data.tries)),
      on: {
        "dtmf:key": (ev, _ctx, fx) => fx.sbbReturn("choice", { key: ev.key }),
      },
    },
  },
});

// …and in the host, one line and a couple of clauses:
placing: {
  enter: (_ctx, fx) => { fx.sbb(Menu, { args: { tries: 1 } }); },
  on: {
    "menu:choice":  (ev) => goto("routing", ev.data.key),
    "menu:timeout": ()   => goto("ready", "no answer"),
  },
},
```

Three things the compiler checks, and they are the ones worth checking: a
host whose context does not provide what the block declares it requires
will not compile; neither will a host that has no clause for what the
block can return — the "waiting for an event nobody will send" silence,
turned into a type error; and `returns` has to document _every_ outcome
of the union, so a block cannot grow one nobody wrote down. An outcome
that is not declared is refused at run time too, for the JavaScript
callers the type system does not reach.

`timeout` is required. `{ delay: "infinity" }` is how a block says it has
no bound of its own — a relay that ends when the dialog ends — and making
that a decision rather than a default is deliberate: a block left
unbounded by accident is exactly the silence above.

A block's sandbox is fresh on every entry, so a hunt calling one block on
target after target cannot inherit the last attempt's scratch.
`fx.sbb(block, { resume: true })` is the explicit exception, for a block
designed to be interrupted and re-entered.

While a block runs, `state` stays the **host's** state — a subroutine
call is not a state your machine declared — and `snapshot.sbb` says which
block is running and where inside it, ready to render:

```tsx
const { state, sbb } = useMachine(Phone);
return (
  <p>
    {state}
    {sbb && ` — ${sbb.block}: ${sbb.state}`}
  </p>
);
```

`fx.sbbReturn` is the only way back. `failure()` and `aborted()` keep
their ordinary meaning inside a block and end the whole machine, host
included, running each block's `cleanup` on the way out.

## Diagrams

Two exports draw a machine, and they see different things.

`Machine.toMermaid()` works at runtime, where handlers are closures. It
can only extract the string shorthand `on: { evt: "target" }`, so a
machine whose handlers all return `goto(…)` prints as a bare list of
states. It costs nothing and needs no tooling — good enough for a quick
look in a debug console.

`finite-state-language/diagram` reads the source instead, where every
`goto("ready")` names its target in plain text. It is a build-time tool:
it needs `typescript` installed (an optional peer dependency), and the
core keeps its zero runtime dependencies.

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { machineGraphs, renderMermaid } from "finite-state-language/diagram";

const [phone] = machineGraphs(readFileSync("src/phone.ts", "utf8"));
writeFileSync("docs/phone.mmd", renderMermaid(phone));
```

A graph also carries `states`, `edges`, and two lists worth printing
beside the picture: `forwarded` (events handed to a child machine with
`fx.notify`) and `consumed` (events a state handles without moving).
Blocks are extracted too, tagged `kind: "block"`, with `fx.sbbReturn`
drawn as the way out; in a host, `graph.blocks` says which state enters
which block, and the diagram names it on the box.

The extraction over-approximates on purpose: guards are ignored, so a
handler that can reach two targets draws two edges. Only string-literal
descriptions become labels. Run it from a test that fails when the
checked-in diagram and the source disagree, and the two cannot drift.

## Documentation

- [Language specification](https://github.com/neutrino38/finite-state-language/blob/main/spec/fsl-js-ts.md)
  — semantics, event model, design decisions. The spec is the arbiter.
- [Software design](https://github.com/neutrino38/finite-state-language/blob/main/typescript/docs/design.md)
  — how the runtime works inside.
- API reference: `npm run docs` (typedoc) generates `docs/api`.
- Start an instance with `{ debug: true }` for an Elixip-style
  transition log.

## License

[Apache-2.0](./LICENSE)
