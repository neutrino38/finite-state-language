# Extracting FSL from Elixip — inventory and plan

**Status: designed, not built.** This is the plan for `elixir/`: how the Elixir
implementation of FSL arrives here.

The language and its engine live today inside
[Elixip](https://github.com/neutrino38/elixip), under
`apps/elixip2/lib/dsl/`, compiled with its SIP stack and unusable without it.
The intent recorded in [`../README.md`](../README.md) is to extract them as a
standalone Elixir package — *"generic states / transitions / `on_events` /
sub-FSM / cooperative shutdown / `Valet` / the scenario Monitor — with the
SIP-specific parts staying in Elixip, plugged in through extension points"* —
and to **publish it on
hex.pm**, semantically aligned with the TypeScript sibling whose arbiter is
[`../../spec/fsl-js-ts.md`](../../spec/fsl-js-ts.md).

This document is the inventory of what moves, the list of couplings to cut and
how, the behaviour and usage changes that follow, and the order in which to do
it. What is built today is described in Elixip's [`DESIGN-FSL.md`][design-fsl],
and the language reference an integrator reads is [`FSL.md`][fsl-md]; this
document assumes both and repeats neither.

[design-fsl]: https://github.com/neutrino38/elixip/blob/master/docs/design/DESIGN-FSL.md
[fsl-md]: https://github.com/neutrino38/elixip/blob/master/FSL.md

> **Reading the paths.** Every `apps/…`, `docs/…`, `scenarios/…` and
> `LICENSE*.md` path below is in the **Elixip** repository, which is where the
> code still is; paths relative to *this* repository are written as such
> (`../../spec/…`). Section references of the form "DESIGN-FSL.md §2.3" point
> into that document in Elixip.

**Two constraints govern every choice below, and they are not of the same
kind.** The first is a fact about deployment; the second is what the language is
for.

**A scenario already written must keep running.** `.exs` scenarios and kelixip
scripts are loaded at *run* time, in the field, from `/etc/kelixip/scripts` and
from customer directories: a rename that a compiler would catch here is a node
that fails to start there. So the
extraction is a refactor of the implementation, not of the language, and the
scenario-visible surface changes in exactly the places listed in §6 — all of
which are additions or opt-ins.

**And a scenario must stay as readable after the extraction as before it.** The
FSL project states readability three times in its own README and it is not
decoration: a scenario is read by integrators who did not write it, and the
whole justification for a declared state machine over a pile of callbacks is
that you can print it and review it. An extraction that leaves the language
correct and the scenarios harder to read has failed, whatever the module graph
looks like afterwards. §4.13 keeps the ledger — what this work makes more
readable, what it costs, and the two places where a regression would be
acceptable only if named out loud.

---

## 1. What "publishable on hex" adds to the requirement

Three consequences, each of which shapes a decision below:

1. **No `SIP.*` symbol may remain in the package**, not even an unreachable one.
   A hex package that refers to a module it does not depend on compiles with a
   warning and crashes at the first call. The enforcement is mechanical: the FSL
   Mix project does not depend on `:elixip2`, and its CI runs
   `mix compile --warnings-as-errors`. Any leftover coupling becomes an
   *undefined module* warning, which is the whole reason to extract into a
   separate project early (§7, P3) rather than to keep a well-behaved
   sub-directory in this umbrella.

2. **The dependency footprint becomes a public promise.** The TypeScript sibling
   advertises a *pure core, zero runtime dependencies*. The Elixir core can hold
   that line — the engine, the monitor and the renderer need nothing but `Logger`
   and OTP — provided `FSL.HTTP` (which needs `Req`) declares it
   `optional: true` (§4.9).

3. **The extracted code changes licence.** Elixip is BUSL-1.1; the
   finite-state-language repository is Apache-2.0 and its TypeScript half is
   published under it. **Decided on 2026-09-12: the ~2 700 extracted lines are
   relicensed to Apache-2.0**, so the two implementations ship under one licence
   (§8.1). Elixip stays BUSL-1.1 and consumes FSL as an ordinary permissive
   dependency, which BUSL allows in that direction.

---

## 2. Inventory — module by module

### 2.1 Moves to the FSL package

| Today | Lines | Becomes | Notes |
|---|---:|---|---|
| `SIP.Scenario` (`dsl/SIPScenario.ex`) | 1181 | `FSL.Machine` | the language. All SIP references become host calls (§4) |
| `SIP.Scenario.Runner` (`dsl/SIPScenarioRunner.ex`) | 1047 | `FSL.Runner` | the engine; ~40 % of it is host-specific and splits out (§4) |
| `SIP.SBB` (`dsl/SIPSBB.ex`) | 106 | `FSL.Block` | already a thin `use FSL.Machine, kind: :sbb` once the facade exists |
| `SIP.Scenario.Child` (`dsl/SIPScenarioChild.ex`) | 21 | `FSL.Child` | pure struct, no coupling |
| `SIP.Scenario.Loader` (`dsl/SIPScenarioLoader.ex`) | 63 | `FSL.Loader` | pure; only the raise *messages* name `SIP.Scenario` |
| `SIP.Scenario.SequenceJournal` (`dsl/…Journal.ex`) | 129 | `FSL.Journal` | pure; the renderer it names moves with it (§4.8) |
| `SIP.Scenario.SequenceDiagram` (`dsl/…Diagram.ex`) | 175 | `FSL.Diagram.PlantUML` | **no SIP symbol at all**; one lane clause generalized (§4.8) |
| `SIP.Scenario.Monitor` (`elixipp/…Monitor.ex`) | 361 | `FSL.Monitor` | three SIP references in 361 lines; host columns stay flat (§4.7) |
| `SIP.Context`, its FSM half (`framework/SIPContext.ex`) | ~60 | `FSL.Context` | the six FSM fields, their accessors and the five generic `ctx_*` macros (§4.1) |
| `Valet` (`framework/Valet.ex`) | 57 | `FSL.Valet` | already generic, already the name the FSL/TS spec uses |
| `HTTP.Session` (`framework/HTTPSession.ex`) | 119 | `FSL.HTTP` | `Req` becomes an optional dep; two SIP calls to cut (§4.9) |

**Total moving: ~3 300 lines** — the whole language, the whole engine and the
whole instrumentation. `FSL.Machine` and `FSL.Runner` are the only two carrying
real coupling; the monitor and the renderer carry almost none, which is why they
move whole rather than in halves.

### 2.2 What stays behind when a module moves

Nothing on that list splits down the middle. Three **value computations** stay,
each a single Elixip function feeding a generic FSL entry point:

| Stays in Elixip | Feeds | Why it cannot travel |
|---|---|---|
| `SIP.Msg.Ops.media_kinds/1` | `FSL.Monitor.note(:medias, …)` | reads an SDP |
| `SIP.Uri.serialize_ruri/1` | `FSL.Monitor.note(:outbound, …)` | renders a SIP URI |
| `SIP.Msg.Ops.asserted_username/1` | `c:account/2` (§4.7) | reads a SIP request |

`SIP.Context` is deliberately **not** in this table either. It is not split: it
becomes `FSL.Context` *extended* with the SIP session fields, keeps its name,
its 19 fields and its `set/3` validation, and no caller changes. See §4.1 — the
framing matters, because "split the context" and "extend FSL's context" produce
different code and only the second one leaves `%SIP.Context{}` intact.

### 2.3 Stays in Elixip, unchanged in substance

| Module | Why |
|---|---|
| `SIP.Scenario.ExternalConfig` (233 l) | its whole model is SIP accounts: `username`/`password`/`domain`/`proxyuri`/`mediaserver`. It keeps producing a keyword list handed to `FSL.Runner.run_instance/2` as `:config_overrides`, which is already the seam |
| `SIP.Scenario.CallDispatcher` (102 l) | routes an inbound INVITE to a waiting child. Pure SIP; becomes the `c:spawn_child/2` host hook's implementation (§4.6) |
| `SBB.Call` (`dsl/sbb/call.ex`) | a call-flow building block written *in* FSL. It is a consumer of the package, not part of it |
| `Elixip.ScenarioUAS`, `Elixip.RegistrarUAS` | elixipp's UAS instance factory and quota |
| every `SIP.Session.*` mixin | the SIP verbs. They stay `var!(sip_ctx)`-based and untouched (§4.2) |

### 2.4 Renamed but kept as facades in Elixip

To hold the governing constraint, these names survive and delegate:

- `SIP.Scenario` — `__using__` expands to
  `use FSL.Machine, host: SIP.FSL.Host, ctx_var: :sip_ctx` plus the three
  session mixins, then `defdelegate`s `deadline/1`, `remaining_timeout/1`,
  `start_stack/0` and `register_namespace/2`;
- `SIP.SBB` — same, with `kind: :sbb`;
- `SIP.Scenario.Runner` — `defdelegate` for `run/2`, `run_instance/2`,
  `spawn_uas_instance/2`, `bootstrap_stack/0`, `build_context/1`,
  `spawn_child/5`, `run_sbb/3`, `note_stay/4`, `sbb_data_get/3` and
  `sbb_data_set/4`;
- `SIP.Scenario.Loader`, `SIP.Scenario.Child`, `SIP.Scenario.SequenceJournal` —
  `defdelegate` / struct alias.

These facades are not a transition device to be removed later: `SIP.Scenario` is
the name a *SIP* scenario should `use`, the one that brings the SIP verbs with
it, and it is what [`FSL.md`][fsl-md] documents. `FSL.Machine` is what a non-SIP user of
the package writes.

---

## 3. The couplings, located

Every SIP reference in `apps/elixip2/lib/dsl/`, with the file and what it does.
This is the list P1 has to empty.

### 3.1 `SIPScenario.ex` (the language)

| Line | Reference | What it is |
|---:|---|---|
| 76–78 | `use SIP.Session.CallUAC / Media / B2bua` | the three mixins `use SIP.Scenario` pulls in |
| 252 | `SIP.Session.B2bua.forget_event()` | state-entry hook: clear the leg binding |
| 996 | `SIP.Session.B2bua.note_event(evt)` | per-event hook: which leg, which transaction |
| 1001 | `SIP.Session.B2bua.note_leg_event(ctx, evt)` | per-event hook: answer what a dead leg owes |
| 1002 | `SIP.Session.CallUAS.auto_store(ctx, evt)` | per-event hook: stash the inbound request |
| 577–585 | `media_down_clause/0` | the injected `{:ms_event, _, :server_disconnected}` clause |
| 541–566 | `handles_media_down?/1` & friends | the compile-time test that suppresses the above |
| 1167–1179 | `first_element_type/1` | event-type inference: `:ms_event → :media`, any other atom/integer → `:sip` |
| 600 | `SIP.Context.set(ctx, :errorreason, …)` | writing the FSM's own field through the SIP struct's setter |
| 310, 353, … | `var!(sip_ctx)`, ×38 | the context variable name, and `.lasterr` read off the struct |

### 3.2 `SIPScenarioRunner.ex` (the engine)

| Lines | Reference | What it is |
|---|---|---|
| 58–67 | `SIP.Transac`, `SIP.Transport.Selector`, `SIP.Dialog`, `SIP.Session.ConfigRegistry`, `SIP.Auth.Secret` | `bootstrap_stack/0` |
| 376–435 | `@global_keys`, `:passwd → ha1`, `SIP.Uri.parse`, `:mediaserver`, `Application.put_env(:elixip2, …)` | `build_context/1` and its three-way key routing |
| 105–165 | `SIP.Msg.Ops.asserted_username/1`, the `is_req` guard | which account the monitor's row shows |
| 281–311 | `SIP.Scenario.CallDispatcher`, `SIP.Session.ConfigRegistry` | `setup_uas_child/2` for a `:uas_invite` child |
| 1015–1038 | `SIP.Session.B2bua.release_legs/1`, `SIP.Session.Media.media_cleanup_ressources/1`, the wait on `{:dialog_terminated, …}` | the SIP half of `finalize/4` |
| 862–886 | `SIP.Scenario.Monitor`, `SIP.Scenario.SequenceJournal` | `report/5` |
| throughout | `%SIP.Context{}` in specs, `SIP.Context.set/3`, `SIP.Context.appdata_set/3`, direct `ctx.laststate` / `ctx.appdata` / `ctx.parent_pid` / `ctx.mediaserverpid` | the context struct |

### 3.3 Everything else in `dsl/`

`SIPScenarioChild.ex` and `SIPScenarioSequenceJournal.ex` are already clean.
`SIPScenarioLoader.ex` names `SIP.Scenario` only inside two `raise` strings and
one doc line. `SIPSBB.ex` names it only in its final `use`.

That is the whole inventory: **three files carry the coupling, one of them
trivially.**

---

## 4. The seams — how each coupling is cut

The shape is one **host module** per embedding. FSL calls back into it for
everything it must not know; the host is named at `use` time, so a scenario
module records its own host and the runner reads it back through a generated
`__fsl_host__/0`. No application env, no global configuration — two hosts can
coexist in one VM, which is what makes the package testable with a trivial host
of its own.

```elixir
defmodule SIP.Scenario do
  defmacro __using__(opts) do
    quote do
      use SIP.Session.CallUAC
      use SIP.Session.Media
      use SIP.Session.B2bua
      use FSL.Machine, host: SIP.FSL.Host, ctx_var: :sip_ctx,
                       kind: unquote(Keyword.get(opts, :kind, :scenario))
    end
  end
end
```

`SIP.FSL.Host` is a new elixip module, ~200 lines, most of it moved verbatim out
of the runner. `FSL.Host.Default` ships with the package: a plain
`%FSL.Context{}`, no hooks, no bootstrap — enough for a non-SIP user to write a
state machine and for FSL's own test suite to run with no host at all.

### 4.1 The context belongs to FSL; a protocol binding extends it

**Decision: `%FSL.Context{}` is FSL's own struct, and `SIP.Context` is that
struct plus the SIP session fields.** The six fields below are not a contract
imposed on a host — they are the FSM's own state, and it is the *protocol*
fields that are the guests.

| Field | Written by | Read by |
|---|---|---|
| `lasterr` | a binding's verbs — 62 sites across 10 files in 3 apps | every transition macro |
| `errorreason` | `scenario_failure/1` | `cleanup/1`, the host |
| `currentstate` | `run_instance/2`, `enter/3` | the scenario, the host |
| `laststate` | `enter/3`, only on a real state change | `goto back` |
| `parent_pid` | `spawn_fsm`, `run_instance/2` | `notify_parent`, `notify_parent_exit` |
| `appdata` | `appdata_set`, `:__children__`, `:__self_name__`, the SBB sandboxes | everything |

That reading matters because it settles which way the dependency points.
`lasterr` is the one field a binding writes and FSL reads — the channel that
lets a verb report an error and a scenario stay readable without an `if` after
every call (DESIGN-FSL.md §2.3). The other five are FSL's alone: outside
`apps/elixip2/lib/dsl/`, **nothing in the Elixip repository reads `currentstate`,
`laststate`, `errorreason` or `parent_pid` off the struct** — `parent_pid`
appears elsewhere only as an *option* of `run_instance/2`. They live in
`%SIP.Context{}` today because there was nowhere else to put them.

So:

```elixir
defmodule FSL.Context do
  @fields [lasterr: :ok, errorreason: "", currentstate: nil,
           laststate: nil, parent_pid: nil, appdata: %{}]
  defstruct @fields
  def fields, do: @fields
  # put/3 and get/2, restricted to those six keys
end

defmodule SIP.Context do
  use FSL.Context                                  # the six, and the generic macros
  defstruct FSL.Context.fields() ++
              [username: nil, domain: nil, ha1: nil, dialogpid: nil,
               mediaserverpid: nil, asserted_identity: nil, …]
end
```

`%SIP.Context{}` keeps its name, its 19 fields, its `set/3` validation, its
`from/1` and `to/2`. **No scenario, script or mixin changes.** FSL never matches
on `%FSL.Context{}`; it reads the six fields by name and writes them with
`FSL.Context.put/3` — deliberately not through `SIP.Context.set/3`, which
validates SIP properties FSL has no business knowing about. The difference with
a plain naming convention is that `use FSL.Context` *defines* the fields rather
than asking a host to remember them: forgetting it is a compile error, not a
crash on the first transition.

`use FSL.Context` also injects the five generic context macros —
`ctx_set`, `ctx_get`, `appdata_set`, `appdata_get`, `ctx_set_multiple` —
parameterized by the binding's context variable (§4.2). The three SIP ones,
`ctx_from`, `ctx_to` and `assert_identity`, stay in `SIP.Context.__using__`,
along with the `:sip_context_used` double-injection guard, which becomes
`:fsl_context_used` and covers both halves.

`c:build_context/1` turns the `config` keyword list into the struct. Elixip's
implementation is today's `build_context/1` moved whole: `@global_keys` routing
to `Application.put_env(:elixip2, …)`, `:passwd → :ha1`, `SIP.Uri.parse` for
`proxyuri`, `:mediaserver`, appdata for the rest. `FSL.Host.Default` puts
everything in `appdata`.

#### The field names stay as they are

`lasterr`, `errorreason`, `currentstate` and `laststate` are unspaced where
Elixir style would write `last_error`, `error_reason`, `current_state`,
`last_state`. Renaming them at extraction time is tempting and is refused:
deployed kelixip scripts read `sip_ctx.lasterr` directly — `mcu_adhoc.exs` three
times, and `sip_ctx.domain` and friends elsewhere — and a struct field takes no
deprecated alias, so the failure would be a node that does not start rather than
a warning. FSL adopts the names it inherits. If they are ever to change, it is a
major version of the package with a migration, not a side effect of moving files.

#### How to get there, in three no-op steps

The migration is ordered so that each step is separately verifiable and only the
last one changes behaviour:

1. **Add `FSL.Context`** with the six field definitions, `put/3`, `get/2` and the
   five generic macros. Nothing uses it. No behaviour change by construction.
2. **`SIP.Context` does `use FSL.Context`** and its `defstruct` becomes
   `FSL.Context.fields() ++ [the SIP fields]`. The resulting struct must be
   *byte-identical*: a test asserting the exact key set and the exact defaults of
   `%SIP.Context{}` is written **before** this step and is what makes it a no-op
   rather than a hope. The generic macros move out of `SIP.Context.__using__` in
   the same commit, and the double-injection guard with them.
3. **Move the four FSM clauses of `set/3`/`get/2`** (`:currentstate`,
   `:laststate`, `:errorreason`, `:lasterr`) into `FSL.Context`;
   `SIP.Context.set/3` delegates for those keys so
   `SIP.Context.set(ctx, :currentstate, …)` — which `scenario_stay_back_test`
   asserts — keeps working.
4. Only then does FSL stop calling `SIP.Context.set/3`: the runner and
   `scenario_failure/1` switch to `FSL.Context.put/3`. This is the first commit
   of the four that can change behaviour, and it is one line in each of five
   places.

### 4.2 The context variable — each binding names its own

Scenarios and kelixip scripts write `sip_ctx` by name — 12 times in
`scripts/registrar.exs`, 17 in `scripts/mcu.exs` and `scripts/mcu_adhoc.exs`,
and in four of the reference scenarios. Every `SIP.Session.*` mixin generates
`var!(sip_ctx)` (37 occurrences in `SIPSessionInvite.ex` alone).

This is **not** a compatibility problem to be tolerated: it is the right answer
once the context belongs to FSL. A SIP scenario reads `sip_ctx` because it is
holding a SIP session; an XMPP one would read `xmpp_ctx`, a Teams bot `bot_ctx`.
What has to go is not the name but the assumption that there is only one.

`use FSL.Machine, ctx_var: :sip_ctx` names it, and `use FSL.Context` takes the
same option so the generic macros bind the same variable. Inside FSL the
technique is one line — `ctx = Macro.var(ctx_var, nil)`, a variable with a `nil`
context being exactly what `var!/1` produces — then `unquote(ctx)` wherever the
source says `var!(sip_ctx)` today. 38 mechanical substitutions in `FSL.Machine`,
ten in `FSL.Context`, none anywhere else. The default is `:fsl_ctx`.

The rule this sets for anything written above FSL: **a mixin meant to work under
more than one binding takes `ctx_var` as a `use` option and never spells a
context variable in its own source.** The `SIP.Session.*` mixins are not such a
mixin — they are SIP's, they say `sip_ctx`, and they are right to.

### 4.3 Per-event hooks — `c:on_event/2`

The three calls instrumented into every `on_events` clause (`note_event`,
`note_leg_event`, `auto_store`) collapse into one callback:

```elixir
@callback on_event(ctx :: struct(), event :: term()) :: struct()
```

`SIP.FSL.Host.on_event/2` is the three of them in today's order — the order
matters: `note_event` records the leg before `note_leg_event` acts on it, and
`auto_store` binds `dialogpid` last. Writing them as one callback keeps that
order where it can be read, instead of in the expansion of a macro.

`c:on_state_enter/1` is the mirror: `B2bua.forget_event()` plus the existing
`Process.delete(:scenario_event_type)`, which is FSL's own and stays in FSL.

### 4.4 Event-type inference — `c:event_type/1`

`first_element_type/1` splits. FSL keeps what it owns and what the TypeScript
spec names: `:parent_msg` / `:child_msg` / `:child_exit` → `:scenario`,
`:scenario_ctl` → `:control`, and the declared SBB namespaces → `:scenario`. The
rest — `:ms_event → :media`, an atom or an integer first element → `:sip` — is
`c:event_type/1` on the host, consulted at macro-expansion time, and the default
host answers `nil`.

`:sip` as the *fallback for anything unrecognised* is a host decision and must
not survive into FSL: it is what makes an unknown leading atom draw an arrow
"from the peer" in the sequence diagram (DESIGN-FSL.md §4bis.3), which is only
meaningful when there is a peer.

### 4.5 Injected clauses — `c:injected_clauses/0` and `c:clause_covers?/2`

FSL injects the cooperative-shutdown clause itself: `{:scenario_ctl, :shutdown,
_}` is the FSM control protocol and belongs to the language. The media-death
clause is the host's. Both are compile-time, so both callbacks run during macro
expansion, in a host module that is necessarily already compiled:

```elixir
@callback injected_clauses() :: [{name :: atom(), clause :: Macro.t()}]
@callback clause_covers?(name :: atom(), pattern :: Macro.t()) :: boolean()
```

`clause_covers?/2` is today's `handles_media_down?/1`, and it keeps its
deliberate generosity: a clause matching every `{:ms_event, _, evt}`, or a
catch-all, suppresses the injection. Both injected families keep the property
the design relies on — they leave the state by construction, so they are
instrumented without the `stay` rewrite and produce no dead-branch warning.

### 4.6 Bootstrap, child setup, teardown

| Callback | Elixip's implementation | Default |
|---|---|---|
| `c:bootstrap/0` | today's `bootstrap_stack/0`: transactions, selector, dialog, config registry, auth secret | `:ok` |
| `c:spawn_child/2` | today's `setup_uas_child/2`: register a `:uas_invite` child with `SIP.Scenario.CallDispatcher`, install it as the call-processing module unless one is set | `:ok` |
| `c:finalize/1` | `release_b2bua_legs/1` then `release_media/1`, in that order, including the bounded wait for `{:dialog_terminated, …}` bare or tagged | identity |

`finalize/4`'s order — children → host teardown → `cleanup/1` → parent — stays
FSL's, because three of its four steps are the FSM's. Only the middle one moves,
and it moves whole: the B2BUA-before-media ordering and the five-second wait are
one rule and must stay in one place.

### 4.7 The monitor moves — `FSL.Monitor`

**Decision: the whole live registry moves, not a generic half of it.** The
earlier draft of this plan kept `SIP.Scenario.Monitor` in Elixip and had FSL
report into a configured sink, on the assumption that its call-shape columns
made it SIP's. Counting the actual references settles it the other way: in 361
lines, the module names a SIP symbol **three times** — a `%SIP.Uri{}` in one
`@spec`, the `uri_label/1` clause that matches it, and `SIP.Uri.serialize_ruri/1`
inside that clause. Everything else — slot keying, the parent/child row order,
`report/6`, `note_command/2`, the subscription — is about finite state machines.

What made it look SIP-shaped is the *columns*, and they are not the problem they
appear to be:

| Column | What it is | Whose |
|---|---|---|
| `scenario`, `state`, `event`, `event_type`, `command`, `command_type` | where the FSM is and what moved it | FSL |
| `account` | who this run serves | the binding's *value*, a generic column |
| `medias`, `mediaserver`, `outbound` | what the call negotiated, with whom | the binding's, entirely |

**The row stays flat and FSL does not know which keys are which.** A host
declares its own columns and their defaults when it starts the monitor —
`FSL.Monitor.start_link(columns: [account: "", medias: "n/a", mediaserver:
"none", outbound: "n/a"])` — and writes one with `FSL.Monitor.note(:medias, v)`.
`row/1` merges them in. The `"n/a"` and `"none"` defaults, which say "this call
negotiated nothing" rather than "nobody measured", travel with the column that
means it.

That flat shape is chosen over nesting the host's columns under `row.extra`
precisely because of who reads them: `ElixippCLI` declares its table at lines
80–86 and `Kelix.InstancePool` its key list at line 70, both by plain key.
Flat rows mean **those two files do not change at all**. `row.extra.medias`
would have bought a tidier type at the cost of touching every consumer, which is
the trade §8.4 left open and this closes.

Three SIP things stay behind, and they are values, not mechanism:
`SIP.Uri.serialize_ruri/1` for `note_outbound/1`, `SIP.Msg.Ops.media_kinds/1`
for `note_medias/1`, and `SIP.Msg.Ops.asserted_username/1` for the account
(below). Each becomes a one-line Elixip wrapper over `FSL.Monitor.note/2`.

#### Who calls it, and the name it is registered under

`report/5` tests `Process.whereis(SIP.Scenario.Monitor)` before reporting, which
is the seam and stays one: FSL tests `Process.whereis(FSL.Monitor)`. But a
**registered name is not something a facade can forward** — `defdelegate` covers
`SIP.Scenario.Monitor.calls/0`, and does nothing for a `Process.whereis/1` or a
supervision child spec. So the name change is real and has to be applied at its
four sites in one commit: `Kelix.Application`'s supervision tree, elixipp's
`Monitor.start/0` bootstrap, `Kelix.InstancePool.subscribe/1`, and the runner's
own `whereis`. `SIP.Scenario.Monitor` survives as a delegating module for the
call sites that only call functions.

`report_account/1` and `initial_account/1` — the `SIP.Msg.Ops.asserted_username`
reading of who a UAS instance serves — move to `SIP.FSL.Host` as `c:account/2`,
called with the context and `:initial | :subsequent`. It is the one piece of the
reporting path that reads a protocol message, and the distinction it encodes (a
UAS instance names its account once, then only the script speaks) is policy.

`:scenario_slot_id` in the process dictionary is a three-way contract between
the runner, the monitor and elixipp's CLI. **The key keeps its name**, and FSL
exposes `FSL.Runner.slot_id/0` / `put_slot_id/1` so the other two stop reaching
into the dictionary directly.

#### Two defects to fix while moving, not after

- **Subscribers are never monitored.** `subscribe/1` puts the pid in a `MapSet`
  and nothing ever takes it out but an explicit `unsubscribe/1`: a subscriber
  that dies stays in the set for the life of the node, and every subsequent
  change `send/2`s into the void. It is invisible today because the one
  in-tree subscriber is a supervised singleton. It is not invisible in a
  published package, where subscribing is the normal way to use the thing, and
  `Kelix.InstancePool` already does the right thing one layer up —
  `Kelix.Control.subscribe_monitor/1`'s docstring says so explicitly ("losing
  that connection is what drops the subscription"). `FSL.Monitor` monitors each
  subscriber and drops it on `:DOWN`.
- **The push message tag is not compile-checked.** `{:sip_scenario_monitor,
  {:updated, slot, row}}` is matched in `Kelix.InstancePool.handle_info/2` at
  two places. Renaming it to `{:fsl_monitor, …}` — which the move should do, the
  tag being the package's public protocol — cannot be caught by the compiler: a
  missed `handle_info` clause is a message that falls through and a live view
  that silently stops updating. So the rename comes with a test that subscribes,
  triggers a change and asserts the received tuple, on both halves of the chain.

### 4.8 The PlantUML renderer moves too

`SIP.Scenario.SequenceDiagram` names **no SIP symbol at all** — its own moduledoc
already claims "no dependency on the SIP stack, so it is fully unit-testable in
isolation", and the claim holds under grep. It is 175 lines of string
manipulation over the journal, and it moves whole as `FSL.Diagram.PlantUML`,
with `FSL.Journal` beside it.

What looked like SIP vocabulary is naming convention, and generalizes for free:

- `send_INVITE → INVITE`, `send_auth_REGISTER → REGISTER (auth)`,
  `media_play → play` are prefix rules over *command names*. They read
  `send_message → MESSAGE` just as well;
- the lane aliases `elixip` / `peer` / `ms` — only the first is branded, and only
  as an alias: the rendered label is already the config's `username`. It becomes
  `local`;
- the secret masking (`:passwd`, `:password`, `:ha1`, `:ha1b` → `****`) is a rule
  about not writing secrets to disk. It keeps the SIP key names, because masking
  a key nobody uses costs nothing and forgetting one costs a password in a file.

**One clause has to be generalized**, and it is the only real work.
`render/2` matches `type: :sip` to draw an arrow from the peer lane; a Matrix or
XMPP binding emitting `:matrix` would fall through to the self-note clause and
produce a worse diagram. The rule becomes *by exclusion*, which needs no host
configuration at all:

| Event/command type | Lane |
|---|---|
| `:media` | the media lane |
| `:scenario`, `:control`, `:timer`, `:http`, `:db`, `nil` | a self-note, as today |
| **anything else** — `:sip`, `:matrix`, `:xmpp`, … | the peer lane |

That reproduces today's rendering exactly for every type Elixip emits, and works
for a binding FSL has never heard of. It is the §4.10 yardstick applied to the
one module where the protocol name had leaked into a pattern match.

`FSL.Journal.flush/0` still asks the host for its renderer
(`c:diagram_renderer/0`) — a binding may want its own — but the default is now a
renderer FSL actually ships, and PlantUML is it.

**Mermaid stays on the list, demoted.** It is what the TypeScript sibling ships
(`toMermaid()`) and it renders in GitHub without a toolchain, so the two
dialects should converge on it eventually. But it is ~80 lines of new code
against a journal that already has a working renderer, so it is no longer what
the package owes on day one: P4 ships PlantUML, and Mermaid follows.

### 4.9 `FSL.HTTP` and `Req`

`HTTP.Session` has exactly two SIP references: `SIP.Scenario.Monitor.note_command`
(→ `FSL.Monitor`, §4.7) and `SIP.Context.set(ctx, :lasterr, :ok)` (→
`FSL.Context.put/3`, §4.1). `Valet` has none.

`Req` is declared `optional: true` in the FSL package, and `FSL.HTTP`'s
`__using__` raises at compile time with a message naming the dependency when
`Req` is not available. That keeps the *core* promise — an FSM with no runtime
dependency — while shipping the HTTP-as-events pattern the spec describes.
`elixip2` already depends on `Req ~> 0.6`, so nothing changes on this side.

### 4.10 What a second binding has to provide — the yardstick

The test of whether a seam is cut in the right place is not "does elixip still
work" — it will, whatever we do, because elixip is what the code was shaped
around. The test is whether a **second binding** could be written without
touching FSL. The candidates named for this are XMPP, Matrix, and the
proprietary frameworks behind chatbots (MS Teams); none of them has a dialog, a
transaction or a media plane, and two of them have no notion of a call at all.

A binding provides, and FSL must require exactly this and no more:

| What | Today's SIP instance | Where §4 puts it |
|---|---|---|
| a context struct | `SIP.Context` | `use FSL.Context` + its own fields (§4.1) |
| the name of the context variable | `sip_ctx` | `ctx_var:` (§4.2) |
| the verbs | `SIP.Session.*` mixins | pulled in by the binding's own `__using__` facade (§2.4) |
| a host module | `SIP.FSL.Host` | the `FSL.Host` behaviour (§4) |
| what to do on each received event | leg, dead-leg answers, request stash | `c:on_event/2` (§4.3) |
| how to categorize an event | `:ms_event → :media`, else `:sip` | `c:event_type/1` (§4.4) |
| clauses every wait must carry | media-server death | `c:injected_clauses/0` (§4.5) |
| what to start, and what to release | the SIP stack; legs then media | `c:bootstrap/0`, `c:finalize/1` (§4.6) |
| how a row is labelled | the asserted identity | `c:account/2` (§4.7) |
| how a run is drawn | PlantUML — which now needs no SIP vocabulary | `c:diagram_renderer/0`, defaulting to `FSL.Diagram.PlantUML` (§4.8) |

What FSL keeps is then exactly the list the finite-state-language README
promises: states, transitions, `on_events` and its selective-receive semantics,
`stay`, `goto back`, sub-FSMs and cooperative shutdown, service building blocks,
the journal, `Valet`, HTTP-as-events. Nothing in that list mentions a protocol.

Two things in today's code fail this test and are fixed by §4.11 and §4.4: the
`uas` annotation, and `:sip` as the fallback event type. A Matrix binding that
had to declare its scenarios `uas :something` would be a tell that the seam is
in the wrong place.

### 4.11 `uas/1` and `__scenario_type__/0` become opaque to FSL

`uas :register` sets `@scenario_type` to `:uas_register`, and three places read
it back: `SIP.Scenario.Loader.scenario_type/1` (so `elixipp` picks server mode),
`setup_uas_child/2` (so a `:uas_invite` child is registered with the call
dispatcher), and `elixipp`'s CLI. The atoms are SIP role names — `uac`, `uas` —
and the language has no business knowing them.

FSL keeps the *slot* and drops the vocabulary: `__scenario_type__/0` returns an
opaque term, default `nil`, and the runner passes it to `c:spawn_child/2`
without inspecting it. `uas/1` stays a macro, but a **SIP** one, exported by
`SIP.Scenario` alongside `config/1`, setting FSL's slot to `:uas_register`.
`SIP.FSL.Host.spawn_child/2` is where `:uas_invite` means "register it with the
dispatcher", which is where that sentence was always true.

Scenario-visible change: none. `uas :register` is written and read exactly as
today; it is simply defined one module further down.

### 4.12 The push chain to kelescope — what moves when

The live scenario list kelescope displays is not one API, it is a chain of
three, and they do not belong to the same layer:

```
FSL.Runner.report ─┐
a verb's note_command ─┤
                       ├→  FSL.Monitor          one row per running FSM
                       │     └ {:fsl_monitor, {:updated | :cleared, slot, row}}
                       │          ↓
                       │       Kelix.InstancePool   joins id / script / domain / quota
                       │          └ {:kelix_monitor, {:upsert, row} | {:remove, id}}
                       │               ↓
                       │            Kelix.Control.subscribe_monitor/1
                       │               ↓  (send/2 across nodes)
                       │            kelescope
                       └→ FSL.Journal → FSL.Diagram.PlantUML
```

**The bottom link moves now**, because it is inside the module §4.7 moves: 20 of
the monitor's 361 lines are `subscribe/1`, `unsubscribe/1`, the `subs` set and
`notify/2`. Extracting the registry and leaving its subscription behind would be
an odd cut, and a package whose live view can only be *polled* is a worse
package.

**The top two links stay kelixip's**, and this is not deferral — it is where
they belong. The join is what turns an FSM row into a *server* row: the instance
id, the script that was registered, the domain it serves, the quota slot it
holds. An FSL package has no notion of a script registered for a domain, and
inventing one to host this would put kelixip's data model inside a language
runtime.

**What may move later, if it earns it** (this is P5, §7): the *shape* of the
chain repeats itself at every link — subscribe a pid, get a snapshot, receive
`upsert` / `remove` per change, drop the subscription when the pid dies, work
across nodes. `Kelix.Control` implements that same shape four times over
(`subscribe_monitor/1`, `subscribe_domain_counters/1`, `subscribe_registrations/2`,
`subscribe_conferences/1`), and only one of the four is about FSMs. If a generic
`FSL.LivePush` is ever extracted, it should be extracted from **all four**, on
kelixip's evidence, not from this one — which is precisely why it is not part of
this plan. Doing it here would generalize from a single example.

#### The ordering invariant, which must survive the move

`Kelix.Control.subscribe_monitor/1` subscribes **and then** takes the snapshot:

```elixir
def subscribe_monitor(pid) do
  Kelix.InstancePool.subscribe_monitor(pid)
  monitor()
end
```

That order is deliberate and it is the only correct one. A change landing
between the two arrives as a push *and* appears in the snapshot — a duplicate
`upsert`, which is idempotent and harmless. Snapshot-first would lose it
entirely, and the row would stay stale until the call happened to change again.
It reads like a tidying opportunity and it is a data-loss bug, so FSL states it
as a contract: **`FSL.Monitor.subscribe/1` returns the snapshot itself**, taken
inside the `GenServer.call` that registers the subscriber, which removes the
window rather than documenting it. `Kelix.Control` then has one call where it
has two.

### 4.13 The readability ledger

Each seam is judged on what a reader gains or loses, not only on what compiles.

**What becomes more readable**

- *"What does SIP add to the state machine?"* is today spread across three files
  and two macro expansions — three `use` lines at `SIPScenario.ex:76`, three
  calls injected into every `on_events` clause at `:996–1002`, one at
  `:252`, a media clause at `:577`, an inference table at `:1167`, and four
  more couplings inside `finalize/4`. After P1 it is one module with ten
  callbacks, read top to bottom. That is the single biggest readability gain in
  this work, and it is a gain *for elixip*, not for the package;
- `SIP.Context` stops being a struct where the FSM's bookkeeping and the SIP
  session's identity sit in one undifferentiated `defstruct`. The `use
  FSL.Context` line says which half is which (§4.1);
- the teardown order — children, legs, media, cleanup, parent — currently has to
  be reconstructed from `finalize/4`'s body. Three of its steps stay in FSL and
  one becomes `c:finalize/1`, so the order is stated in one place and the SIP
  content of one step in another.

**What it costs**

- `var!(sip_ctx)` becomes `unquote(ctx)` in 38 places in `FSL.Machine` and ten
  in `FSL.Context`. This is a real loss: `var!(sip_ctx)` says what it is, and
  `unquote(ctx)` needs the reader to look up one line at the top of the macro.
  It is accepted because the alternative is a language that cannot be bound
  twice, and it is mitigated by binding `ctx` on the first line of each macro
  and nowhere else — never inline, never conditionally;
- a scenario writer debugging an expansion now steps through two packages
  instead of one. Mitigated by keeping `SIP.Scenario` a facade thin enough to
  read in one screen (§2.4), so the hop is obvious rather than hidden.

**What must not regress, and is checked**

- **the scenario source is untouched.** P2's exit criterion is already this: the
  suite green with no change to any `.exs`, any kelixip script, or any fixture's
  `use` line (§7);
- **compile errors keep naming the scenario's own file and line.** `stay`
  outside an `on_events`, `sbb_fsm` inside a clause, an undeclared `sbb_return`
  outcome and the deprecated event shapes all raise with `caller.file` /
  `caller.line` today. Crossing a package boundary is exactly how that gets lost
  — a `CompileError` pointing into `FSL.Machine` instead of into the scenario
  would undo the reason those checks exist. One test per check, asserting the
  reported file, is added in P0 and must still pass in P3;
- **`FSL.md` stays one document.** The language reference is what an integrator
  reads; splitting it into "the FSL part" and "the SIP part" because the code
  now lives in two repositories would move our packaging problem onto the
  reader. It gains a section saying which verbs come from where (§6.1) and
  otherwise stays whole.

---

## 5. Tests — pinning the behaviour before moving it

### 5.1 What exists

Nineteen files, 198 tests, cover the layer. The important finding of this
inventory is **how little of it is SIP-coupled**: outside the fixtures'
`use SIP.Scenario` line, the FSL test bodies name almost no SIP module.

| File | Tests | SIP references in the bodies | Destination |
|---|---:|---|---|
| `scenario_engine_test.exs` | 10 | *none* | FSL package |
| `scenario_stay_back_test.exs` | 11 | one `SIP.Context.get/set` | FSL package |
| `scenario_resilience_test.exs` | 3 | one `SIP.Dialog.reply` (to provoke the exit) | FSL package, with a host-free exit source |
| `spawn_fsm_test.exs` | 13 | `SIP.Session.ConfigRegistry` in the `:uas_invite` describe block only | split: 10 → FSL, 3 stay |
| `sbb_fsm_test.exs` | 26 | `SIP.Context` only | FSL package |
| `sbb_monitor_test.exs` | 7 | *none* | FSL package, with the monitor |
| `sequence_diagram_test.exs` | 10 | *none* | FSL package, whole |
| `scenario_loader_test.exs` | 5 | one `SIP.Uri` (a built-in's config) | split: predicate/resolution → FSL, built-ins stay |
| `http_session_test.exs` | 5 | *none* | FSL package |
| `scenario_external_config_test.exs` | 18 | throughout | stays |
| `scenario_monitor_account_test.exs` | 5 | throughout | stays (tests `c:account/2`) |
| `scenario_monitor_call_shape_test.exs` | 9 | throughout | stays — it tests the three value computations of §2.2 |
| `media_server_down_test.exs` | 8 | throughout | stays (tests `c:injected_clauses/0`'s SIP side) |
| `scenario_uas_test.exs` | 8 | throughout | stays |
| `uas_invite_test.exs` | 38 | throughout | stays |
| `uas_register_test.exs` | 12 | throughout | stays |
| `sbb_bridge_test.exs` | 7 | throughout | stays |
| `scenario_integration_test.exs` | 2 | throughout | stays |
| `reference_scenarios_test.exs` | 1 | throughout | stays |

Roughly **107 tests follow the code** into the package and **91 stay** as the
proof that the host wiring still works. The monitor and diagram tests moving
whole is what the decision of §4.7 and §4.8 buys: no test is rewritten to prove
half a module.

### 5.2 The gaps to fill *first*

These behaviours are relied upon, are described in DESIGN-FSL.md, and nothing
fails if the extraction breaks them. They are P0, and they are written against
today's code, before any seam exists:

1. **Teardown order.** `finalize/4`'s sequence — children, then B2BUA legs, then
   media, then `cleanup/1`, then the parent — is asserted nowhere as an *order*.
   Splitting the middle two out into `c:finalize/1` is exactly the change that
   could reorder them silently. A test recording a timeline (each step sending a
   tagged message to the test process) pins all five.
2. **`release_media` accepting the tagged `{:outbound, {:dialog_terminated, …}}`.**
   Getting this wrong costs five seconds per teardown and no error — the failure
   mode that produced the rule in the first place.
3. **`build_context/1`'s three-way routing**, as a *routing* test: one key of
   each kind (native property, global → app env, unknown → appdata) in one
   config block, asserted in the three destinations. `scenario_engine_test`
   covers the happy path of the first and third; the global-key path is only
   covered indirectly, through `scenario_loader_test`.
4. **The injected-clause suppression rule.** `media_server_down_test` proves the
   clause fires; nothing proves a scenario handling `{:ms_event, _, evt}` itself
   keeps control, nor that a catch-all does. Both are explicit design decisions
   (DESIGN-FSL.md §2.5) and both are about to be reimplemented as
   `c:clause_covers?/2`.
5. **Event-type inference, per pattern shape.** `scenario_engine_test` asserts
   one inference end-to-end. The table (`:ms_event`, the `:parent_msg` family,
   `:scenario_ctl`, an SBB namespace, a bare atom, an integer, a catch-all) is
   about to be split between FSL and the host and deserves one table-driven test
   on this side of the split.
6. **`c:on_event/2`'s ordering.** Assert, on one received event, that the leg is
   noted before a dead leg is answered and before the request is stored — the
   property the collapse into one callback must preserve.
7. **`cleanup/1` and `notify_parent_exit` on every outcome.** Covered for
   success; not for `:failure` and `:aborted`.
8. **The exact shape of `%SIP.Context{}`** — its full key set and every default,
   asserted as one list. This is what turns step 2 of the context migration
   (§4.1) from a hope into a no-op: `defstruct FSL.Context.fields() ++ […]` must
   produce the identical struct, and nothing else in the suite would notice a
   field silently gaining a different default.
9. **Where a compile error points.** `stay` outside an `on_events`, `sbb_fsm`
   inside a clause, an undeclared `sbb_return` outcome and the deprecated event
   shapes all raise today with the *scenario's* file and line. Crossing a package
   boundary is precisely how that gets lost, and a `CompileError` pointing into
   `FSL.Machine` would undo the reason those checks exist (§4.13). One test per
   check, asserting the reported file, and they must still pass in P3.

10. **The push protocol, end to end.** Subscribe, trigger a change, assert the
    received tuple — on both links of the chain (`FSL.Monitor` → its subscriber,
    and `Kelix.InstancePool` → `Kelix.Control`'s subscriber). A `handle_info`
    clause is not compile-checked, so renaming `{:sip_scenario_monitor, …}` to
    `{:fsl_monitor, …}` (§4.7) is a rename no compiler can verify and a live
    view that silently stops updating is how it would be discovered. The same
    test pins the subscribe-then-snapshot ordering of §4.12 and the subscriber
    being dropped on `:DOWN`.

Ten tests, none of them large. They are the acceptance criteria of P1: the
suite must be green before and after, with these included.

### 5.3 The characterization harness

The FSL package's own suite needs a host that is not SIP. `FSL.Test.Host` — a
host whose `on_event/2` appends to a list in appdata, whose `finalize/1` sends a
message, whose `event_type/1` is a fixed map — is what turns the 90 migrated
tests into a suite that proves the *language*, with no stack to start. It is
also the worked example the package documentation needs, so it is written once
and used twice.

---

## 6. Behaviour and usage changes

### 6.1 Scenarios — what changes

**Nothing that is written today stops working.** `use SIP.Scenario`,
`use SIP.SBB`, every macro, `sip_ctx`, `ctx_set`, `appdata_get`, the message
shapes, the `.exs` loading — all unchanged, by construction (§2.4, §4.2).

Three things become *possible* that were not:

- a scenario may `use FSL.Machine` directly, with no SIP anything, and
  `FSL.Runner.run_instance/2` will run it. That is the package's point;
- `FSL.md` gains a section separating the language from the SIP verbs, which is
  the honest reading of the two `use` lines and is what a reader has to
  reconstruct today;
- `mix scenario` and `elixipp` keep taking a scenario module or path; a module
  that is FSL-only runs as a scenario with no stack started.

### 6.2 Elixip's internal API — what changes

| Change | Who is affected |
|---|---|
| `SIP.Scenario.Runner.*` become delegations to `FSL.Runner.*` | nothing breaks; `apps/elixipp/lib/elixipp/ElixippCLI.ex` (6 call sites), `apps/kelixip/lib/kelix/instance_pool.ex` (1), `apps/elixip2/lib/mix/tasks/scenario.ex` (3) may migrate to the new names at leisure |
| `bootstrap_stack/0` moves to `SIP.FSL.Host.bootstrap/0`; the old name delegates | same three callers |
| `build_context/1` moves to `SIP.FSL.Host.build_context/1`; the old name delegates | tests, mostly |
| `Process.get(:scenario_slot_id)` gains `FSL.Runner.slot_id/0` | `SIP.Scenario.Monitor` (3 sites), `ElixippCLI` (1), one test |
| `SIP.Scenario.SequenceJournal.flush/0` asks the host for a renderer | nobody calls it outside the runner |
| `:elixip2` app env keys set by `build_context/1` keep their names and their app | `SIP.Resolver`, `SIP.Session.Register`, the media selection — untouched |

### 6.3 What is deliberately *not* changed

One entry that used to be on this list has left it: `SIP.Scenario.Monitor`'s
**registered name** does change, to `FSL.Monitor`, now that the module moves.
A registered name is the one thing a delegating facade cannot forward, so the
four sites that name it are listed in §4.7 and changed together.


- **the `sip_ctx` name.** §4.2;
- **the process-dictionary key names** (`:scenario_slot_id`, `:scenario_module`,
  `:scenario_event_type`, `:sbb_stack`, `:scenario_sequence_journal`). They are
  internal, but `:scenario_event_leg` / `:scenario_event_tid` are read by
  `SIP.Session.B2bua` and asserted in `b2bua_session_test.exs`, and renaming the
  others for symmetry buys nothing;
- **the monitor's row keys.** `row.medias` stays `row.medias`, not
  `row.extra.medias`, which is what keeps `ElixippCLI` and `Kelix.InstancePool`
  untouched (§4.7);
- **the message protocol** (`{:parent_msg, …}`, `{:child_msg, …}`,
  `{:child_exit, …}`, `{:scenario_ctl, :shutdown, _}`). It is already aligned
  with the TypeScript names and is on the wire between processes.

### 6.4 One change that is a genuine improvement, not a cost

`use SIP.Scenario` pulls in `SIP.Session.CallUAC`, `SIP.Session.Media` **and**
`SIP.Session.B2bua` unconditionally — a registrar scenario carries the B2BUA
macros it will never call, and a pure-logic scenario carries all three. Once the
facade exists, `use SIP.Scenario, verbs: [:call, :media]` is one line to add and
lets a scenario say what it speaks. Default stays all three; this is an opt-in,
listed here because the facade is where it becomes cheap, not because the
extraction requires it.

---

## 7. The plan

Six phases. P0–P2 happen entirely inside the Elixip repository and are individually
revertible. P3 is the only one that moves files between repositories.

### P0 — pin the behaviour (no production code changes)

Write the ten tests of §5.2 against today's implementation. Green suite in
isolation is the bar (see Elixip's `CLAUDE.md` on the order-dependent files).
**Exit criterion:** the ten pass, and each one fails if its rule is
deliberately broken — a test that cannot fail pins nothing.

### P1 — introduce the seams in place

Still `SIP.Scenario` / `SIP.Scenario.Runner`, still in `apps/elixip2/lib/dsl/`,
no renames. Add `FSL.Host` (the behaviour), `SIP.FSL.Host` (the implementation),
`FSL.Context.put/3`, and the `ctx_var:` parameterization. Move each coupling of
§3 behind its callback, one commit per seam, suite green after each:

1. `FSL.Context` — added, then adopted by `SIP.Context` in the four ordered
   steps of §4.1, the second of which is guarded by the struct-shape test of
   §5.2;
2. `ctx_var:` (mechanical, 38 substitutions in the language, 10 in the context,
   no behaviour change);
3. `c:build_context/1` + `c:bootstrap/0`;
4. `c:on_event/2` + `c:on_state_enter/1`;
5. `c:event_type/1`, and `uas/1` moving to `SIP.Scenario` with
   `__scenario_type__/0` going opaque (§4.11);
6. `c:injected_clauses/0` + `c:clause_covers?/2`;
7. `c:finalize/1` + `c:spawn_child/2`;
8. `c:account/2`, and the monitor's flat host-declared columns (§4.7);
9. `c:diagram_renderer/0`, and the PlantUML lane rule by exclusion (§4.8).

**Exit criterion:** `grep -E '\bSIP\.' apps/elixip2/lib/dsl/SIPScenario.ex
apps/elixip2/lib/dsl/SIPScenarioRunner.ex` returns only `SIP.Scenario.*` and
`SIP.FSL.Host`; and `SIP.FSL.Host` reads as the answer to "what does SIP add to
the state machine", top to bottom, which is the readability gain §4.13 claims
and the one worth re-reading before declaring the phase done.

This is the phase where the design is proved; everything after it is moving
files.

### P2 — the `FSL.*` namespace

Rename the eight modules of §2.1 in place, in one commit, and add the facades of
§2.4. `SIP.Scenario` becomes ~40 lines; `SIP.FSL.Host` absorbs what P1 carved
out of the runner. **Exit criterion:** suite green with no change to any `.exs`
scenario, any kelixip script, or any test fixture's `use` line.

### P3 — physical extraction

Create the Mix project in `elixir/` (app `:fsl`), move the ten modules and the
~107 tests, add `FSL.Test.Host` and `FSL.Host.Default`.
`apps/elixip2/mix.exs` gains `{:fsl, path: "../../../finite-state-language/elixir"}`
for the duration of the development. FSL's CI runs
`mix compile --warnings-as-errors`, which is what actually proves the decoupling:
a surviving `SIP.*` reference is an undefined-module warning and fails the build.

**Exit criterion:** both suites green, and FSL's compiles with no reference to
anything it does not depend on. The elixip suite must be run from a clean
`_build` — a stale beam of a moved module is the obvious way to get a false
green here.

### P4 — hex

Apply the licence decision of §8.1 — `LICENSE` and `NOTICE` here, the
`licenses:` key in the FSL `mix.exs`, and the paragraph in both `LICENSE.md`
and `LICENSE_fr.md` at Elixip's root. Then `README.md`, `CHANGELOG.md`, ex_doc,
and `mix hex.publish` as `finite_state_language` (§8.2), with `fsl` registered
alongside it.

Reconcile the language with [the spec](../../spec/fsl-js-ts.md) clause by
clause and record every deliberate divergence *in the spec*, which is the
arbiter between the two implementations: the pending queue exists in TS and not
on the BEAM, `stay` and `goto back` need their Elixir semantics stated, and the
SBB return contract has to be checked against `fx.sbb` / `fx.sbbReturn`.

Then `apps/elixip2/mix.exs` switches from `path:` to
`{:finite_state_language, "~> 0.1"}` — the *package* name is what a dep line
carries, while `:fsl` is the app the runtime starts and `FSL.*` what the code
writes. Three names for one thing is the price of §8.2, and it is paid in
exactly one line of one file.

### P5 — a generic live-push layer (optional, and only on evidence)

The monitor is **not** here any more: it moves in P3 with everything else
(§4.7). What is left for a later phase is the question §4.12 raises and refuses
to answer from one example — whether the *shape* repeated by
`Kelix.Control.subscribe_monitor/1`, `subscribe_domain_counters/1`,
`subscribe_registrations/2` and `subscribe_conferences/1` deserves to be one
`FSL.LivePush` behaviour: subscribe a pid, return a snapshot, push
`upsert`/`remove`, drop on `:DOWN`, work across nodes.

Only one of those four is about FSMs, so the generalization has to be made from
kelixip's four, not from FSL's one — and it can only be made once all four have
lived with the extracted monitor for a while. Deliberately left open, with no
commitment that it should happen at all: the alternative, four explicit
subscriptions that each say what they carry, is a perfectly good end state.

---

## 8. Decisions

§8.1 and §8.2 are **taken** (2026-09-12) and are recorded here rather than
elsewhere because both reach into `mix.exs` and neither is re-litigated per
commit. §8.3 and §8.4 are recommendations still open.

### 8.1 Licence — decided 2026-09-12: Apache-2.0

The extracted code is relicensed from BUSL-1.1 to **Apache-2.0**, matching the
finite-state-language repository and the published TypeScript implementation.
Elixip itself stays BUSL-1.1: a source-available work may depend on a permissive
one, and the extraction does not travel in the other direction.

What that costs, all of it in P4 (§7) except the last line:

- `LICENSE` in the FSL project — the Apache-2.0 text, already present at the
  root of the finite-state-language repository;
- `package: [licenses: ["Apache-2.0"]]` in the FSL `mix.exs`. `mix sbom.cyclonedx`
  reads that key, so the SBoM Elixip generates will correctly show the
  dependency as Apache-2.0 while every elixip component stays BUSL-1.1;
- `NOTICE` naming IVèS as the copyright holder and recording that the code was
  extracted from Elixip, which is what makes the provenance readable rather than
  merely legal;
- a paragraph in **both** `LICENSE.md` and `LICENSE_fr.md` at **Elixip's**
  root, saying that the FSL engine was extracted and relicensed and where it now
  lives. The English text is the binding one and the French translation tracks
  it; they are changed in the same commit;
- **before P3, not P4**: no per-file licence header is added or changed during
  P1 and P2. A relicensing commit that also moves code is unreviewable. The
  header change, if any is wanted, is its own commit in the FSL repository after
  the move.

### 8.2 Package name and module namespace — decided 2026-09-12

The module namespace is settled: `FSL.*`. The hex *package* name is the open
question, and availability is not what settles it — **checked on 2026-09-12,
`fsl`, `finite_state_language` and `finite_state_machine` are all free**, a
search for `fsl` returns nothing at all, and none of the spellings hex's
similarity check would fold onto `fsl` (`f_s_l`, `f_sl`, `fs_l`) is taken
either. The nearest neighbour is `fsm` (2.5 M downloads), which normalizes
differently and does not collide.

So the choice is editorial:

- **`fsl`** — what the language is called, what the modules are called, what a
  `mix.exs` line reads best as. Three letters say nothing to someone who has not
  met the project, and it is the kind of name a future collision is built on;
- **`finite_state_language`** — matches the repository and the npm package
  `finite-state-language`, which is the argument that counts: the two
  implementations are meant to be recognisably one thing, and a reader arriving
  from either side should find the other without a mapping table.

**Decided: hex package `finite_state_language`, OTP app `:fsl`, modules `FSL.*`**
— the long name where it is indexed and searched, the short one where it is
typed. `fsl` is registered as well, pointing at the same project, to close the
squatting question; that second registration happens in P4 with the first
publication, not before.

### 8.3 `FSL.Machine` or `FSL`?

`use FSL.Machine` is explicit and leaves `FSL` free as the documentation and
facade module. `use FSL` reads better in a one-line example. Recommendation:
`FSL.Machine`, with `FSL` holding the moduledoc, `deadline/1`,
`remaining_timeout/1` and the `defdelegate`s — the shape `SIP.Scenario` has
today.

### 8.4 How much of the monitor is FSL's — decided 2026-09-12: all of it

This was left open on the assumption that the call-shape columns made the
registry SIP's. Counting settled it: three SIP references in 361 lines (§4.7).
The monitor, its subscription, the journal and the PlantUML renderer all move.

The sub-question it carried — an open `extra: %{}` map for host columns, versus
the host subclassing the registry — is answered by a third option neither of
them named: **the row stays flat, and the host declares its columns and their
defaults at start**. That is the least code and, more to the point, the only one
of the three under which `ElixippCLI` and `Kelix.InstancePool` do not change.

---

## 9. What this plan does not do

- it does not touch the SIP session mixins, the B2BUA layer, the media layer or
  any of the stack below them;
- it does not change the language. No macro is added, removed or given new
  semantics. `elixir/README.md` points at an `improve-fsl-elixir.md` listing
  DSL features designed for parity with the TypeScript implementation — that
  file exists in neither repository, and whatever it was to contain is
  independent of the extraction and must not ride along with it;
- it does not move `SBB.Call`, `SIP.Scenario.ExternalConfig` or
  `SIP.Scenario.CallDispatcher`, which are SIP policy written in FSL or around
  it;
- it does not make FSL depend on anything. The core stays `Logger`-only.
