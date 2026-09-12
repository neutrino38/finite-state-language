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
  a `debug` field.

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

  @typedoc "A recorded event, in chronological order once read back via `events/0`."
  @type event ::
          %{kind: :command, type: atom(), name: String.t()}
          | %{kind: :transition, to: atom() | String.t(), event: String.t(), type: atom() | nil}
          | %{
              kind: :terminal,
              outcome: :succeeded | :failed,
              reason: String.t(),
              type: atom() | nil
            }

  @type meta :: %{scenario: String.t(), pid: String.t(), config: keyword()}

  @doc "Start a journal in the current process with the given metadata."
  @spec start(meta()) :: :ok
  def start(meta) when is_map(meta) do
    Process.put(@meta_key, meta)
    Process.put(@journal_key, [])
    :ok
  end

  @doc "True when a journal is active in the current process."
  @spec enabled?() :: boolean()
  def enabled?, do: Process.get(@journal_key) != nil

  @doc "Record an outbound command, e.g. `record_command(:sip, \"send_INVITE\")`."
  @spec record_command(atom(), String.t() | atom()) :: :ok
  def record_command(type, name) do
    append(%{kind: :command, type: type, name: to_string(name)})
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

  @doc "Chronological list of recorded events (`[]` when disabled)."
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
  Render the PlantUML file and clear the journal from the process dictionary.

  Returns `{:ok, path}` on success, `:disabled` when no journal is active, or
  `{:error, reason}` if the file could not be written.
  """
  @spec flush() :: {:ok, String.t()} | :disabled | {:error, term()}
  def flush do
    case Process.get(@journal_key) do
      nil ->
        :disabled

      _ ->
        meta = Process.get(@meta_key)

        # The scenario's own host may name a renderer of its own; the default is
        # the PlantUML one this library ships (`c:FSL.Host.diagram_renderer/0`).
        renderer =
          FSL.Host.call(
            Process.get(:scenario_module),
            :diagram_renderer,
            [],
            FSL.Diagram.PlantUML
          )

        content = renderer.render(events(), meta)
        path = renderer.filename(meta)
        clear()

        case File.write(path, content) do
          :ok -> {:ok, path}
          {:error, reason} -> {:error, reason}
        end
    end
  end

  @doc "Drop the journal from the current process (used by `flush/0` and tests)."
  @spec clear() :: :ok
  def clear do
    Process.delete(@journal_key)
    Process.delete(@meta_key)
    :ok
  end

  # ── internals ──────────────────────────────────────────────────────────────

  # No-op when disabled, so callers (note_command / report) need no guard.
  defp append(event) do
    case Process.get(@journal_key) do
      nil -> :ok
      list -> Process.put(@journal_key, [event | list])
    end

    :ok
  end

  defp transition_event(state, event, type) when state in [:succeeded, :failed] do
    %{kind: :terminal, outcome: state, reason: event, type: type}
  end

  defp transition_event(state, event, type) do
    %{kind: :transition, to: state, event: event, type: type}
  end

  defp blank_to_string(nil), do: ""
  defp blank_to_string(value), do: to_string(value)
end
