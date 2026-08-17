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
