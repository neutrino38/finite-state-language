# FSL for Elixir — reserved

This directory is reserved for the Elixir implementation of FSL: the scenario
DSL currently living inside [Elixip](https://github.com/neutrino38/elixip)
(`apps/elixip2/lib/dsl/SIPScenario.ex` and friends), to be extracted here as a
standalone hex package — generic states / transitions / `on_events` / sub-FSM /
cooperative shutdown / `Valet` / the scenario Monitor — with the SIP-specific
parts staying in Elixip, plugged in through extension points.

**The extraction plan is [docs/extraction-plan.md](docs/extraction-plan.md)**:
the inventory of what moves, every coupling to cut and the seam proposed for
each, the tests that pin today's behaviour first, and six phases to do it in.
Two decisions are already taken there — the extracted code is relicensed to
**Apache-2.0**, and the package is **`finite_state_language`** (OTP app `:fsl`,
modules `FSL.*`).

The governing idea, should you read only one thing: the context belongs to FSL
and a *protocol binding* extends it. SIP is the first binding; the test of every
seam is whether a second one — XMPP, Matrix, a chatbot framework — could be
written without touching FSL.

Until the extraction happens, the reference implementation of FSL-Elixir **is**
Elixip's DSL: the language reference is
[FSL.md](https://github.com/neutrino38/elixip/blob/master/FSL.md) and its
as-built design is
[DESIGN-FSL.md](https://github.com/neutrino38/elixip/blob/master/docs/design/DESIGN-FSL.md).
