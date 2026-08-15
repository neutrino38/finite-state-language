# FSL for TypeScript — Implementation Plan

Companion to [the language spec](../../spec/fsl-js-ts.md). Everything in
this plan lives under `typescript/` in the repository. Each milestone ends
green: build, tests, lint all passing. Milestones are ordered so that every
one delivers something usable.

## M0 — Project scaffold

- `package.json` — name **`finite-state-language`** (ESM, `exports` map with
  `.`, `./http` and `./react` subpaths, `types` fields), `tsconfig.json`
  (strict, `moduleResolution: bundler`).
- Toolchain: **tsup** (build, dual ESM+CJS if we decide to ship CJS),
  **vitest** (tests, browser-independent), **eslint + prettier**.
- Layout:
  ```
  src/
    core/           # runtime: machine, runner, queue, timers, tasks
    react/          # adapter (excluded from core bundle)
    index.ts        # public API of "fsl"
  examples/
    webphone-jssip/ # M5
  test/
  ```
- CI (GitHub Actions): node LTS matrix, build + test + lint.
- Licence choice (suggestion: MIT or Apache-2.0 — to be confirmed).

Exit: `npm run build && npm test` green on an empty API.

## M1 — Core runtime (the heart)

- `defineMachine`, `start`, event queue with run-to-completion.
- Transitions: `goto`, `next`, `loop`, `stay`, `success`, `failure`,
  `aborted`; predeclared terminal states; `done` promise.
- `enter` execution, exception ⇒ `failure` contract.
- `subscribe` / `getSnapshot` / `matches` / transition ring-buffer log.
- **Selective receive**: pending queue for unmatched events, replay on every
  state entry, bounded (`pending.max`), `snapshot.pending`, `fx.dropPending`;
  `"*"` catch-all as flush point (spec §4.2).
- Tests: transition table coverage, ordering guarantees (event during
  handler), declaration-order `next()`, terminal-state immutability,
  pending-queue replay order / re-transition during replay / overflow.

Exit: the spec §2 example runs headless under vitest with scripted events.

## M2 — Typing hardening

- State-name inference from `states` keys (template literal / mapped types),
  typed `goto`, typed `on` keys from the event union, `matches` narrowing.
- Type-level tests with `expect-type` (vitest built-in `assertType`).
- JS-consumer check: a plain `.js` fixture consuming the built package with
  `checkJs` to validate completion/JSDoc experience.

Exit: deliberate misuse (`goto("typo")`, wrong payload field) fails to compile.

## M3 — Timers & async effects

- `after` (arm on entry, cancel on exit, re-arm on `loop`).
- `fx.send`, `fx.delay` (+ cancellation on exit), `fx.task` (the Valet
  pattern, spec §4.3): exactly-once delivery, `timeout` + `AbortSignal`
  cancellation, late-result discarding, `fx.cancel(tag)`.
- `finite-state-language/http` module (spec §4.4): `httpGet` on top of
  `fx.task` with `AbortController` timeout, `HttpResult<Tag>` event type;
  tested against a mock `fetch` (no network in CI).
- Fake-timer test suite (vitest `vi.useFakeTimers`).

Exit: Elixip-style `after 30_000 -> failure` and `http_GET`-style flows work
(the spec §4.4 example runs headless).

## M4 — Sub-machines & lifecycle

- `fx.spawn(machine, {as, args})`, `fx.notify`, `fx.notifyParent`,
  `child:msg` / `parent:msg` / `child:exit` events.
- Cooperative shutdown: `shutdown(reason)`, `onShutdown` hook, grace period,
  child teardown ordering; `cleanup(ctx)` hook.
- Tests: parent/child conversation, nested children, straggler force-stop,
  standalone run of a child machine (notifyParent no-op).

Exit: spec §8 examples pass.

## M5 — Adapters & flagship example

- `fsl/react`: `useMachine` on `useSyncExternalStore`, instance ownership
  (start on mount, shutdown on unmount), StrictMode double-mount safety.
- Example app `examples/webphone-jssip`: a minimal but real web phone
  (register / call / answer / hangup) with a ~50-line JsSIP→FSL binding,
  built with Vite. This is the acceptance test of the whole design:
  the machine file must read like the Elixip scenario reads.
- Vanilla-JS example (a few lines in the README).

Exit: `npm run dev` in the example shows a working UI driven by the machine.

## M6 — Observability & docs

- `toMermaid()` static-graph export; debug transition logging format
  aligned with Elixip (`event: (old) -> (new) "desc"`).
- API reference generated from TSDoc (typedoc), README polish,
  CHANGELOG, contribution guide.

## M7 — Publish

- Settle the package name (see spec §11), `npm publish --dry-run` review
  (bundle size budget: core < 5 kB min+gzip target), provenance,
  `0.1.0` release.

## Test strategy summary

- Unit: every runtime rule of the spec has a numbered test citing its section.
- Type-level: compile-time behaviour is tested, not assumed.
- Integration: the JsSIP example runs against a mock UA in CI (no network).
- The core must keep **zero runtime dependencies** — enforced by a CI check
  on `package.json`.

## Risks / watchpoints

- **Type inference complexity** (M2) can explode compile times — keep the
  public generics shallow; prefer two type parameters (Ctx, Ev) over deep
  mapped acrobatics.
- **React StrictMode** double-invocation: instance ownership must be
  idempotent (well-known trap, handled in M5 tests).
- **API stability**: until 0.2, mark everything `@experimental`; the JsSIP
  example is the design pressure-test before freezing.
