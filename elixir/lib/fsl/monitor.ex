defmodule FSL.Monitor do
  @moduledoc """
  In-memory registry of the scenario instances ("calls") currently running, used
  by the `elixipp --monitor` live view.

  One entry per call, keyed by the scenario slot id (an integer for a CLI slot,
  `{parent_slot, name}` for a `spawn_fsm` child, the scenario process pid
  otherwise). Each entry holds the scenario name, the last command sent (e.g.
  `send_INVITE`), the current FSM state and the event that triggered the last
  transition. A sub-FSM gets its own row, displayed right below its parent.

  Both `FSL.Runner` (state transitions) and the `SIP.Session.*` send_*
  macros (commands) report here, but **only when the monitor is started** — the
  reporting helpers are a no-op otherwise, so there is zero overhead when
  monitoring is off.

  Designed to hold several concurrent calls — today a single instance, tomorrow
  the SIPP-like parallel mode.

  ## Whose columns are whose

  `scenario`, `state`, `event`, `event_type`, `command` and `command_type` are
  the machine's: where it is and what moved it. So is `account` — "who this run
  serves" is a generic column, even though only the embedding can say what goes
  in it (`c:FSL.Host.account/2`). Everything else on a row belongs to the
  **embedding**, which declares its columns and their defaults when it starts
  the monitor:

      FSL.Monitor.start(columns: SIP.FSL.Host.monitor_columns())

  and writes one with `note/2`. The registry never learns which keys are which,
  and the row **stays flat** — `row.medias`, not `row.extra.medias`. That is the
  decision of the extraction plan (§4.7, §8.4) and it is not about tidiness: flat
  rows are the only shape under which `ElixippCLI`, which declares its table by
  plain key, and `Kelix.InstancePool`, which declares its key list the same way,
  do not change when this module moves into a package.

  A host's defaults travel with its columns, because they mean something:
  `"n/a"` and `"none"` say "this call negotiated nothing", where a blank cell
  would read as "nobody measured".

  A pid can also `subscribe/1` to be told of changes as they happen instead of
  polling `calls/0` — `{:fsl_monitor, {:updated, slot, row}}` after every
  reported change, `{:fsl_monitor, {:cleared, slot}}` when a slot (and any
  sub-FSM children) is cleared.

  `subscribe/1` **returns the snapshot**, taken inside the call that registers
  the subscriber, and the subscriber is **monitored** so a dead one is dropped
  without an `unsubscribe/1`. Both matter for the same reason: subscribing is the
  normal way to use this, so neither a lost first row nor a set that only grows
  is acceptable. See `subscribe/1` for what each one prevents.
  """
  use GenServer

  @typedoc "Category of a command, to drive the future sequence diagram."
  @type command_type :: :sip | :media | :http | :db | :scenario | :control | nil

  @typedoc """
  One row: the machine's own columns, plus whatever the embedding declared.
  """
  @type call_info :: %{required(atom()) => term()}

  # The machine's own columns. A host's are merged on top, from what it declared
  # at start.
  #
  # `account` is on this list and the other three are not, which is the
  # distinction the extraction plan draws (§4.7): "who this run serves" is a
  # generic column whose *value* the binding supplies — through `c:account/2`,
  # reported on every transition — while what a call negotiated, with which
  # server, towards whom is the binding's question as well as its answer.
  @fsm_columns [
    scenario: "",
    account: "",
    command: "",
    command_type: nil,
    state: "",
    event: "",
    event_type: nil
  ]

  @fsm_keys Keyword.keys(@fsm_columns)

  # ── Public API ──────────────────────────────────────────────────────────────

  @doc """
  Start the monitor **unlinked** (idempotent — reuses an already-running instance).

  This is elixipp's imperative bootstrap, called from the CLI once it knows
  `--monitor` was asked for. A supervised owner wants `start_link/1` instead.
  """
  @spec start(keyword) :: {:ok, pid()}
  def start(opts \\ []) do
    case GenServer.start(__MODULE__, opts, name: __MODULE__) do
      {:ok, pid} -> {:ok, pid}
      {:error, {:already_started, pid}} -> {:ok, pid}
      err -> err
    end
  end

  @doc """
  Start the monitor under a supervisor — how the kelixip server runs it, so
  `kelictl monitor` has FSM state to report (the `use GenServer` default
  `child_spec/1` calls this).
  """
  @spec start_link(keyword) :: GenServer.on_start()
  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc """
  Upsert the state of a call. `call_id` is the scenario process pid. `event_type`
  categorizes the triggering event (`:sip`, `:media`, `:timer`, …) — stored for
  the future sequence diagram, mirroring `command_type`.
  """
  @spec report(pid(), String.t(), String.t(), String.t(), String.t(), command_type()) :: :ok
  def report(call_id, scenario, username, state, event, event_type \\ nil) do
    GenServer.cast(__MODULE__, {:report, call_id, scenario, username, state, event, event_type})
  end

  @doc """
  Write one of the embedding's own columns on the current scenario's row.

  The registry does not know what the key means — that is the point — so a host
  adds a column by declaring it at start and writing it here. No-op if the
  monitor is not running, so it stays free when monitoring is off.
  """
  @spec note(atom(), term()) :: :ok
  def note(key, value) when is_atom(key) do
    if Process.whereis(__MODULE__) do
      slot_id = Process.get(:scenario_slot_id, self())
      GenServer.cast(__MODULE__, {:put, slot_id, key, value})
    end

    :ok
  end

  @doc """
  Update the account column of the current scenario row. Called when the
  registered identity becomes known (e.g. after auth succeeds in a UAS
  REGISTER scenario). No-op if the monitor is not running.
  """
  @spec note_account(String.t()) :: :ok
  def note_account(username), do: note(:account, to_string(username))

  @doc """
  Record the last command issued by the current scenario process, with its
  category (`:sip`, `:media`, `:http`, `:db`, …). Called by the instrumented
  `SIP.Session.*` macros. The category is stored to drive the future sequence
  diagram (knowing whether a command targets the SIP peer, the media server, …).

  No-op if the monitor is not running, so it stays free when `--monitor` is off.
  """
  @spec note_command(command_type(), String.t() | atom()) :: :ok
  def note_command(type, command) when is_atom(type) do
    if Process.whereis(__MODULE__) do
      # Use the stable slot_id set by the CLI duration loop so that successive
      # runs of the same logical slot recycle the same monitor row.
      slot_id = Process.get(:scenario_slot_id, self())
      GenServer.cast(__MODULE__, {:command, slot_id, type, to_string(command)})
    end

    # Feed the PlantUML sequence journal (no-op when not enabled in this process).
    FSL.Journal.record_command(type, command)

    :ok
  end

  @doc """
  Snapshot of all calls (one map per call), ordered by appearance.

  Each row carries its `:slot` — the key it was reported under — so a caller that
  owns those slots can join this view with its own (kelixip keys them on the
  instance id, see `Kelix.Control.monitor/0`). Renderers that build from named
  columns simply ignore it.
  """
  @spec calls() :: [call_info()]
  def calls do
    GenServer.call(__MODULE__, :calls)
  end

  @doc "Remove a slot entry so its row is recycled by the next call on that slot."
  @spec clear(term()) :: :ok
  def clear(slot_id) do
    if Process.whereis(__MODULE__) do
      GenServer.cast(__MODULE__, {:clear, slot_id})
    end

    :ok
  end

  @doc """
  Subscribe `pid` to call changes and **return the snapshot** — the same rows
  `calls/0` would give, taken inside the call that registers the subscriber.

  Returning it is the contract and not a convenience. A subscriber needs both:
  the rows that already exist, and the changes from now on. Taking them in two
  calls leaves a window, and only one order of the two is even survivable —
  subscribe first, then snapshot, so a change landing in between arrives as a
  push *and* in the snapshot, a duplicate `upsert` that is idempotent and
  harmless. Snapshot-first loses it outright, and the row then stays stale until
  the call happens to change again. That reads like a tidying opportunity and it
  is a data-loss bug, so the window is removed rather than documented.

  `pid` is **monitored**: a subscriber that dies is dropped, with no
  `unsubscribe/1` needed. In a library that matters more than it did in one
  application — subscribing is the normal way to use this, and a `MapSet` that
  only ever grows means every later change `send/2`s into the void.
  """
  @spec subscribe(pid()) :: [call_info()]
  def subscribe(pid), do: GenServer.call(__MODULE__, {:subscribe, pid})

  @doc """
  Stop a subscription. Rarely needed — a subscriber that dies is dropped on its
  own — and there for a process that stops caring without stopping.
  """
  @spec unsubscribe(pid()) :: :ok
  def unsubscribe(pid), do: GenServer.call(__MODULE__, {:unsubscribe, pid})

  # ── Server ──────────────────────────────────────────────────────────────────

  @impl true
  def init(opts) do
    # The embedding's columns and their defaults, merged onto a new row. The
    # registry stores them and never reads them.
    columns = opts |> Keyword.get(:columns, []) |> Map.new()

    # `subs`: subscriber pid => the monitor reference held on it, so a dead
    # subscriber can be dropped from a `:DOWN` that only names the ref.
    {:ok, %{calls: %{}, seq: 0, subs: %{}, columns: columns}}
  end

  @impl true
  # Registering and snapshotting in ONE call is the whole point: there is no
  # window for a change to fall into. Re-subscribing an already-subscribed pid
  # keeps its existing monitor rather than taking a second one.
  def handle_call({:subscribe, pid}, _from, st) do
    subs =
      if Map.has_key?(st.subs, pid),
        do: st.subs,
        else: Map.put(st.subs, pid, Process.monitor(pid))

    {:reply, snapshot(st), %{st | subs: subs}}
  end

  def handle_call({:unsubscribe, pid}, _from, st) do
    case Map.pop(st.subs, pid) do
      {nil, _subs} ->
        {:reply, :ok, st}

      {ref, subs} ->
        Process.demonitor(ref, [:flush])
        {:reply, :ok, %{st | subs: subs}}
    end
  end

  def handle_call(:calls, _from, st), do: {:reply, snapshot(st), st}

  @impl true
  def handle_cast({:report, call_id, scenario, username, state, event, event_type}, st) do
    fields = %{
      scenario: to_string(scenario),
      state: to_string(state),
      event: to_string(event),
      event_type: event_type
    }

    # Only overwrite account when the caller provides a non-empty username;
    # otherwise preserve a value set earlier by note_account/1 (e.g. UAS scenarios
    # whose context has no local identity but learned the account after auth).
    fields =
      case to_string(username) do
        "" -> fields
        u -> Map.put(fields, :account, u)
      end

    update(st, call_id, fields)
  end

  @impl true
  # Clearing a slot also removes the rows of its sub-FSMs (keyed
  # {parent_slot, name}, possibly nested), so a recycled slot starts clean.
  def handle_cast({:clear, slot_id}, st) do
    calls =
      st.calls
      |> Enum.reject(fn {call_id, _entry} -> root_slot(call_id) == slot_id end)
      |> Map.new()

    notify(st, {:cleared, slot_id})
    {:noreply, %{st | calls: calls}}
  end

  @impl true
  def handle_cast({:put, call_id, key, value}, st) do
    update(st, call_id, %{key => value})
  end

  @impl true
  def handle_cast({:command, call_id, type, command}, st) do
    update(st, call_id, %{command: command, command_type: type})
  end

  # The public shape of one entry (see `calls/0`): the machine's columns, the
  # embedding's, and `:depth` (tree nesting) plus `:slot` (the key it was
  # reported under). Flat, deliberately: see the moduledoc.
  defp row(entry, columns) do
    entry
    |> Map.take(@fsm_keys ++ Map.keys(columns))
    |> Map.put(:depth, length(entry.idx) - 1)
    |> Map.put(:slot, entry.slot)
  end

  # Merge `fields` into the entry for `call_id`, creating it (with a monotonic
  # display index) if it does not exist yet.
  defp update(st, call_id, fields) do
    {base, seq} =
      case Map.fetch(st.calls, call_id) do
        :error ->
          fresh =
            @fsm_columns
            |> Map.new()
            |> Map.merge(st.columns)
            |> Map.put(:idx, index_for(st, call_id))
            |> Map.put(:slot, call_id)

          {fresh, st.seq + 1}

        {:ok, existing} ->
          {existing, st.seq}
      end

    entry = Map.merge(base, fields)
    st = %{st | calls: Map.put(st.calls, call_id, entry), seq: seq}
    notify(st, {:updated, call_id, row(entry, st.columns)})
    {:noreply, st}
  end

  @impl true
  # A subscriber that died. Dropped here rather than left in the set until an
  # explicit `unsubscribe/1` that is never coming.
  def handle_info({:DOWN, ref, :process, pid, _reason}, st) do
    case Map.fetch(st.subs, pid) do
      {:ok, ^ref} -> {:noreply, %{st | subs: Map.delete(st.subs, pid)}}
      _other -> {:noreply, st}
    end
  end

  def handle_info(_msg, st), do: {:noreply, st}

  defp snapshot(st),
    do: st.calls |> Map.values() |> Enum.sort_by(& &1.idx) |> Enum.map(&row(&1, st.columns))

  defp notify(st, msg) do
    for {pid, _ref} <- st.subs, do: send(pid, {:fsl_monitor, msg})
    :ok
  end

  # Display index of a new entry, as a path so rows sort in tree order: a CLI
  # slot sorts on its number, a sub-FSM right below its parent, anything else
  # (e.g. a server-mode instance) in order of appearance.
  defp index_for(st, call_id) do
    case call_id do
      slot when is_integer(slot) ->
        [slot]

      {parent_slot, _name} ->
        case Map.fetch(st.calls, parent_slot) do
          {:ok, %{idx: parent_idx}} -> parent_idx ++ [st.seq]
          :error -> [st.seq]
        end

      _pid ->
        [st.seq]
    end
  end

  # Root CLI slot of a call id: {parent_slot, name} chains up to the slot that
  # spawned the whole family.
  defp root_slot({parent_slot, _name}), do: root_slot(parent_slot)
  defp root_slot(call_id), do: call_id
end
