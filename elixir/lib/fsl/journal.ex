defmodule FSL.Journal do
  @moduledoc """
  Records one run, so that it can be drawn afterwards.

  A journal holds, in order: every command the machine issued, every state it
  moved through, and how it ended. `FSL.Runner` flushes it through a renderer
  (`FSL.Diagram`) when the run finishes, which produces a sequence diagram of
  that particular run.

  ## Turning it on

  Off by default, and inert when off: every recording helper returns immediately
  if no journal has been started, so a production run pays nothing.

      config :fsl, :log_sequence, true

  An application that keeps its settings in one namespace of its own names it
  instead, and the flag is read there:

      config :fsl, :log_sequence_app, :my_app
      config :my_app, :log_sequence, true

  A single machine can also turn it on for itself, if its embedding's context has
  a `debug` field. `FSL.Runner` asks again after every state, so a flag set in
  the middle of a run starts the journal at the transition that follows.

  ## Turning it on in a live run

  A machine waiting in `on_events` is told from outside:

      send(pid, {:scenario_ctl, :journal, :on})   # journal from now on
      send(pid, {:scenario_ctl, :journal, :off})  # write it out now

  Every `on_events` carries a clause for this message, like the one for
  `{:scenario_ctl, :shutdown, reason}`, and the wait resumes afterwards with the
  time it had left: the machine does not see it. `:on` opens the diagram with a
  note naming the state it was in; `:off` renders and hands the document over
  at once, and the run goes on untraced: a run has one journal, so none starts
  again — not by `:on`, not by the `debug` field, which `:off` lowers, nor by
  `:log_sequence`. A run that ends with its journal on
  flushes it as usual. A machine outside an `on_events` sees the message at its
  next wait.

  ## Where the document goes

  To a file named by the renderer, in the working directory — unless the host
  answers `c:FSL.Host.journal_output/3`, which receives the document and decides.
  A server that keeps diagrams in memory for an operator does it there.

  ## Time

  Every event carries `:at`, the monotonic time it was recorded in
  microseconds, and the metadata carries `:t0`, the time the journal started.
  The renderers draw `+Nms` from the two; the order of events recorded by
  different processes is decided by `:at` alone.

  ## Events recorded elsewhere

  Some of what a run does never passes through the machine's process — a
  protocol message sent by a transaction the binding runs, for instance. A
  binding that records such events keeps them itself and answers two optional
  callbacks: `c:FSL.Host.journal_started/1`, called in the machine's process
  when the journal starts, and `c:FSL.Host.journal_collect/0`, which hands them
  over at `flush/0`. They are merged with the journal's own events by `:at`.
  An event the binding built in the machine's process goes in directly with
  `record/1`.

  ## Where it lives

  In the **process dictionary of the machine's own process** — the same process
  that runs the states, issues the commands and reports the transitions. Two
  consequences follow, and both are the reason for the choice: a journal is
  isolated per run without a registry or any message passing, and it disappears
  with the process that owns it.
  """
  require Logger

  @journal_key :scenario_sequence_journal
  @meta_key :scenario_sequence_meta

  @typedoc """
  A recorded event, in chronological order once read back via `events/0`.
  `:message` events are built by a binding (see `FSL.Diagram` for their shape).
  """
  @type event ::
          %{kind: :command, at: integer(), type: atom(), name: String.t()}
          | %{
              kind: :transition,
              at: integer(),
              to: atom() | String.t(),
              event: String.t(),
              type: atom() | nil
            }
          | %{
              kind: :terminal,
              at: integer(),
              outcome: :succeeded | :failed,
              reason: String.t(),
              type: atom() | nil
            }
          | %{:kind => :message, :at => integer(), optional(atom()) => term()}

  @typedoc """
  `:t0` is the monotonic time the journal started, the diagram's origin. `:slot`
  is the `:slot_id` the run was started with, `nil` when none. `:joined_in` is
  the state the run was in when the journal started after its beginning, `nil`
  when it started with the run.
  """
  @type meta :: %{
          scenario: String.t(),
          pid: String.t(),
          slot: term(),
          joined_in: atom() | nil,
          config: keyword(),
          t0: integer()
        }

  @doc """
  Start a journal in the current process with the given metadata. `:t0` is
  added to it.
  """
  @spec start(map()) :: :ok
  def start(meta) when is_map(meta) do
    Process.put(@meta_key, Map.put(meta, :t0, now()))
    Process.put(@journal_key, [])
    :ok
  end

  @doc "True when a journal is active in the current process."
  @spec enabled?() :: boolean()
  def enabled?, do: Process.get(@journal_key) != nil

  @doc "Record an outbound command, e.g. `record_command(:sip, \"send_INVITE\")`."
  @spec record_command(atom(), String.t() | atom()) :: :ok
  def record_command(type, name) do
    append(%{kind: :command, at: now(), type: type, name: to_string(name)})
  end

  @doc """
  Record a state report. `state` is the target state name, or `:succeeded` /
  `:failed` for a terminal; `event` is the (already stringified) triggering
  description and `type` its category (`:sip`, `:media`, …).
  """
  @spec record_transition(atom(), String.t(), atom() | nil) :: :ok
  def record_transition(state, event, type) do
    append(transition_event(state, blank_to_string(event), type))
  end

  @doc """
  Record an event a binding built — a `:message`, typically. `:at` is stamped
  when the event has none. A no-op when no journal is active.
  """
  @spec record(map()) :: :ok
  def record(%{kind: _} = event), do: append(Map.put_new_lazy(event, :at, &now/0))

  @doc """
  Chronological list of the events recorded in this process (`[]` when
  disabled). Events a binding recorded elsewhere are not in it: they join at
  `flush/0`.
  """
  @spec events() :: [event()]
  def events do
    case Process.get(@journal_key) do
      nil -> []
      list -> Enum.reverse(list)
    end
  end

  @doc "Metadata stored at `start/1` (`nil` when disabled)."
  @spec meta() :: meta() | nil
  def meta, do: Process.get(@meta_key)

  @doc """
  Render the diagram and clear the journal from the process dictionary.

  The document goes where `c:FSL.Host.journal_output/3` says, or to a file named
  by the renderer in the working directory when the host has no opinion.

  The events the host recorded outside this process (`c:FSL.Host.journal_collect/0`)
  are merged in first, ordered by `:at`.

  Returns `{:ok, where}` on success — the file path, or whatever the host
  answered — `:disabled` when no journal is active, or `{:error, reason}`.
  """
  @spec flush() :: {:ok, term()} | :disabled | {:error, term()}
  def flush do
    case Process.get(@journal_key) do
      nil ->
        :disabled

      _ ->
        meta = Process.get(@meta_key)
        module = Process.get(:scenario_module)
        events = Enum.sort_by(events() ++ collect(module), &Map.get(&1, :at, 0))

        # The scenario's own host may name a renderer of its own; the default is
        # the PlantUML one this library ships (`c:FSL.Host.diagram_renderer/0`).
        renderer =
          FSL.Host.call(module, :diagram_renderer, [], FSL.Diagram.PlantUML)

        content = renderer.render(events, meta)
        clear()

        # Where the document goes is the host's to say (c:FSL.Host.journal_output/3);
        # a file named by the renderer, in the working directory, by default.
        case FSL.Host.call(module, :journal_output, [content, meta, renderer], :default) do
          :default -> write_file(renderer.filename(meta), content)
          {:ok, where} -> {:ok, where}
          {:error, reason} -> {:error, reason}
        end
    end
  end

  @doc """
  Drop the journal from the current process (used by `flush/0` and tests).
  What the host recorded elsewhere is collected and dropped with it, so a run
  that ends without a flush leaves nothing behind in the binding's store.
  """
  @spec clear() :: :ok
  def clear do
    if enabled?(), do: collect(Process.get(:scenario_module))
    Process.delete(@journal_key)
    Process.delete(@meta_key)
    :ok
  end

  # ── internals ──────────────────────────────────────────────────────────────

  defp now, do: System.monotonic_time(:microsecond)

  defp write_file(path, content) do
    case File.write(path, content) do
      :ok -> {:ok, path}
      {:error, reason} -> {:error, reason}
    end
  end

  # No scenario module in the process (a journal started by hand, in a test):
  # no host to ask.
  defp collect(nil), do: []
  defp collect(module), do: FSL.Host.call(module, :journal_collect, [], [])

  # No-op when disabled, so callers (note_command / report) need no guard.
  defp append(event) do
    case Process.get(@journal_key) do
      nil -> :ok
      list -> Process.put(@journal_key, [event | list])
    end

    :ok
  end

  defp transition_event(state, event, type) when state in [:succeeded, :failed] do
    %{kind: :terminal, at: now(), outcome: state, reason: event, type: type}
  end

  defp transition_event(state, event, type) do
    %{kind: :transition, at: now(), to: state, event: event, type: type}
  end

  defp blank_to_string(nil), do: ""
  defp blank_to_string(value), do: to_string(value)
end
