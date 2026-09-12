defmodule FSL.LoaderTest do
  @moduledoc """
  `FSL.Loader`: turning a name or a file into a machine module.

  Two entry points exist on purpose. A machine compiled into a binary runs by
  **module name** with no file present; an editable `.exs` is loaded by **path**,
  at run time, from wherever an operator keeps it. The second is why the whole
  extraction had to keep every name it inherited: a file loaded at run time gives
  no compiler a chance to catch a rename.

  What the loader must get right, and each of these has a failure mode with
  nothing in the log:

    * it picks the module that is a **machine**, not the first module in the
      file — a service building block declared above one would otherwise be run
      *as* the machine;
    * it refuses a module that is not one, by name, rather than crashing later
      on a missing `__scenario_states__/0`;
    * `scenario_type/1` reads the opaque slot and has **no opinion** about what
      an absent one means. That is the binding's (SIP reads `nil` as `:uac`).
  """
  use ExUnit.Case, async: true

  @tmp Path.join(System.tmp_dir!(), "fsl-loader-test")

  setup do
    File.mkdir_p!(@tmp)
    on_exit(fn -> File.rm_rf!(@tmp) end)
    :ok
  end

  defp write!(name, source) do
    path = Path.join(@tmp, name)
    File.write!(path, source)
    path
  end

  describe "load_module!/1" do
    defmodule Known do
      use FSL.Machine

      state initial_state do
        scenario_success("x")
      end
    end

    test "resolves a compiled machine by name" do
      assert FSL.Loader.load_module!("FSL.LoaderTest.Known") == Known
    end

    test "raises for a name nothing answers to" do
      assert_raise RuntimeError, ~r/not available/, fn ->
        FSL.Loader.load_module!("No.Such.Machine")
      end
    end

    test "raises for a module that exists but is not a machine" do
      assert_raise RuntimeError, ~r/not a FSL.Machine/, fn ->
        FSL.Loader.load_module!("Enum")
      end
    end
  end

  describe "load_file!/1" do
    test "compiles an .exs and returns its machine" do
      path =
        write!("simple.exs", """
        defmodule Loaded.Simple do
          use FSL.Machine

          state initial_state do
            scenario_success("loaded")
          end
        end
        """)

      module = FSL.Loader.load_file!(path)
      assert module == Loaded.Simple
      assert :initial_state in module.__scenario_states__()
      assert module.run(false) == :ok
    end

    # The rule §6.6 of the design states, and the reason a block defines no
    # `run/1`: the loader takes the first module exporting both `run/1` and
    # `__scenario_states__/0`, so a block declared ABOVE the machine in the same
    # file would otherwise be loaded and run as the machine — a file that
    # executes the wrong half of itself, silently.
    test "skips a service building block declared above the machine" do
      path =
        write!("with_block.exs", """
        defmodule Loaded.Block do
          use FSL.Block

          @sbb_namespace :helper
          @sbb_returns [done: "— %{}"]

          state initial_state do
            sbb_return({:helper, :done, %{}})
          end
        end

        defmodule Loaded.WithBlock do
          use FSL.Machine

          state initial_state do
            scenario_success("the machine ran, not the block")
          end
        end
        """)

      assert FSL.Loader.load_file!(path) == Loaded.WithBlock
    end

    test "raises for a file that defines no machine at all" do
      path =
        write!("no_machine.exs", """
        defmodule Loaded.Nothing do
          def hello, do: :world
        end
        """)

      assert_raise RuntimeError, ~r/No .*machine|not a/i, fn ->
        FSL.Loader.load_file!(path)
      end
    end
  end

  describe "scenario_type/1" do
    defmodule Plain do
      use FSL.Machine

      state initial_state do
        scenario_success("x")
      end
    end

    defmodule NotAMachine do
      def hello, do: :world
    end

    # The slot is opaque and its default is `nil`. What "declared nothing" means
    # is the binding's to decide — SIP reads it as `:uac`, in
    # `SIP.Scenario.Loader`, because `uac` is a role name in a protocol.
    test "answers the opaque slot, and nil when nothing wrote in it" do
      assert FSL.Loader.scenario_type(Plain) == nil
      assert FSL.Loader.scenario_type(NotAMachine) == nil
    end

    test "answers whatever a binding's annotation put there" do
      defmodule Annotated do
        use FSL.Machine

        @scenario_type :something_only_a_binding_knows

        state initial_state do
          scenario_success("x")
        end
      end

      assert FSL.Loader.scenario_type(Annotated) == :something_only_a_binding_knows
    end
  end
end
