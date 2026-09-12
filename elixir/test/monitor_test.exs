defmodule FSL.MonitorTest do
  @moduledoc """
  The live registry's **subscription contract**, which is the half of it a
  library is judged on: an application can get away with polling `calls/0`, and
  a package cannot.

  Two properties, and each one existed as a defect before the extraction
  (extraction-plan §4.7, "two defects to fix while moving, not after"):

    * `subscribe/1` **returns the snapshot**, taken inside the call that
      registers the subscriber. Two calls leave a window, and only one of the two
      orders survives it — subscribe-then-snapshot turns a change landing in
      between into a duplicate `upsert`, which is idempotent, while
      snapshot-first loses the row until the call happens to change again. One
      call has no order to get wrong;
    * a subscriber is **monitored** and dropped when it dies. Invisible while the
      one in-tree subscriber was a supervised singleton; not invisible here,
      where subscribing is the normal way to use this and a set that only grows
      means every later change is `send/2` into the void.

  The rows themselves — the flat shape, the host-declared columns — are pinned
  on the binding's side, where a host exists to declare any.
  """
  use ExUnit.Case, async: false

  setup do
    if pid = Process.whereis(FSL.Monitor), do: GenServer.stop(pid)
    {:ok, _pid} = FSL.Monitor.start()
    slot = System.unique_integer([:positive])
    on_exit(fn -> FSL.Monitor.unsubscribe(self()) end)
    {:ok, slot: slot}
  end

  describe "subscribe/1" do
    test "answers the rows that already exist", %{slot: slot} do
      FSL.Monitor.report(slot, "Already.Running", "alice", "waiting", "start", nil)

      assert [row] = FSL.Monitor.subscribe(self())
      assert row.slot == slot
      assert row.scenario == "Already.Running"
      assert row.state == "waiting"
    end

    test "answers [] on an empty registry, not nil" do
      assert FSL.Monitor.subscribe(self()) == []
    end

    test "is live from that same call on", %{slot: slot} do
      assert FSL.Monitor.subscribe(self()) == []

      FSL.Monitor.report(slot, "S", "alice", "waiting", "start", nil)
      assert_receive {:fsl_monitor, {:updated, ^slot, %{state: "waiting"}}}, 2_000

      FSL.Monitor.clear(slot)
      assert_receive {:fsl_monitor, {:cleared, ^slot}}, 2_000
    end

    test "is idempotent: a second call re-snapshots without doubling the pushes",
         %{slot: slot} do
      FSL.Monitor.subscribe(self())
      FSL.Monitor.report(slot, "S", "alice", "waiting", "start", nil)
      assert_receive {:fsl_monitor, {:updated, ^slot, _}}, 2_000

      assert [%{slot: ^slot}] = FSL.Monitor.subscribe(self())

      FSL.Monitor.report(slot, "S", "alice", "talking", "ok", nil)
      assert_receive {:fsl_monitor, {:updated, ^slot, %{state: "talking"}}}, 2_000
      refute_receive {:fsl_monitor, {:updated, ^slot, %{state: "talking"}}}, 200
    end
  end

  describe "a subscriber that dies" do
    test "is dropped, and the registry keeps serving the others", %{slot: slot} do
      test_pid = self()

      doomed =
        spawn(fn ->
          FSL.Monitor.subscribe(self())
          send(test_pid, :subscribed)
          Process.sleep(:infinity)
        end)

      assert_receive :subscribed, 2_000
      FSL.Monitor.subscribe(self())

      ref = Process.monitor(doomed)
      Process.exit(doomed, :kill)
      assert_receive {:DOWN, ^ref, :process, ^doomed, _}, 2_000

      # The survivor still gets everything, and the registry is still up — which
      # is what a push into a dead mailbox would not have disturbed either, so
      # the real assertion is the one below.
      FSL.Monitor.report(slot, "S", "alice", "waiting", "start", nil)
      assert_receive {:fsl_monitor, {:updated, ^slot, _}}, 2_000
      assert Process.alive?(Process.whereis(FSL.Monitor))
    end

    # What actually observes the set: :sys.get_state/1. Reaching into a
    # GenServer's state is not something a test should normally do, and it is the
    # only way to assert an absence — the point of dropping a dead subscriber is
    # precisely that nothing observable happens when you do not.
    test "is gone from the subscriber set", %{slot: slot} do
      test_pid = self()

      doomed =
        spawn(fn ->
          FSL.Monitor.subscribe(self())
          send(test_pid, :subscribed)
          Process.sleep(:infinity)
        end)

      assert_receive :subscribed, 2_000
      assert Map.has_key?(:sys.get_state(FSL.Monitor).subs, doomed)

      ref = Process.monitor(doomed)
      Process.exit(doomed, :kill)
      assert_receive {:DOWN, ^ref, :process, ^doomed, _}, 2_000

      # A synchronous call after the :DOWN: message order to the registry is
      # per-sender, and the monitor's :DOWN was sent by the runtime before this
      # call, so by the time it answers the set is updated.
      FSL.Monitor.report(slot, "S", "alice", "waiting", "start", nil)
      _ = FSL.Monitor.calls()

      refute Map.has_key?(:sys.get_state(FSL.Monitor).subs, doomed)
    end
  end

  describe "unsubscribe/1" do
    test "stops the pushes", %{slot: slot} do
      FSL.Monitor.subscribe(self())
      assert FSL.Monitor.unsubscribe(self()) == :ok

      FSL.Monitor.report(slot, "S", "alice", "waiting", "start", nil)
      refute_receive {:fsl_monitor, _}, 300
    end

    test "on a pid that never subscribed is a no-op" do
      assert FSL.Monitor.unsubscribe(self()) == :ok
    end
  end
end
