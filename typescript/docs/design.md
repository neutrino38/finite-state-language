# FSL for TypeScript — Software Design

Companion to [the language spec](../../spec/fsl-js-ts.md) (draft v0.2) and the
[implementation plan](implementation-plan.md). The spec says *what* the
language means; this document says *how* the TypeScript implementation is
built: module decomposition, data structures, runtime algorithms, and the
type-level machinery. Where the spec is ambiguous or over-promises, the
resolution is recorded in §11 and fed back to the spec.

Everything here lives under `typescript/`. Spec section numbers are cited as
`spec §N`.

---

## 1. Design goals and constraints

Restating the constraints that shape every decision below:

- **Zero runtime dependencies in the core** (spec §1.4). Only standard
  timers, Promises, `AbortController`. Enforced by CI.
- **Environment-agnostic core**: no DOM, no Node APIs — browser, Node ≥ 18,
  workers (spec §1.2, §9).
- **Semantics identical to FSL Elixir** where the spec demands it: actor-style
  run-to-completion, selective receive via the pending queue (spec §4.1–4.2).
- **Compile-time safety**: state names, event types and context are all
  checked (spec §1.1).
- **Tiny**: core < 5 kB min+gzip (plan M7). This rules out any heavyweight
  abstraction; the runtime is one class plus small helpers.
- **Readability of user code is the product.** Internal cleverness is fine;
  API cleverness is not.

---

## 2. Module decomposition

```
src/
  index.ts            public API of the core (re-exports)
  core/
    types.ts          all public types: MachineDef, StateDef, Fx, Snapshot…
    transition.ts     transition constructors and the Transition union
    define.ts         defineMachine, static validation of the definition
    instance.ts       MachineInstance: event loop, state entry, lifecycle
    fx.ts             per-dispatch Fx facade bound to an instance
    tasks.ts          TaskManager (the Valet pattern, spec §4.3)
    timers.ts         TimerBag: `after` timer + fx.delay handles
    pending.ts        PendingQueue (selective receive, spec §4.2)
    log.ts            TransitionLog ring buffer + debug line formatting
    mermaid.ts        toMermaid() static-graph export
  http/
    index.ts          httpGet + HttpResult (subpath export, spec §4.4)
  react/
    index.ts          useMachine (subpath export, spec §7.1)
test/
  …                   one file per spec section (see §10)
```

Dependency direction is strictly downward: `instance.ts` uses `pending.ts`,
`tasks.ts`, `timers.ts`, `log.ts`; nothing imports `instance.ts` except
`define.ts` and the adapters. `http/` and `react/` import only the public
core API — they are clients, compiled into separate bundle entries so the
core entry never includes them (tsup `entry: {index, http/index, react/index}`
+ `exports` map in `package.json`).

---

## 3. Public type design

### 3.1 The two user-facing type parameters

Per plan M2's risk note, the public generics stay shallow: a machine is
`Machine<Ctx, Ev, S>` where `Ctx` is the context shape, `Ev` the event
discriminated union, and `S` the string-literal union of state names.
`S` is always **inferred** from the `states` object literal, never written
by the user.

### 3.2 `defineMachine` and the partial-inference problem

The spec (§2) writes:

```ts
defineMachine<PhoneCtx, PhoneEvent>({ ... })
```

TypeScript has all-or-nothing type-argument inference: if `Ctx` and `Ev` are
given explicitly, the state names cannot also be inferred from the literal.
Since typed `goto` (the "single biggest robustness win", spec §1.1) requires
that inference, `defineMachine` is **curried**:

```ts
export function defineMachine<Ctx, Ev extends AnyEvent>():
  <SN extends string>(def: MachineDef<Ctx, Ev, SN>) => Machine<Ctx, Ev, SN>;

// usage — one extra pair of parens vs the spec:
export const WebPhone = defineMachine<PhoneCtx, PhoneEvent>()({ ... });
```

The inferred parameter is `SN`, the union of state names, with
`states: Record<SN, StateDef<Ctx, Ev, SN>>`: TypeScript infers a mapped
type's key parameter from the literal's keys. Two implementation findings
(discovered in M1, replacing the earlier recursive-constraint idea):

