defmodule FSL.JournalTraceTest do
  # Not async: the machines below write their diagram into the working directory
  # and read a named agent.
  use ExUnit.Case

  alias FSL.Diagram.{Mermaid, PlantUML}

  # ── A binding that records events outside the machine's process ─────────────

  defmodule TraceHost do
    @moduledoc false
    # What a protocol binding does, reduced to the two journal callbacks: its
    # "elsewhere" is an agent the test started, and it tells the test when it is
    # asked so the calls can be counted.
    @behaviour FSL.Host

    @store FSL.JournalTraceTest.Store

    @impl true
    def journal_started(ctx) do
      if probe = FSL.Context.appdata_get(ctx, :probe), do: send(probe, {:journal_started, ctx})

      # What a server instance knew before its journal existed goes in directly.
      FSL.Journal.record(%{kind: :message, dir: :in, lane: "call-0", label: "HELLO"})
      :ok
    end

    @impl true
    def journal_collect do
      if Process.whereis(@store),
        do: Agent.get_and_update(@store, fn events -> {events, []} end),
        else: []
    end

    def push(event), do: Agent.update(@store, &(&1 ++ [event]))
  end

  defmodule LateDebug do
    use FSL.Machine, host: FSL.JournalTraceTest.TraceHost

    state initial_state do
      FSL.Monitor.note_command(:sip, "send_before")
      goto(next, "first")
    end

    state second do
      # What a binding's `ctx_set(:debug, true)` amounts to on a context that
      # carries the field.
      fsl_ctx = Map.put(fsl_ctx, :debug, true)
      FSL.Monitor.note_command(:sip, "send_after")
      goto(next, "second")
    end

    state third do
      goto(next, "third")
    end

    state fourth do
      scenario_success("done")
    end
  end

  setup do
    start_supervised!(%{
      id: FSL.JournalTraceTest.Store,
      start: {Agent, :start_link, [fn -> [] end, [name: FSL.JournalTraceTest.Store]]}
    })

    on_exit(fn ->
      Enum.each(Path.wildcard("FSL.JournalTraceTest.*.puml"), &File.rm/1)
      Application.delete_env(:fsl, :log_sequence)
      FSL.Journal.clear()
    end)

    :ok
  end

  defp diagram_of(module) do
    path = PlantUML.filename(%{scenario: inspect(module), pid: inspect(self())})
    File.rm(path)
    assert module.run(false) == :ok
    content = File.read!(path)
    File.rm(path)
    content
  end

  describe "the journal" do
    test "stamps every event and its start" do
      :ok = FSL.Journal.start(%{scenario: "X", pid: "p", config: []})
      FSL.Journal.record_command(:sip, "send_INVITE")
      FSL.Journal.record_transition(:calling, "", nil)
      FSL.Journal.record_transition(:failed, "no", nil)

      assert is_integer(FSL.Journal.meta().t0)
      assert [%{at: a}, %{at: b}, %{at: c}] = FSL.Journal.events()
      assert FSL.Journal.meta().t0 <= a and a <= b and b <= c
    end

    test "record/1 stamps what has no clock, keeps what has one, and is inert when off" do
      FSL.Journal.clear()
      assert FSL.Journal.record(%{kind: :message, label: "X"}) == :ok
      assert FSL.Journal.events() == []

      :ok = FSL.Journal.start(%{scenario: "X", pid: "p", config: []})
      FSL.Journal.record(%{kind: :message, label: "A"})
      FSL.Journal.record(%{kind: :message, label: "B", at: 42})

      assert [%{label: "A", at: at}, %{label: "B", at: 42}] = FSL.Journal.events()
      assert is_integer(at) and at != 42
    end

    test "clear/0 drains what the host recorded elsewhere" do
      Process.put(:scenario_module, LateDebug)
      :ok = FSL.Journal.start(%{scenario: "X", pid: "p", config: []})
      TraceHost.push(%{kind: :message, at: 1, lane: "c", label: "LEFT OVER"})

      :ok = FSL.Journal.clear()
      assert TraceHost.journal_collect() == []
    after
      Process.delete(:scenario_module)
    end
  end

  describe "a run" do
    test "a debug flag set in a state starts the journal at the next transition, once" do
      content = diagram_of(LateDebug)

      # Nothing from before the flag…
      refute content =~ "initial_state -> second"
      refute content =~ "send_before"
      # …everything from the transition that follows the state that set it,
      # drawn from the state the journal joined the run in.
      assert content =~ ~r/note over local : \+\d+ms second -> third\n/
      assert content =~ "third -> fourth"
      assert content =~ "succeeded: done"
      # What journal_started/1 recorded, on a lane of its own.
      assert content =~ ~r/peer1 -> local : \+\d+ms HELLO/
    end

    test "journal_started/1 is called once, with the context that turned it on" do
      spawn_link_run(LateDebug, appdata: %{probe: self()})

      assert_receive {:journal_started, ctx}, 2_000
      assert ctx.debug == true
      refute_receive {:journal_started, _}, 200
    end
  end

  describe "flush/0" do
    test "merges what the host collected with the journal's own events, by :at" do
      Process.put(:scenario_module, LateDebug)
      meta = %{scenario: "FSL.JournalTraceTest.Merge", pid: inspect(self()), config: []}
      :ok = FSL.Journal.start(meta)
      t0 = FSL.Journal.meta().t0

      FSL.Journal.record(%{
        kind: :transition,
        at: t0 + 1_000,
        to: :initial_state,
        event: "",
        type: nil
      })

      FSL.Journal.record(%{
        kind: :terminal,
        at: t0 + 9_000,
        outcome: :succeeded,
        reason: "done",
        type: nil
      })

      TraceHost.push(
        msg(t0 + 5_000, :out, "call-1", "INVITE #1", party: "leg", peer: "10.0.0.1:5060/udp")
      )

      assert {:ok, path} = FSL.Journal.flush()
      content = File.read!(path)
      File.rm(path)

      assert content =~ ~s(participant "leg 10.0.0.1:5060/udp" as peer1)

      assert content =~
               "note over local : +1ms initial_state\n" <>
                 "local -> peer1 : +5ms INVITE #1\n" <>
                 "note over local #LightGreen : +9ms succeeded: done\n"

      # Handed over and forgotten.
      assert TraceHost.journal_collect() == []
    after
      Process.delete(:scenario_module)
    end
  end

  defp spawn_link_run(module, opts) do
    spawn_link(fn -> FSL.Runner.run_instance(module, opts) end)
  end

  # ── Rendering a traced run ──────────────────────────────────────────────────

  @meta %{scenario: "UAC.Invite", pid: "#PID<0.1.0>", config: [username: "bob"], t0: 0}

  defp msg(at, dir, lane, label, opts \\ []) do
    Map.merge(
      %{
        kind: :message,
        at: at,
        dir: dir,
        lane: lane,
        party: nil,
        peer: nil,
        label: label,
        reply: false,
        repeat: false
      },
      Map.new(opts)
    )
  end

  defp traced do
    [
      %{kind: :transition, at: 0, to: :initial_state, event: "start", type: nil},
      %{kind: :command, at: 2_000, type: :sip, name: "send_INVITE"},
      msg(3_000, :out, "abc@host", "INVITE #1 +SDP", peer: "10.0.0.1:5060/udp"),
      msg(9_000, :in, "abc@host", "100 Trying / 1 INVITE", reply: true, party: "outbound"),
      msg(500_000, :out, "abc@host", "INVITE #1 +SDP (retransmission)", repeat: true),
      msg(412_000, :in, "abc@host", "200 OK / 1 INVITE +SDP", reply: true),
      msg(600_000, :out, "xyz@host", "REGISTER #1"),
      %{kind: :transition, at: 414_000, to: :answered, event: "200 OK", type: :sip},
      %{kind: :terminal, at: 415_000, outcome: :succeeded, reason: "answered", type: :sip}
    ]
  end

  describe "PlantUML, traced" do
    setup do: %{out: PlantUML.render(traced(), @meta)}

    test "one lane per conversation, in order of first appearance", %{out: out} do
      assert out =~ ~s(participant "bob" as local)
      assert out =~ ~s(participant "outbound 10.0.0.1:5060/udp" as peer1)
      assert out =~ ~s(participant "peer 2" as peer2)
      refute out =~ " as peer\n"
      assert out =~ "'   peer1: outbound 10.0.0.1:5060/udp — abc@host"
      assert out =~ "'   peer2: peer 2 — xyz@host"
    end

    test "requests solid, replies dashed, repetitions grey, all stamped", %{out: out} do
      assert out =~ "local -> peer1 : +3ms INVITE #1 +SDP\n"
      assert out =~ "peer1 --> local : +9ms 100 Trying / 1 INVITE"
      assert out =~ "peer1 --> local : +412ms 200 OK / 1 INVITE +SDP"
      assert out =~ "local -[#Gray]> peer1 : +500ms INVITE #1 +SDP (retransmission)"
      assert out =~ "local -> peer2 : +600ms REGISTER #1"
    end

    test "a protocol command is a note, a protocol transition draws no arrow", %{out: out} do
      assert out =~ "hnote over local : +2ms send_INVITE"
      refute out =~ "local -> peer1 : +2ms INVITE"
      refute out =~ "<-- peer"
      assert out =~ "note over local : +414ms initial_state -> answered"
      assert out =~ "note over local #LightGreen : +415ms succeeded: answered"
    end
  end

  describe "Mermaid, traced" do
    setup do: %{out: Mermaid.render(traced(), @meta)}

    test "one lane per conversation", %{out: out} do
      assert out =~ "    participant peer1 as outbound 10.0.0.1:5060/udp"
      assert out =~ "    participant peer2 as peer 2"
      assert out =~ "%%   peer1: outbound 10.0.0.1:5060/udp — abc@host"
    end

    test "arrows by nature, commands as notes, labels escaped", %{out: out} do
      assert out =~ "    local->>peer1: +3ms INVITE #35;1 +SDP\n"
      assert out =~ "    peer1-->>local: +9ms 100 Trying / 1 INVITE"
      assert out =~ "    local-)peer1: +500ms INVITE #35;1 +SDP (retransmission)"
      assert out =~ "    Note over local: +2ms send_INVITE"
      refute out =~ "->>peer:"
      refute out =~ "peer->>local"
    end
  end

  describe "an event of a kind a renderer does not know" do
    @odd [
      %{kind: :transition, to: :initial_state, event: "start", type: nil},
      %{kind: :telemetry, value: 3},
      %{kind: :terminal, outcome: :succeeded, reason: "", type: nil}
    ]

    test "is skipped by both renderers" do
      meta = %{scenario: "X", pid: "#PID<0.1.0>", config: []}

      for renderer <- [PlantUML, Mermaid] do
        out = renderer.render(@odd, meta)
        refute out =~ "telemetry"
        assert out =~ "succeeded"
      end
    end
  end

  describe "an untraced run" do
    test "keeps the single peer lane and draws commands and events as arrows" do
      events = [
        %{kind: :transition, to: :initial_state, event: "start", type: nil},
        %{kind: :command, type: :sip, name: "send_INVITE"},
        %{kind: :transition, to: :answered, event: "200 OK", type: :sip}
      ]

      out = PlantUML.render(events, %{scenario: "X", pid: "#PID<0.1.0>", config: []})
      assert out =~ "participant peer\n"
      assert out =~ "local -> peer : INVITE"
      assert out =~ "local <-- peer : 200 OK"
      refute out =~ "hnote"
      refute out =~ "Peers"
    end
  end
end
