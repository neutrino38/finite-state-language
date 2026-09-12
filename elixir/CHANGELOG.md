# Changelog

All notable changes to **FSL for Elixir** (hex package `finite_state_language`,
OTP app `:fsl`, modules `FSL.*`).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this package follows [semantic versioning](https://semver.org/). Note what that
means for the field names: `lasterr`, `errorreason`, `currentstate` and
`laststate` are struct fields a deployed `.exs` machine reads directly, and a
struct field takes no deprecated alias — so renaming one is a **major** version
with a migration, never a tidying.

## [Unreleased]

### Added — the first release

Extracted from [Elixip](https://github.com/neutrino38/elixip) on 2026-09-12,
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
- `FSL.Journal` and `FSL.Diagram.PlantUML` — a per-run journal in the process
  dictionary, rendered as a sequence diagram whose lane rule is by exclusion, so
  a protocol this renderer has never heard of is still drawn from the peer;
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
  kept every consumer of those rows unchanged.

### Fixed

- `stay` outside an `on_events` raised a `CompileError` with **no file and no
  line**, unlike the three other compile-time checks. A check whose message
  points at nothing stops helping the author — and once the language is a package,
  "points at nothing" becomes "points into the package".

### Not yet

- not published to hex;
- the cross-language spec (`../spec/fsl-js-ts.md`) is reconciled clause by clause
  but the pending-queue difference and a few `stay` / `goto back` semantics are
  recorded there as deliberate divergences rather than resolved;
- ~91 of Elixip's FSL tests are still in Elixip, where they are the proof that
  the host wiring works; a further ~20 would have to be split rather than moved;
- `FSL.Diagram.Mermaid`: the TypeScript sibling ships `toMermaid()` and Mermaid
  renders in GitHub with no toolchain, so the two dialects should converge on it.
  PlantUML is what this release has.
