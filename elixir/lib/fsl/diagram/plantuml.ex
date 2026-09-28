defmodule FSL.Diagram.PlantUML do
  @moduledoc """
  Renders a run recorded by `FSL.Journal` as a
  [PlantUML](https://plantuml.com/sequence-diagram) sequence diagram. The
  default renderer; `FSL.Diagram.Mermaid` is the alternative, and an application
  chooses with `c:FSL.Host.diagram_renderer/0`.

  A diagram is built from what the instrumentation already collected, which
  bounds how detailed it can be: command names become outgoing arrows, state
  transitions become notes, and a transition caused by an event becomes an
  incoming arrow labelled with the description the machine's author gave it —
  `goto talking, "200 OK"` draws an arrow labelled `200 OK`.

  ## Three lanes, and which one an event is drawn on

  The rule is **by exclusion**, which is what lets this renderer serve an
  application it has never heard of:

  | Event / command type | Lane |
  |---|---|
  | `:media` | the media server |
  | `:scenario`, `:control`, `:timer`, `:http`, `:db`, `nil` | a note over the local lane |
  | **anything else** — `:sip`, `:matrix`, `:xmpp`, … | the peer |

  Written the other way round — naming the types that go to the peer — an
  application emitting a type this renderer predates would fall through to the
  self-note and get a worse diagram for no reason. By exclusion it reproduces today's rendering exactly
  for every type Elixip emits, and does something sensible for one it has never
  seen.

  What looks like protocol vocabulary in the rules below is naming convention,
  and generalises for free: `send_INVITE → INVITE` and `media_play → play` are prefix rules over
  *command names*, and they read `send_message → MESSAGE` just as well.

  ## Traced runs

  When the journal holds `:message` events (see `FSL.Diagram`), each one is an
  arrow on the lane of its conversation — `peer1`, `peer2`… — solid for a
  request, dashed for a reply, grey for a repetition. Protocol commands become
  hexagon notes (`hnote`) beside the arrows they produced, and a protocol
  transition no longer draws an arrow of its own. A header comment names the
  conversation behind each lane.

  Every label is prefixed with `+Nms` when the events carry a clock.
  """

  # Participant aliases used throughout the diagram. `local` rather than
  # `elixip`: it is an alias, and the rendered label is already the config's
  # username.
  @local "local"
  @remote "peer"
  @media "ms"

  # The types that get a note over the local lane rather than an arrow: nothing
  # came from anywhere for them. Everything NOT here is a protocol event and is
  # drawn as coming from the peer.
  @self_note_types [:scenario, :control, :timer, :http, :db, nil]

  # Media commands/events are drawn in a distinct color to stand out from SIP;
  # repetitions are dimmed so the first copy stays the one the eye reads.
  @media_color "#DarkOrange"
  @repeat_color "#Gray"

  @behaviour FSL.Diagram

  @doc "Render the full PlantUML document as a String."
  @impl FSL.Diagram
  @spec render([map()], map()) :: String.t()
  def render(events, meta) when is_list(events) and is_map(meta) do
    lanes = FSL.Diagram.message_lanes(events)

    rctx = %{
      meta: meta,
      traced?: lanes != [],
      aliases: Map.new(lanes, &{&1.lane, &1.alias})
    }

    [
      header(meta, lanes),
      "@startuml",
      participants(meta, events, lanes),
      "",
      body(events, rctx),
      "@enduml"
    ]
    |> List.flatten()
    |> Enum.join("\n")
    |> Kernel.<>("\n")
  end

  @doc """
  Build the `.puml` filename from metadata: `<scenario>_<pid>.puml`, with the pid
  sanitized to keep only digits and dots (`#PID<0.123.0>` → `0.123.0`).
  """
  @impl FSL.Diagram
  @spec filename(map()) :: String.t()
  def filename(meta) when is_map(meta) do
    "#{meta.scenario}_#{safe_pid(meta.pid)}.puml"
  end

  @doc """
  The PlantUML document, under the name it had before renderers were pluggable.
  `render/2` is the callback; this delegates to it, because a document produced
  by *this* module is a PlantUML one and calling it so reads better at a call
  site that chose it deliberately.
  """
  @spec to_plantuml([map()], map()) :: String.t()
  defdelegate to_plantuml(events, meta), to: __MODULE__, as: :render

  @doc "See `FSL.Diagram.safe_pid/1`."
  @spec safe_pid(String.t()) :: String.t()
  defdelegate safe_pid(pid_string), to: FSL.Diagram

  # ── Header (PlantUML comment lines start with a single quote) ───────────────

  defp header(meta, lanes) do
    config = Map.get(meta, :config, [])

    [
      "' Scenario      : #{meta.scenario}",
      "' Instance pid  : #{meta.pid}",
      "' Configuration (passwords masked):",
      Enum.map(config, fn {key, value} -> "'   #{key}: #{mask(key, value)}" end),
      lane_comments(lanes),
      "'"
    ]
  end

  defp lane_comments([]), do: []

  defp lane_comments(lanes) do
    [
      "' Peers (one per conversation):",
      Enum.map(lanes, fn lane ->
        "'   #{lane.alias}: #{lane.label} — #{FSL.Diagram.lane_name(lane.lane)}"
      end)
    ]
  end

  # Secrets are never written out, even though a hashed credential is normally
  # all a context holds by then. Shared with every renderer: FSL.Diagram.mask/2.
  defp mask(key, value), do: FSL.Diagram.mask(key, value)

  # ── Participants ────────────────────────────────────────────────────────────

  defp participants(meta, events, lanes) do
    {local, peer} = FSL.Diagram.lane_labels(meta)

    peers =
      case lanes do
        [] -> [participant(@remote, peer)]
        lanes -> Enum.map(lanes, &participant(&1.alias, &1.label))
      end

    base = [participant(@local, local) | peers]

    # Only declare the media-server lane when the scenario actually touched media,
    # as a `control` so it is visually distinct from the SIP participants.
    if media?(events), do: base ++ [~s(control "media server" as #{@media})], else: base
  end

  defp participant(alias_name, nil), do: "participant #{alias_name}"
  defp participant(alias_name, label), do: ~s(participant "#{label}" as #{alias_name})

  defp media?(events), do: FSL.Diagram.media?(events)

  # ── Body ──────────────────────────────────────────────────────────────────

  defp body(events, rctx) do
    # A journal started mid-run knows the state it joined the run in, so its
    # first transition is drawn from there rather than as an initial state.
    {lines, _current_state} =
      Enum.reduce(events, {[], Map.get(rctx.meta, :joined_in)}, fn event, {acc, current} ->
        {rendered, next} = render_event(event, current, rctx)
        {acc ++ rendered, next}
      end)

    lines
  end

  # A message that went over the wire → an arrow on the lane of its conversation.
  defp render_event(%{kind: :message} = msg, current, rctx) do
    lane = Map.get(rctx.aliases, Map.get(msg, :lane), @remote)
    {from, to} = if Map.get(msg, :dir) == :in, do: {lane, @local}, else: {@local, lane}
    {["#{from} #{arrow(msg)} #{to} : #{stamp(msg, rctx)}#{Map.get(msg, :label)}"], current}
  end

  # Outbound media command → colored arrow towards the media server.
  defp render_event(%{kind: :command, type: :media, name: name} = event, current, rctx) do
    {["#{@local} -[#{@media_color}]> #{@media} : #{stamp(event, rctx)}#{media_label(name)}"],
     current}
  end

  # A command that went nowhere — a timer armed, a database read, a block
  # entered: a note, because there is no lane it travelled to.
  defp render_event(%{kind: :command, type: type, name: name} = event, current, rctx)
       when type in @self_note_types do
    {["note over #{@local} : #{stamp(event, rctx)}#{name}"], current}
  end

  # Anything else is a protocol command. It goes to the peer — unless the real
  # messages are drawn, and then it is a note beside the arrows it produced.
  defp render_event(%{kind: :command, name: name} = event, current, rctx) do
    if rctx.traced? do
      {["hnote over #{@local} : #{stamp(event, rctx)}#{name}"], current}
    else
      {["#{@local} -> #{@remote} : #{stamp(event, rctx)}#{method_label(name)}"], current}
    end
  end

  # First transition (no previous state) = entering the initial state.
  defp render_event(%{kind: :transition, to: to} = event, nil, rctx) do
    {["note over #{@local} : #{stamp(event, rctx)}#{to}"], to}
  end

  # Subsequent transition: optionally an inbound arrow (from the peer for a SIP
  # event, from the media server for a media event), then the state-change note.
  defp render_event(
         %{kind: :transition, to: to, event: event, type: type} = transition,
         from,
         rctx
       ) do
    labelled? = event not in ["", "start"]

    inbound =
      cond do
        # Media events are drawn as a colored arrow from the media server.
        type == :media and labelled? ->
          ["#{@media} -[#{@media_color}]> #{@local} : #{stamp(transition, rctx)}#{event}"]

        type in @self_note_types ->
          []

        # Traced: the message that caused it is already drawn, from its lane.
        rctx.traced? ->
          []

        # By exclusion: a type this renderer has never heard of came from the
        # peer, which is the only place an unrecognised protocol event can come
        # from.
        labelled? ->
          ["#{@local} <-- #{@remote} : #{stamp(transition, rctx)}#{event}"]

        true ->
          []
      end

    {inbound ++ ["note over #{@local} : #{stamp(transition, rctx)}#{from} -> #{to}"], to}
  end

  # Terminal outcome → coloured note.
  defp render_event(%{kind: :terminal, outcome: outcome, reason: reason} = event, current, rctx) do
    label = if reason in ["", nil], do: to_string(outcome), else: "#{outcome}: #{reason}"
    color = if outcome == :succeeded, do: "#LightGreen", else: "#Pink"
    {["note over #{@local} #{color} : #{stamp(event, rctx)}#{label}"], current}
  end

  # A kind this renderer does not know — a newer journal, a binding's own — is
  # skipped rather than failing the whole diagram.
  defp render_event(_event, current, _rctx), do: {[], current}

  # ── Helpers ─────────────────────────────────────────────────────────────────

  defp stamp(event, rctx), do: FSL.Diagram.stamp(event, rctx.meta)

  # Solid for a request, dashed for a reply; grey when repeated.
  defp arrow(msg) do
    color = if Map.get(msg, :repeat, false), do: "[#{@repeat_color}]", else: ""
    if Map.get(msg, :reply, false), do: "-#{color}->", else: "-#{color}>"
  end

  defp method_label(name), do: FSL.Diagram.command_label(name)
  defp media_label(name), do: FSL.Diagram.media_label(name)
end
