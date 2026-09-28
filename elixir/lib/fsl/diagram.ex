defmodule FSL.Diagram do
  @moduledoc """
  What a renderer of `FSL.Journal` has to provide.

  Two functions, and the split between them is the useful part: `render/2` turns
  a run into a document and `filename/1` says what to call it, so the journal can
  write the file without knowing which dialect it is holding.

  Two renderers ship — `FSL.Diagram.PlantUML` and `FSL.Diagram.Mermaid` — and a
  binding names the one it wants with `c:FSL.Host.diagram_renderer/0`. Neither
  knows a protocol: the lane rule is **by exclusion**, so an event type the
  renderer has never heard of is drawn as coming from the peer rather than
  falling through to a self-note (see `FSL.Diagram.PlantUML` for the table).

  ## The event list

  Both callbacks are handed what `FSL.Journal` collected, oldest first:

      %{kind: :command,    at: integer(), type: atom() | nil, name: String.t()}
      %{kind: :transition, at: integer(), type: atom() | nil, to: term(), event: String.t()}
      %{kind: :terminal,   at: integer(), outcome: atom(),    reason: String.t()}
      %{kind: :message,    at: integer(), ...}   # see below

  and the run's metadata: `%{scenario: String.t(), pid: String.t(), config: keyword(), t0: integer()}`.

  `:at` and `:t0` are monotonic microseconds. A renderer prefixes a label with
  `+Nms` when both are present (`stamp/2`), and with nothing otherwise. An event
  of a kind a renderer does not know is skipped.

  ## `:message` — what actually went over the wire

  The first three kinds are what the machine *said* it did. A binding that can
  see the protocol messages themselves records them as `:message` events, built
  by the binding and handed over through `c:FSL.Host.journal_collect/0` or
  `FSL.Journal.record/1`:

      %{
        kind: :message,
        at: integer(),
        dir: :in | :out,
        lane: term(),              # the conversation it belongs to (SIP: the Call-ID)
        party: String.t() | nil,   # local label of that conversation (SIP: the leg tag)
        peer: String.t() | nil,    # the far end (SIP: "10.0.0.1:5060/udp")
        label: String.t(),         # drawn as is
        reply: boolean(),          # a reply: dashed
        repeat: boolean()          # a repetition: dimmed
      }

  Any other key is the binding's own and is ignored. The renderer knows nothing
  of the protocol: the binding decides what a label says and what counts as a
  reply or a repetition.

  One `:message` in the list switches a renderer to **traced mode**:

  - one peer lane per distinct `lane`, in order of first appearance, instead of
    the single peer lane (`message_lanes/1`);
  - a protocol command is a note beside the arrows it produced, not an arrow of
    its own — the arrows are the real messages now;
  - a protocol transition draws its state note and no inbound arrow, for the
    same reason.

  Without one, the rendering is what it was before the kind existed.

  A renderer must **never write a secret**. `config` is the machine's `config`
  block as declared, which is where a password would be; both shipped renderers
  mask a known set of key names. That set keeps its protocol-specific spellings
  on purpose — masking a key nobody uses costs nothing, and forgetting one costs
  a password in a file.
  """

  @doc "The document, as a string."
  @callback render(events :: [map()], meta :: map()) :: String.t()

  @doc "What to call the file, built from the run's metadata."
  @callback filename(meta :: map()) :: String.t()

  @doc """
  Sanitize an inspected pid into a filename-safe string: `#PID<0.123.0>` becomes
  `0.123.0`. Shared, because every renderer needs the same thing in `filename/1`.
  """
  @spec safe_pid(String.t()) :: String.t()
  def safe_pid(pid_string), do: String.replace(to_string(pid_string), ~r/[^0-9.]/, "")

  @doc """
  Mask the value of a key that may hold a secret.

  The list is deliberately over-broad and keeps the SIP spellings it was born
  with (`:passwd`, `:password`, `:ha1`, `:ha1b`): a key no binding uses costs
  nothing to mask, and a key that slips through costs a password written to
  disk. An application whose secrets go by other names should render its own document
  rather than hope.
  """
  @spec mask(atom(), term()) :: String.t()
  def mask(key, _value) when key in [:passwd, :password, :ha1, :ha1b], do: "****"
  def mask(_key, value), do: inspect(value)

  @doc """
  Which lane an event or command of this `type` belongs to, **by exclusion**.

  | Type | Lane |
  |---|---|
  | `:media` | `:media` |
  | `:scenario`, `:control`, `:timer`, `:http`, `:db`, `nil` | `:local` — a note, because nothing came from anywhere |
  | anything else | `:peer` |

  Written the other way round — matching `:sip` for the peer — a binding
  emitting `:matrix` would fall through to the self-note and get a worse diagram
  for no reason. By exclusion it reproduces the original rendering exactly for
  every type SIP emits, and does something sensible for one it has never seen.
  """
  @self_note_types [:scenario, :control, :timer, :http, :db, nil]

  @spec lane(atom() | nil) :: :media | :local | :peer
  def lane(:media), do: :media
  def lane(type) when type in @self_note_types, do: :local
  def lane(_type), do: :peer

  @doc """
  What to call the two lanes, from the run's `config` block and its name.

  | Lane | Read from, in order |
  |---|---|
  | local | `:label`, then `:username`, then the machine's own name |
  | peer | `:peer`, then `:domain`, then nothing — the lane stays bare |

  Two generic keys and one protocol-flavoured fallback each, on the same
  reasoning as the secret masking: reading a key nobody uses costs nothing, and
  the SIP spellings are what every machine written before this list existed
  actually says. The machine's name as the last resort because every run has
  one — an unlabelled lane tells a reader nothing, and `Fishing.Trip` tells them
  whose afternoon they are looking at.
  """
  @spec lane_labels(map()) :: {String.t(), String.t() | nil}
  def lane_labels(meta) do
    config = Map.get(meta, :config, [])

    local =
      Keyword.get(config, :label) || Keyword.get(config, :username) ||
        Map.get(meta, :scenario)

    {local, Keyword.get(config, :peer) || Keyword.get(config, :domain)}
  end

  @doc """
  Did this run touch media? Used to decide whether to declare a media lane at
  all, so a machine with no media plane gets a two-lane diagram.
  """
  @spec media?([map()]) :: boolean()
  def media?(events) do
    Enum.any?(events, fn
      %{kind: :command, type: :media} -> true
      %{kind: :transition, type: :media} -> true
      _other -> false
    end)
  end

  @doc """
  A command name as a message label: `send_INVITE` → `INVITE`,
  `send_auth_REGISTER` → `REGISTER (auth)`.

  A prefix rule over names and not a protocol table — it reads `send_message →
  MESSAGE` just as well.
  """
  @spec command_label(String.t()) :: String.t()
  def command_label(name) do
    base = String.replace_prefix(name, "send_", "")

    {base, suffix} =
      if String.starts_with?(base, "auth_"),
        do: {String.replace_prefix(base, "auth_", ""), " (auth)"},
        else: {base, ""}

    String.upcase(base) <> suffix
  end

  @doc """
  The time since the journal started, as a label prefix: `"+412ms "`. Empty when
  the event or the metadata carries no clock.
  """
  @spec stamp(map(), map()) :: String.t()
  def stamp(%{at: at}, %{t0: t0}) when is_integer(at) and is_integer(t0),
    do: "+#{div(at - t0, 1000)}ms "

  def stamp(_event, _meta), do: ""

  @doc "Is this run traced — does it hold at least one `:message` event?"
  @spec traced?([map()]) :: boolean()
  def traced?(events), do: Enum.any?(events, &match?(%{kind: :message}, &1))

  @doc """
  The peer lanes of a traced run: one per distinct `:lane` of its `:message`
  events, in order of first appearance, as
  `%{lane: term(), alias: "peer1", label: String.t()}`.

  The label is the first non-nil `:party` and the first non-nil `:peer` of that
  lane joined by a space — `"outbound 10.0.0.1:5060/udp"` — or `"peer N"` when
  neither is known. `[]` for an untraced run.
  """
  @spec message_lanes([map()]) :: [%{lane: term(), alias: String.t(), label: String.t()}]
  def message_lanes(events) do
    events
    |> Enum.filter(&match?(%{kind: :message}, &1))
    |> Enum.group_by(&Map.get(&1, :lane))
    |> Enum.sort_by(fn {_lane, msgs} -> msgs |> Enum.map(&Map.get(&1, :at, 0)) |> Enum.min() end)
    |> Enum.with_index(1)
    |> Enum.map(fn {{lane, msgs}, index} ->
      party = Enum.find_value(msgs, &Map.get(&1, :party))
      peer = Enum.find_value(msgs, &Map.get(&1, :peer))

      label =
        case [party, peer] |> Enum.reject(&is_nil/1) |> Enum.join(" ") do
          "" -> "peer #{index}"
          label -> label
        end

      %{lane: lane, alias: "peer#{index}", label: label}
    end)
  end

  @doc "A lane key as a header comment shows it: a string as is, anything else inspected."
  @spec lane_name(term()) :: String.t()
  def lane_name(lane) when is_binary(lane), do: lane
  def lane_name(lane), do: inspect(lane)

  @doc "A media command name: `media_connect` → `connect`."
  @spec media_label(String.t()) :: String.t()
  def media_label(name), do: String.replace_prefix(name, "media_", "")

  @doc """
  Is this transition's event worth drawing an arrow for? `""` and `"start"` are
  the two the journal produces for a transition nobody sent anything to cause.
  """
  @spec labelled?(String.t()) :: boolean()
  def labelled?(event), do: event not in ["", "start"]
end
