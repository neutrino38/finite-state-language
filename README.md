# FSL — Finite State Language

> **Where this stands:** two implementations, one language.
> [`finite-state-language@0.2.0`](https://www.npmjs.com/package/finite-state-language)
> on npm for TypeScript and JavaScript,
> [`finite_state_language@0.2.0`](https://hex.pm/packages/finite_state_language)
> on hex for Elixir. The API is still soft — now is a good time to state your
> opinion.

FSL is a tiny, readable language for describing **finite state machines**. In
TypeScript and plain JavaScript it builds **stateful communication frontends** —
web phones, web chat, video relay, bot UIs — where the interface must follow the
life of a call: registering, ringing, connected, failed, and every state in
between. In Elixir it describes the other end of that call: one machine per
process, driving a SIP stack, a test scenario or a server script.

No framework lock-in. No heavyweight runtime. Just states, events and
transitions you can actually read.

```ts
calling_out: {
  on: {
    "sip:progress": () => loop("ringing"),
    "sip:accepted": () => goto("connected", "200 OK"),
    "ui:hangup":    (_, ctx) => { ctx.session?.terminate();
                                  return goto("ready", "caller gave up"); },
  },
  after: { delay: 90_000, then: () => goto("call_failed", "no answer") },
},
```

If you can read that, you already speak FSL.

## Lineage: Elixip

FSL began as the DSL at the heart of
[**Elixip**](https://framagit.org/elixip/elixip), an Elixir SIP framework
where call scenarios are written as explicit state machines — declared
states, declared transitions, events collected per state, readability above
all. That style proved itself describing real SIP call flows on the backend.
The TypeScript implementation brings the same discipline to the browser,
adapted to how UIs actually work; the Elixir one is that original DSL, lifted
out of the SIP stack and published on its own.

## Why states, stated explicitly?

Communication UIs are state machines whether you admit it or not. The hangup
button that stays clickable after the call ended, the call button that fires
twice — these bugs are *implicit* state machines leaking. FSL makes the
machine explicit:

- **Explicit states** — the machine's state *is* your UI state. Render from
  it directly, in React or anything else.
- **Explicit transitions** — `goto`, with a human-readable description that
  becomes your debug log.
- **Events, not callbacks-of-callbacks** — your SIP/WebRTC stack (e.g.
  [JsSIP](https://jssip.net/) — but any stack works) feeds events in; states
  declare what they listen to.
- **An actor-grade event model** — events are queued and processed one at a
  time, run-to-completion, like an Erlang mailbox. And like Erlang's
  selective receive, an event the current state doesn't handle is **not
  lost**: it waits in a bounded, inspectable pending queue and is replayed
  on every state change until a state claims it (or a `"*"` clause flushes
  it). The INVITE that arrives a millisecond before your state change stops
  being a heisenbug.
- **Readability, readability, readability** — a machine you can print, review
  and diagram. Don't take our word for it: `toMermaid()` and see for yourself.

## Design at a glance

- **Pure core, zero runtime dependencies** — runs in the browser, in Node.js,
  in a worker. Your call flows are testable headless, no DOM required.
- **Thin adapters** — `fsl/react` is one hook; other frameworks are ~30 lines
  each. Vanilla JS just subscribes.
- **TypeScript-first, JavaScript-friendly** — state names, events and context
  are all typed; `goto("connectd")` won't compile. JS users get the same
  library with editor completion for free.
- **Stack-agnostic** — FSL never imports a SIP library. Handles live in the
  machine context; a ~50-line binding connects any stack.

Read the full picture in [spec/fsl-js-ts.md](spec/fsl-js-ts.md) and the
roadmap in
[typescript/docs/implementation-plan.md](typescript/docs/implementation-plan.md).

## Using it

Vanilla JavaScript — subscribe and render:

```js
const phone = WebPhone.start();
bindSipStack(phone); // stack callbacks -> phone.send(...)
callButton.onclick = () =>
  phone.send({ type: "ui:call", number: input.value });
phone.subscribe(({ state }) => renderUi(state));
```

React — one hook, no other coupling:

```tsx
import { useMachine } from "finite-state-language/react";

function Phone() {
  const { state, send } = useMachine(WebPhone);
  return (
    <CallButton
      disabled={state !== "ready"}
      onClick={() => send({ type: "ui:call", number })}
    />
  );
}
```

Elixir — one machine per process, and a `mix.exs` line:

```elixir
{:finite_state_language, "~> 0.2"}
```

See [`elixir/README.md`](elixir/README.md) and the runnable
[`elixir/samples/`](elixir/samples/README.md).

## Repository layout

FSL is a language first, an implementation second — this repository is
structured accordingly:

```
spec/          the language: semantics, event model, design decisions
typescript/    the TypeScript implementation (npm: finite-state-language)
elixir/        the Elixir implementation (hex: finite_state_language), extracted
               from Elixip's DSL — same states, same event model, no SIP coupling
```

The two implementations must stay semantically aligned; the spec is the
arbiter. When they diverge on purpose (JS has no process mailbox; the BEAM
needs no pending queue), the divergence is documented in the spec.

## The other FSL

FSL also reads as **French Sign Language** (LSF — *Langue des Signes
Française*). That collision is embraced, not accidental: this project grew
out of building **total conversation** services — audio, video *and*
real-time text in the same call — so that deaf and hard-of-hearing users are
first-class callers, not an afterthought. Telecoms should be inclusive by
design. If FSL helps one more team ship a video-relay or sign-language
service, the pun has done its job.

## State of the union

- [x] Goals & language specification
- [x] Implementation plan
- [x] Core runtime (event loop, transitions, selective receive)
- [x] Timers, tasks (the Valet pattern) & HTTP-as-events
- [x] Sub-machines & cooperative shutdown
- [x] React adapter
- [x] Diagrams from the source (`finite-state-language/diagram`)
- [x] Service building blocks (`fx.sbb` / `fx.sbbReturn`)
- [ ] JsSIP web phone — full example, as its own project
- [x] `finite-state-language@0.2.0` on npm
- [x] `finite_state_language@0.2.0` on hex

## Get involved

This is the ground floor — the API is still soft, which means your use case
can still shape it. Open an issue, challenge the spec, tell us about the
communication UI you wish were easier to build — the ground rules are in
[CONTRIBUTING.md](CONTRIBUTING.md). Come help us make FSL...
fully operational. We'd love to have you — *no state secrets here*.

## License

[Apache License 2.0](LICENSE).
