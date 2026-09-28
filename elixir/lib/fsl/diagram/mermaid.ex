defmodule FSL.Diagram.Mermaid do
  @moduledoc """
  Renders an `FSL.Journal` run as a [Mermaid](https://mermaid.js.org/) sequence
  diagram.

  The same journal and the same lane rule as `FSL.Diagram.PlantUML` — read that
  module for what is drawn and why — in the dialect that needs no toolchain:
  GitHub, GitLab and most Markdown viewers render a ` ```mermaid ` block
  in place, so a diagram pasted into an issue is a diagram, not an attachment
  somebody has to run a jar over. It is also what the TypeScript sibling ships
  (`Machine.toMermaid()`), so the two dialects converge on one output format
  that a reader can compare side by side.

  ```elixir
  defmodule MyApp.FSLHost do
    @behaviour FSL.Host
    @impl true
    def diagram_renderer, do: FSL.Diagram.Mermaid
  end
  ```

  ## What Mermaid cannot do, and what is done instead

  Mermaid's sequence grammar has no per-arrow colour, where PlantUML has
  `-[#DarkOrange]>`. So media is distinguished by **lane and arrow style**
  rather than by colour: a media message is dotted (`-->>`) and lands on the
  media participant, a protocol message is solid (`->>`) and lands on the peer.
  That is a weaker signal than a colour and it is the honest trade — inventing a
  `rect rgb(...)` block around every media line would colour the *background of
  a region*, which is not the same statement.

  A terminal outcome is a note over the local lane, carrying the outcome word
  (`succeeded: …` / `failed: …`), where PlantUML tints it green or pink. Same
  information, one less channel.

  In a traced run (`:message` events, see `FSL.Diagram`) the same holds for the
  messages: a request is solid (`->>`), a reply dotted (`-->>`), and a
  repetition, which PlantUML greys, is drawn with the open arrowhead Mermaid
  keeps for asynchronous messages (`-)` / `--)`). A protocol command is a note
  over the local lane, since Mermaid has no hexagon note.

  ## Escaping

  Message text runs to the end of the line in Mermaid, so a `:` inside a label
  is safe and a newline is not. `#` starts an entity code (`#quot;`), and `;`
  ends a statement. All three are neutralised, and a label is never allowed to
  be empty — an empty one makes Mermaid drop the arrow silently, which is worse
  than a placeholder.
  """
  @behaviour FSL.Diagram

  @local "local"
  @remote "peer"
  @media "ms"

  @doc "Render the full Mermaid document as a String."
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
      "sequenceDiagram",
      participants(meta, events, lanes),
      body(events, rctx)
    ]
    |> List.flatten()
    |> Enum.join("\n")
    |> Kernel.<>("\n")
  end

  @doc """
  `<scenario>_<pid>.mmd`, with the pid sanitized to digits and dots.

  `.mmd` and not `.md`: the file holds a diagram and not a document, and every
  Mermaid tool recognises the extension.
  """
  @impl FSL.Diagram
  @spec filename(map()) :: String.t()
  def filename(meta) when is_map(meta),
    do: "#{meta.scenario}_#{FSL.Diagram.safe_pid(meta.pid)}.mmd"

  # ── Header (Mermaid comments are `%%` and must be on their own line) ────────

  defp header(meta, lanes) do
    config = Map.get(meta, :config, [])

    [
      "%% Machine       : #{meta.scenario}",
      "%% Instance pid  : #{meta.pid}",
      "%% Configuration (secrets masked):",
      Enum.map(config, fn {key, value} ->
        "%%   #{key}: #{FSL.Diagram.mask(key, value)}"
      end),
      lane_comments(lanes)
    ]
  end

  defp lane_comments([]), do: []

  defp lane_comments(lanes) do
    [
      "%% Peers (one per conversation):",
      Enum.map(lanes, fn lane ->
        "%%   #{lane.alias}: #{lane.label} — #{FSL.Diagram.lane_name(lane.lane)}"
      end)
    ]
  end

  # ── Participants ────────────────────────────────────────────────────────────

  defp participants(meta, events, lanes) do
    {local, peer} = FSL.Diagram.lane_labels(meta)

    peers =
      case lanes do
        [] -> [participant(@remote, peer)]
        lanes -> Enum.map(lanes, &participant(&1.alias, &1.label))
      end

    base = [participant(@local, local) | peers]

    # Only declare the media lane when the run actually touched media, so a
    # machine with no media plane gets a two-lane diagram.
    if FSL.Diagram.media?(events),
      do: base ++ ["    participant #{@media} as media server"],
      else: base
  end

  defp participant(id, nil), do: "    participant #{id}"
  defp participant(id, label), do: "    participant #{id} as #{escape(label)}"

  # ── Body ────────────────────────────────────────────────────────────────────

  defp body(events, rctx) do
    {lines, _state} =
      Enum.reduce(events, {[], nil}, fn event, {acc, current} ->
        {rendered, next} = render_event(event, current, rctx)
        {acc ++ rendered, next}
      end)

    lines
  end

  # A message that went over the wire: an arrow on the lane of its conversation.
  defp render_event(%{kind: :message} = msg, current, rctx) do
    lane = Map.get(rctx.aliases, Map.get(msg, :lane), @remote)
    {from, to} = if Map.get(msg, :dir) == :in, do: {lane, @local}, else: {@local, lane}

    {["    #{from}#{arrow(msg)}#{to}: #{label(msg, Map.get(msg, :label), rctx)}"], current}
  end

  # A media command: dotted, towards the media lane.
  defp render_event(%{kind: :command, type: :media, name: name} = event, current, rctx) do
    {["    #{@local}-->>#{@media}: #{label(event, FSL.Diagram.media_label(name), rctx)}"],
     current}
  end

  # A command that went nowhere — a timer armed, a database read, a block
  # entered: a note, because there is no lane it travelled to. A protocol
  # command is a note too in a traced run, beside the arrows it produced.
  defp render_event(%{kind: :command, type: type, name: name} = event, current, rctx) do
    case {FSL.Diagram.lane(type), rctx.traced?} do
      {:peer, false} ->
        {["    #{@local}->>#{@remote}: #{label(event, FSL.Diagram.command_label(name), rctx)}"],
         current}

      _note ->
        {["    Note over #{@local}: #{label(event, name, rctx)}"], current}
    end
  end

  # The first transition: entering the initial state.
  defp render_event(%{kind: :transition, to: to} = event, nil, rctx) do
    {["    Note over #{@local}: #{label(event, to, rctx)}"], to}
  end

  defp render_event(%{kind: :transition, to: to, event: event, type: type} = t, from, rctx) do
    labelled? = FSL.Diagram.labelled?(event)

    inbound =
      case {FSL.Diagram.lane(type), labelled?, rctx.traced?} do
        {:media, true, _} -> ["    #{@media}-->>#{@local}: #{label(t, event, rctx)}"]
        {:peer, true, false} -> ["    #{@remote}->>#{@local}: #{label(t, event, rctx)}"]
        _otherwise -> []
      end

    {inbound ++ ["    Note over #{@local}: #{label(t, "#{from} -> #{to}", rctx)}"], to}
  end

  defp render_event(%{kind: :terminal, outcome: outcome, reason: reason} = event, current, rctx) do
    text = if reason in ["", nil], do: to_string(outcome), else: "#{outcome}: #{reason}"
    {["    Note over #{@local}: #{label(event, text, rctx)}"], current}
  end

  # A kind this renderer does not know is skipped rather than failing the whole
  # diagram.
  defp render_event(_event, current, _rctx), do: {[], current}

  # Solid for a request, dotted for a reply, open arrowhead for a repetition.
  defp arrow(msg) do
    case {Map.get(msg, :reply, false), Map.get(msg, :repeat, false)} do
      {false, false} -> "->>"
      {true, false} -> "-->>"
      {false, true} -> "-)"
      {true, true} -> "--)"
    end
  end

  # The stamp, then the text, escaped as one.
  defp label(event, text, rctx),
    do: escape(FSL.Diagram.stamp(event, rctx.meta) <> to_string(text))

  # ── Escaping ────────────────────────────────────────────────────────────────

  # `#` opens an entity code, `;` ends a statement, and a newline ends a line —
  # none of them survives in a label. An empty label makes Mermaid drop the
  # arrow without a word, so it never stays empty.
  @entities %{"#" => "#35;", ";" => "#59;"}

  defp escape(text) do
    # ONE pass over both characters, not two passes: replacing `#` first turns a
    # later `;` substitution into `#35#59;`, and replacing `;` first gets its own
    # `#` eaten by the second pass. The entity for `#` contains a `;` and the
    # entity for `;` contains a `#`, so they cannot be done in sequence at all.
    case ~r/[#;]/
         |> Regex.replace(to_string(text), &Map.fetch!(@entities, &1))
         |> String.replace(~r/[\r\n]+/, " ")
         |> String.trim() do
      "" -> "?"
      escaped -> escaped
    end
  end
end