- a self-referential constraint `S extends Record<string, StateDef<…,
  keyof S>>` does **not** work — `keyof S` resolves to `never` while the
  handlers are contextually typed;
- every SN use-site inside `StateDef` (handler returns, string
  shorthands) must be wrapped in `NoInfer<SN>`, because return-position
  inference outranks mapped-type key inference: without it,
  `goto("typo")` would silently widen SN instead of failing to compile.

With both in place, `goto("connectd")` and a shorthand routing to an
unknown state are compile errors already in M1; M2 adds the type-level
test suite around this, plus a type-level `initial_state` requirement
(an intersection on the `def` parameter, which adds no SN inference
site).

Ctx and Ev carry defaults (`Record<string, any>` / `AnyEvent`) so plain
JavaScript gets two tiers (validated by the M2 `checkJs` fixture):

- zero-effort: `defineMachine()({ ... })` — loose context and events,
  state names still checked;
- typed: `/** @type {typeof defineMachine<Ctx, Ev>} */ (defineMachine)`
  with `@typedef` — the full TS experience from JSDoc.

### 3.3 Transitions as tagged values

Transitions are plain frozen objects, discriminated on `kind`, parameterised
by the target so the type-checker can reject unknown names:

```ts
type Transition<S extends string = string> =
  | { kind: "goto"; to: S; desc?: string }
  | { kind: "next"; desc?: string }
  | { kind: "loop"; desc?: string }
  | { kind: "stay"; desc?: string }
  | { kind: "final"; outcome: "success" | "failure" | "aborted"; reason?: string };

function goto<S extends string>(to: S, desc?: string): Transition<S>;
function next(desc?): Transition<never>;      // target-free constructors use
function loop(desc?): Transition<never>;      // `never` so they are assignable
function stay(desc?): Transition<never>;      // to any Transition<S>
function success(reason?): Transition<never>; // (never ⊆ S for all S)
function failure(reason?): Transition<never>;
function aborted(reason?): Transition<never>;
```

A handler's declared return type is `Transition<StateNames<S>> | void`;
contextual typing then constrains the `S` of an inline `goto(...)` call.
Constructors are pure value factories — no ambient registry, no side effect
(spec §3.3) — so they are safely importable at module top level and shareable
across machines.

### 3.4 State and machine definitions

Directly transcribing spec §3.1–3.2:

```ts
type AnyEvent = { type: string };
type Handler<Ctx, Ev, E, SN extends string> =
  (ev: E, ctx: Ctx, fx: Fx<Ev, SN>) => Transition<SN> | void;

interface StateDef<Ctx, Ev extends AnyEvent, SN extends string> {
  enter?: (ctx: Ctx, fx: Fx<Ev, SN>) => Transition<SN> | void;
  on?: { [T in Ev["type"]]?: Handler<Ctx, Ev, Extract<Ev, { type: T }>, SN> | SN }
     & { "*"?: Handler<Ctx, Ev, Ev, SN> | SN };
  after?: { delay: number; then: (ctx: Ctx, fx: Fx<Ev, SN>) => Transition<SN> };
  meta?: Record<string, unknown>;
}

interface MachineDef<Ctx, Ev extends AnyEvent, SN extends string> {
  name: string;
  context: () => Ctx;
  states: Record<SN, StateDef<Ctx, Ev, SN>>;  // must contain "initial_state"
  pending?: { max?: number };                 // default 32 (spec §4.2)
  onShutdown?: (ctx: Ctx, fx: Fx<Ev, SN>) => Transition<SN> | void;
  cleanup?: (ctx: Ctx) => void;
}
```

Event narrowing in `on` clauses is `Extract<Ev, { type: T }>` — the
discriminated-union dispatch promised in spec §1.1. The internal event types
the engine injects (`task:*`, `child:*`, `parent:msg`, `http:*`) are exported
as generic helper types (`TaskResult<Tag, T>`, `ChildExit`, …) that the user
adds to their union, exactly as `HttpResult<Tag>` does in spec §4.4.

`Fx` (spec §3, §4.3, §8.1):

