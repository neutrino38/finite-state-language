// @vitest-environment happy-dom
/**
 * finite-state-language/react (spec §7.1, design §8): binding,
 * re-render discipline, instance ownership, StrictMode double-mount.
 */
import { StrictMode } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  defineMachine,
  goto,
  stay,
  type Instance,
  type Machine,
} from "../src/index.js";
import { useMachine } from "../src/react/index.js";

afterEach(cleanup);

type Ev = { type: "go" } | { type: "tick" } | { type: "noop" };
interface Ctx {
  count: number;
}

interface Counters {
  starts: number;
  cleanups: number;
}

function makeMachine(counters: Counters) {
  return defineMachine<Ctx, Ev>()({
    name: "UiMachine",
    context: () => {
      counters.starts++;
      return { count: 0 };
    },
    cleanup: () => {
      counters.cleanups++;
    },
    states: {
      initial_state: {
        meta: { badge: "idle" },
        on: { go: () => goto("active", "engaged") },
      },
      active: {
        meta: { badge: "active" },
        on: {
          tick: (_ev, ctx) => {
            ctx.count++;
            return stay("tick");
          },
          noop: () => undefined,
        },
      },
    },
  });
}

interface Spy {
  renders: number;
  instance?: Instance<Ctx, Ev, "initial_state" | "active">;
}

function Probe({
  machine,
  spy,
}: {
  machine:
    | Machine<Ctx, Ev, "initial_state" | "active">
    | Instance<Ctx, Ev, "initial_state" | "active">;
  spy: Spy;
}) {
  const { state, context, meta, send, instance } = useMachine(machine);
  spy.renders++;
  spy.instance = instance;
  return (
    <div>
      <span data-testid="state">{state}</span>
      <span data-testid="count">{context.count}</span>
      <span data-testid="badge">{String(meta?.badge)}</span>
      <button data-testid="go" onClick={() => send({ type: "go" })} />
      <button data-testid="tick" onClick={() => send({ type: "tick" })} />
      <button data-testid="noop" onClick={() => send({ type: "noop" })} />
    </div>
  );
}

describe("§7.1 useMachine", () => {
  it("renders from the snapshot and re-renders on transitions", () => {
    const counters: Counters = { starts: 0, cleanups: 0 };
    const spy: Spy = { renders: 0 };
    const r = render(<Probe machine={makeMachine(counters)} spy={spy} />);
    expect(r.getByTestId("state").textContent).toBe("initial_state");
    expect(r.getByTestId("badge").textContent).toBe("idle");

    fireEvent.click(r.getByTestId("go"));
    expect(r.getByTestId("state").textContent).toBe("active");
    expect(r.getByTestId("badge").textContent).toBe("active");

    fireEvent.click(r.getByTestId("tick"));
    fireEvent.click(r.getByTestId("tick"));
    expect(r.getByTestId("count").textContent).toBe("2");
  });

  it("does not re-render on a handled-silently event (void ⇒ same snapshot)", () => {
    const counters: Counters = { starts: 0, cleanups: 0 };
    const spy: Spy = { renders: 0 };
    const r = render(<Probe machine={makeMachine(counters)} spy={spy} />);
    fireEvent.click(r.getByTestId("go"));
    const renders = spy.renders;
    fireEvent.click(r.getByTestId("noop")); // void: snapshot reference kept
    expect(spy.renders).toBe(renders);
    fireEvent.click(r.getByTestId("tick")); // stay(): explicit repaint
    expect(spy.renders).toBe(renders + 1);
  });

  it("owns the instance: unmount shuts it down with reason 'unmounted'", async () => {
    const counters: Counters = { starts: 0, cleanups: 0 };
    const spy: Spy = { renders: 0 };
    const r = render(<Probe machine={makeMachine(counters)} spy={spy} />);
    const inst = spy.instance!;
    r.unmount();
    expect(await inst.done).toEqual({
      outcome: "aborted",
      reason: "unmounted",
    });
    expect(counters.cleanups).toBe(counters.starts); // every start cleaned up
  });

  it("survives StrictMode double-mount: one live instance, symmetric teardown", async () => {
    const counters: Counters = { starts: 0, cleanups: 0 };
    const spy: Spy = { renders: 0 };
    const r = render(
      <StrictMode>
        <Probe machine={makeMachine(counters)} spy={spy} />
      </StrictMode>,
    );
    // StrictMode simulates unmount/remount: the first instance was
    // started AND shut down; exactly one is left alive.
    expect(counters.starts).toBe(2);
    expect(counters.cleanups).toBe(1);

    // the survivor is fully functional
    fireEvent.click(r.getByTestId("go"));
    fireEvent.click(r.getByTestId("tick"));
    expect(r.getByTestId("state").textContent).toBe("active");
    expect(r.getByTestId("count").textContent).toBe("1");

    const inst = spy.instance!;
    r.unmount();
    expect(counters.cleanups).toBe(2);
    expect((await inst.done).reason).toBe("unmounted");
  });

  it("binds to an externally-owned instance without managing its lifecycle", () => {
    const counters: Counters = { starts: 0, cleanups: 0 };
    const inst = makeMachine(counters).start();
    const spy: Spy = { renders: 0 };
    const r = render(<Probe machine={inst} spy={spy} />);
    fireEvent.click(r.getByTestId("go"));
    expect(inst.state).toBe("active");
    r.unmount();
    // not owned: still alive after unmount
    expect(inst.state).toBe("active");
    expect(counters.cleanups).toBe(0);
    inst.send({ type: "tick" });
    expect(inst.context.count).toBe(1);
  });
});
