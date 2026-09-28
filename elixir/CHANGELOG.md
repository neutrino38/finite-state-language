# Changelog

All notable changes to **FSL for Elixir** (hex package `finite_state_language`,
OTP app `:fsl`, modules `FSL.*`).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this package follows [semantic versioning](https://semver.org/). Note what that
means for the field names: `lasterr`, `errorreason`, `currentstate` and
`laststate` are struct fields a deployed `.exs` machine reads directly, and a
struct field takes no deprecated alias — so renaming one is a **major** version
with a migration, never a tidying.

## [0.4.0] — unreleased

### Added

- **Turning the journal on in a live run.** Every `on_events` carries a clause
  for `{:scenario_ctl, :journal, :on | :off}`, next to the one for the
  cooperative shutdown: `:on` starts the journal of a machine that is waiting,
  `:off` renders it and hands it over at once. The wait then resumes with the
  time it had left; the machine does not see the message, the monitor reports
  nothing, and a clause of the machine's own matching `:scenario_ctl` does not
  suppress it. The diagram opens with a note naming the state it joined.
- **`c:FSL.Host.journal_output/3`**, where a finished diagram goes: the host
  receives the document, the run's metadata and the renderer, and answers
  `{:ok, where}`, `{:error, reason}`, or `:default` for the file in the working
  directory that is still written when a host does not implement it.
- **`:slot` and `:joined_in` in the journal's metadata**: the `:slot_id` the run
  was started with, and the state the run was in when the journal started after
  its beginning.

### Changed

- A journal started after the beginning of a run — by a `debug` flag set in a
  state, or live — draws its first transition from the state it joined
  (`second -> third`), where 0.3.0 drew it as an initial state (`third`).
- `FSL.Journal.flush/0` returns `{:ok, where}`: the path of the file, or what
  `c:FSL.Host.journal_output/3` answered.

## [0.3.0] — 2026-09-28

Released together with `finite-state-language` 0.3.0 on npm, which gains the
same trace and the same Mermaid sequence diagram; the two are reconciled in
[`spec/fsl-js-ts.md`](https://framagit.org/elixip/finite-state-language/-/blob/main/spec/fsl-js-ts.md)
§6.2 and §12.4b, mechanism by mechanism.

### Added

- **A clock on the journal.** Every `FSL.Journal` event carries `:at`
  (`System.monotonic_time(:microsecond)`) and the metadata carries `:t0`. Both
  renderers prefix every label with `+Nms` when the two are present.
- **Events recorded outside the machine's process.** Two optional callbacks on
  `FSL.Host`: `c:FSL.Host.journal_started/1`, called in the machine's process
  when its journal starts, and `c:FSL.Host.journal_collect/0`, which hands the
  binding's events over at `FSL.Journal.flush/0` (merged by `:at`) and at
  `FSL.Journal.clear/0` (dropped). `FSL.Journal.record/1` appends an event a
  binding built, stamping `:at` when absent.
- **The `:message` event kind**, for what actually went over the wire: `dir`,
  `lane`, `party`, `peer`, `label`, `reply`, `repeat` (see `FSL.Diagram`). One
  such event switches `FSL.Diagram.PlantUML` and `FSL.Diagram.Mermaid` to a
  traced rendering: one peer lane per conversation, replies dashed, repetitions
  dimmed, protocol commands as notes. `FSL.Diagram.stamp/2`, `traced?/1`,
  `message_lanes/1` and `lane_name/1` are shared by both renderers.
- **Starting the journal mid-run.** `FSL.Runner` asks again after every state,
  with the context the state handed back, so a `debug` flag set in a state
  starts the journal at the transition that follows. It starts at most once.

### Changed

- A renderer **skips** an event of a kind it does not know, where it raised a
  `FunctionClauseError`.
- A run without `:message` events renders as before, except for the `+Nms`
  prefix now that the journal stamps its events. A test asserting an exact
  label of a *journalled* run sees the prefix; one rendering hand-built events
  without `:at` does not.

## [0.2.1] — 2026-09-21

### Fixed

- **A state that raises or exits now tears down what it had allocated.** The
  context is a stack variable, and Elixir's `rescue` and `catch` clauses see the
  bindings of the moment the `try` was entered — so a state that allocated
  something and then raised handed the teardown the context of *before* its own
  body, and whatever it held was released by nobody. In the SIP binding that was
  a call left standing on both legs with its media session allocated, found in
  production on 2026-09-21. The live context is now kept off the stack:
  `FSL.Context.snapshot/1` records it on every write through `put/3` and
  `appdata_set/3` (and through a binding's own setter, which calls it), `state`
  takes one on entry, and the two clauses read it back with
  `FSL.Context.latest/1`. `FSL.Context.forget/0` drops it when an instance ends.
  No API change: a machine, a block and a binding are untouched.

## [0.2.0] — 2026-09-12

The first release of this package, numbered to match the TypeScript
implementation rather than to count this package's own releases. The two honour
the same *contract*, reconciled clause by clause in
[`spec/fsl-js-ts.md`](https://framagit.org/elixip/finite-state-language/-/blob/main/spec/fsl-js-ts.md)
§12 — the SBB return shape, the declared vocabulary, the block-level bound,
`resume:`, the inter-machine event names.

### Added — the first release

Extracted from [Elixip](https://framagit.org/elixip/elixip) on 2026-09-12,
where the language and its engine had lived inside a SIP stack since 2024, and
**relicensed from BUSL-1.1 to Apache-2.0** so that the Elixir and TypeScript
implementations ship under one licence (see `NOTICE`).

The language:

- `FSL.Machine` — `state`, `goto` (a named state, `next`, `loop`, `back`),
  `stay`, `on_events` with its selective-receive semantics and its absolute
  deadline, `config`, `scenario_success` / `scenario_failure` /
  `scenario_aborted`, `spawn_fsm` / `notify` / `notify_parent` / `on_shutdown`;
- `FSL.Block` — service building blocks: a subroutine of the language, entered
  with `sbb_fsm` and returning `{namespace, outcome, data}`, with the outcome
  vocabulary checked at compile time, a completion bound per block, and a
  `cleanup/1` that runs on **every** way out — including an enclosing block's
  deadline abandoning it, the exit no hand-written release could cover;
- `FSL.Context` — the six fields a machine keeps about itself, the five generic
  context macros, and `@after_compile` so a binding that forgot them fails to
  compile;
- `FSL.Runner` — the engine: one FSM per process, a flat call stack across any
  number of transitions, a fixed teardown order, and three outcomes so a
  controller-driven stop is not counted as a failure.

A runnable sample:

- `samples/fishing.exs` — a fishing trip that plays itself in two seconds and
  prints the afternoon as a Mermaid diagram. It needs the deadline that does not
  restart, `stay`, `goto back`, a sub-FSM and a host, for reasons a reader
  already believes rather than reasons they have to be taught.

The embedding:

- `FSL.Host` — the twelve callbacks a protocol binding provides, named at `use`
  time and recorded on the machine's own module, so two bindings coexist in one
  VM;
- `FSL.Host.Default` — what a machine with no protocol gets;
- `FSL.Test.Host` — an observable host: every hook appends to a trace or
  messages the process that started the machine. What this package's own suite
  runs against, and the worked example.

Instrumentation:

- `FSL.Monitor` — a live registry, one row per run, with the columns an embedding
  declares at start and writes with `note/2`; `subscribe/1` pushes
  `{:fsl_monitor, {:updated | :cleared, …}}`;
- `FSL.Journal`, and two renderers behind the `FSL.Diagram` behaviour —
  `FSL.Diagram.PlantUML` and `FSL.Diagram.Mermaid`. A per-run journal in the
  process dictionary, rendered as a sequence diagram whose lane rule is **by
  exclusion**, so a protocol a renderer has never heard of is still drawn from
  the peer. Mermaid is what the TypeScript sibling emits and what GitHub renders
  with no toolchain; a binding picks one with `c:FSL.Host.diagram_renderer/0`;
- `FSL.Loader`, `FSL.Child`, `FSL.Valet`, and `FSL.HTTP` (HTTP-as-events, the one
  module needing `Req`, declared `optional: true`).

### Changed relative to Elixip's DSL

Nothing a machine writes. The extraction was a refactor of the implementation and
not of the language: Elixip's `.exs` scenarios, its kelixip scripts and every
`use SIP.Scenario` line were untouched, and `SIP.Scenario` &c. remain the names
that binding calls the engine by.

What did change is who answers for what, and it is worth listing because a second
binding meets exactly these:

- **the context belongs to FSL and a binding extends it**, rather than the FSM's
  bookkeeping living in a protocol's struct;
- **the context variable is a parameter** (`ctx_var:`). `sip_ctx` was the only
  name the language could bind;
- **`:sip` as the fallback event type is the binding's**, not the language's. An
  unrecognised leading atom read as coming *from the peer* is a sentence about a
  protocol;
- **the injected-clause families are asymmetric, on purpose.** A cooperative
  shutdown is the FSM control protocol and only an explicit `:scenario_ctl`
  clause opts out of it; a binding's failure domain is a policy default and its
  suppression test is generous;
- **the three per-event hooks are one callback**, so the order they run in is
  three statements of one function rather than the expansion of a macro;
- **`__scenario_type__/0` is an opaque slot** with default `nil`. `uas :register`
  is a SIP macro on SIP's facade;
- **the monitor's row is flat and its host columns are declared**, which is what
  kept every consumer of those rows unchanged;
- **`:log_sequence` is read under `:fsl`**, not under a binding's app. A binding
  that keeps its configuration in one namespace names it once with
  `config :fsl, :log_sequence_app, :my_app`;
- **a host inherits `FSL.Host.Default` for the callbacks it leaves out.** It used
  to get the literal each call site passed, which for `c:FSL.Host.build_context/1`
  meant an empty context — a machine's whole `config` block dropped on the floor,
  silently, the moment its host implemented any *other* callback. Found by
  writing the sample;
- **the diagram's lane labels** are read from `:label` / `:peer`, falling back to
  `:username` / `:domain` and then to the machine's own name. Those last two are
  SIP config keys that a generic renderer had no business knowing as its only
  source.

### Fixed

- **`FSL.Monitor.subscribe/1` returned `:ok`**, so a caller had to read
  `calls/0` separately — two calls with a window between them, survivable in one
  order only. It returns the snapshot, taken in the call that registers the
  subscriber;
- **a subscriber was never monitored**, so one that died stayed in the set for
  the life of the node and every later change was `send/2` into the void;
- `stay` outside an `on_events` raised a `CompileError` with **no file and no
  line**, unlike the three other compile-time checks. A check whose message
  points at nothing stops helping the author — and in a package, "points at
  nothing" reads as "points somewhere inside the dependency".

### Divergences kept on purpose

The reconciliation with the TypeScript implementation left two differences
standing, both recorded in
[`spec/fsl-js-ts.md`](https://framagit.org/elixip/finite-state-language/-/blob/main/spec/fsl-js-ts.md)
§12 rather than resolved: the pending queue, which the BEAM's selective receive
makes unnecessary here, and a few details of `stay` and `goto back`.