```ts
interface Fx<Ev extends AnyEvent, SN extends string> {
  send(ev: Ev): void;
  delay(ev: Ev, ms: number, opts?: { sticky?: boolean }): DelayHandle;
  task<T>(work: Promise<T> | ((signal: AbortSignal) => Promise<T>),
          tag: string, opts?: { timeout?: number }): void;
  cancel(tag: string): void;
  dropPending(sel: Ev["type"] | ((ev: Ev) => boolean)): void;
  spawn(machine: AnyMachine, opts: { as: string; args?: object }): void;
  notify(child: string, payload: unknown): void;
  notifyParent(payload: unknown): void;
}
```

### 3.5 Runtime validation of the definition

Types protect TS users; `defineMachine` also validates at runtime for JS
consumers (spec §1.1 "zero cost for JS users" cuts both ways — they deserve
loud errors too):

- `states.initial_state` must exist (spec §3.1);
- no user state may be named `terminal_success_state`,
  `terminal_failure_state` or `terminal_aborted_state` (spec §3.1);
- `context` must be a function.

Violations throw synchronously from `defineMachine` — fail at module load,
not at first transition.

---

## 4. Runtime core: `MachineInstance`

One class, one instance per `Machine.start()`. Its fields:

```
def                the frozen MachineDef
ctx                the live context (context() merged with opts.args)
stateName          current state (starts as "initial_state" on start)
phase              "running" | "terminating" | "done"
inbox              FIFO array of external/self events
pendingQ           PendingQueue (spec §4.2)
timers             TimerBag (after-timer + delay handles)
tasks              TaskManager
children           Map<string, MachineInstance>, plus parent back-ref
subscribers        Set<listener>
snapshot           cached { state, context, pending, meta } (see §4.7)
translog           TransitionLog ring buffer
doneResolve/done   the terminal promise (spec §6)
draining           boolean re-entrancy latch of the event loop
```

### 4.1 The event loop (run-to-completion, spec §4.1)

`send(ev)` never processes inline; it enqueues and triggers a drain:

```
send(ev):
  if phase == "done": log(debug, "event dropped, machine done"); return
  inbox.push(ev)
  drain()

drain():
  if draining: return            // re-entrancy latch: fx.send / subscriber
  draining = true                // sends land in inbox and are picked up
  while inbox not empty and phase == "running":
    dispatch(inbox.shift())
  draining = false
```

The loop is **synchronous**: a `send` from outside a handler fully processes
the event (transitions, `enter`, pending replay included) before returning,
which is what makes scripted headless tests deterministic (plan M1 exit
criterion). Events sent *during* a dispatch (from `fx.send`, from a
subscriber, from a synchronously-settling child) hit the latch and queue —
"queued, never lost, never re-entrant" (spec §4.1).

### 4.2 Dispatching one event

```
dispatch(ev):
  clause = states[stateName].on?[ev.type] ?? states[stateName].on?["*"]
  if clause == undefined:
    pendingQ.push(ev)                     // bounded; see §4.5
    log(debug, `event '${ev.type}' pended in state '${stateName}'`)
    return
  if clause is a string:                  // shorthand, spec §3.2 + §2
    enterState(clause, `on ${ev.type}`, redispatch = ev)
    return
  t = guard(() => clause(ev, ctx, makeFx()))   // guard: see §4.8
  applyTransition(t, ev)
```

**String shorthand re-dispatches the event** in the target state: spec §2
annotates `"ui:call": "ready"` with *"re-dispatch after moving there"*, while
spec §3.2 reduces the shorthand to `goto(thatState)`. Plain `goto` would
consume the event and the target state would never see it — the §2 example
would move to `ready` without dialling. The design follows §2: after entering
the target state (and after its pending replay), the triggering event is
offered to the new state exactly once, through the normal `dispatch` path —
so if the new state doesn't match it either, it pends normally. Recorded as
spec feedback in §11.2.

### 4.3 Applying a transition

