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
    [
      header(meta),
      "sequenceDiagram",
      participants(meta, events),
      body(events)
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

  defp header(meta) do
    config = Map.get(meta, :config, [])

    [
      "%% Machine       : #{meta.scenario}",
      "%% Instance pid  : #{meta.pid}",
      "%% Configuration (secrets masked):",
      Enum.map(config, fn {key, value} ->
        "%%   #{key}: #{FSL.Diagram.mask(key, value)}"
      end)
    ]
  end

  # ── Participants ────────────────────────────────────────────────────────────

  defp participants(meta, events) do
    config = Map.get(meta, :config, [])

    base = [
      participant(@local, Keyword.get(config, :username)),
      participant(@remote, Keyword.get(config, :domain))
    ]

    # Only declare the media lane when the run actually touched media, so a
    # machine with no media plane gets a two-lane diagram.
    if FSL.Diagram.media?(events),
      do: base ++ ["    participant #{@media} as media server"],
      else: base
  end

  defp participant(id, nil), do: "    participant #{id}"
  defp participant(id, label), do: "    participant #{id} as #{escape(label)}"

  # ── Body ────────────────────────────────────────────────────────────────────

  defp body(events) do
    {lines, _state} =
      Enum.reduce(events, {[], nil}, fn event, {acc, current} ->
        {rendered, next} = render_event(event, current)
        {acc ++ rendered, next}
      end)

    lines
  end

  # A media command: dotted, towards the media lane.
  defp render_event(%{kind: :command, type: :media, name: name}, current) do
    {["    #{@local}-->>#{@media}: #{escape(FSL.Diagram.media_label(name))}"], current}
  end

  # A command that went nowhere — a timer armed, a database read, a block
  # entered: a note, because there is no lane it travelled to.
  defp render_event(%{kind: :command, type: type, name: name}, current) do
    case FSL.Diagram.lane(type) do
      :local ->
        {["    Note over #{@local}: #{escape(name)}"], current}

      _peer ->
        {["    #{@local}->>#{@remote}: #{escape(FSL.Diagram.command_label(name))}"], current}
    end
  end

  # The first transition: entering the initial state.
  defp render_event(%{kind: :transition, to: to}, nil) do
    {["    Note over #{@local}: #{escape(to)}"], to}
  end

  defp render_event(%{kind: :transition, to: to, event: event, type: type}, from) do
    labelled? = FSL.Diagram.labelled?(event)

    inbound =
      case {FSL.Diagram.lane(type), labelled?} do
        {:media, true} -> ["    #{@media}-->>#{@local}: #{escape(event)}"]
        {:peer, true} -> ["    #{@remote}->>#{@local}: #{escape(event)}"]
        _otherwise -> []
      end

    {inbound ++ ["    Note over #{@local}: #{escape(from)} -> #{escape(to)}"], to}
  end

  defp render_event(%{kind: :terminal, outcome: outcome, reason: reason}, current) do
    label = if reason in ["", nil], do: to_string(outcome), else: "#{outcome}: #{reason}"
    {["    Note over #{@local}: #{escape(label)}"], current}
  end

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
