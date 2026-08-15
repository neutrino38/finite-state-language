# Changelog

All notable changes to `finite-state-language` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/)
(everything below 0.2 is `@experimental` — the API is still soft).

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
