defmodule FSL.Context do
  @moduledoc """
  The state a machine keeps about itself, and the macros a state body reads and
  writes it with.

  Every machine has a context. `%FSL.Context{}` is the one a machine gets when
  the application supplies none, and it holds six fields the engine needs.

  ## Extending it

  An application does not hand FSL a context of its own: it **extends** FSL's.
  Build the struct from `fields/0` and add whatever a session of the application
  holds:

      defmodule MyApp.Context do
        @after_compile FSL.Context
        defstruct FSL.Context.fields() ++ [endpoint: nil, connection: nil, user: nil]
      end

  `@after_compile FSL.Context` turns a `defstruct` that forgot `fields/0` into a
  compile error rather than a crash on the first transition.

  The six fields are the machine's own bookkeeping; the application's are the
  guests. That is the direction, and it is worth stating because the file layout
  suggests the opposite: a machine keeps state about *itself* whether or not
  there is an application around it, and nothing the application adds is
  anything FSL reads.

  ## The six fields

  | Field | Written by | Read by |
  |---|---|---|
  | `lasterr` | the application's verbs | every transition macro |
  | `errorreason` | `scenario_failure/1` | `cleanup/1`, the host |
  | `currentstate` | the runner, on entering a state | the machine, the host |
  | `laststate` | the runner, only on a real state change | `goto back` |
  | `parent_pid` | `spawn_fsm`, `run_instance/2` | the parent notifications |
  | `appdata` | `appdata_set`, the sub-FSM and SBB bookkeeping | everything |

  `lasterr` is the one field an application writes and FSL reads — the channel that
  lets a verb report an error and a scenario stay readable without an `if` after
  every call. The other five are FSL's alone.

  ## Why the names are unspaced

  `lasterr`, `errorreason`, `currentstate` and `laststate` are where Elixir style
  would write `last_error`, `error_reason`, `current_state`, `last_state`.
  Renaming them is refused, and not out of nostalgia: deployed scripts read
  `sip_ctx.lasterr` off the struct, a struct field takes no deprecated alias, and
  the failure would be a node that does not start rather than a warning. FSL
  adopts the names it inherits. Changing them is a major version with a
  migration, never a side effect of moving files.

  ## Writing them

  FSL writes these fields with `put/3`, and deliberately not through an
  application's own setter, which would validate properties FSL has no business
  knowing about. The guards in `put/3` are the machine's own invariants and
  nothing else: a state name is an atom, a failure reason is a string, a parent
  is a pid or `nil`, and `lasterr` takes any term because it carries whatever a
  verb failed with.
  """

  @fields [
    lasterr: :ok,
    errorreason: "",
    currentstate: nil,
    laststate: nil,
    parent_pid: nil,
    appdata: %{}
  ]

  defstruct @fields

  @keys Keyword.keys(@fields)

  @typedoc """
  Any struct carrying the six fields — `%FSL.Context{}` itself, or a binding's
  context extending it. FSL never matches on `%FSL.Context{}`: it reads the six
  fields by name, so a binding's own struct travels everywhere its own.
  """
  @type t :: struct()

  @doc """
  The six fields with their defaults, as a keyword list to splice into a
  binding's `defstruct`.
  """
  @spec fields() :: keyword()
  def fields, do: @fields

  @doc "The six field names."
  @spec keys() :: [atom()]
  def keys, do: @keys

  @doc """
  Write one of the six fields.

  Raises for any other key: a context property that is not the FSM's is the
  binding's business, and writing it here would bypass whatever the binding
  validates about it.
  """
  @spec put(t(), atom(), term()) :: t()
  def put(ctx, :currentstate, value) when is_atom(value), do: Map.put(ctx, :currentstate, value)
  def put(ctx, :laststate, value) when is_atom(value), do: Map.put(ctx, :laststate, value)
  def put(ctx, :errorreason, value) when is_binary(value), do: Map.put(ctx, :errorreason, value)
  def put(ctx, :lasterr, value), do: Map.put(ctx, :lasterr, value)
  def put(ctx, :appdata, value) when is_map(value), do: Map.put(ctx, :appdata, value)

  # nil means "this FSM has no parent and runs standalone", which is what makes
  # the parent notifications no-ops rather than a special case at each call site.
  def put(ctx, :parent_pid, nil), do: Map.put(ctx, :parent_pid, nil)
  def put(ctx, :parent_pid, value) when is_pid(value), do: Map.put(ctx, :parent_pid, value)

  def put(_ctx, key, value) when key in @keys do
    raise ArgumentError,
          "FSL.Context: #{inspect(value)} is not a valid #{inspect(key)}"
  end

  def put(_ctx, key, _value) do
    raise ArgumentError,
          "FSL.Context.put/3 writes only #{inspect(@keys)}, not #{inspect(key)}"
  end

  @doc "Read one of the six fields."
  @spec get(t(), atom()) :: term()
  def get(ctx, key) when key in @keys, do: Map.get(ctx, key)

  def get(_ctx, key) do
    raise ArgumentError,
          "FSL.Context.get/2 reads only #{inspect(@keys)}, not #{inspect(key)}"
  end

  @doc "Read an application-defined value from the `appdata` map."
  @spec appdata_get(t(), term()) :: term()
  def appdata_get(ctx, key), do: Map.get(ctx.appdata, key)

  @doc "Store an application-defined value in the `appdata` map."
  @spec appdata_set(t(), term(), term()) :: t()
  def appdata_set(ctx, key, value), do: Map.put(ctx, :appdata, Map.put(ctx.appdata, key, value))

  @doc false
  # `@after_compile FSL.Context` in a binding's context module.
  def __after_compile__(env, _bytecode), do: check_struct!(env.module)

  @doc """
  Assert at compile time that `module`'s struct carries the six fields with the
  right defaults. An application writes `@after_compile FSL.Context` in its context
  module, so a `defstruct` that forgot `FSL.Context.fields()` is a compile error
  rather than a crash on the first transition.
  """
  @spec check_struct!(module()) :: :ok
  def check_struct!(module) do
    actual = module.__struct__() |> Map.from_struct()

    missing =
      Enum.reject(@fields, fn {key, default} ->
        Map.has_key?(actual, key) and Map.fetch!(actual, key) == default
      end)

    if missing != [] do
      raise CompileError,
        description:
          "#{inspect(module)} is an FSL context, so its defstruct must splice in " <>
            "FSL.Context.fields(). Missing or redefined: #{inspect(missing)}."
    end

    :ok
  end

  @doc """
  Write several of the six fields from a keyword list, in order.
  """
  @spec put(t(), keyword()) :: t()
  def put(ctx, []), do: ctx

  def put(ctx, [{prop, value} | rest]), do: ctx |> put(prop, value) |> put(rest)

  @doc """
  Inject the five generic context macros into a scenario: `ctx_set`, `ctx_get`,
  `ctx_set_multiple`, `appdata_set` and `appdata_get`.

  ## Options

    * `:ctx_var` — what a machine of this application calls the context
      variable. `:fsl_ctx` by default.

      A name worth choosing: a machine holding a chat session reads better with
      `chat_ctx` than with `fsl_ctx`, and the SIP embedding uses `sip_ctx`. What
      FSL does not assume is that there is only **one** such name, which is what
      lets two applications' machines run in one VM.

    * `:setter` / `:getter` — `{module, function}` that `ctx_set` and `ctx_get`
      go through. `{FSL.Context, :put}` and `{FSL.Context, :get}` by default.

      Name your own when your context has fields of its own to validate:
      `ctx_set(:endpoint, …)` should go through whatever checks an endpoint,
      and FSL's own pair is restricted to the six fields on purpose, so that a
      machine with no application around it cannot write a field nobody defined.

  Injected once per module: a machine reaching this through two `use` lines
  would otherwise redefine the macros and warn on every clause.

  The macros are one-liners over the `*_ast/3` builders below rather than
  quoted-inside-quoted code. Three levels of `unquote` is not a style
  preference — it is the level at which nobody can read which stage a variable
  belongs to.
  """
  defmacro __using__(opts) do
    # Everything here is written imperatively, at EXPANSION time, and this is not
    # a style choice: a `@attr value` sitting in the quote below is *evaluated*
    # later, when the module body runs, while sibling macro calls — the guard
    # against a second injection, and every `state` of the scenario — are
    # expanded before that. An attribute the language has to read while it
    # expands must therefore be put, not quoted.
    #
    # The guard has always worked this way (a scenario reaches this module
    # through two `use` chains and would otherwise redefine every macro). The
    # context variable joined it the day `state` had to know the name to bind in
    # the head it generates: quoted, it read `nil` at module level and
    # `:sip_ctx` inside each state body, so the head bound one variable and the
    # body read another.
    if Module.get_attribute(__CALLER__.module, :fsl_context_used) do
      quote(do: nil)
    else
      Module.put_attribute(__CALLER__.module, :fsl_context_used, true)

      Module.put_attribute(
        __CALLER__.module,
        :fsl_ctx_var,
        Keyword.get(opts, :ctx_var, :fsl_ctx)
      )

      Module.put_attribute(
        __CALLER__.module,
        :fsl_setter,
        Keyword.get(opts, :setter, {FSL.Context, :put})
      )

      Module.put_attribute(
        __CALLER__.module,
        :fsl_getter,
        Keyword.get(opts, :getter, {FSL.Context, :get})
      )

      quote do
        defmacro ctx_set(prop, value),
          do: FSL.Context.ctx_set_ast(@fsl_ctx_var, @fsl_setter, [prop, value])

        defmacro ctx_get(prop),
          do: FSL.Context.ctx_get_ast(@fsl_ctx_var, @fsl_getter, prop)

        defmacro ctx_set_multiple(proplist),
          do: FSL.Context.ctx_set_ast(@fsl_ctx_var, @fsl_setter, [proplist])

        defmacro appdata_set(prop, value),
          do: FSL.Context.appdata_set_ast(@fsl_ctx_var, prop, value)

        defmacro appdata_get(prop),
          do: FSL.Context.appdata_get_ast(@fsl_ctx_var, prop)
      end
    end
  end

  # ── The macro bodies ────────────────────────────────────────────────────────
  #
  # `Macro.var(name, nil)` is exactly what `var!/1` produces, so `ctx` below
  # reads as `var!(sip_ctx)` did. Bound on the first line of each builder and
  # nowhere else — never inline, never conditionally — which is what keeps these
  # readable now that the name is a parameter.

  @doc false
  def ctx_set_ast(ctx_var, {mod, fun}, args) do
    ctx = Macro.var(ctx_var, nil)

    quote do
      unquote(ctx) = unquote(mod).unquote(fun)(unquote_splicing([ctx | args]))
    end
  end

  @doc false
  def ctx_get_ast(ctx_var, {mod, fun}, prop) do
    ctx = Macro.var(ctx_var, nil)
    quote(do: unquote(mod).unquote(fun)(unquote(ctx), unquote(prop)))
  end

  @doc false
  def appdata_set_ast(ctx_var, prop, value) do
    ctx = Macro.var(ctx_var, nil)

    quote do
      unquote(ctx) = FSL.Context.appdata_set(unquote(ctx), unquote(prop), unquote(value))
    end
  end

  @doc false
  def appdata_get_ast(ctx_var, prop) do
    ctx = Macro.var(ctx_var, nil)
    quote(do: FSL.Context.appdata_get(unquote(ctx), unquote(prop)))
  end
end
