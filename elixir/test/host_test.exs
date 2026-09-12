defmodule FSL.HostTest do
  @moduledoc """
  What the language asks of its embedding, asked of a host that is not a
  protocol.

  Every hook of `FSL.Host` is observable on `FSL.Test.Host` — it appends to a
  list in appdata or messages the process that started the machine — so these
  tests read back what FSL called, with what, and in what order.
  """
  use ExUnit.Case, async: false

  defmodule Machine do
    use FSL.Machine, host: FSL.Test.Host

    config(colour: "blue")

    state initial_state do
      goto(waiting)
    end

    state waiting do
      on_events do
        {:knock, who} ->
          send(appdata_get(:probe), {:knocked, who, Process.get(:scenario_event_type)})
          goto(done)

        {:tick, _n} ->
          stay("later")
      after
        5_000 -> scenario_failure("nobody came")
      end
    end

    state done do
      send(appdata_get(:probe), {:trace, FSL.Test.Host.trace(fsl_ctx)})
      scenario_success("answered the door")
    end
  end

  defp run(module, opts \\ []) do
    test_pid = self()

    spawn(fn ->
      Process.put(:fsl_test_probe, test_pid)

      send(
        test_pid,
        {:done,
         FSL.Runner.run_instance(
           module,
           Keyword.merge([appdata: %{probe: test_pid}], opts)
         )}
      )
    end)
  end

  test "the host builds the context, sees every event, and is told to let go" do
    pid = run(Machine, my_own_option: :interesting)

    send(pid, {:tick, 1})
    send(pid, {:knock, "alice"})

    # The type is the host's answer, and it is one FSL has no table entry for.
    assert_receive {:knocked, "alice", :door}, 5_000
    assert_receive {:trace, trace}, 5_000
    assert_receive {:fsl_test_host, :finalize}, 5_000
    assert_receive {:done, :ok}, 5_000

    # The context was built from the config block…
    assert {:build_context, config} = hd(trace)
    assert Keyword.equal?(config, colour: "blue")

    # …then the run options FSL does not own were handed over, once.
    assert Enum.count(trace, &match?({:apply_run_opts, _}, &1)) == 1
    assert {:apply_run_opts, [my_own_option: :interesting]} = Enum.at(trace, 1)

    # Every event reached the host before the machine's own clause, including
    # the one the clause answered with `stay`.
    events = for {:on_event, e} <- trace, do: e
    assert events == [{:tick, 1}, {:knock, "alice"}]

    # And a state entry was announced for each state actually entered.
    assert Enum.count(trace, &(&1 == :on_state_enter)) == 3
  end

  test "run/2 bootstraps the host it names" do
    test_pid = self()

    spawn(fn ->
      Process.put(:fsl_test_probe, test_pid)
      send(test_pid, {:done, FSL.Runner.run(Machine, true)})
    end)

    assert_receive {:fsl_test_host, :bootstrap}, 5_000
  end

  describe "the host's injected clause" do
    defmodule Oblivious do
      use FSL.Machine, host: FSL.Test.Host

      state initial_state do
        on_events do
          {:knock, _who} -> scenario_success("someone came")
        after
          30_000 -> scenario_failure("nothing woke this wait")
        end
      end
    end

    defmodule Aware do
      use FSL.Machine, host: FSL.Test.Host

      state initial_state do
        on_events do
          {:door, what} -> scenario_success("mine: #{inspect(what)}")
        after
          30_000 -> scenario_failure("clause never ran")
        end
      end
    end

    test "fires for a machine that never considered its failure domain" do
      pid = run(Oblivious)
      send(pid, {:door, :slammed})

      # Aborted, not failed: nothing went wrong with the machine.
      assert_receive {:done, {:aborted, _reason}}, 5_000
    end

    test "is suppressed by a machine that handles it" do
      pid = run(Aware)
      send(pid, {:door, :slammed})
      assert_receive {:done, :ok}, 5_000
    end
  end

  describe "what stays the language's" do
    defmodule Stoppable do
      use FSL.Machine, host: FSL.Test.Host

      state initial_state do
        on_events do
          {:never, _} -> scenario_success("unreachable")
        after
          30_000 -> scenario_failure("timeout")
        end
      end
    end

    # The control protocol is FSL's, so it works whatever the host is — and a
    # host cannot opt its machines out of being stoppable.
    test "cooperative shutdown" do
      pid = run(Stoppable)
      send(pid, {:scenario_ctl, :shutdown, :operator})
      assert_receive {:done, {:aborted, "shutdown"}}, 5_000
    end

    defmodule Family do
      use FSL.Machine, host: FSL.Test.Host

      state initial_state do
        on_events do
          {:parent_msg, _p} ->
            send(appdata_get(:probe), {:typed, Process.get(:scenario_event_type)})
            scenario_success("heard from the parent")
        after
          5_000 -> scenario_failure("silence")
        end
      end
    end

    # The inter-FSM vocabulary is FSL's, so the host is not consulted about it
    # — and answers `nil` if it ever were, which is what makes this test able to
    # fail if the classification were handed over.
    test "the inter-FSM event types are the language's, not the host's" do
      assert FSL.Test.Host.event_type(:parent_msg) == nil

      pid = run(Family)
      send(pid, {:parent_msg, :hello})

      assert_receive {:typed, :scenario}, 5_000
      assert_receive {:done, :ok}, 5_000
    end
  end
end
