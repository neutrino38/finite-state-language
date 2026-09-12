# A fishing trip, as a finite state machine.
#
#     mix run samples/fishing.exs
#
# Nothing here knows about any protocol: it is `use FSL.Machine` and nothing
# else. Everything the language is for shows up because a fishing trip happens
# to need exactly those things — which is the point of the example rather than a
# coincidence:
#
#   * a **deadline that does not restart** when something happens that is not
#     what you were waiting for (§ `waiting`, the ducks);
#   * `stay`, for an event you react to without starting the state over;
#   * `goto back`, for a detour that returns where it came from;
#   * a **sub-FSM**, because your hands are a separate thing with a reaction
#     time of their own, and the language spawns one as a second process;
#   * a host, in eight lines, because that is all an embedding has to write —
#     here, what a lake event is and how to draw a run.
#
# Run it. It plays a whole trip and prints it as a Mermaid diagram you can paste
# into a GitHub comment.

# ── Your hands, which are not as fast as you think ──────────────────────────
#
# A sub-FSM: its own process, its own mailbox, talking to the trip through
# `{:parent_msg, …}` and `notify_parent/1`. They could have been a function
# call — but a function call cannot take 400 ms without blocking the trip, and
# a machine must never block. So they are a machine.

defmodule Fishing.Hands do
  use FSL.Machine

  state initial_state do
    goto(resting)
  end

  state resting do
    on_events do
      {:parent_msg, :bite} -> goto(reacting)
      {:parent_msg, :go_home} -> scenario_success("hands rested")
    after
      30_000 -> scenario_failure("nobody ever went fishing")
    end
  end

  state reacting do
    # The whole trick of this machine: it does not sleep, it waits. An `after`
    # is a deadline, and the process is free the whole time — which is why a
    # hundred of these can run at once.
    reaction = appdata_get(:reaction_ms)

    on_events do
      # Nothing to hear while reacting; the `after` is the point.
      {:parent_msg, :never} -> stay()
    after
      reaction ->
        notify_parent(:strike)
        # Back to `resting` — wherever we came from. One slot, not a stack.
        goto(back)
    end
  end
end

# ── The host: eight lines, and the only thing an embedding must write ───────
#
# Declared BEFORE the machine that names it, and that is not tidiness: three of
# the twelve callbacks are asked *while the machine compiles* — which event type
# a clause carries, which clauses to inject into every wait, whether the machine
# already handles them. A host defined further down the file does not exist yet
# when those questions are asked, and the machine silently gets the defaults.
#
# Everything the language refuses to decide for itself is a callback here, and a
# host inherits the default for every one it leaves out. A SIP binding answers
# all twelve; a fishing trip answers two.
#
# The second one is the interesting one. FSL classifies its own vocabulary — a
# message from a child, a control message — and asks the embedding about
# everything else, *including what to do with something it has never seen*. Here
# the lake is the protocol, so the host says so, and the diagram grows arrows
# between the angler and the water instead of a column of notes. Delete
# `event_type/1` and run it again: the trip is identical and the drawing is
# duller, which is exactly how much the language depends on knowing a protocol.

defmodule Fishing.Host do
  @behaviour FSL.Host

  @impl true
  def diagram_renderer, do: FSL.Diagram.Mermaid

  @impl true
  def event_type(:bite), do: :lake
  def event_type(:duck), do: :lake
  def event_type(:snag), do: :lake
  def event_type(_anything_else), do: nil
end

# ── The trip itself ─────────────────────────────────────────────────────────

