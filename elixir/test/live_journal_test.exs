defmodule FSL.LiveJournalTest do
  # Not async: the machines below read application env and write diagrams
  # through a host that reports to the test process.
  use ExUnit.Case

  defmodule SinkHost do
    @moduledoc false
    # Keeps nothing: hands each finished document to the process that asked for
    # the machine, so a test can read what an operator would have got.
    @behaviour FSL.Host

    @impl true
    def journal_output(document, meta, renderer) do
      send(Process.get(:fsl_live_probe), {:diagram, document, meta, renderer})
      {:ok, {:memory, meta.slot}}
    end
  end

  defmodule Waiter do
    use FSL.Machine, host: FSL.LiveJournalTest.SinkHost

    state initial_state do
      Process.put(:fsl_live_probe, appdata_get(:probe))
      send(appdata_get(:probe), {:waiting, self()})
      goto(waiting)
    end

    state waiting do
      on_events do
        :go -> goto(talking, "go")
        :done -> scenario_success("done early")
      after
        appdata_get(:timeout) -> scenario_failure("timeout")
      end
    end

    state talking do
      on_events do
        :done -> scenario_success("done")
      after
        2_000 -> scenario_failure("timeout")
      end
    end
  end

  # A machine that handles `:scenario_ctl` itself — which suppresses the injected
  # shutdown clause, and must not suppress the journal one.
  defmodule OwnControl do
    use FSL.Machine, host: FSL.LiveJournalTest.SinkHost

    state initial_state do
      Process.put(:fsl_live_probe, appdata_get(:probe))
      send(appdata_get(:probe), {:waiting, self()})

      on_events do
        {:scenario_ctl, _what, _why} -> scenario_aborted("my own control")
        :done -> scenario_success("done")
      after
        2_000 -> scenario_failure("timeout")
      end
    end
  end

  defp start(module, timeout \\ 2_000) do
    test = self()

    pid =
      spawn(fn ->
        send(
          test,
          {:result,
           FSL.Runner.run_instance(module,
             slot_id: 42,
             appdata: %{probe: test, timeout: timeout}
           )}
        )
      end)

    assert_receive {:waiting, ^pid}, 1_000
    pid
  end

  test "a live machine turned on mid-wait draws from there to its end" do
    pid = start(Waiter)
    send(pid, {:scenario_ctl, :journal, :on})
    send(pid, :go)
    send(pid, :done)

    assert_receive {:result, :ok}, 1_000
    assert_receive {:diagram, doc, meta, FSL.Diagram.PlantUML}, 1_000

    assert meta.slot == 42
    assert doc =~ ~r/note over local : \+\d+ms journal on \(waiting\)/
    assert doc =~ "waiting -> talking"
    assert doc =~ "succeeded: done"
    # Nothing from before the operator asked.
    refute doc =~ "initial_state"
  end

  test "the wait resumes unseen, with the time it had left" do
    started = System.monotonic_time(:millisecond)
    pid = start(Waiter, 400)
    Process.sleep(250)
    send(pid, {:scenario_ctl, :journal, :on})

    assert_receive {:result, {:error, "timeout"}}, 1_000
    elapsed = System.monotonic_time(:millisecond) - started
    # Re-armed from scratch it would have run 250 + 400.
    assert elapsed < 600, "the deadline was re-armed (#{elapsed} ms)"

    assert_receive {:diagram, doc, _meta, _renderer}, 1_000
    assert doc =~ "failed: timeout"
  end

  test ":off hands the document over at once, and the run goes on untraced" do
    pid = start(Waiter)
    send(pid, {:scenario_ctl, :journal, :on})
    send(pid, {:scenario_ctl, :journal, :off})

    assert_receive {:diagram, doc, _meta, _renderer}, 1_000
    assert doc =~ "journal on (waiting)"
    assert doc =~ "journal off (waiting)"

    send(pid, :go)
    send(pid, :done)
    assert_receive {:result, :ok}, 1_000
    refute_receive {:diagram, _, _, _}, 200
  end

  test ":on twice starts one journal; :off without one does nothing" do
    pid = start(Waiter)
    send(pid, {:scenario_ctl, :journal, :off})
    send(pid, {:scenario_ctl, :journal, :on})
    send(pid, {:scenario_ctl, :journal, :on})
    send(pid, :done)

    assert_receive {:result, :ok}, 1_000
    assert_receive {:diagram, doc, _meta, _renderer}, 1_000
    assert length(String.split(doc, "journal on")) == 2
    refute_receive {:diagram, _, _, _}, 200
  end

  test "a machine with its own :scenario_ctl clause still takes the journal message" do
    pid = start(OwnControl)
    send(pid, {:scenario_ctl, :journal, :on})
    send(pid, :done)

    assert_receive {:result, :ok}, 1_000
    assert_receive {:diagram, doc, _meta, _renderer}, 1_000
    assert doc =~ "journal on (initial_state)"
  end

  test "without journal_output/3 the document is a file, as before" do
    defmodule Plain do
      use FSL.Machine

      state initial_state do
        send(appdata_get(:probe), {:waiting, self()})

        on_events do
          :done -> scenario_success("done")
        after
          2_000 -> scenario_failure("timeout")
        end
      end
    end

    pid = start(Plain)
    path = FSL.Diagram.PlantUML.filename(%{scenario: inspect(Plain), pid: inspect(pid)})
    on_exit(fn -> File.rm(path) end)

    send(pid, {:scenario_ctl, :journal, :on})
    send(pid, :done)
    assert_receive {:result, :ok}, 1_000
    assert File.read!(path) =~ "journal on (initial_state)"
  end
end
