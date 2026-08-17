# Changelog

All notable changes to `finite-state-language` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/)
(everything below 0.2 is `@experimental` — the API is still soft).

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
