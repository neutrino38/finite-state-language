defmodule FSL.SpawnFsmTest do
  @moduledoc """
  Sub-FSMs: `spawn_fsm`, the three message families, and cooperative shutdown.

  A sub-FSM is a **second process** with resources of its own, which is what
  separates it from a service building block — the block runs on the caller's
  mailbox, the child has one of its own. Everything here follows from that:
  monitor and not link, a cooperative message and then a bounded wait before a
  hard kill, and a name assigned at spawn so the parent matches a stable literal
  in every state.

  What a binding adds to a spawned child — for SIP, registering a `:uas_invite`
  one with the call dispatcher — is `c:FSL.Host.spawn_child/2` and is tested on
  the binding's side, where a dispatcher exists.
  """
  use ExUnit.Case

  # ── Scenario fixtures ───────────────────────────────────────────────────────

  # A child that announces itself to its parent, then waits for a go-ahead.
  defmodule Child do
    use FSL.Machine

    config(label: "x")

    state initial_state do
      notify_parent(:ready)
      goto(waiting)
    end

    state waiting do
      on_events do
        {:parent_msg, :go} -> scenario_success("went")
      after
        2_000 -> scenario_failure("no go received")
      end
    end
  end

  # A parent that spawns the child, waits for its :ready, sends :go, and waits for
  # the child's successful exit.
  defmodule Parent do
    use FSL.Machine

    config(label: "x")

    state initial_state do
      spawn_fsm(Child, as: :callee)
      goto(waiting)
    end

    state waiting do
      on_events do
        {:child_msg, :callee, :ready} ->
          notify(:callee, :go)
          goto(finishing)
      after
        2_000 -> scenario_failure("child never became ready")
      end
    end

    state finishing do
      on_events do
        {:child_exit, :callee, :success, _reason} -> scenario_success("child done")
      after
        2_000 -> scenario_failure("child never exited")
      end
    end
  end

  # Calls notify_parent with no parent set: must be a silent no-op so the same
  # scenario also runs standalone.
  defmodule Orphan do
    use FSL.Machine

    config(label: "x")

    state initial_state do
      notify_parent(:nobody_listening)
      scenario_success("standalone ok")
    end
  end

  # Sits in an on_events forever (until a shutdown request). No on_shutdown block,
  # so the default cooperative termination (:aborted) applies.
  defmodule WaitsForever do
    use FSL.Machine

    config(label: "x")

    state initial_state do
      on_events do
        {:never, _x} -> scenario_success("unreachable")
      after
        60_000 -> scenario_failure("timeout")
      end
    end
  end

  # Same, but with a custom on_shutdown handler.
  defmodule CustomShutdown do
    use FSL.Machine

    config(label: "x")

    state initial_state do
      on_events do
        {:never, _x} -> scenario_success("unreachable")
      after
        60_000 -> scenario_failure("timeout")
      end
    end

    on_shutdown do
      scenario_aborted("custom wind-down")
    end
  end

  # ── Tests ───────────────────────────────────────────────────────────────────

  test "parent and child exchange messages and the child's exit propagates" do
    assert Parent.run(false) == :ok
  end

  # `spawn_fsm "child.exs"` names a file next to the scenario that declares it —
  # include semantics, so a scenario is self-contained wherever it is run from.
  # Resolving against the current directory instead is what made
  # scenarios/uac_register_and_uas_invite.exs die with a bare "exception!" for anyone
  # who did not happen to be standing in apps/elixip2. The fixture pair lives in
  # test/support/machines/, which is NOT the suite's working directory: a
  # cwd-relative resolution cannot find the child.
  test "a spawn_fsm path is resolved next to the file that declares it" do
    parent = FSL.Loader.load_file!("test/support/machines/sibling_parent.exs")
    assert FSL.Runner.run_instance(parent) == :ok
  end

  test "a sub-scenario that exists nowhere is reported with both paths tried" do
    defmodule Missing do
      use FSL.Machine

      config(label: "x")

      state initial_state do
        spawn_fsm("no_such_child.exs", as: :ghost)
        goto(loop)
      end
    end

    # The state body rescues the raise and fails the scenario; the message itself is
    # in the log (Exception.format), which is why the reason is spelled out there.
    assert {:error, _} = FSL.Runner.run_instance(Missing)
  end

  test "notify_parent is a no-op when the scenario has no parent" do
    assert Orphan.run(false) == :ok
  end

  test "a cooperative shutdown request aborts a waiting child by default" do
    parent = self()

    {pid, ref} =
      spawn_monitor(fn ->
        result =
          FSL.Runner.run_instance(WaitsForever, parent_pid: parent, self_name: :child)

        send(parent, {:result, result})
      end)

    # Let it reach the on_events before asking it to stop.
    Process.sleep(50)
    send(pid, {:scenario_ctl, :shutdown, :test})

    assert_receive {:child_exit, :child, :aborted, "shutdown"}, 1_000
    assert_receive {:result, {:aborted, "shutdown"}}, 1_000
    assert_receive {:DOWN, ^ref, :process, ^pid, :normal}, 1_000
  end

  test "on_shutdown runs a custom wind-down instead of the default" do
    parent = self()

    pid =
      spawn(fn ->
        result =
          FSL.Runner.run_instance(CustomShutdown, parent_pid: parent, self_name: :child)

        send(parent, {:result, result})
      end)

    Process.sleep(50)
    send(pid, {:scenario_ctl, :shutdown, :test})

    assert_receive {:child_exit, :child, :aborted, "custom wind-down"}, 1_000
    assert_receive {:result, {:aborted, "custom wind-down"}}, 1_000
  end

  # The 1.4 inter-FSM event shapes cannot be aliased the way `sub_fsm` was: a
  # scenario still matching one would never be woken, and would wait on its
  # `after` without a word. The compile-time warning is that safety net, so it
  # gets a test of its own.
  describe "deprecated inter-FSM event shapes" do
    defp compile_warnings(source) do
      ExUnit.CaptureIO.capture_io(:stderr, fn -> Code.compile_string(source) end)
    end

    defp scenario_matching(pattern) do
      """
      defmodule :"#{:erlang.unique_integer([:positive])}" do
        use FSL.Machine
        state initial_state do
          on_events do
            #{pattern} -> scenario_success("ok")
          end
        end
      end
      """
    end

    test "matching {:scenario_msg, …} warns and names both replacements" do
      warnings = compile_warnings(scenario_matching("{:scenario_msg, :parent, :go}"))

      assert warnings =~ "{:scenario_msg, …} is no longer sent"
      assert warnings =~ "{:parent_msg, payload}"
      assert warnings =~ "{:child_msg, name, payload}"
    end

    test "matching {:scenario_exit, …} warns, guard or no guard" do
      assert compile_warnings(scenario_matching("{:scenario_exit, :callee, o, _r}")) =~
               "{:child_exit, name, outcome, reason}"

      assert compile_warnings(
               scenario_matching("{:scenario_exit, :callee, o, _r} when o == :success")
             ) =~ "{:child_exit, name, outcome, reason}"
    end

    test "the current shapes warn about nothing" do
      for pattern <- [
            "{:parent_msg, :go}",
            "{:child_msg, :callee, :ready}",
            "{:child_exit, n, o, r}"
          ] do
        refute compile_warnings(scenario_matching(pattern)) =~ "no longer sent"
      end
    end
  end

  test "spawn_fsm requires an :as name" do
    assert_raise KeyError, fn ->
      FSL.Runner.spawn_child(%FSL.Context{}, Child, [], self())
    end
  end
end
