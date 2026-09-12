# FSL for Elixir

The Elixir implementation of the **Finite State Language**: describe a process as
a finite state machine — states, transitions, `on_events` and its selective
receive, `stay`, `goto back`, sub-FSMs and cooperative shutdown, service building
blocks, a live registry, a sequence journal and a PlantUML renderer — and plug a
*protocol* into it.

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
[Elixip](https://github.com/neutrino38/elixip): `SIP.FSL.Host` is ~380 lines and
`SIP.Scenario` is the 100-line facade a SIP scenario writes.

## Status

Extracted from Elixip and building here; **not yet published to hex**. The
package will be `finite_state_language` (OTP app `:fsl`, modules `FSL.*`),
licensed Apache-2.0 — decided 2026-09-12, see
[docs/extraction-plan.md](docs/extraction-plan.md) §8, which is also the record
of every seam and why it is where it is.

Remaining before a first release: the `LICENSE`/`NOTICE` files, `CHANGELOG.md`,
ex_doc output, a reconciliation with
[the cross-language spec](../spec/fsl-js-ts.md) clause by clause, and the rest of
Elixip's FSL test suite, which still lives there.

The language reference an integrator reads is
[FSL.md](https://github.com/neutrino38/elixip/blob/master/FSL.md) and its
as-built design is
[DESIGN-FSL.md](https://github.com/neutrino38/elixip/blob/master/docs/design/DESIGN-FSL.md).
