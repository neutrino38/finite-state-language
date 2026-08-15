# FSL for Elixir — reserved

This directory is reserved for the Elixir implementation of FSL: the
scenario DSL currently living inside
[Elixip](https://github.com/neutrino38/elixip)
(`apps/elixip2/lib/dsl/SIPScenario.ex` and friends), to be extracted here as
a standalone hex package — generic states / transitions / `on_events` /
sub-FSM / cooperative shutdown / `Valet` / the scenario Monitor — with the
SIP-specific parts staying in Elixip, plugged in through extension points.

The extraction analysis (couplings identified, seams to cut along) is
tracked on the Elixip side; see also `improve-fsl-elixir.md` in
`elixip/docs/design/` for DSL features (`stay`, `goto back`) already
designed for parity with the TypeScript implementation.

Until the extraction happens, the reference implementation of FSL-Elixir
**is** Elixip's DSL, documented in
[Elixip's DSL.md](https://github.com/neutrino38/elixip/blob/master/DSL.md).