| returned value | effect |
|---|---|
| `undefined` / `void` | nothing: same state, no `enter`, **no notification** |
| `stay(desc?)` | same state, no `enter`, timers untouched, **notify** (the "same state, new data" repaint tick, spec §5) |
| `goto(s, d?)` | `enterState(s, d)` |
| `next(d?)` | `enterState(declarationSuccessor(stateName), d)`; `next` from the last declared state is a definition error → `failure` |
| `loop(d?)` | `enterState(stateName, d)` — `enter` re-runs, `after` re-arms (spec §3.3) |
| `success/failure/aborted` | `finalize(outcome, reason)` (§4.9) |

`void` vs `stay()`: spec §3.3 says they are equivalent, spec §5 says `stay`
is the *explicit* repaint tick. The design distinguishes them — implicit
`void` is silent, explicit `stay()` notifies and logs. This is the only
reading that makes both sections true and keeps handler-per-event UIs from
repainting on every ignored event. Spec feedback, §11.3.

`declarationSuccessor` is precomputed at `defineMachine` time as a
`Record<state, state>` from `Object.keys(states)` order (insertion order is
spec-guaranteed for string keys, spec §3.1).

### 4.4 State entry — the heart of the engine

```
enterState(target, desc?, redispatch?):
  chainGuard()                       // §4.8: bounded synchronous chain
  timers.onExit()                    // cancel after-timer + non-sticky delays
  prev = stateName; stateName = target
  translog.push(prev, target, currentEvent, desc)
  notifySubscribers()                // on entry, before enter runs
  t = guard(() => states[target].enter?.(ctx, makeFx()))
  if t is goto/next/loop/final:      // e.g. initial_state returning goto
    applyTransition(t); return       // deeper entry owns the rest
  // stay/void from enter are equivalent: the entry already notified
  timers.armAfter(states[target].after)
  replayPending()                    // spec §4.2 — before any new event
  if redispatch: dispatch(redispatch)
```

Ordering rationale:

- Subscribers are notified **at entry, before `enter` runs**: the machine
  *is* in the state while `enter` executes, and each intermediate hop of a
  synchronous chain (`initial_state → registering`) notifies, so the
  transition log and the subscriber stream agree.
- `enter` runs **before** `after` is armed, so an `enter` that immediately
  transitions never leaks a timer.
- Pending replay happens after `enter` completes and before the inbox drain
  resumes — "on every state entry, before any new event is taken" (spec §4.2).

### 4.5 The pending queue (selective receive, spec §4.2)

`PendingQueue` is an array + max bound (default 32):

```
push(ev):
  if len == max: dropped = shift(); log(warn, "pending overflow, dropped …")
  arr.push(ev)
```

