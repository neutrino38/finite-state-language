defmodule FSL.EngineTest do
  use ExUnit.Case

  # ── Scenario fixtures (compiled once) ───────────────────────────────────────

  # Exercises goto next / goto <named> / goto loop, appdata accumulation across
  # loop iterations, and scenario_success. No SIP / media involved, so it runs
  # entirely in the calling process and finishes synchronously.
  defmodule Basic do
    use FSL.Machine

    config(label: "alice")

    state initial_state do
      appdata_set(:count, 0)
      goto(next)
    end

    state second do
      n = appdata_get(:count)
      appdata_set(:count, n + 1)

      if n < 2 do
        goto(loop, "iteration #{n}")
      else
        goto(third)
      end
    end

    state third do
      scenario_success("looped #{appdata_get(:count)} times")
    end
  end

  defmodule Fails do
    use FSL.Machine

    state initial_state do
      scenario_failure("boom")
    end
  end

  # A non-:ok lasterr makes the next `goto` abort the scenario as a failure.
  defmodule LastErrAborts do
    use FSL.Machine

    state initial_state do
      ctx_set(:lasterr, {:error, :simulated})
      goto(unreached)
    end

    state unreached do
      scenario_success("should not happen")
    end
  end

  defmodule WithCleanup do
    use FSL.Machine

    state initial_state do
      scenario_success("ok")
    end

    def cleanup(_sip_ctx) do
      # run_instance/1 runs in the calling (test) process, so this lands in the
      # test mailbox and can be asserted.
      send(self(), :cleanup_called)
      :ok
    end
  end

  # Jumps to a state that does not exist. The runner must stop the scenario as a
  # failure instead of raising.
  defmodule UnknownState do
    use FSL.Machine

    state initial_state do
      goto(does_not_exist)
    end
  end

  # A state whose body does not end with goto / scenario_success /
  # scenario_failure. The runner must stop the scenario as a failure instead of
  # raising.
  defmodule MissingGoto do
    use FSL.Machine

    state initial_state do
      :some_unexpected_value
    end
  end

  # Uses on_events so the event type is inferred from the matched pattern.
  # Two clauses, two kinds of type: `:knock` is the HOST's answer
  # (`c:FSL.Host.event_type/1`) and `:parent_msg` is the language's own. That
  # split is the whole point of §4.4 of the extraction plan.
  defmodule InferEvents do
    use FSL.Machine, host: FSL.Test.Host

    config(label: "alice")

    state initial_state do
      on_events do
        {:knock, _who} -> goto(holding, "someone at the door")
        {:parent_msg, _payload} -> goto(holding, "word from the parent")
      end
    end

    state holding do
      # Plain receive: stay until the test releases us, so the monitor can be
      # inspected before the terminal report overwrites the event type.
      receive do
        :stop -> scenario_success("ok")
      end
    end
  end

  # ── Tests ───────────────────────────────────────────────────────────────────

  test "runs the FSM through next / named / loop transitions to success" do
    assert Basic.run(false) == :ok
  end

  test "exposes the declared states in order" do
    assert Basic.__scenario_states__() == [:initial_state, :second, :third]
  end

  test "scenario_failure returns {:error, reason}" do
    assert Fails.run(false) == {:error, "boom"}
  end

  test "goto aborts as failure when lasterr is not :ok" do
    assert LastErrAborts.run(false) == {:error, {:error, :simulated}}
  end

  test "calls the optional cleanup/1 callback on termination" do
    assert WithCleanup.run(false) == :ok
    assert_received :cleanup_called
  end

  test "a goto to an unknown state stops the scenario as a failure" do
    assert UnknownState.run(false) == {:error, {:unknown_state, :does_not_exist}}
  end

  test "a state that does not end with a transition stops the scenario as a failure" do
    assert MissingGoto.run(false) == {:error, {:invalid_transition, :initial_state}}
  end

  # What `config` means is the binding's, so the routing of its keys is pinned
  # on the binding's side — for SIP, `fsl_build_context_test` in Elixip, which
  # asserts all three destinations of `SIP.FSL.Host.build_context/1` at once.
  # Here the default host's answer is enough: everything goes to appdata.
  test "the config block reaches the machine through its host" do
    assert Basic.__scenario_config__() == [label: "alice"]
    ctx = FSL.Host.Default.build_context(Basic.__scenario_config__())
    assert FSL.Context.appdata_get(ctx, :label) == "alice"
  end

  test "run(false) is reentrant: several instances reuse an already-bootstrapped host" do
    # Bootstrap once, then run several independent instances. This is the basis
    # of the parallel mode.
    assert Basic.run(true) == :ok
    assert Basic.run(false) == :ok
    assert Basic.run(false) == :ok
  end

  test "on_events infers the event type and feeds it to the monitor" do
    if pid = Process.whereis(FSL.Monitor), do: GenServer.stop(pid)
    {:ok, _} = FSL.Monitor.start()

    parent = self()
    pid = spawn(fn -> send(parent, {:done, InferEvents.run(false)}) end)

    # A `:knock` is the host's to classify, and it answers `:door` — a type the
    # language has no table entry for. Checked before sending :stop, since the
    # terminal report would overwrite the event type.
    send(pid, {:knock, "alice"})
    assert wait_for_event_type(:door, 100) == :door

    send(pid, :stop)
    assert_receive {:done, :ok}, 2_000
  end

  test "…and what the language owns, it classifies itself" do
    if pid = Process.whereis(FSL.Monitor), do: GenServer.stop(pid)
    {:ok, _} = FSL.Monitor.start()

    parent = self()
    pid = spawn(fn -> send(parent, {:done, InferEvents.run(false)}) end)

    # `:parent_msg` is FSL's own vocabulary: the host answers `nil` for it, and
    # it is still `:scenario`.
    assert FSL.Test.Host.event_type(:parent_msg) == nil
    send(pid, {:parent_msg, :hello})
    assert wait_for_event_type(:scenario, 100) == :scenario

    send(pid, :stop)
    assert_receive {:done, :ok}, 2_000
  end

  defp wait_for_event_type(_type, 0), do: :timeout

  defp wait_for_event_type(type, attempts) do
    if Enum.any?(FSL.Monitor.calls(), &(&1.event_type == type)) do
      type
    else
      Process.sleep(10)
      wait_for_event_type(type, attempts - 1)
    end
  end
end
