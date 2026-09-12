defmodule FSL.Host do
  @moduledoc """
  What an **embedding** of FSL provides: everything the language refuses to
  decide for itself.

  FSL runs state machines, and that is all it does. It knows states,
  transitions, `on_events` and its selective-receive semantics, `stay`,
  `goto back`, sub-FSMs, cooperative shutdown, service building blocks and the
  journal. It knows nothing about a socket, a session, a protocol or a call.
  Every question that needs such a thing to answer is a callback on this
  behaviour.

  ## The smallest host that is not the default

  Twelve callbacks, **all optional**, and a host inherits `FSL.Host.Default` for
  every one it leaves out. So a real host can be this:

      defmodule Fishing.Host do
        @behaviour FSL.Host

        # Draw a run as Mermaid rather than PlantUML.
        @impl true
        def diagram_renderer, do: FSL.Diagram.Mermaid

        # An event from the lake is a lake event. FSL classifies its own
        # vocabulary and asks the embedding about everything else.
        @impl true
        def event_type(:bite), do: :lake
        def event_type(:duck), do: :lake
        def event_type(_other), do: nil
      end

      defmodule Fishing.Trip do
        use FSL.Machine, host: Fishing.Host
        # …
      end

  That is a complete, working host — `samples/fishing.exs` runs it. It answers
  two questions and inherits ten, which is what "optional" buys.

  ## When each callback is asked

  Grouped by *when*, because that is what decides what a callback may do. The
  three compile-time ones are asked while the machine is being compiled, so the
  host module has to be **defined before the machine that names it** — a host
  further down the same file does not exist yet, and the machine silently gets
  the defaults.

  | When | Callback | The question |
  |---|---|---|
  | compile time | `c:event_type/1` | what kind of event does a clause matching *this* pattern carry? |
  | | `c:injected_clauses/1` | which clauses must every wait carry, whether or not the author thought of them? |
  | | `c:clause_covers?/2` | does a clause the author wrote already cover one of those? |
  | starting a run | `c:bootstrap/0` | what has to be running before any machine can act? |
  | | `c:build_context/1` | what does this machine's `config` block *mean*? |
  | | `c:apply_run_opts/2` | what do the run options this embedding accepts do? |
  | during a run | `c:on_event/2` | what does the embedding do with an event, before the machine's own clause? |
  | | `c:on_state_enter/1` | what must be forgotten when a state is entered? |
  | | `c:account/2` | who is this run about? |
  | | `c:spawn_child/2` | what does a freshly spawned child of this kind need? |
  | ending a run | `c:finalize/1` | what does the embedding hold that must be released? |
  | writing it down | `c:diagram_renderer/0` | how is a run drawn? |

  ## How a host is found

  A machine names it at `use` time, the module records it, and the runner reads
  it back through the generated `__fsl_host__/0`:

      use FSL.Machine, host: MyApp.Host

  No application env and no global configuration, which is deliberate: two
  embeddings coexist in one VM, so a library can run its own machines beside
  yours, and the language is testable against a host that is nobody's protocol
  (`FSL.Test.Host`, in this package's test suite).

  ## A worked example: SIP

  SIP is **one** embedding — the first one, in
  [Elixip](https://github.com/neutrino38/elixip), where this language grew up —
  and it is worth reading as a sanity check on how much a real protocol needs,
  not as a description of what a host must be. `SIP.FSL.Host` is about 380 lines
  and answers eleven of the twelve:

  | Callback | What SIP does |
  |---|---|
  | `c:bootstrap/0` | start the transaction layer, the transport selector, the dialog layer, the session config registry, and the node's auth secret |
  | `c:build_context/1` | route each `config` key to one of three places: a field of its own context struct, the application env for a node-wide setting, or `appdata` |
  | `c:apply_run_opts/2` | read `:dialog_pid` and `:inbound_request` — a server instance does not create the dialog it serves |
  | `c:on_event/2` | record which call leg and which transaction the event came from, answer what a leg that has just died owes, then stash an inbound request where the reply verbs will find it |
  | `c:on_state_enter/1` | forget that leg and that transaction |
  | `c:event_type/1` | a media-server event is `:media`; anything else it is shown is `:sip` |
  | `c:injected_clauses/1` | one clause in every wait: the media server going away |
  | `c:clause_covers?/2` | generously — a clause matching any media event, or a catch-all, counts |
  | `c:account/2` | the identity the inbound request asserts, once, then silence so the script can name a better one |
  | `c:spawn_child/2` | register a child that waits for a call with the call dispatcher |
  | `c:finalize/1` | wind down the call legs, then the media, after a bounded wait for the dialog to end |
  | `c:diagram_renderer/0` | not implemented — the default is the right one |

  The test of whether a seam is in the right place is never "does SIP still
  work": it will, because this code was shaped around it. The test is whether a
  **second** embedding could be written without touching FSL. XMPP, Matrix and
  the frameworks behind chat bots are the candidates that were used to check;
  none of them has a dialog or a transaction, and two of them have no notion of
  a call at all.
  """

  @doc """
  Start whatever the binding's verbs need before any machine runs. Idempotent:
  it is called once per run, and several runs share one process tree.

  Returns `:ok`. A binding with nothing to start says so by not implementing it.
  """
  @callback bootstrap() :: :ok

  @doc """
  Build the initial context from the scenario's `config` block.

  The keyword list is the `config` of the scenario module, with any run-time
  overrides already merged on top. What a binding does with a key is entirely
  its business — a native property of its own context struct, a value routed
  somewhere else entirely, or `appdata`, which is where the default host puts
  everything.
  """
  @callback build_context(config :: keyword()) :: FSL.Context.t()

  @doc """
  Who is this run about? The `account` column of `FSL.Monitor`, which is what an
  operator scans a live table by.

  Called with the context and `:initial` for the first row of a run, then
  `:subsequent` for every one after it — and **an empty string means "keep what
  you have"**, which is why the distinction exists. SIP answers the identity the
  inbound request asserts for the first row of a server instance and then keeps
  quiet, so a script that learns a better name (the address it registered, the
  conference it joined) can set it without every later transition clobbering it.

      @impl true
      def account(ctx, :initial), do: FSL.Context.appdata_get(ctx, :label) || ""
      def account(_ctx, :subsequent), do: ""

  A host that has nothing to say leaves the column empty by not implementing
  this.
  """
  @callback account(ctx :: FSL.Context.t(), phase :: :initial | :subsequent) :: String.t()

  @doc """
  Prepare a child machine that `spawn_fsm` has just started, given the **kind**
  its module declared and its pid.

  The kind is an opaque term as far as FSL is concerned: whatever an embedding's
  own annotation put in `__scenario_type__/0`. A child that does nothing until
  something is routed to it has to be registered somewhere, and this is where.

  SIP writes `:uac`, `:uas_register` and `:uas_invite` there; a `:uas_invite`
  child waits for an inbound call, so that host registers it with the call
  dispatcher and installs the dispatcher as the call-processing module. A
  language that knew those three atoms would be a language that knows about
  server roles in a protocol.
  """
  @callback spawn_child(kind :: term(), pid :: pid()) :: :ok

  @doc """
  Release what the embedding holds for this run, and return the context.

      @impl true
      def finalize(ctx) do
        case FSL.Context.appdata_get(ctx, :connection) do
          nil -> ctx
          conn -> close(conn) && FSL.Context.appdata_set(ctx, :connection, nil)
        end
      end

  **One callback rather than one per resource**, because when an embedding holds
  several the order between them is its own rule and has to stay in one place:
  SIP releases its call legs before its media — a leg left behind holds the call
  up at the far end, and it is the leg that carries the media — and waits,
  bounded, for the dialog to end first.

  *Where* this step sits among the others — after the children, before
  `cleanup/1`, before the parent is told — is the machine's, and stays in
  `FSL.Runner`.
  """
  @callback finalize(ctx :: FSL.Context.t()) :: FSL.Context.t()

  @doc """
  Apply the `run_instance/2` options the machine has no reading of, and return
  the context.

  FSL owns `:parent_pid`, `:self_name`, `:appdata`, `:slot_id` and
  `:config_overrides`, and applies those itself. Everything else a caller passes
  names something only the embedding understands, and arrives here:

      FSL.Runner.run_instance(MyMachine, connection: conn)

      @impl true
      def apply_run_opts(ctx, opts) do
        case Keyword.get(opts, :connection) do
          nil -> ctx
          conn -> FSL.Context.appdata_set(ctx, :connection, conn)
        end
      end

  SIP reads two: the dialog an inbound request already created — a server
  instance does not create the one it serves — and the request itself, whose
  presence is also what tells that host this run is a server instance at all.

  A host with no options of its own inherits the default, which returns the
  context untouched.
  """
  @callback apply_run_opts(ctx :: FSL.Context.t(), opts :: keyword()) :: FSL.Context.t()

  @doc """
  Act on an event the machine has just received, **before** the machine's own
  clause runs, and return the context that clause will see.

  Called for every matched event, including the ones FSL injects itself, so an
  embedding sees the whole stream. This is where bookkeeping that must happen
  whatever the machine decides belongs — noting where an event came from,
  answering something that is owed, unpacking a message into the context.

      @impl true
      def on_event(ctx, {:bite, fish}), do: FSL.Context.appdata_set(ctx, :fish_on, fish)
      def on_event(ctx, _other), do: ctx

  **One callback and not three**, because when a host does several things here
  the order between them is usually load-bearing, and one function is where an
  order can be read. SIP's does three: it records which call leg and transaction
  the event came from (so a clause replying to it needs no direction argument),
  then answers what a leg that has just died owes — at once, so a caller hears
  about its callee going away now rather than at the teardown — and only then
  stashes an inbound request where the reply verbs will find it. Spread over
  three injected calls, that sequence lived in the expansion of a macro.
  """
  @callback on_event(ctx :: FSL.Context.t(), event :: term()) :: FSL.Context.t()

  @doc """
  Forget whatever the last event left behind, because a state has just been
  entered. Returns the context.

  The mirror of `c:on_event/2`: anything the embedding remembered *about the
  event* stops being true the moment the machine moves on. FSL clears its own
  per-event bookkeeping either way; this is for the embedding's.

  SIP forgets which leg and which transaction the matched event came from, so an
  `after` body — which no event caused — acts on the inbound leg rather than on
  whatever the previous state happened to match.
  """
  @callback on_state_enter(ctx :: FSL.Context.t()) :: FSL.Context.t()

  @doc """
  What kind of event does a clause matching this pattern carry? Asked at
  **macro-expansion time**, with the first element of the pattern.

      # a clause `{:bite, fish} -> …` asks with `:bite`
      @impl true
      def event_type(:bite), do: :lake
      def event_type(:duck), do: :lake
      def event_type(_other), do: nil

  The type travels with the transition into the live registry and the sequence
  diagram, where it decides **which lane an arrow is drawn from**: `:media` goes
  to the media lane, a handful of types that came from nowhere become a note,
  and anything else is drawn as coming from the peer (`FSL.Diagram`).

  FSL classifies what it owns — its own inter-FSM messages, its control
  protocol, a service block's declared namespace — and asks here about
  everything else, **including the fallback**. That last part is the whole
  reason this is not the language's: SIP answers `:sip` for any leading atom it
  is shown, and "an unrecognised event came from the peer" is a sentence about a
  protocol with a peer in it, not about state machines.

  `element` is quoted AST, not a value: a bound variable in the pattern arrives
  as `{name, meta, context}`, so `def event_type({_, _, _}), do: :something` is
  how a catch-all clause is typed. Answer `nil` for anything with nothing to
  say.
  """
  @callback event_type(element :: Macro.t()) :: atom() | nil

  @doc """
  Clauses to prepend to **every** `on_events` wait, as `{name, quoted_clause}`.

  This is for an embedding's **failure domains**: something that can go wrong,
  that is delivered to every machine, and that a machine which never considered
  it would otherwise sit and wait through.

      @impl true
      def injected_clauses(ctx) do
        [
          {:lake_froze,
           quote do
             {:lake, :froze} ->
               {:goto, :__shutdown__, "the lake froze", :lake, unquote(ctx)}
           end
           |> hd()}
        ]
      end

  `ctx` is the context variable of the machine being compiled, already quoted,
  so a clause hands the context back without knowing what this particular
  machine calls it.

  SIP injects one: the media server going away. That event is delivered to every
  sink and acted upon by nothing, so a scenario with no clause for it waits for
  media that cannot come until its own `after` fires — if it has one. FSL
  injects its own cooperative-shutdown clause and a service block's deadline,
  and neither is an embedding's business.

  Asked at expansion time. Every injected clause must **leave the state** by
  construction, which is what lets it be instrumented without the `stay` rewrite
  and produce no dead branch.
  """
  @callback injected_clauses(ctx :: Macro.t()) :: [{atom(), Macro.t()}]

  @doc """
  Does a clause the machine wrote itself already cover the injected clause called
  `name`? If so that injection is dropped and the machine keeps control.

  `pattern` is the quoted pattern of one of the machine's own clauses, `when`
  guard stripped, and the question is asked clause by clause:

      @impl true
      def clause_covers?(:lake_froze, {:lake, _anything}), do: true
      def clause_covers?(_name, _pattern), do: false

  **Be generous.** An injected clause is a default for machines that never
  considered the case, not a rule to overrule those that did — so a clause
  matching the whole family, or a catch-all, should count. Erring that way leaves
  the author in charge, which is the safe direction.

  FSL's own cooperative-shutdown clause is **not** governed by this, and the
  asymmetry is deliberate: only an explicit `:scenario_ctl` clause opts out of
  being stoppable. A machine that merely writes `event -> …` has not thereby
  declined to be stopped, and one that could not be stopped would be a node that
  cannot drain.
  """
  @callback clause_covers?(name :: atom(), pattern :: Macro.t()) :: boolean()

  @doc """
  How is a run drawn? A module implementing `FSL.Diagram`.

  Two ship: `FSL.Diagram.PlantUML` (the default) and `FSL.Diagram.Mermaid`,
  which renders in a GitHub comment with no toolchain. An embedding that wants
  its own writes `render/2` and `filename/1`.

      @impl true
      def diagram_renderer, do: FSL.Diagram.Mermaid

  Neither shipped renderer knows a protocol: the lane rule is by exclusion, so a
  type this host answered `c:event_type/1` with — one the renderer has never
  heard of — is still drawn as coming from the peer.
  """
  @callback diagram_renderer() :: module()

  @optional_callbacks bootstrap: 0,
                      diagram_renderer: 0,
                      apply_run_opts: 2,
                      build_context: 1,
                      account: 2,
                      spawn_child: 2,
                      finalize: 1,
                      on_event: 2,
                      on_state_enter: 1,
                      event_type: 1,
                      injected_clauses: 1,
                      clause_covers?: 2

  @doc """
  The host a scenario module declared, or `FSL.Host.Default` when it declared
  none.

  Read off the module rather than out of a configuration key, so two bindings
  can run side by side in one VM — which is what lets FSL's own suite run
  against a host that is not SIP's.
  """
  @spec of(module()) :: module()
  def of(module) do
    with true <- function_exported?(module, :__fsl_host__, 0),
         host when is_atom(host) and not is_nil(host) <- module.__fsl_host__() do
      host
    else
      _none -> FSL.Host.Default
    end
  end

  @doc """
  Call `fun` on a module's host, or answer `default` when it does not implement
  it.

  On the path of every transition — `c:account/2` is asked once per report — so
  `function_exported?/3` is tried first, on its own: it is a lookup in the
  already-loaded module. `Code.ensure_loaded?/1` is the fallback and not the
  first test, because a host is only *not* loaded once (a binding shipped in a
  kelixip `module_dir` is loaded on first use), and paying for the code server on
  every transition to cover that once is how a hook becomes a cost.
  """
  @spec call(module(), atom(), [term()], term()) :: term()
  def call(module, fun, args, default), do: hook(of(module), fun, args, default)

  @doc """
  Same, on a host that is already known — which is the case inside a macro, where
  the scenario's host was read off the module at expansion time.

  `Code.ensure_compiled/1` and not `ensure_loaded/1` in the fallback: some of
  these hooks are asked *while the compiler is running*, and a host being
  compiled in the same pass has to be waited for rather than declared absent.
  That is what `ensure_compiled/1` does, and it is the whole reason a
  compile-time hook can be trusted.
  """
  @spec hook(module(), atom(), [term()], term()) :: term()
  def hook(host, fun, args, default) do
    arity = length(args)

    cond do
      exports?(host, fun, arity) ->
        apply(host, fun, args)

      # A host implements what it needs and inherits the rest. `FSL.Host.Default`
      # is what "the rest" means — not the literal the call site passes, which is
      # only reached when the default host has nothing to say either.
      #
      # This is not a nicety: `c:build_context/1` is the one callback whose
      # default does real work, and a host that implemented, say, only
      # `c:diagram_renderer/0` used to get an empty `%FSL.Context{}` here — its
      # machine's whole `config` block dropped on the floor, silently, with the
      # first `appdata_get/1` answering nil.
      host != FSL.Host.Default and exports?(FSL.Host.Default, fun, arity) ->
        apply(FSL.Host.Default, fun, args)

      true ->
        default
    end
  end

  # `function_exported?/3` first and on its own — a lookup in an already-loaded
  # module — with `Code.ensure_compiled/1` behind it, because some of these hooks
  # are asked while the compiler is running and a host being compiled in the same
  # pass has to be waited for rather than declared absent.
  defp exports?(module, fun, arity) do
    function_exported?(module, fun, arity) or
      (match?({:module, _}, Code.ensure_compiled(module)) and
         function_exported?(module, fun, arity))
  end
end

defmodule FSL.Host.Default do
  @moduledoc """
  The host of a state machine that embeds no protocol: a plain `%FSL.Context{}`,
  nothing to start, no hooks.

  It is not a placeholder. It is what `use FSL.Machine` gets when it names no
  host, what FSL's own test suite runs against, and the worked example the
  documentation needs — so it is written once and used three times.
  """
  @behaviour FSL.Host

  @impl true
  def bootstrap, do: :ok

  @doc """
  Everything the `config` block carries goes into `appdata`.

  A machine with no protocol has no native properties to speak of, and guessing
  which keys deserve a field of their own is the binding's job, not the
  language's.
  """
  @impl true
  def build_context(config) do
    Enum.reduce(config, %FSL.Context{}, fn {key, value}, ctx ->
      FSL.Context.appdata_set(ctx, key, value)
    end)
  end
end
