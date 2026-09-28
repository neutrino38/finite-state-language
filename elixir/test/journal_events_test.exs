defmodule FSL.JournalEventsTest do
  # c:FSL.Host.journal_events/2: the host is offered the journal itself before
  # anything is rendered. Not async: the hosts read a probe and an answer from
  # the application env.
  use ExUnit.Case

  defmodule Boom do
    @moduledoc false
    # A renderer that must never run: its use is the failure.
    @behaviour FSL.Diagram
    @impl true
    def render(_events, _meta), do: raise("rendered although the host took the events")
    @impl true
    def filename(_meta), do: "never.puml"
  end

  defmodule KeepingHost do
    @moduledoc false
    # Keeps the journal (tells the test), collected events included, and names a
    # renderer that raises — so a rendering anywhere on the path fails the test.
    @behaviour FSL.Host

    @impl true
    def journal_collect,
      do: [%{kind: :message, at: 5, dir: :in, lane: "c", label: "ELSEWHERE"}]

    @impl true
    def diagram_renderer, do: FSL.JournalEventsTest.Boom

    @impl true
    def journal_events(events, meta) do
      send(Application.get_env(:fsl, :journal_events_probe), {:events, events, meta})
      Application.get_env(:fsl, :journal_events_answer, {:ok, :kept})
    end

    @impl true
    def journal_output(_document, _meta, _renderer),
      do: raise("a document reached journal_output/3 although the host took the events")
  end

  defmodule DeclinesHost do
    @moduledoc false
    # Answers :default: the 0.4.0 path goes on, render then journal_output/3.
    @behaviour FSL.Host

    @impl true
    def journal_events(_events, _meta), do: :default

    @impl true
    def journal_output(document, meta, renderer) do
      send(
        Application.get_env(:fsl, :journal_events_probe),
        {:document, document, meta, renderer}
      )

      {:ok, :document_kept}
    end
  end

  setup do
    Application.put_env(:fsl, :journal_events_probe, self())

    on_exit(fn ->
      Application.delete_env(:fsl, :journal_events_probe)
      Application.delete_env(:fsl, :journal_events_answer)
      Process.delete(:scenario_module)
      FSL.Journal.clear()
    end)
  end

  # A journal as the runner leaves it: started under a host, with one event of
  # its own at :at 1_000 and the collected one at 5, which must sort first.
  defp journal_under(machine) do
    Process.put(:scenario_module, machine)
    :ok = FSL.Journal.start(%{scenario: "X", pid: "p", slot: 7, config: []})
    FSL.Journal.record(%{kind: :command, at: 1_000, type: :sip, name: "send_INVITE"})
  end

  defmodule Keeping do
    use FSL.Machine, host: FSL.JournalEventsTest.KeepingHost

    state initial_state do
      scenario_success("done")
    end
  end

  defmodule Declining do
    use FSL.Machine, host: FSL.JournalEventsTest.DeclinesHost

    state initial_state do
      scenario_success("done")
    end
  end

  test "a host that keeps the events gets them merged and ordered, and nothing is rendered" do
    journal_under(Keeping)

    assert FSL.Journal.flush() == {:ok, :kept}
    assert_receive {:events, events, meta}

    assert [%{label: "ELSEWHERE", at: 5}, %{name: "send_INVITE", at: 1_000}] = events
    assert meta.slot == 7
    assert is_integer(meta.t0)
    refute FSL.Journal.enabled?()
  end

  test "an error from the host is the flush's answer, and still nothing is rendered" do
    Application.put_env(:fsl, :journal_events_answer, {:error, :store_full})
    journal_under(Keeping)

    assert FSL.Journal.flush() == {:error, :store_full}
    refute FSL.Journal.enabled?()
  end

  test ":default goes on as 0.4.0 did: rendered, then journal_output/3" do
    journal_under(Declining)

    assert FSL.Journal.flush() == {:ok, :document_kept}
    assert_receive {:document, doc, %{slot: 7}, FSL.Diagram.PlantUML}
    assert doc =~ "@startuml"
  end

  test "a whole run hands its journal over at the end, rendered by nobody" do
    Application.put_env(:fsl, :log_sequence, true)
    on_exit(fn -> Application.delete_env(:fsl, :log_sequence) end)

    assert Keeping.run(false) == :ok
    assert_receive {:events, events, _meta}
    assert Enum.any?(events, &match?(%{kind: :terminal, outcome: :succeeded}, &1))
  end
end
