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

  Both callbacks are handed what `FSL.Journal.events/0` collected, oldest first:

      %{kind: :command,    type: atom() | nil, name: String.t()}
      %{kind: :transition, type: atom() | nil, to: term(), event: String.t()}
      %{kind: :terminal,   outcome: atom(),    reason: String.t()}

  and the run's metadata: `%{scenario: String.t(), pid: String.t(), config: keyword()}`.

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
  disk. A binding whose secrets go by other names should render its own document
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
