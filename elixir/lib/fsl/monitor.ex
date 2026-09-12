defmodule FSL.Monitor do
  @moduledoc """
  A live registry of the machines currently running: one row each, updated as
  they move.

  It exists so that a running system can be watched from outside — a terminal
  table, a web view, a control command — without polling the machines
  themselves or instrumenting them by hand. A row is created the first time a
  machine reports, and recycled when its slot is cleared.

  The registry is optional and **inert until started**. Every reporting helper
  checks whether it is running and returns immediately if it is not, so a
  production run that does not want it pays nothing.

  ## A row

  | Column | Holds |
  |---|---|
  | `scenario` | the machine's module name |
  | `state` | the state it is in now |
  | `event` | what caused the last transition |
  | `event_type` | that event's category, from `c:FSL.Host.event_type/1` |
  | `command` | the last command the machine issued |
  | `command_type` | that command's category |
  | `account` | who the run is about, from `c:FSL.Host.account/2` |
  | `slot` | the key the row is filed under |
  | `depth` | 0 for a machine, 1 for a sub-FSM below its parent |

  Rows are keyed by **slot id**: an integer when a caller manages numbered slots,
  `{parent_slot, name}` for a machine started with `spawn_fsm`, and the machine's
  pid otherwise. Clearing a parent's slot clears its children's rows too.

  ## Columns an application adds

  The columns above are the machine's. An application that wants more declares
  them, with their defaults, when it starts the registry:

      FSL.Monitor.start(columns: [medias: "n/a", server: "none"])

  and writes them with `note/2`:

      FSL.Monitor.note(:medias, "AV")

  The registry never learns what those keys mean. Defaults are worth choosing:
  `"n/a"` states that this run negotiated nothing, where an empty string reads as
  "not measured yet".

  A row is **flat** — `row.medias`, not `row.extra.medias`. Consumers declare the
  columns they display by plain key, and a nested map would make every one of
  them aware of which half a column came from.

  ## Writing to it

  `FSL.Runner` reports every transition. The verbs an embedding supplies report
  their commands with `note_command/2`, which is what fills the `command` column;
  `c:FSL.Host.account/2` supplies the `account` column on every report.

  ## Reading it

  `calls/0` returns every row, ordered so that a sub-FSM follows its parent.

  For a live view, `subscribe/1` is better than polling: it returns the current
  snapshot **and** registers the caller for `{:fsl_monitor, {:updated, slot,
  row}}` on every change and `{:fsl_monitor, {:cleared, slot}}` when a slot is
  recycled. Subscribers are monitored, so one that dies is dropped without an
  `unsubscribe/1`. See `subscribe/1`.

  ## Example: what this looks like in a SIP application

  [Elixip](https://github.com/neutrino38/elixip) is one embedding of FSL, where a
  machine is a SIP scenario and a run is a call. Its host declares three columns
  of its own — the media the call negotiated, the media server it uses, and the
  destination it dialled — and its session verbs report commands such as
  `send_INVITE`. A `kelixip` server joins these rows with its own, and serves the
  result over a control API so an operator sees, live, which call is in which
  state and what moved it there.
  """

  use GenServer

  @typedoc """
  The category of a command or an event.

  FSL sets `:scenario` and `:control` for its own vocabulary; every other value
  comes from `c:FSL.Host.event_type/1` or from whatever an embedding passes to
  `note_command/2`. The atoms below are the ones a SIP application uses, listed
  as an illustration rather than as a closed set: any atom is valid, and
  `FSL.Diagram` draws an unfamiliar one as coming from the peer.
  """
  @type command_type :: :sip | :media | :http | :db | :scenario | :control | atom() | nil

  @typedoc """
  One row: the machine's own columns, plus whatever the embedding declared.
  """
  @type call_info :: %{required(atom()) => term()}

  # The machine's own columns. An embedding's are merged on top, from what it
  # declared at start.
  #
  # `account` is on this list and an embedding's columns are not, and the line
  # between them is which side asks the question. "Who is this run about" is a
  # question every embedding has, so the column is generic even though only the
  # embedding can answer it (`c:FSL.Host.account/2`). What a call negotiated,
  # with which server, towards whom, is a question only a telephony application
  # asks — so both the question and the answer are its own.
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
  Start the registry **unlinked**, for a caller that decides at run time that it
  wants one — a CLI given a `--monitor` flag, for instance. Idempotent: an
  already-running registry is reused, and its columns are the ones declared by
  whoever started it first.

  A supervised owner should use `start_link/1` instead.

  ## Options

    * `:columns` — the columns this application adds, as a keyword list of
      `name: default`. See the moduledoc.
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
  Start the registry under a supervisor. Takes the same options as `start/1`.

      children = [
        {FSL.Monitor, columns: [medias: "n/a", server: "none"]},
        # …
      ]
  """
  @spec start_link(keyword) :: GenServer.on_start()
  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @doc """
  Record where a machine is now. Called by `FSL.Runner` on every transition; an
  embedding does not normally call it.

  `call_id` is the slot the row is filed under. An empty `username` leaves the
  `account` column as it was, which is how a run that named itself once is not
  overwritten by every later transition.
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
  Set the `account` column of the current machine's row.

  For a run that learns who it is about only once it is under way — after an
  identity is verified, or once it knows which conversation it joined. Reported
  values from `c:FSL.Host.account/2` will not overwrite it as long as that
  callback answers `""` afterwards.

  No-op if the registry is not running.
  """
  @spec note_account(String.t()) :: :ok
  def note_account(username), do: note(:account, to_string(username))

  @doc """
  Record the last command the current machine issued, with its category.

  This is what an embedding's verbs call, so that the `command` column shows what
  the machine last *did* rather than only where it is:

      def send_message(ctx, text) do
        FSL.Monitor.note_command(:chat, "send_message")
        # …
      end

  The category decides which lane the command is drawn on in a sequence diagram
  (`FSL.Diagram`). It also feeds `FSL.Journal`, so a command is recorded whether
  or not the registry is running.
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
  Every row, ordered so that a sub-FSM follows its parent.

  Each row carries its `:slot`, the key it was filed under, so that a caller that
  assigns those slots can join this view with records of its own — a server that
  keys its instances by id, for instance. A renderer that displays named columns
  ignores it.
  """
  @spec calls() :: [call_info()]
  def calls do
    GenServer.call(__MODULE__, :calls)
  end

  @doc """
  Remove a row so its slot is reused by the next machine that reports under it.
  Also removes the rows of any sub-FSMs filed beneath it.
  """
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
