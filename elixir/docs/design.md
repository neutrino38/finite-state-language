# The Finite State Language and its engine — as-built design

The as-built design of **FSL for Elixir**: the language in which a process is
described as a finite state machine, the engine that runs it, and the seam a
*protocol binding* plugs into. Everything described here is implemented and
covered by tests, in `lib/fsl/`.

This document is the **why and how it is built**. The language *reference* — what
to write, macro by macro, with examples — is Elixip's
[FSL.md][fsl-md], which documents the language through its
first binding and is the right place to start if you are writing a machine
rather than changing one. The cross-language contract with the TypeScript
implementation is [`spec/fsl-js-ts.md`](https://github.com/neutrino38/finite-state-language/blob/main/spec/fsl-js-ts.md).

> **History.** This file was `docs/design/DESIGN-FSL.md` in
> [Elixip](https://github.com/neutrino38/elixip) until the extraction of
> 2026-09-12 ([extraction-plan.md](https://github.com/neutrino38/finite-state-language/blob/main/elixir/docs/extraction-plan.md)). It moved here with the
> code, and it is rewritten rather than transplanted: the language now calls back
> into an embedding for everything it must not know, and that is a change in the
> design and not only in the module names. What stayed behind — SIP's host, the
> `SIP.Scenario` facade, the SIP-specific policy around the language — is
> described in Elixip's [`docs/design/DESIGN-FSL.md`][elixip-fsl], now a short
> document about the binding.

[fsl-md]: https://github.com/neutrino38/elixip/blob/master/FSL.md
[elixip-fsl]: https://github.com/neutrino38/elixip/blob/master/docs/design/DESIGN-FSL.md

---

## 1. The compilation model

A machine is a plain Elixir module — often an `.exs` file, so it can be loaded at
run time — that does `use FSL.Machine`:

```elixir
defmodule Turnstile do
  use FSL.Machine

  state locked do
    on_events do
      {:coin, _} -> goto unlocked, "paid"
    end
  end
end
```

That line brings the language and **nothing else**. A binding wraps it in a
facade of its own, which is what a machine written for that binding uses instead:
`use SIP.Scenario` is `use FSL.Machine, host: SIP.FSL.Host, ctx_var: :sip_ctx`
plus the three SIP session mixins, so the call and media verbs are in scope
inside the states without further ceremony.

Each `state name do … end` compiles to a function `__state_<name>/1` taking the
implicit context. Its body must end with a **transition macro**, which returns a
*transition descriptor* — a tuple the runner consumes:

| Descriptor | Meaning |
|---|---|
| `{:goto, target, desc, type, ctx}` | move to another state |
| `{:stay, desc, type, ctx}` | (error path only — see §2.4) |
| `{:terminal, :success \| :failure \| :aborted, reason, type, ctx}` | the machine ends |

`@before_compile` generates four introspection functions —
`__scenario_states__/0` (declaration order, which is what `goto next` means),
`__scenario_config__/0`, `__scenario_type__/0` and `__fsl_host__/0` — plus the
`run/1` entry point.

**A state never calls the next state.** It returns a descriptor and the runner
performs the transition (§4.2). That is what keeps the call stack flat across an
arbitrary number of transitions: a machine that waits an hour and loops through a
thousand keep-alives has the same stack depth as one that finishes at once.

---

## 2. The language surface

| Macro | Role |
|---|---|
| `config/1` | declare the machine's parameters; the host turns them into the context |
| `state/2` | declare a state |
| `goto/1..3` | transition |
| `stay/0..2` | consume an event, keep waiting |
| `on_events/1` | typed `receive` |
| `scenario_success/failure/aborted` | terminals |
| `spawn_fsm/2`, `notify/2`, `notify_parent/1`, `on_shutdown/1` | sub-FSMs and cooperative shutdown |
| `sbb_fsm/2`, `sbb_return/1`, `sbb_data_get/1`, `sbb_data_set/2` | service building blocks (§6) |
| `ctx_set/2`, `ctx_get/1`, `ctx_set_multiple/1`, `appdata_set/2`, `appdata_get/1` | the context (`FSL.Context`) |

### 2.1 `config` and the context

`config` stores a keyword list read at instantiation by
`c:FSL.Host.build_context/1`. **What a key means is the binding's business**, and
that is the whole reason `config` is a macro over an opaque list rather than a
map with a schema: the same declaration can seed a per-session identity and a
process-wide setting, and a machine should not have to know which is which.

`FSL.Host.Default` puts everything in `appdata`. SIP's host routes each key to
one of three places — a native `%SIP.Context{}` property (`username`, `domain`,
`ha1` computed from `passwd`), the application env for a global key
(`proxyuri`, `mediaserver`), or `appdata` for anything else.

### 2.2 `FSL.Context` — six fields, and which way the dependency points

The context is **FSL's**, and a protocol binding **extends** it:

```elixir
defmodule SIP.Context do
  @after_compile FSL.Context
  defstruct FSL.Context.fields() ++ [username: nil, domain: nil, dialogpid: nil, …]
end
```

| Field | Written by | Read by |
|---|---|---|
| `lasterr` | a binding's verbs | every transition macro |
| `errorreason` | `scenario_failure/1` | `cleanup/1`, the host |
| `currentstate` | the runner, on entering a state | the machine, the host |
| `laststate` | the runner, only on a real state change | `goto back` |
| `parent_pid` | `spawn_fsm`, `run_instance/2` | the parent notifications |
| `appdata` | `appdata_set`, the sub-FSM and block bookkeeping | everything |

That reading settles the direction, and it is the opposite of what the file
layout suggested before the extraction. These six are not a contract imposed on a
host: they are the machine's own state, and it is the *protocol's* fields that are
the guests. `lasterr` is the single exception — the one field a binding writes and
FSL reads, which is the channel that lets a verb report an error and a machine
stay readable without an `if` after every call (§2.3).

FSL writes them with `FSL.Context.put/3`, deliberately **not** through a
binding's setter, which validates properties FSL has no business knowing about.
`@after_compile FSL.Context` makes a `defstruct` that forgot `fields()` a compile
error rather than a crash on the first transition.

**The names stay unspaced** — `lasterr`, not `last_error`. Deployed scripts read
`ctx.lasterr` off the struct, a struct field takes no deprecated alias, and the
failure would be a node that does not start rather than a warning. FSL adopted
the names it inherited; changing them is a major version with a migration, never
a side effect of moving files.

#### The context variable is a parameter

A machine written for SIP reads `sip_ctx`, because it is holding a SIP session;
an XMPP one would read `xmpp_ctx`, a chatbot `bot_ctx`. What the language must not
assume is that there is only **one**: `ctx_var:` names it, `use FSL.Context` takes
the same option so the generic macros bind the same variable, and inside FSL the
technique is one line — `ctx = Macro.var(ctx_var, nil)`, a variable with a `nil`
context being exactly what `var!/1` produces — then `unquote(ctx)` wherever the
source used to say `var!(sip_ctx)`.

This costs readability and it is worth saying so: `var!(sip_ctx)` said what it
was, `unquote(ctx)` asks the reader to look up one line. It is accepted because
the alternative is a language that cannot be bound twice, and it is mitigated by
binding `ctx` on the **first line** of each macro and nowhere else — never
inline, never conditionally — and by giving the pure clause-building helpers the
variable as their first argument rather than letting them reach for it.

The attribute holding the name is written **imperatively**, with
`Module.put_attribute/3` at expansion time, and that is not a style choice: a
`@attr value` sitting in a `use`'s quote is *evaluated* when the module body runs,
while sibling macro calls — every `state` of the machine — are *expanded* before
that. Quoted, the name read `nil` at module level and `:sip_ctx` inside each state
body, so the generated head bound one variable and the body read another.

### 2.3 `goto`

Four target kinds: a named state, `next` (the next declared state), `loop`
(re-enter this one) and `back` (the state entered before this one). `next`, `loop`
and `back` are reserved words; `back` is mapped at expansion time to the
pseudo-target `:__back__` so it cannot collide with a state actually named `back`.

**`back` is one slot, not a stack.** The runner writes `laststate` in `enter/3` on
every transition *that actually changes state* — `goto loop`, an explicit
self-goto and `stay` leave it alone, because re-entering a state is not "coming
from" it. Two consecutive `goto back` therefore toggle between two states, and
`goto back` with no previous state fails the machine cleanly. A stack is
deliberately out of scope until a machine needs one.

**The `lasterr` contract.** Every transition macro first checks `lasterr`;
anything other than `:ok` aborts the machine as a failure instead of
transitioning. This is what lets a binding's verb report an error by writing the
context, and a machine stay readable without an `if` after every call.

**Event typing.** `goto target, desc, type` records what kind of event caused the
move. When the type is omitted and the `goto` sits inside an `on_events` clause,
it is **inferred from the matched pattern** at compile time and passed through the
process dictionary. An explicit type always wins. The type is what makes the live
registry and the sequence diagram readable, so it is collected by default rather
than on request — and who answers for it is split (§3.3).

### 2.4 `stay` — and why it is a rewrite, not a descriptor

`stay` consumes the matched event and goes back to waiting **on the same
`on_events`**, without re-running the state body. `goto loop` cannot do this: it
re-executes the body and replays its side effects — re-sending a request,
re-arming work, re-allocating a resource. Answering a keep-alive inside an
established state needs exactly that distinction.

The `after` timeout is **not** re-armed: it is the deadline of the *wait*,
computed once when the block is entered (`FSL.Machine.deadline/1`), and a `stay`
comes back with the time that is left (`FSL.Machine.remaining_timeout/1`).
Otherwise a keep-alive answered every 10 s would hold a 30 s answer timeout open
forever — a bug wearing a feature's clothes. This also matches FSL/TS, whose
transition model we keep aligned on purpose.

`stay` is **rewritten in the clause AST** into a call back into the wait closure,
rather than returning a `{:stay, …}` descriptor that the clause result is matched
against. The descriptor version is the obvious design and it does not survive
contact with the compiler: Elixir infers the exact type each clause returns, so in
the normal case — no clause stays — the `{:stay, …}` branch is provably dead and
the compiler says so, once per state of every machine.

Consequences of rewriting rather than dispatching:

- the recursion stops at a nested `on_events` / `receive`, and never walks the
  `after` body — a `stay` there belongs to another wait, or to none;
- `stay` outside an `on_events` is caught at **compile time** (`state/2` and
  `on_shutdown/1` walk their body for it), and the error names **the machine's own
  file and the line the `stay` sits on**. That matters more than it looks: a
  `CompileError` pointing into `FSL.Machine` rather than into the file the author
  is editing would undo the reason the check exists;
- the runner still fails the machine on a `{:stay, …}` tuple that reaches it,
  which is how a `stay` in a hand-written `receive` is reported;
- `stay` is a reserved word inside a state body, like `next` and `loop`.

A `stay` is logged and reported like a transition `(state) -> (state)`, so a
machine whose whole activity is `stay` never looks frozen in the live view.

### 2.5 `on_events`

A `receive` whose clauses are instrumented at compile time. Four things happen to
every clause:

1. **type inference** from the pattern (§3.3);
2. **the per-event hook**: the pattern is bound through an as-pattern and
   `c:FSL.Host.on_event/2` is called on the event before the machine's own clause
   body runs (§3.2);
3. **`stay` rewriting** (§2.4);
4. **wait closure**: the `receive` lives inside a self-calling closure so `stay`
   re-enters it without leaving the state function. The closure and deadline
   variables are `Macro.unique_var/2`, so nested `on_events` never capture each
   other's.

Clauses are **injected**, prepended so a catch-all `_ ->` cannot swallow them
first. One family is the language's and one is the binding's, and **the difference
between them is not cosmetic**:

| Injected clause | Whose | Suppressed by |
|---|---|---|
| `{:scenario_ctl, :shutdown, _}` → `:__shutdown__` | FSL's: the FSM control protocol | an explicit `:scenario_ctl` clause, and nothing else |
| `{:sbb_deadline, ref}` | FSL's: a block's completion bound (§6) | nothing — only present in a block |
| whatever `c:FSL.Host.injected_clauses/1` returns | the binding's failure domains | `c:FSL.Host.clause_covers?/2`, generously |

A controller asking a machine to stop is a **protocol**, so only an explicit
clause opts out of it: a machine that happens to write `event -> …` has not
thereby declined to be stoppable, and one that could not be stopped would be a
node that cannot drain. A host's clause is a **policy default**, for machines that
never considered the case rather than to overrule those that did, so its
suppression test is allowed to be generous — a clause matching every event of the
family, or a catch-all, is enough.

Every injected clause leaves the state by construction, so they are instrumented
without the `stay` rewrite — a dead `{:stay, …}` branch there would be one
compiler warning per state, again.

### 2.6 Terminals

`scenario_success` and `scenario_failure` are the two ordinary outcomes;
`scenario_failure` also writes `errorreason` into the context. `scenario_aborted`
is a **third** outcome for a controller-driven wind-down, kept distinct so a
graceful stop is not counted as a failure in a tool's verdict tally.

---

## 3. The embedding — `FSL.Host`

FSL runs state machines. It knows nothing about a dialog, a transaction, a media
plane or a call, and **the test of whether a seam is cut in the right place is not
"does the SIP binding still work"** — it will, whatever we do, because the code
was shaped around it. The test is whether a *second* binding could be written
without touching FSL. XMPP, Matrix and the frameworks behind chatbots are the
candidates named for this; none of them has a dialog or a transaction, and two of
them have no notion of a call at all.

So everything FSL must not know is a callback here. A machine names its host at
`use` time, the module records it, and the runner reads it back through the
generated `__fsl_host__/0` — **no application env, no global configuration**, so
two hosts coexist in one VM. That is what makes the language testable against a
host of its own (`FSL.Test.Host`) and what a published package needs.

Every callback is optional. `FSL.Host.Default` answers each with the least a
machine needs, so a machine with no protocol runs with no host written.

| Callback | When | SIP's answer |
|---|---|---|
| `c:FSL.Host.bootstrap/0` | `run(true)`, once | start the transaction, transport, dialog and config layers, and the node's auth secret |
| `c:FSL.Host.build_context/1` | instantiation | the three-way routing of §2.1 |
| `c:FSL.Host.apply_run_opts/2` | instantiation | `:dialog_pid` and `:inbound_request` — a UAS instance does not create its own dialog |
| `c:FSL.Host.on_event/2` | every matched event | §3.2 |
| `c:FSL.Host.on_state_enter/1` | every state entry | forget the matched event's leg and transaction |
| `c:FSL.Host.event_type/1` | expansion, per clause | `:ms_event` is media, anything else it is shown is `:sip` |
| `c:FSL.Host.injected_clauses/1` | expansion, per `on_events` | the media server going away |
| `c:FSL.Host.clause_covers?/2` | expansion, per clause | generously (§2.5) |
| `c:FSL.Host.spawn_child/2` | `spawn_fsm` | register a `:uas_invite` child with the call dispatcher |
| `c:FSL.Host.finalize/1` | teardown | the B2BUA legs, then the media (§4.3) |
| `c:FSL.Host.account/2` | every report | who this run serves (§7) |
| `c:FSL.Host.diagram_renderer/0` | journal flush | not implemented: the shipped renderer is the right one |

`FSL.Host.hook/4` is how the language calls one. It tries `function_exported?/3`
first and falls back to `Code.ensure_compiled/1`, in that order and not the
reverse: some of these hooks are asked *while the compiler is running*, so a host
being compiled in the same pass has to be waited for rather than declared absent —
and paying for the code server on the path of every transition to cover a host
that is only not-loaded once is how a hook becomes a cost.

### 3.1 What a binding provides, in full

| What | SIP's instance |
|---|---|
| a context struct | `SIP.Context` — `use FSL.Context` plus its own fields |
| the name of the context variable | `sip_ctx`, through `ctx_var:` |
| the verbs | the `SIP.Session.*` mixins, brought in by its own facade |
| a host module | `SIP.FSL.Host` — ~380 lines, most of it moved verbatim out of the runner |
| a facade | `SIP.Scenario` — ~100 lines, and what a SIP machine actually writes |

Nothing in that list is in FSL, and nothing FSL keeps mentions a protocol: states,
transitions, `on_events` and its selective-receive semantics, `stay`, `goto back`,
sub-FSMs and cooperative shutdown, service building blocks, the journal,
`FSL.Valet`, HTTP-as-events.

### 3.2 `c:FSL.Host.on_event/2` — one callback, because the order is the point

Three things used to be injected into every `on_events` clause. They are one
function on the host now, and the gain is not decoupling but that **the order can
be read**. SIP's does, in this order:

1. **which leg, which transaction.** Recorded first, because it is what the
   `b2bua_*` verbs read to know where to act: a clause replying to the event it
   just matched is not asked for a direction.
2. **what a leg that has just died owes.** A dialog dying is not news the machine
   has to translate: whatever it decides next, the requests that leg was going to
   answer never will be, and someone is waiting for each of them. They are
   answered here, at once, so the caller hears about its callee going away now
   rather than at the teardown.
3. **the inbound request, stashed last**, on the context step 2 produced.

Spread over three injected calls, that sequence lived in the expansion of a macro.
It is now three lines of one function — which is also why the test that used to
read the expansion now tests the host directly.

`c:FSL.Host.on_state_enter/1` is the mirror, next to FSL's own `Process.delete(:scenario_event_type)`.

### 3.3 Event typing — who answers for what

`FSL` classifies what it owns and hands the rest over:

| First element of the pattern | Type | Whose |
|---|---|---|
| `:parent_msg`, `:child_msg`, `:child_exit` | `:scenario` | FSL |
| a declared block namespace (3-tuple) | `:scenario` | FSL (§6.3) |
| `:scenario_ctl` | `:control` | FSL |
| anything else | `c:FSL.Host.event_type/1`, else `nil` | the binding |

**The fallback is the binding's, and that is the interesting half.** SIP answers
`:sip` for any leading atom it is shown, and that sentence — an unrecognised event
came *from the peer* — is only meaningful where there is a peer. A language that
made it would be a language that assumes one.

---

## 4. The engine

### 4.1 One FSM, one process

`FSL.Runner.run_instance/2` runs the whole FSM **in the calling process**. For
SIP this is not an implementation detail one could relax: the dialog and media
layers bind events to `self()`, so two FSMs sharing a process would share one
mailbox and steal each other's responses. Every consequence in §5 and §6 follows
from this single constraint, and a binding whose events are not bound to a process
simply does not feel it.

`c:FSL.Host.bootstrap/0` is idempotent, so `run(true)` (the one-shot mode) and
`run(false)` (many instances over an already-bootstrapped host) are the same code
path.

### 4.2 The loop

`loop/4` applies `__state_<name>/1`, matches the descriptor, resolves the
pseudo-targets, logs the transition, reports it to `FSL.Monitor` and to the
sequence journal, then tail-calls itself on the next state. Four descriptors are
error paths that end the machine cleanly rather than crashing it:

| Situation | Outcome |
|---|---|
| `goto` to an undeclared state | failure `{:unknown_state, target}` |
| `goto back` with no previous state | failure, "goto back with no previous state" |
| `{:stay, …}` reaching the runner | failure `{:stay_outside_on_events, state}` |
| anything that is not a descriptor | failure `{:invalid_transition, state}` — a state that forgot its transition macro |

`:__shutdown__` is resolved here too: if the machine declared `on_shutdown`, the
runner enters it as a state; otherwise it terminates with the `:aborted` outcome.

`state/2` installs the safety net that makes a failure *a failure* rather than a
dead process: it **rescues** exceptions and **catches exits**, both becoming a
failure terminal. Every primitive a SIP verb calls is a `GenServer.call` toward a
dialog or a transport that may have died between the check and the call. Until
this existed, such an exit killed the process outright and the teardown never ran:
no leg was torn down, no media released, and the caller of a relayed request
waited forever for a final response nobody would send. So: **whatever happens, the
machine ends** — which is what runs the teardown.

### 4.3 Teardown — `finalize/4`

The order is fixed and it matters:

```
shutdown_children        # sub-FSMs first: they release their own resources
  → c:FSL.Host.finalize  # whatever the binding holds — one step, opaque here
    → cleanup/1          # the machine's own optional callback
      → notify_parent_exit
        → flush the sequence journal
```

Three of those four steps are the FSM's, which is why the order stays in the
runner and only the middle one is the host's. Why each neighbour:

- **children before everything.** A child holds resources of its own and may be
  acting on the parent's; releasing ours first leaves it working on something
  gone.
- **the binding before `cleanup/1`.** The machine's own hook runs last among the
  releases, so it can still read a context whose handles the framework has not yet
  invalidated.
- **the parent last.** `{:child_exit, …}` is the parent's signal that this
  instance is done with everything it held; sent earlier, the parent may reuse a
  resource we have not released.

`c:FSL.Host.finalize/1` is **one** callback and not one per resource, because the order
*between* a binding's own releases is that binding's rule and has to stay in one
place: SIP winds down its B2BUA legs before its media — a leg left behind holds a
call up at the far end, and it is the leg that carries the media the server is
about to stop serving — and waits (bounded, 5 s) for the dialog's termination
event first, accepting it **tagged** as well as bare. A B2BUA outbound leg's
`{:outbound, {:dialog_terminated, …}}` says just as much about the call being
over, and ignoring it stalled the teardown for the full five seconds with no error
at all.

---

## 5. Sub-FSMs

### 5.1 The shape

`spawn_fsm target, as: :name, args: %{…}` spawns another machine as a **separate
monitored process** and stores a `%FSL.Child{name, pid, ref, module}` handle in
`appdata[:__children__]`, so it survives across states. `target` is a compiled
module or a path to an `.exs` file — resolved against the directory of the file
that *declares* it (include semantics), not against the current working
directory. Resolving against the cwd is what made `spawn_fsm "scenarios/x.exs"`
die with a bare "exception!" for anyone not standing in the right directory.

Decisions, all deliberate:

| Question | Choice |
|---|---|
| parent reference in the child | a dedicated `parent_pid` field on the context |
| OTP coupling | **monitor only** (`spawn_monitor`), no link — a child crash must not kill the parent |
| cleanup when the parent ends | cooperative shutdown message, then a hard kill after a 5 s grace period |
| nesting | a full tree: a child may spawn its own children |
| scope of the shutdown protocol | **generalized** — the same control message any controller uses |
| the event names | `{:parent_msg, …}` / `{:child_msg, …}` / `{:child_exit, …}`, matching `parent:msg` / `child:msg` / `child:exit` of FSL/TS. They were one `{:scenario_msg, from, …}` for both directions: that names the transport and hides the direction, and TS cannot fold the two into one type because it dispatches on the type alone. A message takes no deprecated alias, so `on_events` warns at compile time when a machine matches an old shape |
| the name | `spawn_fsm`, after `fx.spawn` of FSL/TS — one name per concept across the two dialects. Spelled `sub_fsm` in Elixip up to 1.4.1; the old macro is kept as a deprecated alias sharing the same expansion, because `.exs` files are loaded at run time and a rename would break them in the field, not at compile time |
| what a child of a given kind needs | `c:FSL.Host.spawn_child/2`, with the kind **opaque** to FSL (§8) |

### 5.2 The message protocol

Three families, all plain `send/2` into the FSM's mailbox and matched in
`on_events`:

| Message | Direction | Meaning |
|---|---|---|
| `{:parent_msg, payload}` | parent → child | application message downwards. The sender was always the parent, so the name is dropped from the tuple and put in the tag |
| `{:child_msg, name, payload}` | child → parent | application message upwards, tagged with the name the parent assigned at spawn (`as:`), so the parent matches a stable literal in every state |
| `{:scenario_ctl, :shutdown, reason}` | controller → FSM | cooperative stop. The 3-tuple envelope leaves room for future verbs without changing shape |
| `{:child_exit, name, outcome, reason}` | child → parent | how the child ended |
| `{:DOWN, ref, :process, pid, reason}` | OTP → parent | safety net when the child died without reporting |

### 5.3 Cooperative shutdown

A shutdown request is *observed* by the injected `on_events` clause (§2.5), which
jumps to the reserved `:__shutdown__` state. The machine's `on_shutdown` block
runs there — release resources, send a last message, end with `scenario_aborted` —
and when there is none the runner ends the machine as `:aborted` by itself. A
parent tearing down asks every child, waits (bounded) for their `:DOWN`, and
hard-kills the stragglers past the grace period.

---

## 6. Service building blocks

A **sub-FSM** is a second process with resources of its own. A **service building
block** is the opposite animal: `sbb_fsm module, opts` makes the *current* process
enter `module`'s FSM, on the current machine's context and mailbox, until the
block hands control back with `sbb_return event`. A subroutine call, not a spawn.

The shape follows from invariant 2, not from preference: where a binding's events
are bound to `self()`, a block running anywhere else could not receive the host's
events at all.

Blocks exist because a layer of primitives, however right, leaves a working flow
at five or six states and a queue rather more. `FSL.Block` is the mechanism;
what a block *does* is the binding's — Elixip's `SBB.Call` is a call-flow block
written in FSL, a consumer of this and not part of it.

### 6.1 The engine side

`loop/4` already takes the module, the state name, the context and the state list
as arguments — nothing in it is bound to *the* machine. A block is that same
dispatcher, so `sbb_loop/5` differs in exactly two ways: it never calls
`finalize/4` (the host's resources and children are not the block's to release)
and it never reports an outcome to a parent FSM (its caller is a state, not a
process).

| Descriptor | Produced by | Handled by |
|---|---|---|
| `{:sbb_return, event, ctx}` | `sbb_return/1` | `sbb_loop/5` returns it; `loop/4` treats it as a machine error, since there is nothing to return to |
| `throw {:sbb_terminal, outcome, reason, type, ctx}` | a terminal inside a block | `loop/4` only — re-applied as if the host state had written it |
| `throw {:sbb_deadline_hit, ref, ctx}` | the clause `on_events` injects into every block state | the `run_sbb/3` frame whose `ref` it is |

Both non-local exits are `throw`, and both rely on one property of the engine: the
`try` wrapping every state body catches **exceptions and `:exit`, never
`:throw`**. A thrown term therefore crosses every state frame and every nested
block. `sbb_loop/5` deliberately does not catch either, so a terminal three blocks
deep still unwinds to the root, and a parent's deadline passes through a running
child to the frame that armed it.

### 6.2 The return contract

A block returns `{namespace, outcome, data}` — fixed arity, last element a map, so
a block can report one more thing without breaking a host that matches it. The
namespace and the outcomes are declared (`@sbb_namespace`, `@sbb_returns`) and
`sbb_return/1` checks a literal return against them at **compile time**: a
mistyped outcome is otherwise not an error but a silence, the host waiting on its
`after` for an event nobody sends.

### 6.3 Why the namespaces are learned, not listed

The namespace is the block author's word, so `on_events` cannot classify a return
from a table — and an unrecognised leading atom falls through to the binding's
fallback, which for SIP draws an arrow *from the peer* in the sequence diagram.
A block's return came from nobody.

So the namespaces are **learned at macro-expansion time**: expanding
`sbb_fsm(Block, …)` resolves the alias and records `Block.__sbb_namespace__/0` on
the calling module, and a face module records its own from `__using__`
(`FSL.Machine.register_namespace/2`). `on_events` reads the list when it
classifies its clauses.

The list is a plain attribute written with read-modify-write, **not**
`accumulate: true` — the same lesson as §2.2. It is written and read during
expansion, whereas a `Module.register_attribute` call placed in `__using__`'s
quote runs later, when the module body is evaluated, and would clear at that point
everything expansion had gathered.

### 6.4 The context

The block gets the host's context as it stands — that is the whole point. Three
things are put back on return: `currentstate` and `laststate` (so `goto back`
inside a block cannot land in a host state), and, by construction, the host's
`after` deadline, which does not exist yet when a state body runs.

`appdata` is shared, with one reserved key per block — `{:sbb, Module}` — for its
scratch space, read and written with `sbb_data_get/1` and `sbb_data_set/2`. It is
**cleared on every call**, so a block entered target after target does not inherit
the previous attempt; `resume: true` is the exception, for a block designed to be
re-entered after an interruption.

### 6.5 What the live view shows

A block's states are reported on the **host's own row** — one run, one row — with
the state qualified by the block it belongs to: `MyApp.Confirming/waiting`. Making
the sequence visible is the layer's purpose, so hiding it while the host is
suspended would be a strange way to serve it, and reporting the block's states
bare would show a run in states its machine does not declare.

`run_sbb/3` pushes the block on a per-process stack and pops it in its `after`, so
an unwinding terminal leaves the reporting as it found it; the outcome that follows
is the host's and is reported unqualified. The row always names the machine the
process runs (`:scenario_module` in the process dictionary), never the block — on
the way *out* of `run_sbb/3` the block is already off the stack, and the report
that restores the host's state would otherwise be labelled with it. Nesting shows
the innermost block, which is where the run actually is.

### 6.6 Two rules the compiler enforces

- **`sbb_fsm` is refused inside an `on_events` clause.** That clause's deadline is
  absolute (`FSL.Machine.deadline/1`), so a block called from one would burn the
  host's remaining timeout while it runs. From a state body the suspension is
  free. Same check, and the same rationale, as `stay` outside an `on_events` —
  and, like it, the error names the author's own file and line;
- **a block defines no `run/1`.** `FSL.Loader` accepts anything exporting `run/1`
  and `__scenario_states__/0`, and `load_file!/1` takes the first match — so a
  block declared above the machine in the same `.exs` would otherwise be run *as*
  the machine.

---

## 7. Observability

Two sinks, both no-ops when not started, so a production run pays nothing.

### 7.1 `FSL.Monitor`

An in-memory registry of the running instances: one row per run, a sub-FSM under
its parent, keyed on a slot id. The runner reports transitions; a binding's verbs
report commands through `note_command/2`. A pid can `subscribe/1` instead of
polling `calls/0`, and gets `{:fsl_monitor, {:updated, slot, row}}` after every
change and `{:fsl_monitor, {:cleared, slot}}` when a slot is recycled.

**Whose columns are whose.** `scenario`, `state`, `event`, `event_type`, `command`
and `command_type` are the machine's; so is `account`, because "who this run
serves" is a generic question even though only the binding can answer it
(`c:FSL.Host.account/2`). Everything else belongs to the embedding, which declares
its columns **and their defaults** when it starts the registry:

```elixir
FSL.Monitor.start(columns: [medias: "n/a", mediaserver: "none", outbound: "n/a"])
```

and writes one with `note/2`. The registry never learns which key is whose. A
host's defaults travel with its columns because they mean something: `"n/a"` says
*this run negotiated nothing*, where a blank cell would read as *nobody measured*.

**The row stays flat** — `row.medias`, not `row.extra.medias`. That is not
tidiness: flat rows are the only shape under which a consumer that declares its
table by plain key does not change when this module moves into a package.

`c:FSL.Host.account/2` is asked with `:initial` for the first row of a run and
`:subsequent` for every one after it, and the distinction is policy: SIP answers
the identity the inbound request asserts for the first row of a server instance,
then keeps quiet so the script can name the account it learned without every
transition clobbering it.

### 7.2 `FSL.Journal` and `FSL.Diagram.PlantUML`

A per-instance chronological journal (commands, transitions, outcome) kept in the
**process dictionary** of the machine's process, which is precisely where the
runner, the macros and the reporting all run. It is therefore isolated per run
with no registry and no message passing.

Two renderers ship behind the `FSL.Diagram` behaviour — `render/2` and
`filename/1` — and a binding names the one it wants with
`c:FSL.Host.diagram_renderer/0`:

| | |
|---|---|
| `FSL.Diagram.PlantUML` | the default. Colours the media lane, tints a terminal note green or pink |
| `FSL.Diagram.Mermaid` | what the TypeScript sibling emits, and what GitHub renders in place with no toolchain. No per-arrow colour in the grammar, so media is dotted and on its own lane rather than orange — a weaker signal, and the honest trade against inventing a `rect` block that would colour a region instead of a message |

The journal is turned on by `config :fsl, :log_sequence, true`, or by the
binding's own app when it named one with `config :fsl, :log_sequence_app,
:my_app` — a binding usually keeps all of its configuration in one namespace and
should not have to split one flag out of it.

**Three lanes, and the rule is by exclusion:**

| Event / command type | Lane |
|---|---|
| `:media` | the media server |
| `:scenario`, `:control`, `:timer`, `:http`, `:db`, `nil` | a note over the local lane |
| **anything else** — `:sip`, `:matrix`, `:xmpp`, … | the peer |

Written the other way round — matching `:sip` for the peer — a binding emitting
`:matrix` falls through to the self-note and gets a worse diagram for no reason.
By exclusion it reproduces the previous rendering exactly for every type SIP
emits, and does something sensible for one it has never seen. What is left of
protocol vocabulary is naming convention that generalizes for free:
`send_INVITE → INVITE` is a prefix rule over command names and reads
`send_message → MESSAGE` just as well. The secret masking keeps its SIP key
names, because masking a key nobody uses costs nothing and forgetting one costs a
password in a file.

---

## 8. The opaque slot — `__scenario_type__/0`

A binding needs somewhere to record what *kind* of machine this is: SIP writes
`:uac`, `:uas_register`, `:uas_invite`, from its own `uas/1` macro on
`SIP.Scenario`. FSL keeps the **slot** and drops the vocabulary — the default is
`nil`, the runner hands whatever is in it to `c:FSL.Host.spawn_child/2` without
inspecting it, and `FSL.Loader.scenario_type/1` reads it back without an opinion
about what "declared nothing" means.

A language that knew the atoms `:uac` and `:uas` would be a language that knows
about server roles in a protocol. A Matrix binding having to declare its machines
`uas :something` would be a tell that the seam is in the wrong place.

---

## 9. Loading and running

`FSL.Loader` has two entry points and one reader:

- `load_file!/1` compiles an `.exs` and returns the module defining both `run/1`
  and `__scenario_states__/0` — the signature of `use FSL.Machine`;
- `load_module!/1` resolves a name (`"UAC.Register"`) among already-compiled
  modules;
- `scenario_type/1` (§8).

Both paths exist on purpose: a machine compiled into a binary runs by module name
with no file present, while an editable `.exs` is loaded by path.

`use FSL.Machine` generates the `run/1` those paths call: it bootstraps the host
when asked, builds the initial context from the `config` block and enters
`initial_state`. It returns `:ok` on a success terminal, `{:error, reason}` on a
failure one, and `{:aborted, reason}` when the machine was wound down by a
cooperative shutdown — three outcomes rather than two, so tooling can tell a
controller-driven stop from a machine that failed.

---

## 10. Invariants

1. A state ends with a transition macro and returns a descriptor; it never calls
   the next state (§1).
2. One FSM *stack*, one process (§4.1). A sub-FSM is another process with
   resources of its own; a service building block is a nested FSM on this
   process's (§5, §6).
3. A machine always *ends*: an exception or an exit inside a state becomes a
   failure, so teardown runs (§4.2).
4. Teardown order is children → the binding → `cleanup/1` → parent (§4.3).
5. `laststate` is written only when the state actually changes (§2.3).
6. `stay` does not re-arm the `after` deadline (§2.4).
7. Every `on_events` is stoppable whether or not the author thought about it, and
   carries whatever failure domains the binding declared (§2.5).
8. The context belongs to FSL; a binding extends it (§2.2).
9. No symbol of a protocol appears in `lib/fsl/`, and that is enforced by
   `mix compile --warnings-as-errors` in a project that depends on no binding —
   not by review.
10. A machine states a flow; it does not implement one. A private helper carrying
    real logic is a missing macro in the framework, not a style choice.
