defmodule FSL.BlockCleanupTest do
  @moduledoc """
  A block's `cleanup/1` runs on **every** way out, which is the whole reason the
  hook exists.

  Without it, every branch of every block had to remember to release what the
  block reserved — and a branch that forgot leaked with nothing in the log,
  because a machine's own `cleanup/1` does not know what a block took. The
  interesting exits are therefore not the happy one but the four that abandon a
  block mid-flight: its own deadline, a terminal written inside it, a
  cooperative shutdown passing through, and an *enclosing* block's deadline.

  Each block below reserves one observable thing — a message it owes the test —
  and releases it in `cleanup/1`. A test that never receives it is a leak.
  """
  use ExUnit.Case, async: false

  # ── Blocks ──────────────────────────────────────────────────────────────────

  defmodule Returns do
    use FSL.Block

    @sbb_namespace :ret
    @sbb_returns [done: "handed control back — %{}"]

    state initial_state do
      sbb_return({:ret, :done, %{}})
    end

    def cleanup(ctx) do
      send(FSL.Context.appdata_get(ctx, :probe), {:cleaned, :returns})
      FSL.Context.appdata_set(ctx, :released, true)
    end
  end

  defmodule TimesOut do
    use FSL.Block

    @sbb_namespace :slow
    @sbb_returns [never: "unreachable — %{}"]
    @sbb_timeout 60

    state initial_state do
      on_events do
        {:never, _} -> sbb_return({:slow, :never, %{}})
      end
    end

    def cleanup(ctx) do
      send(FSL.Context.appdata_get(ctx, :probe), {:cleaned, :times_out})
      ctx
    end
  end

  defmodule Fails do
    use FSL.Block

    @sbb_namespace :fails
    @sbb_returns [never: "unreachable — %{}"]

    state initial_state do
      scenario_failure("the block decided to stop everything")
    end

    def cleanup(ctx) do
      send(FSL.Context.appdata_get(ctx, :probe), {:cleaned, :fails})
      ctx
    end
  end

  defmodule WaitsForShutdown do
    use FSL.Block

    @sbb_namespace :waits
    @sbb_returns [never: "unreachable — %{}"]
    @sbb_timeout :infinity

    state initial_state do
      on_events do
        {:never, _} -> sbb_return({:waits, :never, %{}})
      end
    end

    def cleanup(ctx) do
      send(FSL.Context.appdata_get(ctx, :probe), {:cleaned, :waits})
      ctx
    end
  end

  # An inner block with no deadline of its own, entered by an outer block that
  # has one: the outer deadline unwinds through the inner, abandoning it.
  defmodule Inner do
    use FSL.Block

    @sbb_namespace :inner
    @sbb_returns [never: "unreachable — %{}"]
    @sbb_timeout :infinity

    state initial_state do
      on_events do
        {:never, _} -> sbb_return({:inner, :never, %{}})
      end
    end

    def cleanup(ctx) do
      send(FSL.Context.appdata_get(ctx, :probe), {:cleaned, :inner})
      ctx
    end
  end

  defmodule Outer do
    use FSL.Block

    @sbb_namespace :outer
    @sbb_returns [never: "unreachable — %{}"]
    @sbb_timeout 60

    state initial_state do
      sbb_fsm(Inner)
      sbb_return({:outer, :never, %{}})
    end

    def cleanup(ctx) do
      send(FSL.Context.appdata_get(ctx, :probe), {:cleaned, :outer})
      ctx
    end
  end

  # A cleanup that raises must not turn a clean return into an exception.
  defmodule Explodes do
    use FSL.Block

    @sbb_namespace :boom
    @sbb_returns [done: "returned fine — %{}"]

    state initial_state do
      sbb_return({:boom, :done, %{}})
    end

    def cleanup(_ctx), do: raise("cleanup is broken")
  end

  # A block with no cleanup at all: the context must pass through untouched.
  defmodule NoCleanup do
    use FSL.Block

    @sbb_namespace :plain
    @sbb_returns [done: "— %{}"]

    state initial_state do
      sbb_return({:plain, :done, %{}})
    end
  end

  # ── Hosts ───────────────────────────────────────────────────────────────────

  defmodule Host do
    use FSL.Machine

    state initial_state do
      sbb_fsm(appdata_get(:block))
      goto(waiting)
    end

    state waiting do
      on_events do
        {_ns, _outcome, _data} ->
          send(appdata_get(:probe), {:host_saw, appdata_get(:released)})
          scenario_success("block returned")
      after
        5_000 -> scenario_failure("the block never handed control back")
      end
    end

    on_shutdown do
      send(appdata_get(:probe), {:host_shutdown, fsl_ctx.currentstate})
      scenario_aborted("asked to stop")
    end
  end

  defp run(block) do
    test_pid = self()

    spawn(fn ->
      send(
        test_pid,
        {:done, FSL.Runner.run_instance(Host, appdata: %{probe: test_pid, block: block})}
      )
    end)
  end

  # ── The five exits ──────────────────────────────────────────────────────────

  test "on sbb_return, and the context it returns reaches the host" do
    run(Returns)

    assert_receive {:cleaned, :returns}, 5_000
    # The cleanup's return is threaded: what a block released is cleared in the
    # host's context, which is where it lived.
    assert_receive {:host_saw, true}, 5_000
    assert_receive {:done, :ok}, 5_000
  end

  test "on the block's own deadline" do
    run(TimesOut)

    assert_receive {:cleaned, :times_out}, 5_000
    # …and the host still gets its `{namespace, :timeout, …}`, as before.
    assert_receive {:host_saw, _}, 5_000
    assert_receive {:done, :ok}, 5_000
  end

  test "on a terminal written inside the block, which still reaches the root" do
    run(Fails)

    assert_receive {:cleaned, :fails}, 5_000
    assert_receive {:done, {:error, "the block decided to stop everything"}}, 5_000
  end

  test "on a cooperative shutdown, which still winds down into the host" do
    pid = run(WaitsForShutdown)
    # Let the host enter the block before asking it to stop.
    Process.sleep(50)
    send(pid, {:scenario_ctl, :shutdown, :operator})

    assert_receive {:cleaned, :waits}, 5_000
    # The host's own on_shutdown still runs: the wind-down continues past the
    # block rather than ending there.
    assert_receive {:host_shutdown, _state}, 5_000
    assert_receive {:done, {:aborted, "asked to stop"}}, 5_000
  end

  test "on an enclosing block's deadline, for the inner block too" do
    run(Outer)

    # The inner block is abandoned by a deadline it did not arm, and cleans up
    # all the same — the exit the old code could not have caught at all.
    assert_receive {:cleaned, :inner}, 5_000
    assert_receive {:cleaned, :outer}, 5_000
    assert_receive {:done, :ok}, 5_000
  end

  # ── Tolerance ───────────────────────────────────────────────────────────────

  test "a cleanup that raises is logged and does not break the return" do
    import ExUnit.CaptureLog

    log =
      capture_log(fn ->
        run(Explodes)
        assert_receive {:host_saw, _}, 5_000
        assert_receive {:done, :ok}, 5_000
      end)

    assert log =~ "cleanup/1 of"
    assert log =~ "cleanup is broken"
  end

  test "a block with no cleanup passes its context through" do
    run(NoCleanup)

    assert_receive {:host_saw, nil}, 5_000
    assert_receive {:done, :ok}, 5_000
    refute_receive {:cleaned, _}, 200
  end
end
