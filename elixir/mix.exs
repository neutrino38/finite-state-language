defmodule FSL.MixProject do
  use Mix.Project

  # One language, two packages: this one and the npm package
  # `finite-state-language` share a *contract* — the SBB return shape, the
  # vocabulary declared and refused, the block-level bound, `resume:`, the
  # inter-machine event names — reconciled clause by clause in
  # ../spec/fsl-js-ts.md §12. So this package opened at 0.2.0, matching the
  # sibling, and a version of the contract is a version both packages carry.
  #
  # The number follows the contract, not every release: what does not touch the
  # contract is released here without waiting for the sibling. A fix is a PATCH —
  # 0.2.1 is one, a rule of Elixir about `rescue` and the stack, which the
  # TypeScript implementation cannot have. A feature the contract names is taken
  # by both packages together, at the same number — 0.3.0 is one: the trace of a
  # run and its sequence diagram, spec §6.2, with the mechanisms that differ
  # recorded in §12.4b. A feature of this implementation alone is a MINOR here,
  # and the sibling skips that number rather than reuse it — 0.4.0 is one:
  # turning the journal on in a live run, and `c:FSL.Host.journal_output/3`.
  #
  # 0.4.1 is a PATCH that adds a callback, and that is a ruling, not an oversight
  # (2026-09-28): `c:FSL.Host.journal_events/2` completes 0.4.0's hand-off of a
  # finished journal rather than opening a feature of its own — the same moment,
  # the same host, handed the events instead of a document — and it is optional,
  # so no binding written against 0.4.0 changes behaviour.
  #
  # 0.5.0 is a MINOR of this implementation alone: `run_instance/2` starts a
  # machine at a named state (`:start_state`), for a binding that sets a run's
  # context aside and restores it later.
  @version "0.5.0"
  @source_url "https://framagit.org/elixip/finite-state-language"

  def project do
    [
      # Three names for one thing, and each is the right one where it is used:
      # `finite_state_language` is the hex package — what a `mix.exs` line
      # carries and what is indexed and searched, matching the repository and
      # the npm package `finite-state-language`; `:fsl` is the OTP application
      # the runtime starts; `FSL.*` is what the code writes. Decided 2026-09-12
      # (extraction plan §8.2).
      app: :fsl,
      version: @version,
      elixir: "~> 1.15",
      start_permanent: Mix.env() == :prod,
      elixirc_paths: elixirc_paths(Mix.env()),
      deps: deps(),
      package: package(),
      description:
        "The Finite State Language: describe a process as a finite state machine, " <>
          "and plug a protocol into it.",
      docs: docs()
    ]
  end

  def application do
    [extra_applications: [:logger]]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  defp deps do
    [
      # `optional: true`, and it is the promise the package makes: the core — the
      # engine, the monitor, the journal, the renderer — needs nothing but Logger
      # and OTP. `FSL.HTTP` is the one module that needs a client, and its
      # `__using__` says so at compile time when Req is absent, rather than
      # dragging a dependency into every machine that never makes a request
      # (extraction plan §4.9).
      {:req, "~> 0.5", optional: true},
      {:ex_doc, "~> 0.34", only: :dev, runtime: false}
    ]
  end

  defp package do
    [
      name: "finite_state_language",
      # Apache-2.0, decided 2026-09-12 (extraction plan §8.1): the two
      # implementations of the language ship under one licence, and the SBoM a
      # consumer generates reads this key. The code was extracted from Elixip,
      # which stays BUSL-1.1 — a source-available work may depend on a
      # permissive one, and the extraction does not travel the other way.
      licenses: ["Apache-2.0"],
      links: %{"Framagit" => @source_url},
      # `docs/design.md` and not `docs`: `docs/extraction-plan.md` is the record
      # of how this package was lifted out of Elixip, which belongs in the
      # repository and not in the tarball a consumer unpacks.
      files: ~w(lib samples mix.exs README.md LICENSE NOTICE CHANGELOG.md docs/design.md),
      maintainers: ["Emmanuel Buu"]
    ]
  end

  defp docs do
    [
      main: "FSL.Machine",
      source_url: @source_url,
      # The repository holds two implementations of one language, so this
      # package lives under `elixir/` while `@source_url` names the repository
      # root. ex_doc cannot know that, and its default pattern would send every
      # "source" link on hexdocs to `blob/main/lib/fsl/...` — a 404 for each
      # function in the reference, and missing GitLab's `/-/` separator besides.
      # The pattern below restores both, and pins the links to the release tag,
      # so the code a reader lands on is the code that shipped in this version
      # rather than whatever `main` has become since.
      source_url_pattern: "#{@source_url}/-/blob/#{@version}/elixir/%{path}#L%{line}",
      # extraction-plan.md is deliberately NOT here: it is a historical document
      # whose links point into the sibling repositories, and ex_doc would lint it
      # as if it were reference material.
      extras: ["README.md", "samples/README.md", "CHANGELOG.md", "docs/design.md"],
      groups_for_extras: ["Getting started": ["README.md", "samples/README.md"]],
      groups_for_modules: [
        "The language": [FSL.Machine, FSL.Block, FSL.Context],
        "The engine": [FSL.Runner, FSL.Loader, FSL.Child],
        "The embedding": [FSL.Host, FSL.Host.Default],
        Instrumentation: [
          FSL.Monitor,
          FSL.Journal,
          FSL.Diagram,
          FSL.Diagram.PlantUML,
          FSL.Diagram.Mermaid
        ],
        Utilities: [FSL.Valet, FSL.HTTP]
      ]
    ]
  end
end
