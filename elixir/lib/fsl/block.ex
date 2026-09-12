defmodule FSL.Block do
  @moduledoc """
  Declares a **service building block**: a reusable fragment of a flow, written
  in FSL, that other machines call.

  A block is the **subroutine** of the language. A machine enters one from a
  state; the block then runs a machine of its own, in the caller's process, until
  it hands control back by returning one event. Use it for a sequence that
  several machines need and none of them should have to get right twice —
  establishing a call, running a menu, collecting credentials.

  Contrast with `spawn_fsm`, which starts a second machine in a process of its
  own: a block has no concurrency and no mailbox of its own, and the caller is
  suspended at the call site until it returns.

  ## Writing one

      defmodule MyApp.Confirming do
        use FSL.Block

        @sbb_namespace :confirm
        @sbb_returns [
          accepted: "the far end agreed — %{}",
          declined: "it said no — %{reason}"
        ]

        @sbb_args [prompt: "what to ask"]
        @sbb_timeout 30_000

        state initial_state do
          notify_parent({:asking, sbb_data_get(:prompt)})
          goto waiting
        end

        state waiting do
          on_events do
            {:parent_msg, :yes} -> sbb_return({:confirm, :accepted, %{}})
            {:parent_msg, {:no, why}} -> sbb_return({:confirm, :declined, %{reason: why}})
          end
        end
      end

  ## Calling one

  `sbb_fsm/2` enters the block; the event it returns is matched in the
  `on_events` that follows, like any other event:

      state asking_the_user do
        sbb_fsm MyApp.Confirming, prompt: "Delete everything?"

        on_events do
          {:confirm, :accepted, _data} ->
            goto deleting, "confirmed"

          {:confirm, :declined, %{reason: why}} ->
            goto cancelled, "declined: \#{why}"

          # Bounded blocks add `:timeout` to their vocabulary, so this arm always
          # exists and the caller needs no `after` clause of its own.
          {:confirm, :timeout, _data} ->
            goto cancelled, "no answer"
        end
      end

  Two rules the compiler enforces at the call site:

    * **`sbb_fsm` belongs in a state body, not in an `on_events` clause.** A
      clause's deadline is absolute, so a block called from one would spend the
      caller's remaining time while it ran;
    * **an outcome the block did not declare is a compile error**, so a typo
      cannot become a caller waiting on a deadline for an event nobody will send.

  Keys declared in `@sbb_args` are written plainly at the call site, as above;
  `args: %{prompt: "…"}` is the same thing spelled as a map. A key the block does
  not declare raises rather than becoming a sandbox entry nobody reads.

  ## What a block returns

  Every block returns **`{namespace, outcome, data}`** — the namespace it
  declares, an outcome atom, and a map. The shape is fixed so that a block can
  learn to report one more thing without breaking a host that matches it: a new
  key in `data` is invisible to whoever does not read it, where a fifth tuple
  element would be a compile error in every caller.

  `@sbb_returns` declares that vocabulary, and it is enforced rather than
  documentary: `sbb_return/1` refuses an outcome that is not in it, at compile
  time. `@sbb_namespace` defaults to the block's last name segment, underscored.

  When the block is bounded (the default), `:timeout` is added to the vocabulary
  for free and `{namespace, :timeout, %{block: module}}` is what the host
  receives on expiry, unless `@sbb_timeout_event` says otherwise.

  ## What a block takes

  `@sbb_args` declares the keys a caller may seed the sandbox with, and it is no
  more decoration than `@sbb_returns`: a call site names them plainly —
  `authenticate(realm: "example.com")`, `call(peer: peer)` — and a key no block
  declares raises instead of becoming a sandbox entry nobody reads. `args: %{…}`
  is the same thing spelled as a map, and both may be mixed.

  ## What a block is, exactly

  The same language as any machine — same `state`, same `on_events`, and whatever
  verbs the binding brought — with two differences:

    * it gains `sbb_return/1`, `sbb_data_get/1` and `sbb_data_set/2`;
    * it has **no `run/1`**, so it can never be mistaken for the machine of the
      `.exs` file that declares it. `FSL.Loader` picks the first module exporting
      `run/1`, and a block declared above the machine in the same file would
      otherwise be loaded and run *as* that machine.

  It runs in the **calling machine's own process**, on that machine's own
  mailbox and resources: a block observes and acts on what its host is doing,
  which is what separates it from `spawn_fsm/2` and its independent child.
  Terminals written inside a block (`scenario_failure`, `scenario_aborted`) keep
  their ordinary meaning and tear the host down too.

  `:ctx_var` and `:host` are passed through to `FSL.Machine`, so an application's
  facade declares them once for its blocks as it does for its machines.

  ## `cleanup/1` — a block releases what it reserved, on every way out

  A block may define `cleanup/1`. It runs on **every** exit from the block, not
  only on the happy one:

  | Leaving by | `cleanup/1` runs |
  |---|---|
  | `sbb_return/1` | yes |
  | the block's own deadline | yes |
  | a terminal written inside it (`scenario_failure`, `scenario_aborted`) | yes, then the terminal continues to the root |
  | a cooperative shutdown reaching it | yes, then the wind-down continues into the host |
  | an **enclosing** block's deadline passing through | yes — this block is abandoned too |

  That last column is the point. A block is a subroutine of a machine that is
  often dying: "the host is tearing down anyway" is not a reason to skip the
  release, because the host's own `cleanup/1` does not know what a block took.
  Without this, every branch of every block had to remember — and a branch that
  forgot leaked with nothing in the log, which is exactly the silence this layer
  exists to remove.

  It runs **while the block is still on the reporting stack**, so a command it
  issues is attributed to the block rather than to the host state control is
  about to return to.

  Unlike a machine's `cleanup/1`, whose return the runner discards, a block's is
  **threaded**: what a block reserved lives in the *host's* context, so releasing
  it means clearing it there.

      def cleanup(ctx) do
        case sbb_data_get_in(ctx, :handle) do
          nil -> ctx
          h -> release(h) && FSL.Context.appdata_set(ctx, :handle, nil)
        end
      end

  A block that has nothing to hand back writes `:ok`; anything that is not a
  context is ignored and the context passes through unchanged. And a `cleanup/1`
  that raises is logged and swallowed: it runs on the failure path, so it must
  not turn a clean return into an exception nor swallow a terminal on its way to
  the root.

  The hook is the one the TypeScript dialect had first; the cross-language spec
  recorded it as a commitment this side owed (`spec/fsl-js-ts.md` §12.4).

  Design: `docs/design.md` §6.
  """

  defmacro __using__(opts) do
    quote do
      # The completion bound every block carries (S7): a block that never
      # returns would leave its host waiting on an `after` for a subroutine that
      # is not coming. 32 s is inherited from SIP's timer B — the limit a silent
      # callee leaves — and is as good a default as any for a bound that exists
      # to be overridden per block and per call site.
      @sbb_timeout 32_000

      # The vocabulary. The namespace defaults to the block's last name segment,
      # underscored — `MyApp.Confirming` gives `:confirming` — which is right for
      # a block named after what it does, and overridden by one line when it is
      # not: `SBB.Call.Establish` and `SBB.Call.Bridge` speak `:call` and
      # `:bridge`, after the verb the scenario writes, not after their own name.
      @sbb_namespace __MODULE__
                     |> Module.split()
                     |> List.last()
                     |> Macro.underscore()
                     |> String.to_atom()

      # Outcome -> what it means. Declaring it is what lets sbb_return/1 reject a
      # typo at compile time, and what a host can be told it has not handled.
      @sbb_returns []

      # The `args` keys a caller may name at the call site, read inside the block
      # with `sbb_data_get/1`. Declaring them is what lets `sbb_fsm/2` accept them
      # written plainly — `authenticate(realm: "example.com")` — and refuse a key
      # the block does not read. Keys the block only writes for itself
      # (`sbb_data_set/2`) are scratch and do not belong here.
      @sbb_args []

      # Overrides the `{namespace, :timeout, %{block: module}}` the mechanism
      # sends on expiry. Rarely needed: the default already follows the contract.
      @sbb_timeout_event nil

      use FSL.Machine, unquote(Keyword.put(opts, :kind, :sbb))
    end
  end
end
