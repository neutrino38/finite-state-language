defmodule FSL.Loader do
  @moduledoc """
  Locate and load scenario modules, for the `mix scenario` task and the
  `elixipp` escript.
  """

  @doc """
  Compile a scenario `.exs` file and return the scenario module it defines
  (the one created by `use FSL.Machine`). Raises if none is found.
  """
  @spec load_file!(Path.t()) :: module()
  def load_file!(path) do
    path
    |> Code.compile_file()
    |> Enum.map(&elem(&1, 0))
    |> Enum.find(&scenario_module?/1)
    |> case do
      nil -> raise "No scenario module (use FSL.Machine) found in #{path}"
      module -> module
    end
  end

  @doc """
  Resolve a scenario module from its name (e.g. `"UAC.Invite"`), assuming it is
  already compiled / bundled. Raises if it is not a scenario module.
  """
  @spec load_module!(String.t()) :: module()
  def load_module!(name) do
    module = Module.concat([name])

    cond do
      not Code.ensure_loaded?(module) -> raise "Module #{name} is not available"
      not scenario_module?(module) -> raise "Module #{name} is not a FSL.Machine"
      true -> module
    end
  end

  @doc """
  The **opaque** kind `module` declared, or `nil`.

  FSL keeps the slot and has no opinion about what goes in it: the vocabulary is
  the binding's — SIP writes `:uac`, `:uas_register`, `:uas_invite` from its own
  `uas/1` macro — and so is the reading of a machine that declared nothing. SIP
  reads `nil` as `:uac`, in `SIP.Scenario.Loader`, because a default role is a
  statement about a protocol.

  `nil` for a module that has no `__scenario_type__/0` at all, which is both a
  module that is not a machine and one compiled before its binding grew an
  annotation.
  """
  @spec scenario_type(module()) :: term() | nil
  def scenario_type(module) do
    if Code.ensure_loaded?(module) and function_exported?(module, :__scenario_type__, 0),
      do: module.__scenario_type__(),
      else: nil
  end

  # A service building block is FSL too — same states, same on_events — so the
  # `__scenario_states__/0` half matches one. It is excluded on `__sbb__/0`
  # rather than only on the absence of `run/1`: a block does not define run/1,
  # which already makes this impossible, but `load_file!/1` takes the FIRST
  # match in a file, so a block declared above the scenario would be run AS the
  # scenario if that ever changed. Two guards for one trap, deliberately.
  defp scenario_module?(module) do
    Code.ensure_loaded?(module) and
      not function_exported?(module, :__sbb__, 0) and
      function_exported?(module, :run, 1) and
      function_exported?(module, :__scenario_states__, 0)
  end
end
