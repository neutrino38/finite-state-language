defmodule FSL.DiagramTest do
  use ExUnit.Case

  alias FSL.Diagram.PlantUML, as: SequenceDiagram
  alias FSL.Journal, as: SequenceJournal

  # ── Pure formatter (SequenceDiagram) ────────────────────────────────────────

  @meta %{
    scenario: "UAC.Invite",
    pid: "#PID<0.123.0>",
    config: [username: "alice", domain: "example.com", passwd: "s3cret"]
  }

  @events [
    %{kind: :transition, to: :initial_state, event: "start", type: nil},
    %{kind: :command, type: :media, name: "media_connect"},
    %{kind: :transition, to: :calling, event: "", type: nil},
    %{kind: :command, type: :sip, name: "send_INVITE"},
    %{kind: :transition, to: :answered, event: "200 OK", type: :sip},
    %{kind: :command, type: :media, name: "media_play"},
    %{kind: :transition, to: :playing, event: "media connected", type: :media},
    %{kind: :terminal, outcome: :succeeded, reason: "answered", type: :sip}
  ]

  test "renders a well-formed PlantUML document" do
    out = SequenceDiagram.to_plantuml(@events, @meta)

    assert out =~ "@startuml"
    assert out =~ "@enduml"
    # Both participants are declared (the README example forgot the local one).
    assert out =~ ~s(participant "alice" as local)
    assert out =~ ~s(participant "example.com" as peer)
  end

  test "renders commands, transitions and the terminal outcome" do
    out = SequenceDiagram.to_plantuml(@events, @meta)

    # Outbound SIP command → request arrow with the bare method name.
    assert out =~ "local -> peer : INVITE"
    # A :sip transition carrying a description → inbound arrow.
    assert out =~ "local <-- peer : 200 OK"
    # First transition is the initial-state note; later ones are from -> to.
    assert out =~ "note over local : initial_state"
    assert out =~ "note over local : calling -> answered"
    # Terminal outcome.
    assert out =~ "succeeded: answered"
  end

  test "renders media commands and events against a media-server lane" do
    out = SequenceDiagram.to_plantuml(@events, @meta)

    # The media lane is declared as a `control`, only because media was touched.
    assert out =~ ~s(control "media server" as ms)
    # Media command → outbound colored arrow (the media_ prefix is stripped).
    assert out =~ "local -[#DarkOrange]> ms : connect"
    assert out =~ "local -[#DarkOrange]> ms : play"
    # Media event → colored arrow from the media server.
    assert out =~ "ms -[#DarkOrange]> local : media connected"
  end

  test "omits the media lane when no media is involved" do
    sip_only = [
      %{kind: :transition, to: :initial_state, event: "start", type: nil},
      %{kind: :command, type: :sip, name: "send_INVITE"},
      %{kind: :terminal, outcome: :succeeded, reason: "ok", type: :sip}
    ]

    refute SequenceDiagram.to_plantuml(sip_only, @meta) =~ "as ms"
  end

  test "masks secrets in the configuration header and never leaks them" do
    out = SequenceDiagram.to_plantuml(@events, @meta)

    assert out =~ "passwd: ****"
    refute out =~ "s3cret"
    # Non-secret config is shown.
    assert out =~ "username:"
  end

  test "auth command names keep an (auth) suffix" do
    out =
      SequenceDiagram.to_plantuml(
        [%{kind: :command, type: :sip, name: "send_auth_REGISTER"}],
        @meta
      )

    assert out =~ "local -> peer : REGISTER (auth)"
  end

  test "builds a filename with a sanitized pid" do
    assert SequenceDiagram.filename(@meta) == "UAC.Invite_0.123.0.puml"
    assert SequenceDiagram.safe_pid("#PID<0.987.2>") == "0.987.2"
  end

  # ── Journal collection (SequenceJournal) ────────────────────────────────────

  test "collects events in chronological order while enabled" do
    refute SequenceJournal.enabled?()

    :ok = SequenceJournal.start(@meta)
    assert SequenceJournal.enabled?()

    SequenceJournal.record_transition(:initial_state, "start", nil)
    SequenceJournal.record_command(:sip, "send_INVITE")
    SequenceJournal.record_transition(:answered, "200 OK", :sip)
    SequenceJournal.record_transition(:succeeded, "done", :sip)

    assert SequenceJournal.events() == [
             %{kind: :transition, to: :initial_state, event: "start", type: nil},
             %{kind: :command, type: :sip, name: "send_INVITE"},
             %{kind: :transition, to: :answered, event: "200 OK", type: :sip},
             %{kind: :terminal, outcome: :succeeded, reason: "done", type: :sip}
           ]

    :ok = SequenceJournal.clear()
    refute SequenceJournal.enabled?()
    assert SequenceJournal.events() == []
  end

  test "recording is a no-op when no journal is started" do
    SequenceJournal.clear()
    assert SequenceJournal.record_command(:sip, "send_INVITE") == :ok
    assert SequenceJournal.record_transition(:calling, "", nil) == :ok
    assert SequenceJournal.events() == []
  end

  # ── End-to-end: a scenario run writes the .puml file ────────────────────────

  defmodule SeqScenario do
    use FSL.Machine

    config(username: "alice", authusername: "alice", domain: "example.com", passwd: "s3cret")

    state initial_state do
      # Call the raw monitor hooks directly so the journal records commands
      # without needing the SIP stack / media server / network.
      FSL.Monitor.note_command(:media, "media_connect")
      goto(next)
    end

    state calling do
      FSL.Monitor.note_command(:sip, "send_INVITE")
      goto(wait, "INVITE sent")
    end

    state wait do
      scenario_success("answered")
    end
  end

  test "a scenario run with --log-sequence enabled writes the PlantUML file" do
    path =
      SequenceDiagram.filename(%{
        scenario: "FSL.DiagramTest.SeqScenario",
        pid: inspect(self())
      })

    File.rm(path)

    # `:fsl`, not a binding's app: the journal and this renderer are the
    # language's. A binding that keeps its configuration in one namespace names
    # it with `config :fsl, :log_sequence_app, :my_app` instead.
    Application.put_env(:fsl, :log_sequence, true)

    try do
      # Runs synchronously in this (test) process, so the file pid is self().
      assert SeqScenario.run(false) == :ok
    after
      Application.delete_env(:fsl, :log_sequence)
    end

    assert File.exists?(path)
    content = File.read!(path)
    assert content =~ "@startuml"
    assert content =~ "@enduml"
    assert content =~ "local -> peer : INVITE"
    assert content =~ "local -[#DarkOrange]> ms : connect"
    assert content =~ "note over local : initial_state -> calling"
    assert content =~ "passwd: ****"
    refute content =~ "s3cret"

    File.rm(path)
  end

  describe "the lane rule, by exclusion" do
    @moduletag :lanes

    # The one clause §4.8 had to generalize. Written as "`:sip` goes to the
    # peer", a binding emitting `:matrix` fell through to the self-note and drew
    # a worse diagram for no reason; written by exclusion, a type this renderer
    # has never heard of is still drawn as coming from the peer — which is the
    # only place an unrecognised protocol event can come from.
    defp render_one(event) do
      FSL.Diagram.PlantUML.to_plantuml(
        [
          %{kind: :transition, to: :initial_state, event: "start", type: nil},
          event
        ],
        %{scenario: "X", pid: "#PID<0.1.0>", config: []}
      )
    end

    test "a protocol type FSL has never heard of is drawn from the peer" do
      for type <- [:sip, :matrix, :xmpp, :teams] do
        out = render_one(%{kind: :transition, to: :next, event: "200 OK", type: type})
        assert out =~ "local <-- peer : 200 OK", "#{inspect(type)} was not drawn from the peer"
      end
    end

    test "media is drawn from the media server" do
      out = render_one(%{kind: :transition, to: :next, event: "ice_connected", type: :media})
      assert out =~ "ms -[#DarkOrange]> local : ice_connected"
      refute out =~ "<-- peer"
    end

    test "what came from nowhere is a note, not an arrow" do
      for type <- [:scenario, :control, :timer, :http, :db, nil] do
        out = render_one(%{kind: :transition, to: :next, event: "block returned", type: type})
        refute out =~ "<-- peer", "#{inspect(type)} was drawn as an arrow"
        assert out =~ "note over local : initial_state -> next"
      end
    end

    test "the same rule applies to commands" do
      peer =
        FSL.Diagram.PlantUML.to_plantuml(
          [%{kind: :command, type: :matrix, name: "send_message"}],
          %{scenario: "X", pid: "#PID<0.1.0>", config: []}
        )

      # …including the prefix rule, which is a naming convention and not a SIP
      # table: `send_message` reads as well as `send_INVITE`.
      assert peer =~ "local -> peer : MESSAGE"

      note =
        FSL.Diagram.PlantUML.to_plantuml(
          [%{kind: :command, type: :db, name: "lookup_subscriber"}],
          %{scenario: "X", pid: "#PID<0.1.0>", config: []}
        )

      assert note =~ "note over local : lookup_subscriber"
    end
  end

  describe "which app the :log_sequence flag lives under" do
    # A binding usually configures everything in one namespace of its own, so
    # the flag is read under `:fsl` AND under whatever app the binding named.
    # Elixip's `elixipp --log-sequence` sets `:fsl`; a binding that would rather
    # keep it with the rest of its configuration says so once.
    setup do
      on_exit(fn ->
        Application.delete_env(:fsl, :log_sequence)
        Application.delete_env(:fsl, :log_sequence_app)
        Application.delete_env(:some_binding, :log_sequence)
        FSL.Journal.clear()
      end)
    end

    defmodule Quiet do
      use FSL.Machine

      state initial_state do
        send(appdata_get(:probe), {:journal, FSL.Journal.enabled?()})
        scenario_success("done")
      end
    end

    defp journal_on?() do
      test_pid = self()
      spawn(fn -> FSL.Runner.run_instance(Quiet, appdata: %{probe: test_pid}) end)
      assert_receive {:journal, on?}, 2_000
      on?
    end

    test "off by default" do
      refute journal_on?()
    end

    test "on when :fsl says so" do
      Application.put_env(:fsl, :log_sequence, true)
      assert journal_on?()
    end

    test "on when the app the binding named says so" do
      Application.put_env(:fsl, :log_sequence_app, :some_binding)
      Application.put_env(:some_binding, :log_sequence, true)
      assert journal_on?()
    end

    test "off when the named app says nothing, whatever else is configured" do
      Application.put_env(:fsl, :log_sequence_app, :some_binding)
      refute journal_on?()
    end
  end
end
