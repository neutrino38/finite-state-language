defmodule FSL.Test.Host do
  @moduledoc """
  A host that is not a protocol: what FSL's own suite runs machines against, and
  the worked example the documentation needs — so it is written once and used
  twice (extraction plan §5.3).

  Everything it does, it does **observably**. Each hook appends to a list in
  `appdata` or sends a message to the process that asked for the machine, so a
  test can read back what the language asked of its embedding and in what order.
  That is the whole point: the suite here proves the *language*, with no stack to
  start and no protocol to speak, and it can only do that if the embedding is a
  thing it can watch.

  A test names it at `use` time:

      defmodule MyMachine do
        use FSL.Machine, host: FSL.Test.Host
        ...
      end

  and reads the trace back with `trace/1`.
  """
  @behaviour FSL.Host

  @trace_key :__fsl_test_trace__

  @doc "Everything the host was asked, oldest first."
  @spec trace(FSL.Context.t()) :: [term()]
  def trace(ctx), do: FSL.Context.appdata_get(ctx, @trace_key) || []

  defp note(ctx, entry),
    do: FSL.Context.appdata_set(ctx, @trace_key, trace(ctx) ++ [entry])

  # The process that asked for this machine, so a hook with no context to write
  # into can still be observed. Set by the test before `run_instance/2`.
  defp probe, do: Process.get(:fsl_test_probe)

  defp tell(msg) do
    if pid = probe(), do: send(pid, {:fsl_test_host, msg})
    :ok
  end

  @impl true
  def bootstrap do
    tell(:bootstrap)
    :ok
  end

  @doc """
  The `config` block goes to appdata, like the default host — this one is about
  observing the language, not about modelling a protocol.
  """
  @impl true
  def build_context(config) do
    Enum.reduce(config, %FSL.Context{}, fn {key, value}, ctx ->
      FSL.Context.appdata_set(ctx, key, value)
    end)
    |> note({:build_context, config})
  end

  @impl true
  def apply_run_opts(ctx, opts), do: note(ctx, {:apply_run_opts, opts})

  @impl true
  def on_event(ctx, event), do: note(ctx, {:on_event, event})

  @impl true
  def on_state_enter(ctx), do: note(ctx, :on_state_enter)

  @doc """
  A fixed map, so a test can assert that a type the language has no table entry
  for reaches the diagram and the monitor unchanged.
  """
  @impl true
  def event_type(:knock), do: :door
  def event_type(:tick), do: :timer
  def event_type(_element), do: nil

  @doc """
  One clause in every wait: this host's own failure domain. `{:door, :slammed}`
  is to it what a media server going away is to SIP — an event delivered to
  every sink that nothing would otherwise act on.
  """
  @impl true
  def injected_clauses(ctx) do
    [
      {:door_slammed,
       quote do
         {:door, :slammed} ->
           {:goto, :__shutdown__, "door slammed", :door, unquote(ctx)}
       end
       |> hd()}
    ]
  end

  @impl true
  def clause_covers?(:door_slammed, {:door, _any}), do: true
  def clause_covers?(_name, _pattern), do: false

  @impl true
  def account(_ctx, :initial), do: "test"
  def account(_ctx, :subsequent), do: ""

  @impl true
  def spawn_child(kind, pid) do
    tell({:spawn_child, kind, pid})
    :ok
  end

  @impl true
  def finalize(ctx) do
    tell(:finalize)
    note(ctx, :finalize)
  end
end
