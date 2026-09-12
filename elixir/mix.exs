defmodule FSL.MixProject do
  use Mix.Project

  # 0.2.0 and not 0.1.0, deliberately: the TypeScript sibling is at 0.2.0, and
  # what the two now share is the *contract* — the SBB return shape, the
  # vocabulary declared and refused, the block-level bound, `resume:`, the
  # inter-machine event names — reconciled clause by clause in
  # ../spec/fsl-js-ts.md §12. Two numbers for one language would tell a reader
  # that one half is a release behind, which is the thing this repository exists
  # to deny. Nothing was published as 0.1.x, so the jump costs nothing.
  @version "0.2.0"
  @source_url "https://github.com/neutrino38/finite-state-language"

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
      links: %{"GitHub" => @source_url},
      files: ~w(lib samples mix.exs README.md LICENSE NOTICE CHANGELOG.md docs),
      maintainers: ["Emmanuel Buu"]
    ]
  end

  defp docs do
    [
      main: "FSL.Machine",
      source_url: @source_url,
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
