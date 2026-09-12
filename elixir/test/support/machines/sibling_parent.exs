# Fixture: a machine that pulls in a sub-machine by bare file name. The file lives
# next to this one, and nowhere near the directory the suite runs from — so this only
# loads if `spawn_fsm` resolves the path against the declaring file (include semantics).
defmodule SpawnFsmFixture.SiblingParent do
  use FSL.Machine

  config(label: "parent")

  state initial_state do
    spawn_fsm("sibling_child.exs", as: :child)
    goto(waiting)
  end

  state waiting do
    on_events do
      {:child_msg, :child, :child_ran} -> scenario_success("child ran")
    after
      2_000 -> scenario_failure("child never reported")
    end
  end
end
