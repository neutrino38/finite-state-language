defmodule FSL.Loader do
  @moduledoc """
  Finds the machine a caller asked for, by module name or by file path.

  A tool that runs machines — a mix task, a CLI, a server loading scripts from a
  directory — needs to turn what a user typed into a module it can run. There are
  two ways to have a machine, and this module covers both:

    * **compiled into the application**, and named. `load_module!/1` resolves
      `"Fishing.Trip"` to `Fishing.Trip`;
    * **written in an `.exs` file**, loaded at run time. `load_file!/1` compiles
      the file and returns the machine it defines.

  The second is why FSL is careful about names: a file compiled at run time gives
  no compiler the chance to catch a rename, so a machine that has been deployed
  keeps working only if the names it uses still exist.

  ## What counts as a machine

  A module that exports `run/1` and `__scenario_states__/0`, which is what
  `use FSL.Machine` generates — and that is **not** a service building block,
  which `use FSL.Block` marks. A file may define both; `load_file!/1` returns the
  machine even when a block is declared above it.

  ## Example

      iex> FSL.Loader.load_file!("samples/fishing.exs")
      Fishing.Trip
  """

  @doc """
  Compile an `.exs` file and return the machine it defines.

  Raises if the file defines no machine. When it defines several, the first is
  returned; when it defines a service building block as well, the block is
  skipped whatever the order.
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
  Resolve an already-compiled machine from its name.

      FSL.Loader.load_module!("Fishing.Trip")

  Raises if no module answers to that name, and again if the module that does is
  not a machine.
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
  The kind this machine declared, or `nil`.

  FSL provides the slot and attaches no meaning to it. What may go in it, and
  what an absent value means, belong to the application: a tool that runs
  machines uses this to decide how to run one — whether it needs a listening
  port, say, or which factory should create it.

  A machine writes the slot through an annotation its own embedding supplies:

      defmodule Fishing.Competition do
        use FSL.Machine, host: Fishing.Host
        @scenario_type :timed
        # …
      end

  Returns `nil` for a machine that declared nothing, and for any module that is
  not a machine. An application that wants a default applies it on its own side,
  where it means something.

  In the SIP embedding, `uas :register` writes `:uas_register` and the tool reads
  it to decide between running a client scenario and listening for inbound
  traffic; a scenario that declared nothing is read as a client.
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
  # match in a file, so a block declared above the machine would be run AS the
  # machine if that ever changed. Two guards for one trap, deliberately.
  defp scenario_module?(module) do
    Code.ensure_loaded?(module) and
      not function_exported?(module, :__sbb__, 0) and
      function_exported?(module, :run, 1) and
      function_exported?(module, :__scenario_states__, 0)
  end
end
