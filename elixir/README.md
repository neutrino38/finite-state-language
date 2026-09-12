# FSL for Elixir

The Elixir implementation of the **Finite State Language**: describe a process as
a finite state machine — states, transitions, `on_events` and its selective
receive, `stay`, `goto back`, sub-FSMs and cooperative shutdown, service building
blocks, a live registry, a sequence journal and its PlantUML and Mermaid
renderers — and plug a *protocol* into it.

```elixir
defmodule Turnstile do
  use FSL.Machine

  config label: "gate 3"

  state initial_state do
    goto locked
  end

  state locked do
    on_events do
      {:coin, _} -> goto unlocked, "paid"
      {:push, _} -> stay("still locked")
    after
      60_000 -> scenario_success("nobody came")
    end
  end

  state unlocked do
    on_events do
      {:push, _} -> goto locked, "went through"
    after
      10_000 -> goto locked, "timed out"
    end
  end
end

FSL.Runner.run_instance(Turnstile)
```

**The core depends on nothing but `Logger` and OTP.** `FSL.HTTP` is the one
module that needs a client, and `Req` is declared `optional: true` for it.

## Install

```elixir
def deps do
  [{:finite_state_language, "~> 0.2"}]
end
```

Three names for one thing: `finite_state_language` is the hex package,
`:fsl` is the OTP application, `FSL.*` is what the code writes. Documentation is
on [hexdocs](https://hexdocs.pm/finite_state_language).

## Run something

```
mix run samples/fishing.exs
```

Bob goes fishing. Ducks paddle past, the line snags, two fish bite, and he has
400 ms to strike each time — his hands, which are a sub-FSM with a reaction time
of their own, take 250 ms. The trip prints itself as a Mermaid diagram you can
paste into a GitHub comment. [`samples/`](samples/README.md) is the file to read
first, and it is commented for that.

## The governing idea

**The context belongs to FSL, and a protocol binding extends it.** The six fields
a machine keeps about itself — `lasterr`, `errorreason`, `currentstate`,
`laststate`, `parent_pid`, `appdata` — are `FSL.Context`; a binding splices them
into its own struct and adds what a session of *its* protocol holds.

Everything the language must not know is a callback on `FSL.Host`: what to
bootstrap, how to read a `config` block, what to do with each received event, how
to categorize one, which clause every wait must carry, what to release at the
end. A machine that names no host gets `FSL.Host.Default` and runs with no
protocol at all. `FSL.Test.Host` (`test/support/`) is the worked example, and
what this package's own suite runs against.

The test of every seam is whether a **second** binding — XMPP, Matrix, a chatbot
framework — could be written without touching FSL. SIP is the first, in
[Elixip](https://framagit.org/elixip/elixip): `SIP.FSL.Host` is ~380 lines and
`SIP.Scenario` is the 100-line facade a SIP scenario writes.

## Documentation

- the [API reference](https://hexdocs.pm/finite_state_language) — `FSL.Machine`
  is the entry point, `FSL.Host` is what an embedding writes;
- [`samples/README.md`](samples/README.md) — the fishing trip, annotated;
- [`docs/design.md`](docs/design.md) — the as-built design: why the engine is a
  flat call stack, what `stay` rewrites, how a block's `cleanup/1` is guaranteed;
- [`spec/fsl-js-ts.md`](https://framagit.org/elixip/finite-state-language/-/blob/main/spec/fsl-js-ts.md)
  — the cross-language contract, reconciled clause by clause with the TypeScript
  implementation, including the divergences kept on purpose.

## Licence

[Apache-2.0](https://framagit.org/elixip/finite-state-language/-/blob/main/elixir/LICENSE). The code was extracted from
[Elixip](https://framagit.org/elixip/elixip), which stays BUSL-1.1, and
relicensed so that both implementations of the language ship under one licence —
see [`NOTICE`](https://framagit.org/elixip/finite-state-language/-/blob/main/elixir/NOTICE).
