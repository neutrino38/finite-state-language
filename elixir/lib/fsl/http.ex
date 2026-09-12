# HTTP client session layer for SIP scenarios.
#
# Part of the scenario helper family (same philosophy as the SIP.Session.*
# mixins): a small FSL macro that operates on the implicit `sip_ctx` and never
# blocks the scenario. See FSL.md ("SIP.Session.HTTP / http_GET") for the
# scenario-side contract.

defmodule FSL.HTTP do
  @moduledoc """
  HTTP helpers mixin for SIP scenarios — issue outbound HTTP requests from a
  scenario state without ever blocking the finite-state machine.

  `use FSL.HTTP` brings in the `http_GET/3` FSL macro. Like the other
  `SIP.Session.*` macros it operates on the implicit `sip_ctx`, sets
  `sip_ctx.lasterr` to `:ok` and returns the updated context (so a `goto` placed
  right after it works), but the HTTP *result* is delivered asynchronously, later,
  as a single tagged message to the scenario mailbox:

      { tag, {:ok, %Req.Response{}} }
      { tag, {:error, reason} }

  where `reason` is one of:

    * `:timeout`         — the total `timeout` elapsed; the request was cancelled;
    * a `Req` exception  — a network / transport error (`%Req.TransportError{}`, …);
    * `{:crash, reason}` — the worker process died before producing a result.

  The scenario waits for this message in `on_events`:

      state query_backend do
        http_GET("https://backend/api/x", 10_000, :provisioning)
        on_events do
          { :provisioning, {:ok, %Req.Response{status: 200, body: b}}} ->
            appdata_set(:data, b); goto next, "backend OK"
          { :provisioning, {:ok, %Req.Response{status: c}}} ->
            scenario_failure("backend HTTP \#{c}")
          { :provisioning, {:error, :timeout}} ->
            scenario_failure("backend timeout")
          { :provisioning, {:error, r}} ->
            scenario_failure("backend error: \#{inspect(r)}")
        end
      end

  Because `http_GET` guarantees a message even on timeout, the scenario does not
  need an `after` clause for the timeout case — it arrives as an `{:error,
  :timeout}` event. A wide safety `after` remains possible but is optional.

  ## Timeout & cancellation — the coordinator pattern

  `http_GET` never touches `receive` in the scenario process. It spawns a
  disposable **coordinator** process which in turn `spawn_monitor`s a **worker**
  that runs `Req.get/2`. The coordinator arbitrates time with a single
  `receive`/`after`, so exactly one of three things happens:

    1. the worker returns in time → the coordinator forwards the result;
    2. the worker crashes → the coordinator reports `{:error, {:crash, reason}}`;
    3. the `timeout` fires → the coordinator **kills** the worker with
       `Process.exit(worker, :kill)`, so the request is genuinely cancelled and
       no late reply can ever be produced, then reports `{:error, :timeout}`.

  The `receive`/`after` serializes the timer against the worker result, so there
  is no race between them, and the coordinator sends **exactly one**
  `{tag, …}` message before terminating — no stray late message can pollute
  a subsequent `on_events`.

  > Killing the worker tears down the HTTP request in flight: the socket it had
  > checked out of the Finch/NimblePool pool is reclaimed when the process dies.
  > That is the intended behaviour here — cancelling a timed-out request must not
  > leave a connection lingering to deliver a response nobody is listening for.
  """
  require Logger

  # Combined with `use FSL.Machine` (directly or through a binding's facade),
  # which is what records the name of the context variable this macro rebinds.
  defmacro __using__(_opts) do
    quote do
      @doc """
      Fire an asynchronous HTTP GET to `url`, bounding the whole operation to
      `timeout` milliseconds. `tag` (an atom or any term) discriminates several
      concurrent requests. Does not block the machine: sets `lasterr` to `:ok`,
      returns the updated context, and delivers the result later as a single
      `{tag, result}` message. See `FSL.HTTP`.
      """
      defmacro http_GET(url, timeout, tag),
        do: FSL.HTTP.http_get_ast(@fsl_ctx_var, url, timeout, tag)
    end
  end

  @doc false
  # The macro body, built here rather than nested three `quote` deep — and
  # parameterized by the binding's context variable, like every other macro of
  # the language (`FSL.Context.__using__`).
  def http_get_ast(ctx_var, url, timeout, tag) do
    ctx = Macro.var(ctx_var, nil)

    quote do
      FSL.Monitor.note_command(:http, "http_GET")

      # `self()` here is the machine's process — the coordinator sends the
      # {tag, …} message back to it, where `on_events` collects it.
      FSL.HTTP.get_async(unquote(url), unquote(timeout), unquote(tag))

      # Fire-and-forget: the launch itself cannot fail, so leave lasterr clean
      # for the `goto` that usually follows.
      unquote(ctx) = FSL.Context.put(unquote(ctx), :lasterr, :ok)
    end
  end

  @doc """
  Launch an asynchronous HTTP GET. Spawns the disposable coordinator process
  (which owns the worker and the timeout) and returns its pid immediately; the
  calling process is never blocked. The result is delivered to the **caller** as
  a single `{tag, result}` message (`FSL.Valet` captures `self()`).

  `req_opts` is forwarded to `Req.get/2` — normally empty from the FSL macro,
  but used by the tests to inject a `Req.Test` stub / a fake `:adapter`.
  """
  @spec get_async(binary(), pos_integer(), term(), keyword()) :: pid()
  def get_async(url, timeout, tag, req_opts \\ [])
      when is_binary(url) and is_integer(timeout) and timeout > 0 and
             is_list(req_opts) do
    FSL.Valet.ask(tag, &Req.get/2, [url, req_opts], timeout)
  end
end