Replay must survive re-transition mid-replay (a replayed event may `goto`,
whose `enterState` replays again — spec §4.2 "the remaining pending events
are replayed on entering *that* state"). The algorithm uses a **generation
counter** instead of recursion bookkeeping:

```
replayPending():
  gen = ++replayGeneration
  i = 0
  while i < pendingQ.length:
    ev = pendingQ[i]
    clause = currentState.on?[ev.type] ?? currentState.on?["*"]
    if clause == undefined: i++; continue          // stays pended, order kept
    pendingQ.remove(i)
    handle clause (same logic as dispatch, minus the pend branch)
    if replayGeneration != gen: return             // a transition happened:
                                                   // the inner enterState
                                                   // already replayed against
                                                   // the new state; stop.
```

A `stay()`/`void` result keeps replaying in the same state at the same index.
`fx.dropPending(sel)` filters the array in place; `"*"` in a state matches
every pended event, making it the flush point (spec §4.2).

`snapshot.pending` and `machine.pending` expose a frozen copy (see §4.7).

### 4.6 Timers: `TimerBag`

Two kinds, both `setTimeout`-based (available identically in browser, Node,
workers — no injection layer; tests use vitest fake timers on the globals):

- **the `after` timer** — armed at state entry when the state declares
  `after`, cancelled by `onExit()`, re-armed on `loop`. Firing runs
  `guard(() => after.then(ctx, fx))` and applies the transition. It fires
  through the same drain latch as events (it enqueues an internal thunk) so
  run-to-completion holds even against timer interleavings.
- **`fx.delay(ev, ms, {sticky})`** — a handle `{cancel()}` kept in the bag;
  `onExit()` cancels all non-sticky handles (spec §4.3). Firing simply
  `send(ev)`.

`finalize` cancels everything, sticky included.

### 4.7 Snapshot and subscription (spec §6, §7.1)

The snapshot is **cached and reference-stable**: rebuilt only inside
`notifySubscribers()`, returned as-is by `getSnapshot()`. This is the
contract `useSyncExternalStore` needs — an unchanged reference means "no
re-render". Shape:

```ts
{ state, context, pending, meta }   // meta = current state's meta block (spec §7.3)
```

`context` in the snapshot is the live object (spec §5: UIs read it at render
time; mutation without a transition is invisible by design). `subscribe(fn)`
adds to the set and returns an unsubscriber; listeners are called with
`{ state, context, event?, desc? }` inside a `try/catch` (a broken UI
listener must not kill the machine). Listener-thrown errors are logged and
swallowed.

### 4.8 Error containment and runaway protection

- `guard(f)` wraps every user callback (`enter`, `on` handlers, `after.then`,
  `onShutdown`): an exception is caught, logged with the state name, and
  converted to `failure(String(err))` (spec §5).
- `chainGuard()` bounds synchronous transition chains: more than 1 000
  `enterState` calls without draining an external event ⇒
  `failure("transition livelock in state '…'")`. Two states `goto`-ing each
  other from `enter` would otherwise hang the tab; the BEAM survives this,
  a browser thread does not. (Spec feedback, §11.4.)
- Exceptions in `cleanup` and in subscribers are logged and swallowed —
  teardown always completes, `done` always settles.

### 4.9 Termination: `finalize(outcome, reason)`

Directly implements spec §8.3, and is asynchronous only where children force
it to be:

```
finalize(outcome, reason):
  if phase != "running": return           // idempotent
  phase = "terminating"
  stateName = terminal state for outcome
  timers.cancelAll(); tasks.cancelAll(); inbox.clear(); pendingQ.clear()
  await shutdownChildren()                // §5: cooperative + 5 s grace
  guard-log( def.cleanup?.(ctx) )
  phase = "done"
  notifySubscribers()                     // final notification
  doneResolve({ outcome, reason })        // settle spec §6 `done` last
```

Note the order mandated by spec §8.3: cancel → children → cleanup → *then*
`done` settles and subscribers get the final notification. When the machine
has no children the whole path is synchronous.

---

## 5. Tasks (`fx.task`, the Valet pattern — spec §4.3)

`TaskManager` holds `Map<tag, { ctrl: AbortController, timer, settled }>`.

```
task(work, tag, {timeout}):
  cancel(tag)                        // one live task per tag; §11.5
  ctrl = new AbortController()
  entry = { ctrl, settled: false }
  map.set(tag, entry)
  p = (typeof work == "function") ? work(ctrl.signal) : work
  if timeout: entry.timer = setTimeout(() => settle(entry, tag,
                 { ok:false, error:"timeout" }, abort=true), timeout)
  p.then(v => settle(entry, tag, { ok:true,  value:v }),
         e => settle(entry, tag, { ok:false, error:String(e) }))

settle(entry, tag, result, abort=false):
  if entry.settled or map.get(tag) != entry: return   // late/stale ⇒ discarded
  entry.settled = true; clearTimeout(entry.timer); map.delete(tag)
  if abort: entry.ctrl.abort()
  if machine.phase == "running": send({ type: `task:${tag}`, ...result })
```

This yields every guarantee of spec §4.3 from one choke point: exactly one
event ever; first of {settlement, timeout, `fx.cancel`} wins; timeout aborts
the signal; results after cancel or after a terminal state are discarded
(`phase` check). `fx.cancel(tag)` = mark settled, abort, no event.
Re-using a live tag cancels the previous task — one outstanding event per
tag, the Valet contract (recorded in §11.5).

---

## 6. Sub-machines and shutdown (spec §8)

`fx.spawn(machineDef, { as, args })` starts a child instance with
`parent = this` and registers it in `children`. Message plumbing is direct
method calls — no bus:

- `fx.notify(name, payload)` → `children.get(name).send({ type: "parent:msg", payload })`;
- `fx.notifyParent(payload)` → `parent?.send({ type: "child:msg", from: myName, payload })` — literally a no-op without a parent (spec §8.1);
- the child calls `parent.childExited(name, result)` **synchronously** at
  the end of its own teardown, which synthesizes
  `{ type: "child:exit", from, outcome, reason }` (M4 finding: awaiting
  the child's `done` promise would defer child:exit to a microtask and
  make parent/child conversations nondeterministic under the
  synchronous drain).

Spawning a duplicate name is a runtime error (⇒ `failure`). A child that
exits is removed from the registry.

**Cooperative shutdown** (`instance.shutdown(reason)`, spec §8.2):

```
shutdown(reason):
  if phase != "running": return done
  if def.onShutdown:
    t = guard(() => onShutdown(ctx, fx))
    if t is terminal:      finalize(t.outcome, t.reason)
    else if t is goto/…:   applyTransition(t)   // graceful path: machine keeps
                                                // running toward its own end
    else:                  finalize("aborted", reason)
  else: finalize("aborted", reason)
  return done
```

`onShutdown` may return a *non-terminal* transition ("finish business first",
spec §8.2 — send the BYE, wait for `sip:ended` in a dedicated state). The
machine then keeps running; whoever asked for shutdown holds `done` and the
parent's grace period is the backstop. (Interpretation recorded in §11.6.)

**Child teardown inside `finalize`** (spec §8.1):

```
shutdownChildren():
  if children empty: return               // keeps the common path synchronous
  for child of children: child.shutdown("parent terminated")
  await Promise.race([ all children done, sleep(graceMs = 5000) ])
  for child still not done: child.forceStop()
```

`forceStop()` skips `onShutdown`, cancels the child's timers/tasks,
force-stops *its* children (recursion bottoms out because forced teardown is
synchronous), runs its `cleanup`, settles its `done` as
`{ outcome: "aborted", reason: "force-stopped" }`.

---

## 7. `finite-state-language/http` (spec §4.4)

A thin client of `fx.task` — no new machinery:

```ts
export type HttpResult<Tag extends string> =
  | { type: `http:${Tag}`; ok: true; status: number; headers: Headers; body: unknown }
  | { type: `http:${Tag}`; ok: false; error: string };

export function httpGet(fx, url, { tag, timeout, headers?, parse? = "json" }) {
  fx.task(async signal => {
    const res = await fetch(url, { signal, headers });
    const body = parse === "raw" ? res
               : parse === "text" ? await res.text()
               : await res.json();
    return { status: res.status, headers: res.headers, body };
  }, `http§${tag}`, { timeout });
}
```

The only subtlety: the task event must surface as `http:${tag}` (not
`task:…`) with the flattened result shape. Rather than teach `TaskManager`
about HTTP, `fx.task` accepts an internal `mapEvent` hook (not part of the
public `Fx` type) that the http module uses to reshape the settlement into
the spec §4.4 event. Every Valet guarantee (exactly-once, abort on timeout,
late-result discard) is inherited untouched. Non-2xx statuses are **not**
errors — the handler inspects `ev.status` (spec §4.4 example does exactly
that); only network/parse/timeout produce `ok: false`.

`httpPost`/`httpRequest`: same shape, added when Elixip grows them (spec §4.4).

---

## 8. `finite-state-language/react` (spec §7.1)

~30 lines, as promised:

```ts
export function useMachine<C, E>(m: Machine<C, E> | Instance<C, E>) {
  const inst = useOwnedInstance(m);
  const snap = useSyncExternalStore(inst.subscribe, inst.getSnapshot, inst.getSnapshot);
  return { state: snap.state, context: snap.context, meta: snap.meta, send: inst.send };
}
```

`useOwnedInstance` — the only real design point (plan M5 StrictMode risk):

- given an **instance**, the hook does not own it: no start, no shutdown;
- given a **machine**, the hook owns the lifecycle. StrictMode double-mount
  is handled by starting lazily in a ref on first `subscribe` *inside
  `useEffect`* and shutting down in the effect's cleanup; a remount after a
  simulated unmount starts a **fresh** instance (contexts are per-instance,
  spec §3.1, so this is semantically clean). The third
  `useSyncExternalStore` argument reuses `getSnapshot` for SSR safety.

Vue/Svelte adapters replicate the pattern against the same two methods —
nothing in the core is React-aware.

---

## 9. Observability (spec §6.1)

- **TransitionLog**: fixed-size ring buffer (default 50, `opts.log?.size`)
  of `{ seq, from, to, eventType?, desc? }`. Exposed as `instance.log`.
- **Debug logging**: `opts.debug` logs each transition through
  `opts.logger ?? console.debug` in the Elixip format:
  `` `${eventType}: (${from}) -> (${to}) "${desc}"` ``. Pending/overflow/
  discard messages go through the same logger.
- **`Machine.toMermaid()`** — static export, honest about its limits:
  handlers are opaque closures, so extractable edges are (a) string
  shorthands, (b) `next` adjacency is *not* guessed, (c) nothing else.
  Emitted graph: all states in declaration order, terminal states styled,
  one labelled edge per string shorthand, and for every state with
  non-shorthand handlers a single dashed self-annotation listing its event
  types. The dynamic trace (transition log) is the tool for actual paths.
  The spec's "declared gotos" phrasing over-promises for v1 — recorded in
  §11.7. If richer diagrams prove needed, a `meta.transitions` hint is the
  escape hatch, not source parsing.

---

## 10. Testing design (plan "Test strategy summary")

- Every runtime rule above carries the spec section in the test name
  (`"§4.2 replay stops at generation change"`). One test file per spec
  section under `test/core/`.
- **Determinism**: the synchronous drain (§4.1) means scripted tests are
  plain function calls + assertions; fake timers (`vi.useFakeTimers`) cover
  `after`/`delay`/task timeouts; `http/` is tested against a stubbed
  global `fetch`.
- **Type-level tests** (plan M2): `assertType` fixtures proving
  `goto("typo")`, wrong event payload access, and redefinition of terminal
  state names fail to compile; plus a `checkJs` fixture consuming the built
  package.
- **Zero-dependency check**: CI script asserts
  `Object.keys(pkg.dependencies ?? {}).length === 0`.

---

## 11. Resolved ambiguities — feedback to the spec

Decisions made here that the spec should absorb in its next revision:

1. **`defineMachine` is curried** — `defineMachine<Ctx, Ev>()({ ... })`.
   TypeScript cannot infer state names while `Ctx`/`Ev` are explicit
   (all-or-nothing inference). One extra `()` buys typed `goto`. Spec §2/§3.1
   examples need the extra parens.
2. **String shorthand re-dispatches** the triggering event in the target
   state (once, then normal pending rules). Spec §3.2 ("shorthand for
   `goto`") contradicts the §2 comment ("re-dispatch after moving there");
   the §2 semantics is the useful one and is adopted.
3. **`void` ≠ `stay()` for notification**: both keep the state without
   re-entry, but only explicit `stay()` notifies subscribers and logs.
   Reconciles spec §3.3 with §5.
4. **Synchronous transition chains are bounded** (1 000 hops ⇒ `failure`):
   livelock protection absent from the spec, mandatory in a browser.
5. **Reusing a live task tag cancels the previous task** — one outstanding
   settlement event per tag.
6. **`onShutdown` may return a non-terminal transition**: the machine
   continues toward a graceful end; the parent's grace period (or the
   caller's patience on `done`) is the backstop.
7. **`toMermaid()` v1 extracts string-shorthand edges only**; handler-internal
   `goto`s are not statically recoverable without source analysis
   (a non-goal). Spec §6.1 should be softened accordingly.
8. **Terminal states**: the `aborted` outcome lands in a third predeclared
   state name, `terminal_aborted_state`, reserved like the other two
   (spec §3.1 lists only two names but three outcomes).

Open question inherited from spec §11 (meta merging) is deferred: v1 exposes
the raw per-state `meta` block, unmerged — the simplest behaviour that the
open discussion can later extend compatibly.
