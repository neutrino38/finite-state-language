defmodule FSL.DiagramMermaidTest do
  @moduledoc """
  The Mermaid renderer: the same journal and the same lane rule as the PlantUML
  one, in the dialect that needs no toolchain — GitHub renders a ` ```mermaid `
  block in place, and it is what the TypeScript sibling emits, so the two
  dialects produce one output a reader can compare.

  What is checked here is what a second renderer can get wrong: the grammar
  (Mermaid is whitespace- and prefix-sensitive where PlantUML is not), the lane
  rule being the shared one rather than a second copy, and the escaping — a
  label that ends a statement early produces a diagram that renders, wrongly,
  with no error anywhere.
  """
  use ExUnit.Case, async: true

  alias FSL.Diagram.Mermaid

  defp meta(config \\ []),
    do: %{scenario: "My.Machine", pid: "#PID<0.123.0>", config: config}

  defp render(events, config \\ []), do: Mermaid.render(events, meta(config))

  describe "the document" do
    test "opens with the header comments, then the graph declaration" do
      out = render([])

      lines = String.split(out, "\n")
      assert Enum.at(lines, 0) == "%% Machine       : My.Machine"
      assert Enum.at(lines, 1) == "%% Instance pid  : #PID<0.123.0>"
      # Every comment line is its own, prefixed: Mermaid has no inline comment.
      for line <- Enum.take_while(lines, &String.starts_with?(&1, "%%")) do
        assert String.starts_with?(line, "%%")
      end

      assert "sequenceDiagram" in lines
    end

    test "declares the two lanes, labelled from the config" do
      out = render([], username: "alice", domain: "example.com")

      assert out =~ "participant local as alice"
      assert out =~ "participant peer as example.com"
      # No media lane for a run that touched no media.
      refute out =~ "participant ms"
    end

    test "declares a bare participant when the config names nothing" do
      out = render([])
      assert out =~ ~r/^    participant local$/m
      assert out =~ ~r/^    participant peer$/m
    end

    test "declares the media lane only when the run touched media" do
      out = render([%{kind: :command, type: :media, name: "media_connect"}])
      assert out =~ "participant ms as media server"
    end

    test "masks secrets in the header and never leaks them" do
      out = render([], username: "alice", passwd: "hunter2", ha1: "deadbeef")

      assert out =~ "passwd: ****"
      assert out =~ "ha1: ****"
      refute out =~ "hunter2"
      refute out =~ "deadbeef"
    end

    test "builds a filename with a sanitized pid" do
      assert Mermaid.filename(meta()) == "My.Machine_0.123.0.mmd"
    end
  end

  describe "the lane rule, shared with every renderer" do
    defp one(event),
      do: render([%{kind: :transition, to: :initial_state, event: "start", type: nil}, event])

    test "a protocol type the renderer has never heard of comes from the peer" do
      for type <- [:sip, :matrix, :xmpp] do
        out = one(%{kind: :transition, to: :next, event: "200 OK", type: type})
        assert out =~ "peer->>local: 200 OK", "#{inspect(type)} was not drawn from the peer"
      end
    end

    test "media is dotted and comes from the media lane" do
      out = one(%{kind: :transition, to: :next, event: "ice_connected", type: :media})
      assert out =~ "ms-->>local: ice_connected"
      refute out =~ "peer->>local"
    end

    test "what came from nowhere is a note, not an arrow" do
      for type <- [:scenario, :control, :timer, :http, :db, nil] do
        out = one(%{kind: :transition, to: :next, event: "block returned", type: type})
        refute out =~ "->>", "#{inspect(type)} was drawn as an arrow"
        assert out =~ "Note over local: initial_state -> next"
      end
    end

    test "commands follow the same rule, with the same prefix stripping" do
      assert render([%{kind: :command, type: :matrix, name: "send_message"}]) =~
               "local->>peer: MESSAGE"

      assert render([%{kind: :command, type: :sip, name: "send_auth_REGISTER"}]) =~
               "local->>peer: REGISTER (auth)"

      assert render([%{kind: :command, type: :media, name: "media_play"}]) =~
               "local-->>ms: play"

      assert render([%{kind: :command, type: :db, name: "lookup_subscriber"}]) =~
               "Note over local: lookup_subscriber"
    end

    test "a transition with nothing to say draws no arrow" do
      for event <- ["", "start"] do
        out = one(%{kind: :transition, to: :next, event: event, type: :sip})
        refute out =~ "->>"
      end
    end
  end

  describe "the terminal" do
    test "carries the outcome word, since Mermaid cannot tint a note" do
      assert render([%{kind: :terminal, outcome: :succeeded, reason: "answered"}]) =~
               "Note over local: succeeded: answered"

      assert render([%{kind: :terminal, outcome: :failed, reason: "no answer"}]) =~
               "Note over local: failed: no answer"
    end

    test "an outcome with no reason is just the word" do
      assert render([%{kind: :terminal, outcome: :aborted, reason: ""}]) =~
               "Note over local: aborted"
    end
  end

  describe "escaping" do
    # A label that ends a statement early produces a diagram that renders,
    # wrongly, with nothing reported anywhere — which is why this is tested and
    # not trusted.
    test "neutralises the three characters that would break the grammar" do
      out = render([%{kind: :command, type: :db, name: "a;b\nc#d"}])

      assert [label] = Regex.run(~r/Note over local: (.*)$/m, out, capture: :all_but_first)
      assert label == "a#59;b c#35;d"

      # What matters is that no BARE `#` or `;` survives — one inside an entity
      # is the escape, not a leak. Asserting `refute label =~ ";"` would fail on
      # the entity's own semicolon, which is why the entities come out first.
      bare = label |> String.replace("#35;", "") |> String.replace("#59;", "")
      refute bare =~ ";"
      refute bare =~ "#"

      # …and the newline did not end the statement early: one note, one line.
      assert length(String.split(out, "Note over local")) == 2
      refute label =~ "\n"
    end

    test "a colon is left alone, because a label runs to end of line" do
      assert one(%{kind: :transition, to: :next, event: "200 OK: fine", type: :sip}) =~
               "peer->>local: 200 OK: fine"
    end

    test "an empty label becomes a placeholder rather than a dropped arrow" do
      assert render([%{kind: :command, type: :sip, name: "   "}]) =~ "local->>peer: ?"
    end
  end

  describe "a whole run" do
    test "reads as a sequence, in order" do
      out =
        render(
          [
            %{kind: :transition, to: :initial_state, event: "start", type: nil},
            %{kind: :command, type: :media, name: "media_connect"},
            %{kind: :transition, to: :calling, event: "", type: nil},
            %{kind: :command, type: :sip, name: "send_INVITE"},
            %{kind: :transition, to: :talking, event: "200 OK", type: :sip},
            %{kind: :terminal, outcome: :succeeded, reason: "answered"}
          ],
          username: "alice",
          domain: "example.com"
        )

      body =
        out
        |> String.split("\n")
        |> Enum.reject(&(&1 == "" or String.starts_with?(&1, "%%")))

      assert body == [
               "sequenceDiagram",
               "    participant local as alice",
               "    participant peer as example.com",
               "    participant ms as media server",
               "    Note over local: initial_state",
               "    local-->>ms: connect",
               "    Note over local: initial_state -> calling",
               "    local->>peer: INVITE",
               "    peer->>local: 200 OK",
               "    Note over local: calling -> talking",
               "    Note over local: succeeded: answered"
             ]
    end
  end

  describe "as a host's chosen renderer" do
    defmodule MermaidHost do
      @behaviour FSL.Host
      @impl true
      def diagram_renderer, do: FSL.Diagram.Mermaid
    end

    defmodule Machine do
      use FSL.Machine, host: MermaidHost

      config(username: "alice", domain: "example.com", debug: true)

      state initial_state do
        scenario_success("done")
      end
    end

    test "the journal writes the dialect the host named" do
      tmp = Path.join(System.tmp_dir!(), "fsl-mermaid-#{System.unique_integer([:positive])}")
      File.mkdir_p!(tmp)
      on_exit(fn -> File.rm_rf!(tmp) end)

      previous = File.cwd!()
      File.cd!(tmp)
      Application.put_env(:fsl, :log_sequence, true)

      on_exit(fn ->
        Application.delete_env(:fsl, :log_sequence)
        File.cd!(previous)
      end)

      assert FSL.Runner.run_instance(Machine) == :ok

      assert [path] = Path.wildcard(Path.join(tmp, "*.mmd"))
      content = File.read!(path)
      assert content =~ "sequenceDiagram"
      assert content =~ "participant local as alice"
      refute content =~ "@startuml"
    end
  end
end
