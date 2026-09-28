import { describe, expect, it } from "vitest";
import { defineMachine, goto, stay, success } from "../src/index.js";

type Ev =
  { type: "go" } | { type: "tick" } | { type: "noop" } | { type: "end" };

interface Ctx {
  hits: number;
  label?: string;
}

const M = defineMachine<Ctx, Ev>()({
  name: "Inst",
  context: () => ({ hits: 0 }),
  states: {
    initial_state: {
      meta: { badge: "idle" },
      on: {
        go: (_ev, ctx) => {
          ctx.hits++;
          return goto("busy", "off we go");
        },
        end: () => success("done"),
      },
    },
    busy: {
      meta: { badge: "busy" },
      on: { tick: () => stay("repaint") },
    },
  },
});

describe("§6 machine instances", () => {
  it("context is fresh per instance and opts.args is merged", () => {
    const a = M.start({ args: { label: "A" } });
    const b = M.start();
    a.send({ type: "go" });
    expect(a.context).toEqual({ hits: 1, label: "A" });
    expect(b.context).toEqual({ hits: 0 });
  });

  it("subscribe delivers {state, context, event, desc} and returns an unsubscriber", () => {
    const m = M.start();
    const seen: string[] = [];
    const unsub = m.subscribe((n) =>
      seen.push(`${n.state}|${n.event?.type}|${n.desc}`),
    );
    m.send({ type: "go" });
    expect(seen).toEqual(["busy|go|off we go"]);
    unsub();
    m.send({ type: "tick" });
    expect(seen.length).toBe(1);
  });

  it("getSnapshot is reference-stable between transitions (design §4.7)", () => {
    const m = M.start();
    m.send({ type: "go" });
    const s1 = m.getSnapshot();
    const s2 = m.getSnapshot();
    expect(s1).toBe(s2);
    m.send({ type: "noop" }); // pends: no transition, same reference
    expect(m.getSnapshot()).toBe(s1);
    m.send({ type: "tick" }); // stay(): explicit repaint, new snapshot
    expect(m.getSnapshot()).not.toBe(s1);
    expect(m.getSnapshot().state).toBe("busy");
  });

  it("snapshot.meta exposes the current state's meta block (§7.3)", () => {
    const m = M.start();
    m.send({ type: "go" });
    expect(m.getSnapshot().meta).toEqual({ badge: "busy" });
  });

  it("matches compares the current state", () => {
    const m = M.start();
    expect(m.matches("initial_state")).toBe(true);
    m.send({ type: "go" });
    expect(m.matches("busy")).toBe(true);
    expect(m.matches("initial_state")).toBe(false);
  });

  it("the transition log records from/to/event/desc, bounded by logSize", () => {
    const m = M.start({ logSize: 2 });
    m.send({ type: "go" });
    m.send({ type: "tick" });
    const log = m.log;
    expect(log.length).toBe(2); // start entry evicted
    expect(log[0]).toMatchObject({
      from: "initial_state",
      to: "busy",
      event: "go",
      desc: "off we go",
    });
    expect(log[1]).toMatchObject({ from: "busy", to: "busy", event: "tick" });
  });

  it("debug logging uses the Elixip line format (§6.1)", () => {
    const lines: string[] = [];
    const m = M.start({ debug: true, logger: (l) => lines.push(l) });
    m.send({ type: "go" });
    expect(lines).toContain(': ((start)) -> (initial_state) "start"');
    expect(lines).toContain('go: (initial_state) -> (busy) "off we go"');
  });

  it("cleanup runs after a terminal transition, before done settles (§8.3)", async () => {
    const order: string[] = [];
    const C = defineMachine<Ctx, Ev>()({
      name: "C",
      context: () => ({ hits: 0 }),
      cleanup(ctx) {
        order.push(`cleanup hits=${ctx.hits}`);
      },
      states: {
        initial_state: {
          on: {
            end: (_ev, ctx) => {
              ctx.hits = 7;
              return success();
            },
          },
        },
      },
    });
    const m = C.start();
    m.subscribe((n) => order.push(`notified:${n.state}`));
    m.send({ type: "end" });
    const r = await m.done;
    order.push(`done:${r.outcome}`);
    expect(order).toEqual([
      "cleanup hits=7",
      "notified:terminal_success_state",
      "done:success",
    ]);
  });

  it("an exception in cleanup is swallowed and done still settles", async () => {
    const C = defineMachine<Ctx, Ev>()({
      name: "C",
      context: () => ({ hits: 0 }),
      cleanup() {
        throw new Error("cleanup broke");
      },
      states: { initial_state: { on: { end: () => success("fine") } } },
    });
    const m = C.start({ logger: () => {} });
    m.send({ type: "end" });
    expect(await m.done).toEqual({ outcome: "success", reason: "fine" });
  });

  // The sibling implementation had the defect this pins: there, the context is
  // a stack variable and Elixir's `rescue` sees the bindings of the moment the
  // `try` was entered, so a state that allocated and then raised handed the
  // teardown the context of before its own body (fixed in :fsl 0.2.1). Here the
  // context is one object the instance holds and every handler mutates in
  // place, so the property comes for free — which is exactly why it is worth an
  // assertion rather than a reading of the code.
  it("a state that throws hands cleanup what it had already written (§5)", async () => {
    let seen = -1;
    const C = defineMachine<Ctx, Ev>()({
      name: "C",
      context: () => ({ hits: 0 }),
      cleanup(ctx) {
        seen = ctx.hits;
      },
      states: {
        initial_state: {
          on: {
            end: (_ev, ctx) => {
              ctx.hits = 7;
              throw new Error("boom");
            },
          },
        },
      },
    });
    const m = C.start({ logger: () => {} });
    m.send({ type: "end" });

    const r = await m.done;
    expect(r.outcome).toBe("failure");
    expect(seen).toBe(7);
  });

  it("an exception in a subscriber is contained", () => {
    const m = M.start({ logger: () => {} });
    const seen: string[] = [];
    m.subscribe(() => {
      throw new Error("broken listener");
    });
    m.subscribe((n) => seen.push(n.state));
    m.send({ type: "go" });
    expect(seen).toEqual(["busy"]);
    expect(m.state).toBe("busy");
  });
});
