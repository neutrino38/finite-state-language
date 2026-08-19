# Changelog

All notable changes to `finite-state-language` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/)
(the API is still `@experimental` and soft — 0.2 marks the arrival of the
Service Building Block layer, not the freeze 0.1.2 had reserved the
number for).

## [0.2.0] — 2026-08-19

Service Building Blocks, reserved in the spec since §8.4 was written and
now implemented — in the shape both dialects of FSL agree on:
`finite-state-language` here and Elixip's DSL on the BEAM. The rule is
recorded in the spec (§11, decision 5) and the shared table lives in
[`elixip/docs/design/DESIGN-SBB.md`](https://github.com/neutrino38/elixip/blob/master/docs/design/DESIGN-SBB.md)
§10: a concept present in both dialects is spelled the same in both.

Additive over 0.1.2 — nothing existing changes behaviour, and the pending
queue of §4.2 is untouched, which was the point of choosing a stack of
definitions over anything cleverer. The minor bump buys the new layer
room to move before the API stops being experimental.

### Added

- **`defineSbb` and `fx.sbb` / `fx.sbbReturn` — a subroutine call, not a
  second machine.** A block is a reusable fragment of a state machine
  behind a callable face: a sequence written once — establish a call, run
  a menu, collect credentials — that a host enters and observes through a
  handful of service-level events.

  `fx.spawn` starts a machine with state of its own; `fx.sbb` calls a
  block that works on the state its host already holds. Same instance,
  same context, same mailbox, same children — only the definition
  answering events changes. The host is suspended at the call site: its
  `enter` does not re-run on return, and its `after` is suspended for the
  duration and armed afresh afterwards.

  Three things the compiler checks that no runtime can: a host whose
  context does not provide what a block declares it requires does not
  compile; neither does a host with no clause for what the block can
  return; and `returns` has to document every outcome of the return
  union. The second one is the failure the layer exists to prevent — an
  outcome nobody matches leaves the host waiting on a deadline for an
  event that never comes, a silence with nothing in the log.

  A block gets a private sandbox (`fx.data`, seeded by `args`, fresh on
  every entry) rather than a share of the host's keys, and its own
  `timeout`. `fx.sbbReturn` is the only way back: `failure()` and
  `aborted()` keep their ordinary meaning and end the whole machine, host
  included, running each block's `cleanup` on the way out.

- **A block declares the vocabulary it talks back with, and a return is
  `{ type: "namespace:outcome", data }` — nothing else.** `namespace` is
  the word every return leads with; `returns` maps each outcome to what
  it means, and the type requires it to be exhaustive, so a block cannot
  grow an outcome nobody wrote down. Both are published on the block
  (`block.namespace`, `block.returns`), the counterpart of Elixir's
  `__sbb_namespace__/0` and `__sbb_returns__/0`, so a tool can show what
  a block can send.

  `fx.sbbReturn(outcome, data)` names an outcome and hands over a map;
  the runtime builds the event from the declared namespace, and an
  outcome the block did not declare fails the machine with a reason
  naming it and listing what *is* declared — the JavaScript half of the
  compile-time refusal Elixir does in `sbb_return/1`.

  The arity is fixed, for the reason it was fixed on the BEAM: a block
  that learns to report one more thing adds a key to `data`, invisible to
  a host that does not read it, where a fourth slot would break every
  host matching the old shape.

- **`timeout` is required, and takes `delay: number | "infinity"`.**
  Elixir bounds every block by default at 32 s — timer B, which a browser
  does not have — so rather than inventing a default this dialect makes
  the author decide. `{ delay: "infinity" }` is how a block says it ends
  on an event and never on a clock, the shape Elixir writes
  `@sbb_timeout :infinity`.

  `timeout.then` is optional. Without it the deadline is an outcome like
  any other: the block returns `{namespace}:timeout` with `{ block }`, so
  the host has one clause to write and no special case — Elixir's "a
  bounded block gets `:timeout` in its vocabulary for free". A bounded
  block that declares no `timeout` outcome and no `then` is refused at
  define time rather than at expiry.

- **`fx.sbb(block, { resume: true })`** keeps the sandbox the block left
  behind on its previous entry, for a block designed to be interrupted
  and re-entered — Elixir's `sbb_fsm(module, resume: true)`. Without it
  the sandbox is fresh.

- **`SbbReturn`, `SbbNamespace`, `SbbOutcome`, `SbbData`** are exported:
  the first writes a block's return union, the other three are what
  `SbbDef` and `sbbReturn` derive their checks from.

- **`snapshot.sbb` / `instance.sbb`, and `sbb` from `useMachine`.** While
  a block runs, `state` stays the host's — a subroutine call is not a
  state the machine declared, and `matches()` must keep working — and the
  block's position is published beside it: name, state, depth, and the
  block state's `meta`. The transition log takes the other option and
  qualifies: `Establish/ringing`, never a bare `ringing` no host declared.

- **`finite-state-language/diagram` reads blocks.** `defineSbb`
  definitions are extracted like machines and tagged `kind: "block"`,
  with `fx.sbbReturn` drawn as the edge to `[*]` and a block-level
  `timeout` applied to every state. In a host, `graph.blocks` records
  which state enters which block, and `renderMermaid` names it on the
  box — a state that enters a block has no outgoing edge until it
  returns, so leaving it out drew a dead end exactly where the sequence
  was.

- **`finite-state-language/diagram` resolves a spread in `on`.** States
  that share a set of clauses write them once —
  `on: { ...interruptions(), "ui:go": … }` — and until now the shared half
  was invisible to the extractor: the machine drew with no arrow for the
  events it answers *everywhere*, which is the opposite of what a reader
  needs. A spread of a call to a module-level helper returning an object
  literal is now followed, and the state's own clause overrides the
  fragment's, as it does at run time.

### Fixed

- **`VERSION` had said `0.1.1` since the 0.1.2 release.** The constant
  and the manifest were two literals with nothing tying them together,
  and the test that should have caught it was pinning the constant to the
  same stale value. It now reads `package.json`.

### Internal

- `fx.delay` handles are scoped by SBB depth. A delay armed by the host
  before it called a block survives the block's state hops — the host
  never left its state, so its "cancelled on state exit" has not
  happened — while the block's own delays die with it.

## [0.1.2] — 2026-08-17

Additive release: a new subpath export, no change to the core runtime or
to `Machine.toMermaid()`. Stays in 0.1.x on purpose — 0.2 is reserved for
the moment the API stops being experimental.

### Added

- **`finite-state-language/diagram` — the transition graph, read from the
  source.** `Machine.toMermaid()` sees only what the live definition
  exposes, and a machine whose handlers all return `goto(…)` exposes no
  edge at all: it prints as a list of states with no arrows. The new
  subpath parses the machine's TypeScript source instead, where every
  target is named in plain text.

  `machineGraphs(code, fileName?)` returns one `MachineGraph` per
  `defineMachine` call in the file: `name`, `states` in declaration
  order, merged `edges`, plus `forwarded` (events handed to a child with
  `fx.notify`) and `consumed` (events handled without moving).
  `renderMermaid(graph)` turns one into a `stateDiagram-v2`.

  It resolves what the runtime exporter cannot: `goto` targets inside
  closures, `stay`/`loop` as self edges, terminal constructors as edges
  to `[*]`, `next()` through declaration order — and calls to
  module-level helper functions, so a shared `fail(ctx)` contributes its
  targets to every handler that calls it.

  Guards are ignored: the graph over-approximates, and a handler that can
  reach two targets draws two edges. Only string-literal descriptions
  become labels.

  This is a build-time tool. It imports `typescript`, now declared as an
  **optional peer dependency** and left external to the bundle — the core
  keeps its zero runtime dependencies. Nothing changes for consumers who
  do not import the subpath.

### Changed

- Source parsing was recorded as a non-goal in design §11.7, with a
  `meta.transitions` hint as the intended escape hatch. The hint would
  write every target twice — once in `goto`, once in `meta` — and rot
  silently. Design §9 and §11.7 record the reversal; spec §6.1 and §1.4
  describe the new subpath and the optional-peer-dependency rule.

## [0.1.1] — 2026-08-16

Documentation fix, no runtime behaviour change. Only the text produced by
`Machine.toMermaid()` differs; if you have generated diagrams checked in,
regenerate them.

### Fixed

- **`toMermaid()` output now renders on GitHub.** The per-state summary
  is emitted as a state description (`state : on: …`) instead of a
  `note … end note` block. Mermaid 11 — the renderer behind GitHub and
  mermaid.live — aborts the whole diagram with "No such shape:
  undefined" when a note is attached to a state that appears in no
  transition, which is the normal case for a machine whose handlers are
  all closures (no extractable edges at all). Described states are now
  declared in the quoted form (`state "x" as x`) so they keep their name
  next to the summary: mermaid replaces a bare `state x` declaration's
  own label as soon as a description is attached, which used to drop the
  state name from the picture. States without a summary keep the short
  `state x` form, and the emitted statements are now grouped
  (declarations, initial edge, transitions, descriptions).

## [0.1.0] — 2026-08-15

First public release. Everything below 0.2 is experimental: the API is
still soft, and real-world use (the JsSIP web-phone project) is the
pressure test before freezing.

### Added

- **Core runtime** — `defineMachine` (curried, fully inferred state
  names), event queue with synchronous run-to-completion, transitions
  (`goto`, `next`, `loop`, `stay`, `success`, `failure`, `aborted`),
  three predeclared terminal states, `done` promise, exception ⇒
  failure contract, livelock guard.
- **Selective receive** — bounded pending queue for unmatched events,
  replayed on every state entry; `"*"` catch-all as flush point;
  `fx.dropPending`; queue exposed on the snapshot.
- **Typing** — typed `goto` and `on` keys, payload narrowing per
  clause, sender-side `send` checking, type-level `initial_state`
  requirement; JS consumers get two tiers (loose by default, full
  checking via a JSDoc cast).
- **Timers & async effects** — `after` clause (Elixir semantics),
  `fx.delay` with sticky option, `fx.task` (the Valet pattern:
  exactly-once settlement, timeout with AbortSignal, late-result
  discarding, `fx.cancel`), `finite-state-language/http` with
  `httpGet` and `HttpResult<Tag>`.
- **Sub-machines & lifecycle** — `fx.spawn` / `fx.notify` /
  `fx.notifyParent`, `parent:msg` / `child:msg` / `child:exit` events,
  cooperative `shutdown(reason)` with the `onShutdown` hook, grace
  period with force-stop for stragglers, ordered teardown
  (children → cleanup → final notification → `done`).
- **React adapter** — `useMachine` on `useSyncExternalStore`, instance
  ownership tied to the component lifecycle, StrictMode double-mount
  safety; react stays an optional peer dependency.
- **Observability** — Elixip-format debug transition log
  (`event: (old) -> (new) "desc"`), transition ring buffer,
  `Machine.toMermaid()` static-graph export, typedoc API reference.