defmodule Fishing.Trip do
  use FSL.Machine, host: Fishing.Host

  # Change these and re-run. `reaction_ms: 600` is an angler who will go home
  # with a story; `quota: 3` is a longer afternoon than the lake has fish for.
  #
  # `label:` and `peer:` are the two keys a renderer reads to name the lanes of
  # the diagram; every other key here is this machine's own business, and the
  # language never looks at any of them.
  config(label: "Bob the angler", peer: "the lake", reaction_ms: 250, quota: 2)

  state initial_state do
    say("#{appdata_get(:label)} arrives. Quota: #{appdata_get(:quota)} fish.")
    appdata_set(:caught, [])

    # Two hands, spawned once, used all trip. `as:` is the name we will match on
    # in every later state — a literal, so a typo is a clause that never fires
    # rather than a variable that silently matches everything.
    spawn_fsm(Fishing.Hands, as: :hands, args: %{reaction_ms: appdata_get(:reaction_ms)})

    goto(next)
  end

  state casting do
    say("A cast. The float settles.")
    goto(waiting)
  end

  state waiting do
    on_events do
      {:bite, fish} ->
        say("Something tugs the line — a #{fish}!")
        appdata_set(:fish_on, fish)
        goto(striking, "a bite")

      # `stay` is the interesting one. A duck is worth noticing and worth
      # nothing else: the state does not start over, so the float is not recast
      # — AND the ten-second patience below is **not** re-armed. Ducks eat your
      # afternoon. That is the whole difference between `stay` and `goto loop`,
      # and a fishing trip is the shortest way to feel it.
      {:duck, name} ->
        say("(#{name} the duck paddles past. You wait.)")
        stay("a duck")

      # A detour that comes back by itself.
      {:snag, thing} ->
        say("The line catches on #{thing}.")
        goto(untangling, "a snag")
    after
      10_000 ->
        say("Ten seconds of nothing. You have the patience of a heron, but not today.")
        goto(packing_up, "patience ran out")
    end
  end

  state striking do
    # Tell the hands to move. They will answer when they answer.
    notify(:hands, :bite)

    on_events do
      {:child_msg, :hands, :strike} ->
        caught = appdata_get(:caught) ++ [appdata_get(:fish_on)]
        appdata_set(:caught, caught)
        say("Hooked! That is #{length(caught)} of #{appdata_get(:quota)}.")

        if length(caught) >= appdata_get(:quota),
          do: goto(packing_up, "quota reached"),
          else: goto(casting, "one more")
    after
      # Strike too late and it is gone. 400 ms is generous; try `reaction_ms:
      # 600` in the config above and watch the trip end badly.
      400 ->
        say("Too slow. It spat the hook and is telling its friends.")
        goto(casting, "missed it")
    end
  end

  state untangling do
    say("You free the line. Nothing was harmed except your afternoon.")
    # Wherever we came from — which is `waiting`, and would be `casting` if a
    # snag could happen there too. The state does not have to know.
    goto(back)
  end

  state packing_up do
    notify(:hands, :go_home)
    caught = appdata_get(:caught)

    case caught do
      [] ->
        say("#{appdata_get(:label)} goes home with a story instead.")
        scenario_failure("skunked")

      fish ->
        say("#{appdata_get(:label)} goes home with: #{Enum.join(fish, ", ")}.")
        scenario_success("#{length(fish)} fish")
    end
  end

  # A trivial one-liner with no meaning of its own — the kind of helper a
  # machine is allowed. Anything that made a *decision* would belong in a verb.
  defp say(line), do: IO.puts("  " <> line)
end

# ── The lake, which is not a state machine at all ───────────────────────────
#
# Just a process with a script, feeding the trip. In a real embedding this is
# where a protocol would be: a socket, a SIP dialog, a WebSocket. FSL never
# knows the difference — an event is an event.

defmodule Fishing.Lake do
  @script [
    {600, {:duck, "Gerald"}},
    {400, {:bite, "perch"}},
    {900, {:snag, "a shopping trolley"}},
    {500, {:duck, "Gerald, again"}},
    {700, {:bite, "pike"}}
  ]

  def start(trip) do
    spawn(fn ->
      Enum.each(@script, fn {delay, event} ->
        Process.sleep(delay)
        send(trip, event)
      end)
    end)
  end
end

# ── Go fishing ──────────────────────────────────────────────────────────────

Logger.configure(level: :warning)
Application.put_env(:fsl, :log_sequence, true)

IO.puts("\n🎣  A fishing trip, as a finite state machine\n")

me = self()

trip =
  spawn(fn ->
    send(me, {:outcome, FSL.Runner.run_instance(Fishing.Trip, appdata: %{probe: me})})
  end)

Fishing.Lake.start(trip)

outcome =
  receive do
    {:outcome, outcome} -> outcome
  after
    30_000 -> :the_machine_got_stuck
  end

IO.puts("\n  → #{inspect(outcome)}\n")

# The journal was on, so the run wrote itself down. Here it is — paste it into
# a GitHub comment and it renders.
case Path.wildcard("Fishing.Trip_*.mmd") do
  [path | _] ->
    IO.puts("Your afternoon, as a diagram (#{path}):\n")
    IO.puts(File.read!(path))
    File.rm(path)

  [] ->
    IO.puts("(no diagram — the journal was off)")
end
