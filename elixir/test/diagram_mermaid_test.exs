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
  # NOT async: one test here sets `:fsl, :log_sequence`, which is application
  # state and therefore everyone's. An async file would turn the journal on
  # under every machine another async file happens to be running, and those
  # runs would flush diagrams of their own into the working directory.
  use ExUnit.Case, async: false

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

    test "falls back to the machine's own name, and leaves the peer bare" do
      out = render([])
      # An unlabelled lane tells a reader nothing; the machine's name tells them
      # whose run they are looking at, and every run has one.
      assert out =~ ~r/^    participant local as My\.Machine$/m
      assert out =~ ~r/^    participant peer$/m
    end

    test "prefers the generic keys over the protocol-flavoured ones" do
      out = render([], label: "the angler", peer: "the lake", username: "alice", domain: "ex.com")
      assert out =~ "participant local as the angler"
      assert out =~ "participant peer as the lake"

      # …and the protocol-flavoured keys are not used as labels. They still
      # appear in the header, which dumps the whole config block on purpose.
      lanes = for line <- String.split(out, "\n"), String.contains?(line, "participant"), do: line
      refute Enum.any?(lanes, &String.contains?(&1, "alice"))
      refute Enum.any?(lanes, &String.contains?(&1, "ex.com"))
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

    # The journal flushes to the working directory, so this test writes a file
    # and deletes it. NOT by chdir-ing somewhere temporary first: the working
    # directory belongs to the VM and not to the process, so a `File.cd!` here
    # moves it under every concurrently running async test — including one that
    # loads a fixture by relative path to prove `spawn_fsm` resolves against the
    # declaring file. That is not a hypothetical; it is how this test was
    # written the first time, and it broke that one.
    test "the journal writes the dialect the host named" do
      Application.put_env(:fsl, :log_sequence, true)

      on_exit(fn ->
        Application.delete_env(:fsl, :log_sequence)
        Enum.each(Path.wildcard("FSL.DiagramMermaidTest.Machine_*.mmd"), &File.rm/1)
      end)

      assert FSL.Runner.run_instance(Machine) == :ok

      assert [path | _] = Path.wildcard("FSL.DiagramMermaidTest.Machine_*.mmd")
      content = File.read!(path)
      assert content =~ "sequenceDiagram"
      assert content =~ "participant local as alice"
      refute content =~ "@startuml"
    end
  end
end
