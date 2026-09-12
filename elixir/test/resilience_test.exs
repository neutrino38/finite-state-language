defmodule FSL.ResilienceTest do
  @moduledoc """
  The engine's safety net: **whatever happens, a machine ends**, because ending
  is what runs the teardown.

  A binding's verbs are typically `GenServer.call`s toward something that can
  die — a dialog, a transport, a connection. One that dies between the liveness
  check and the call makes that an **exit** in the machine's process, and the
  `state` macro rescued exceptions only, so the process died where it stood.
  `finalize/4` never ran: nothing the binding held was released, and, in the SIP
  case that produced this, a caller was left waiting for a final response nobody
  would ever send.

  What is asserted here is not that the exit is *survived* — a state that cannot
  reach what it needs has nothing left to do — but that the machine reaches a
  terminal, which is what runs `c:FSL.Host.finalize/1` and `cleanup/1`.

  The exit source is a dead pid and a plain `GenServer.call`, which is what such
  a verb is underneath and needs no protocol to reproduce.
  """
  use ExUnit.Case

  defmodule Exiting do
    use FSL.Machine

    config(label: "resilience")

    state initial_state do
      # A process that is already gone: what a handle whose owner just died looks
      # like from inside a state. Nothing here is contrived — a binding's verbs
      # are GenServer.calls on exactly such a pid.
      dead = spawn(fn -> :ok end)
      ref = Process.monitor(dead)
      receive do: ({:DOWN, ^ref, :process, _, _} -> :ok)

      GenServer.call(dead, :getdialogid)

      scenario_success("unreachable")
    end

    # finalize/4 calls this last. Since run_instance/2 runs the FSM in the
    # CALLING process, `self()` here is the test process.
    def cleanup(_ctx), do: send(self(), :teardown_ran)
  end

  test "an exit inside a state ends the scenario as a failure instead of killing it" do
    assert FSL.Runner.run_instance(Exiting) == {:error, "exit!"}
  end

  test "…and the teardown runs, which is the whole reason to catch it" do
    FSL.Runner.run_instance(Exiting)
    assert_received :teardown_ran
  end

  defmodule Raising do
    use FSL.Machine

    config(label: "resilience")

    state initial_state do
      raise "boom"
      scenario_success("unreachable")
    end
  end

  # The pre-existing exception path, pinned here next to its new sibling so the
  # two stay told apart: a scenario that raises still reports "exception!", not
  # "exit!".
  test "an exception is still reported as one" do
    assert FSL.Runner.run_instance(Raising) == {:error, "exception!"}
  end
end
