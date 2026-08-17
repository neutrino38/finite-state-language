# FSL for TypeScript / JavaScript — Language Specification

Status: draft v0.2 — 2026-08-15 (post first review)
Lineage: [Elixip DSL](https://github.com/neutrino38/elixip/blob/master/DSL.md)

FSL (Finite State Language) is a small, readable language for describing
finite state machines, embedded in TypeScript. It is the TypeScript sibling
of the Elixip DSL used for SIP scenarios on the BEAM. Its first target is
**stateful communication frontends**: web phones, web chat, bot UIs — where
the UI must follow the life of a call, a registration, a conversation.

---

## 1. Foundational decisions

### 1.1 TypeScript, consumed from both TS and JS

The language is **authored in TypeScript** and published as a compiled npm
package (ESM, with `.d.ts` type declarations).

Why TypeScript and not plain JavaScript:

- **State names become types.** `goto("connectd")` is a compile error, not a
  silent dead transition discovered in production. This is the single biggest
  robustness win a DSL embedded in TS can get for free.
- **Events become a discriminated union.** The equivalent of Elixir pattern
  matching in `on_events` is TS narrowing on `event.type` — the compiler
  checks the payload you read in each clause.
- **The context becomes typed.** `ctx` carries the SIP stack handles, the
  session, appdata — typos and wrong shapes are caught at build time.
- **Zero cost for JS users.** The published package is plain JS; a JavaScript
  project uses it unchanged and still gets editor completion from the shipped
  types. Choosing TS excludes nobody; choosing JS would exclude type safety.

There is no `enum`/decorator/class magic: the DSL is plain object literals and
functions, so the JS-consumer experience is idiomatic JS.

### 1.2 Framework strategy: pure core + thin adapters

The npm package is **`finite-state-language`** (availability on the npm
registry checked 2026-08-15) — the exact expansion of the FSL acronym.

```
finite-state-language           core: zero dependency, no DOM, browser & Node
finite-state-language/http      optional: HTTP requests as events (§4.4) — no
                                dependency either (standard fetch)
finite-state-language/react     adapter: one hook (optional react peerDependency)
finite-state-language/vue       adapter: one composable (later)
finite-state-language/diagram   build tool: the graph read from the source
                                (§6.1) — optional typescript peerDependency
```

- The **core is a pure JS library**: it needs nothing but standard timers and
  Promises. It runs identically in the browser, in Node.js, in workers.
  This directly answers "can we remain a pure JS lib?" — yes, the core is.
- **Adapters are subpath exports of the same npm package**, not separate
  packages: one repo, one version, no lockstep publishing problem. Importing
  the core never pulls React; importing the `/react` subpath requires React
  as a peer.
- The machine exposes a tiny **external-store contract** (`getSnapshot` +
  `subscribe`) which is exactly what modern frameworks bind to
  (`useSyncExternalStore` in React, `shallowRef` + watch in Vue, plain
  listener in vanilla JS). The adapters are therefore ~30 lines each.

### 1.3 Communication-stack agnosticism

FSL never imports a SIP/WebRTC library. The integration contract is:

- the application stores stack handles (JsSIP `UA`, `RTCSession`,
  `RTCPeerConnection`, a WebSocket…) **in the machine context**;
- the application translates stack callbacks into **FSL events** and feeds
  them with `machine.send(...)`.

A ~50-line binding file per stack (one is provided as an example for
[JsSIP](https://jssip.net/)) is the whole coupling surface.

### 1.4 Dependencies

Runtime dependencies of the core: **none**. Dev dependencies (compiler,
bundler, test runner) must be mainstream, maintained, and security-clean.

A subpath may declare an **optional peer dependency** when what it does
cannot be done without one — `react` for the adapter, `typescript` for
the diagram tool. It stays optional and external to the bundle: a
consumer who never imports that subpath installs nothing extra, and the
core keeps its zero-dependency promise.

---

## 2. A complete example

A web phone: register, place a call, receive a call, hang up.

```ts
import { defineMachine, goto, next, loop, success, failure }
  from "finite-state-language";

// ---- the typed vocabulary of this machine --------------------------------

interface PhoneCtx {
  ua?: SipUserAgent;          // any comm stack — FSL does not care
  session?: SipSession;
  callee?: string;
  lastError?: string;
}

type PhoneEvent =
  | { type: "ui:call"; number: string }
  | { type: "ui:answer" }
  | { type: "ui:hangup" }
  | { type: "sip:registered" }
  | { type: "sip:registrationFailed"; cause: string }
  | { type: "sip:progress" }                          // 180/183
  | { type: "sip:accepted" }                          // 200 OK
  | { type: "sip:incoming"; session: SipSession; from: string }
  | { type: "sip:ended"; cause: string };

// ---- the machine ----------------------------------------------------------

export const WebPhone = defineMachine<PhoneCtx, PhoneEvent>({
  name: "WebPhone",

  context: () => ({}),

  states: {
    // initial_state is mandatory, and is entered on machine.start()
    initial_state: {
      enter(ctx) {
        ctx.ua = createUserAgent(sipConfig);   // app-provided binding
        ctx.ua.start();
        return goto("registering");
      },
    },

    registering: {
      on: {
        "sip:registered":         ()   => goto("ready", "REGISTER OK"),
        "sip:registrationFailed": (ev) => failure(`registration: ${ev.cause}`),
      },
      after: { delay: 30_000, then: () => failure("registrar did not answer") },
    },

    ready: {
      on: {
        "ui:call": (ev, ctx) => {
          ctx.callee = ev.number;
          ctx.session = ctx.ua!.call(ev.number);
          return goto("calling_out", `calling ${ev.number}`);
        },
        "sip:incoming": (ev, ctx) => {
          ctx.session = ev.session;
          return goto("ringing_in", `incoming from ${ev.from}`);
        },
      },
    },

    calling_out: {
      on: {
        "sip:progress": () => loop("ringing"),        // stay, note the event
        "sip:accepted": () => goto("connected", "200 OK"),
        "sip:ended":    (ev, ctx) => { ctx.lastError = ev.cause;
                                       return goto("call_failed", ev.cause); },
        "ui:hangup":    (_, ctx) => { ctx.session?.terminate();
                                      return goto("ready", "caller gave up"); },
      },
      after: { delay: 90_000, then: () => goto("call_failed", "no answer") },
    },

    ringing_in: {
      on: {
        "ui:answer": (_, ctx) => { ctx.session!.answer(); return stay(); },
        "sip:accepted": () => goto("connected"),
        "ui:hangup": (_, ctx) => { ctx.session?.terminate();
                                   return goto("ready", "rejected"); },
        "sip:ended": () => goto("ready", "caller hung up"),
      },
    },

    connected: {
      on: {
        "ui:hangup": (_, ctx) => { ctx.session?.terminate(); return stay(); },
        "sip:ended": () => goto("ready", "call ended"),
      },
    },

    call_failed: {
      on: {
        "ui:call": "ready",       // shorthand: re-dispatch after moving there
      },
      after: { delay: 5_000, then: () => goto("ready") },
    },
  },
});
```

Running it (vanilla):

```ts
const phone = WebPhone.start();
bindSipStack(phone);                       // stack callbacks -> phone.send(...)
callButton.onclick = () =>
  phone.send({ type: "ui:call", number: input.value });
phone.subscribe(({ state }) => renderUi(state));
```

Running it (React):

```tsx
import { useMachine } from "finite-state-language/react";

function Phone() {
  const { state, context, send } = useMachine(WebPhone);
  return (
    <>
      <StatusBadge state={state} />
      <button disabled={state !== "ready"}
              onClick={() => send({ type: "ui:call", number })}>
        Call
      </button>
      <button disabled={!["calling_out", "ringing_in", "connected"].includes(state)}
              onClick={() => send({ type: "ui:hangup" })}>
        Hang up
      </button>
    </>
  );
}
```

---

## 3. Concepts

| Elixip DSL                  | FSL/TS                                        |
|-----------------------------|-----------------------------------------------|
| `state name do ... end`     | key in the `states` object                    |
| synchronous state body      | `enter(ctx, fx)`                              |
| `on_events do ... end`      | `on: { "event:type": handler, ... }`          |
| `after ms -> ...`           | `after: { delay, then }`                      |
| `goto state, "desc"`        | `return goto("state", "desc")`                |
| `goto next`                 | `return next("desc")`                         |
| `goto loop`                 | `return loop("desc")` (re-runs `enter`)       |
| —                           | `return stay()` (handle without re-entering)  |
| `scenario_success("r")`     | `return success("r")`                         |
| `scenario_failure("r")`     | `return failure("r")`                         |
| `scenario_aborted("r")`     | `return aborted("r")` / cooperative shutdown  |
| `sip_ctx` + `appdata_*`     | typed `ctx` (whole context is user-defined)   |
| process mailbox             | machine event queue (see §6.3)                |
| `sub_fsm / notify`          | `fx.spawn / fx.notify / fx.notifyParent`      |
| `on_shutdown`               | `onShutdown` hook                             |
| `cleanup/1`                 | `cleanup(ctx)` hook                           |
| `Valet.ask/4`               | `fx.task(work, tag, {timeout})`               |
| `use HTTP.Session`, `http_GET` | `finite-state-language/http`, `httpGet(fx, …)` |

### 3.1 Machine definition

```ts
defineMachine<Ctx, Ev>(def: MachineDef<Ctx, Ev>): Machine<Ctx, Ev>
```

`MachineDef`:

- `name` — for logs, devtools, diagram export.
- `context: () => Ctx` — factory producing a fresh context per instance.
  Starting a machine twice never shares mutable state.
- `states` — ordered record of state definitions. **Declaration order is
  meaningful**: it defines what `next()` means (JS object string keys preserve
  insertion order — this is spec-guaranteed, not luck).
- `initial_state` **must** exist. It plays the role of `main()`.
- `onShutdown?`, `cleanup?` — lifecycle hooks (§8).

Two terminal states are **predeclared** and cannot be redefined:
`terminal_success_state` and `terminal_failure_state` (plus the `aborted`
outcome). User states may not use these names.

### 3.2 State definition

```ts
interface StateDef<Ctx, Ev> {
  enter?: (ctx: Ctx, fx: Fx<Ev>) => Transition | void;
  on?:    { [type in Ev["type"] | "*"]?: Handler | StateName };
  after?: { delay: number; then: (ctx: Ctx, fx: Fx<Ev>) => Transition };
  meta?:  Record<string, unknown>;   // free UI hints (see §7.3)
}
```

- `enter` is the equivalent of the Elixir state body: synchronous set-up code
  executed each time the state is entered (including on `loop()`). It may
  return a transition directly (`initial_state` typically does), or return
  nothing and let events drive.
- `enter` must **never block**: no `await` inside the machine's critical path,
  no busy loops. Long work goes through `fx.task()` (§6.4) and comes back as
  an event — same rule as "no `Process.sleep`" in Elixip.
- `on` maps an event type to a handler
  `(ev, ctx, fx) => Transition | void`. A string value is a shorthand for
  `() => goto(thatState)`. `"*"` is the catch-all clause.
- `after` arms one timer when the state is entered; it is cancelled on exit
  and re-armed on `loop()`. Exactly the Elixir `after` clause.

### 3.3 Transitions

Transition constructors are **values returned by handlers** — never called
for side effect. This keeps handlers pure-ish and makes "goto must be the
last expression" a non-issue: in TS it is simply `return`.

- `goto(state, desc?)` — move to a named state (type-checked).
- `next(desc?)` — move to the state declared after the current one.
- `loop(desc?)` — re-enter the current state; `enter` runs again, `after`
  re-arms.
- `stay(desc?)` — remain in the state **without** re-running `enter`.
  This has no Elixir equivalent (a `receive` loop always re-enters); UIs need
  it constantly (e.g. keep a call timer running while handling a mute event).
- `success(reason?)` / `failure(reason?)` / `aborted(reason?)` — jump to the
  terminal states and settle `machine.done`.
- Returning `void`/`undefined` from an `on` handler ≡ `stay()`.

The optional `desc` string is what the transition log shows — the same
"readability first" idea as the second argument of Elixip's `goto`.

---

## 4. Events

An event is any object with a string `type` field:

```ts
{ type: "sip:accepted" }
{ type: "ui:call", number: "sip:alice@example.com" }
```

Recommended naming: `source:name` (`ui:`, `sip:`, `media:`, `net:`, `child:`).
The event union is declared by the machine author; the compiler enforces both
the sender side (`machine.send`) and the receiver side (`on` clauses).

### 4.1 Delivery semantics

- `machine.send(ev)` **enqueues**; events are processed one at a time, in
  order (run-to-completion). A handler that triggers a transition completes
  fully — `enter` of the new state included — before the next event is taken.
- Events arriving while a handler runs are queued, never lost, never
  re-entrant. This reproduces the actor-mailbox behaviour of Elixip without
  processes.

### 4.2 Unmatched events: the pending queue (selective receive)

Elixir's selective `receive` leaves unmatched messages in the mailbox, where
a later state can still collect them. **FSL keeps this model**, implemented
in the engine, so the event semantics of FSL/TS and FSL Elixir stay close —
an INVITE that races a state change must not be lost.

- An event with no matching clause in the current state is **not dropped**:
  it is appended to the **pending queue** (arrival order preserved) and
  logged at debug level (`event 'sip:incoming' pended in state 'connected'`).
- On every **state entry** (`goto`, `next`, `loop` — not `stay`, which keeps
  the same clauses), before any new event is taken, the engine **replays the
  pending queue in order** against the new state's clauses. A matched pending
  event is consumed and handled normally — it may itself trigger a
  transition, in which case the remaining pending events are replayed on
  entering *that* state. Still-unmatched events stay queued.
- The `"*"` catch-all matches everything, so a state declaring it drains the
  queue — the explicit "flush point" of a flow.

This is exactly the selective-receive contract; what a browser adds is
**hygiene**, because a UI can produce unbounded stale events:

- the queue is **bounded** (`pending: { max }`, default 32); on overflow the
  oldest event is dropped with a warning log;
- the queue is **inspectable**: exposed read-only as `snapshot.pending` (and
  `machine.pending`), so app code and devtools can see what is waiting;
- the queue is **purgeable** from handlers: `fx.dropPending(type)` or
  `fx.dropPending(ev => ...)` — e.g. entering `ready` may discard stale
  `ui:*` events while keeping `sip:*` ones.

### 4.3 Timers and async work: `fx.task`, the Valet pattern

`fx.task` is the transposition of Elixip's **`Valet`** coordinator
(`apps/elixip2/lib/framework/Valet.ex`): turn any long-running work into
**exactly one** tagged event delivered to the machine, with the timeout
arbitrated at a single point so no race and no late leak is possible.

```ts
fx.task(work, tag, opts?)
// work: Promise<T> | ((signal: AbortSignal) => Promise<T>)
// opts: { timeout?: number }
```

```ts
enter(ctx, fx) {
  fx.task(signal => fetch("/api/policy", { signal }).then(r => r.json()),
          "policy", { timeout: 10_000 });
},
on: {
  "task:policy": (ev, ctx) =>
    ev.ok ? (ctx.policy = ev.value, next())
          : failure(`policy fetch: ${ev.error}`),
}
```

- resolves → `{ type: "task:<tag>", ok: true,  value }`
- rejects  → `{ type: "task:<tag>", ok: false, error }`
- timeout  → `{ type: "task:<tag>", ok: false, error: "timeout" }`, and the
  `AbortSignal` fires so the underlying work is actually cancelled (a JS
  Promise cannot be killed like a BEAM worker — the signal is the TS
  equivalent of `Process.exit(worker, :kill)`).
- Whichever of {settlement, timeout, cancellation} happens first wins;
  every later outcome of the same task is **discarded**. Results arriving
  after the machine reached a terminal state (or after `fx.cancel(tag)`) are
  discarded too — the full Valet guarantee: no `after` clause needed for the
  timeout case, no late reply can ever pollute a later `on` block.

`fx.send(ev)` self-sends an event (processed after the current one).
`fx.delay(ev, ms)` sends it later; the handle is cancelled on state exit
unless marked `{ sticky: true }`.

### 4.4 HTTP as events: `finite-state-language/http`

The transposition of Elixip's **`HTTP.Session`** mixin (`http_GET`), which is
built on `Valet` exactly as this module is built on `fx.task`. It lives in a
**separate subpath module**: the core stays protocol-free, and importing it
adds no dependency (standard `fetch`, available in every browser and in
Node ≥ 18).

```ts
import { httpGet, type HttpResult } from "finite-state-language/http";

type Ev = PhoneEvent | HttpResult<"provisioning">;   // typed like any event

// ...
query_backend: {
  enter(ctx, fx) {
    httpGet(fx, "https://backend/api/x", { tag: "provisioning", timeout: 10_000 });
  },
  on: {
    "http:provisioning": (ev, ctx) => {
      if (!ev.ok)            return failure(`backend ${ev.error}`);
      if (ev.status !== 200) return failure(`backend HTTP ${ev.status}`);
      ctx.data = ev.body;
      return next("backend OK");
    },
  },
},
```

Compare with the Elixip original — the shape is deliberately identical:

```elixir
state query_backend do
  http_GET("https://backend/api/x", 10_000, :provisioning)
  on_events do
    {:provisioning, {:ok, %Req.Response{status: 200, body: b}}} ->
      appdata_set(:data, b); goto next, "backend OK"
    ...
  end
end
```

API:

```ts
httpGet(fx, url, { tag, timeout, headers?, parse? })
// parse: "json" (default) | "text" | "raw" (the Response object)
```

Delivered events (one per call, ever):

```ts
{ type: `http:${tag}`, ok: true,  status, headers, body }
{ type: `http:${tag}`, ok: false, error }   // "timeout" | network/parse error
```

`HttpResult<Tag>` is the exported event type to add to the machine's union.

Guarantees, inherited from `fx.task` and matching `HTTP.Session` word for
word: **exactly one** event even on timeout (no `after` clause needed for
it); on timeout the fetch is aborted so the connection is reclaimed; a late
or post-terminal result is discarded and can never pollute a later state.

`httpPost` / a generic `httpRequest` will follow the same event shape when
needed — Elixip only has `http_GET` today, and parity is kept on purpose.

---

## 5. Context

The context is a **single mutable object, owned by the machine instance**,
created by the `context()` factory at `start()`.

- Handlers receive it as `ctx` and may mutate it directly — this replaces
  `appdata_set/get`. The whole context is app-defined and typed; FSL reserves
  no field names.
- Comm-stack handles live here (`ctx.ua`, `ctx.session`…). FSL never touches
  them; `cleanup` is where the app releases them.
- Subscribers are notified **on transition** (state change, `loop`, terminal),
  not on context mutation. UIs read `snapshot.context` at render time. If a
  context change must repaint without a state change, the handler returns
  `stay("desc")` — an explicit, logged "same state, new data" tick.

Unlike Elixip there is no `lasterr` auto-check on `goto`: TS has exceptions.
Any exception thrown by `enter` or a handler is caught by the runner, logged
with the state name, and converted to `failure(String(err))` — the same
"uncaught exception ⇒ scenario_failure" contract.

---

## 6. Machine instances

```ts
const m = WebPhone.start(opts?);

m.state          // current state name (string)
m.context        // the live context
m.send(ev)       // feed an event
m.subscribe(fn)  // fn({state, context, event?, desc?}) on every transition;
                 // returns an unsubscribe function
m.getSnapshot()  // stable {state, context} reference for external-store APIs
m.matches(s)     // convenience: m.state === s, type-checked
m.done           // Promise<{outcome: "success"|"failure"|"aborted", reason?}>
m.shutdown(r?)   // cooperative shutdown (§8)
m.log            // ring buffer of the last N transitions (state, event, desc)
```

`opts`: `{ debug?: boolean, args?: Partial<Ctx>, logger?: (line) => void }`.
`args` is merged into the fresh context — the equivalent of `args:` for
sub-FSMs and of external configuration for top machines.

### 6.1 Observability

- `debug: true` logs every transition as `event: (old) -> (new) "desc"` —
  same format as Elixip.
- `Machine.toMermaid()` renders the **static** graph at runtime. Handlers
  are closures there, so the only targets it can extract are the `on`
  string-shorthands; every other state is printed with a summary of the
  events it listens to.
- The **`diagram` module** renders the same graph from the machine's
  source, where every `goto` names its target. It recovers the real
  edges, resolves `next()` through declaration order, and reports the
  events a state consumes or forwards to a child. It is a build-time
  tool: it parses TypeScript, so it lives outside the runtime.
- The transition log gives the **dynamic** trace. Readability is a
  feature: a machine you can print is a machine you can review.

---

## 7. UI integration

### 7.1 The external-store contract

`subscribe` + `getSnapshot` is the entire integration surface. The React
adapter is:

```ts
export function useMachine<C, E>(machine: Machine<C, E> | Instance<C, E>) {
  const inst = useOwnedInstance(machine);          // start/stop tied to lifecycle
  const snap = useSyncExternalStore(inst.subscribe, inst.getSnapshot);
  return { state: snap.state, context: snap.context, send: inst.send };
}
```

Vue, Svelte, Solid bindings follow the same 30-line pattern. None of them is
required: vanilla JS subscribes directly.

### 7.2 Explicit state ⇒ UI state

The FSL state name is *designed* to be used directly in rendering — the
modern equivalent of `automate.js`'s per-state Activate/Deactivate switch,
but derived instead of imperative:

```tsx
<CallButton disabled={state !== "ready"} />
```

### 7.3 `meta`: declarative UI hints

For teams that prefer the old uielements table style, each state may carry
free-form `meta` (e.g. `meta: { buttons: { call: false, hangup: true } }`).
FSL does not interpret it; `snapshot.meta` just exposes the current state's
block. This keeps "which widget is active in which state" in one readable
place without coupling the core to any UI.

---

## 8. Sub-machines, shutdown, cleanup

### 8.1 Sub-machines

```ts
enter(ctx, fx) {
  fx.spawn(AutoAnswer, { as: "callee", args: { play: "ring.wav" } });
  return next();
}
```

- The child is a full machine instance owned by the parent.
- `fx.notify("callee", payload)` → child receives
  `{ type: "parent:msg", payload }`.
- `fx.notifyParent(payload)` → parent receives
  `{ type: "child:msg", from: "callee", payload }`. No-op without a parent,
  so the same machine runs standalone — same contract as Elixip.
- Child termination → parent receives
  `{ type: "child:exit", from, outcome, reason }`.
- Children nest freely. When a machine terminates, it shuts its live children
  down cooperatively, then force-stops stragglers after a grace period
  (default 5 s), before settling its own `done`.

### 8.2 Cooperative shutdown

`instance.shutdown(reason)` (or a parent winding down) triggers:

1. if the definition has `onShutdown(ctx, fx)`, it runs and decides the exit
   (`aborted(...)` by default, but it may finish business first — send a BYE,
   flush a message — then return a terminal transition);
2. otherwise the machine terminates immediately with outcome `aborted`.

### 8.3 Cleanup

After any terminal transition the runner: cancels timers and pending tasks,
shuts down children, then calls `cleanup(ctx)` if defined — the place to
`ua.stop()`, close PeerConnections, release media. Only then does
`done` settle and do subscribers get the final notification.

---

## 9. Backend usage (non-priority, kept honest)

Because the core is dependency-free and DOM-free, the same machine definition
runs under Node.js — for tests (drive the machine with scripted events,
assert `done`), for service-side call-flow description, or on any JS runtime.
Nothing in this spec may break that property. Deliberate non-goals for v1:
distribution, persistence/rehydration, BEAM-style supervision.

**There is deliberately no Node adapter.** An adapter exists to bind the
machine to a framework's *render cycle* (that is all `fsl/react` does); Node
has no render cycle, so the core API *is* the Node API:

```ts
const call = CallFlow.start({ args: { callee } });
ws.on("message", m => call.send(parseEvent(m)));
call.subscribe(({ state }) => logger.info(state));
const outcome = await call.done;      // like Elixip run/0: success | failure | aborted
```

What a backend *will* eventually need is not adaptation but **supervision** —
what OTP gives Elixip for free: a service runs one machine instance per
call/session, and a `SIGTERM` must broadcast cooperative `shutdown()` to every
live instance (each `onShutdown` sends its BYE) before the process exits —
the equivalent of `elixipp`'s graceful stop broadcasting
`{:scenario_ctl, :shutdown}` to all active calls. When backend becomes a
priority, this becomes a `finite-state-language/node` module (instance
registry + signal-driven graceful shutdown; an EventEmitter→`send` binding is
trivial app code and may tag along). Out of scope for v1, recorded here so
the reasoning is not lost.

**Phoenix LiveView** was studied and deliberately left out of FSL/TS:
LiveView events are delivered server-side, so that adapter belongs to Elixip
(see `elixip/docs/design/liveview-adapter.md`). FSL/TS's role in a LiveView
service is browser-side only: the media machine inside a `phx` hook
(getUserMedia / RTCPeerConnection), bound to LiveView through
`pushEvent`/`handleEvent` like any other comm stack — a recipe for
`examples/`, not an adapter.

---

## 10. Differences from Elixip DSL — summary

| Topic | Elixip | FSL/TS | Why |
|---|---|---|---|
| Blocking waits | `receive` blocks a process | event queue + run-to-completion | no processes in JS |
| Unmatched events | stay in mailbox | pending queue replayed at every state entry — same selective-receive model, bounded & inspectable | keep the event models close; add UI hygiene |
| `stay()` | n/a | handle event without re-entry | UI needs it (mute during a call) |
| Error channel | `lasterr` checked by `goto` | exceptions ⇒ `failure` | idiomatic TS |
| Pattern matching | full Elixir patterns | `event.type` dispatch + plain TS in the handler | keep the DSL small |
| SIP helpers | `SIP.Session.*` macros | out of scope: bindings live app-side | stack-agnostic requirement |

---

## 11. Decisions log & open questions

Settled (review of 2026-08-15):

1. **npm package name: `finite-state-language`** (availability checked;
   `fsl` is taken). Keeps the acronym — and the LSF pun — intact.
2. **Selective receive is engine-level** (§4.2 pending queue). The earlier
   idea of an opt-in per-state `defer` list is superseded and removed:
   keeping the FSL/TS and FSL Elixir event models close is a requirement.
3. **Wildcards: exact event type + `"*"` only.** `"*"` is the moral
   equivalent of Elixir's `_` catch-all, and that is judged sufficient;
   no `"sip:*"` family matching in v1.
4. **No `goto back` / history helper in v1.** Deferred until a concrete
   screen needs it. Both `stay()` and `goto back` are proposed as
   improvements to FSL Elixir instead (see
   `elixip/docs/design/improve-fsl-elixir.md`).

Still open:

1. `meta` snapshot exposure: raw per-state block vs. merged with
   machine-level defaults (see §7.3) — under discussion.
