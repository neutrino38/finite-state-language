/**
 * Sub-machines (spec §8.1): spawn, parent/child messaging, child:exit,
 * nesting, standalone runs.
 */
import { describe, expect, it } from "vitest";
import {
  defineMachine,
  goto,
  stay,
  success,
  type ChildExit,
  type ChildMsg,
  type ParentMsg,
} from "../src/index.js";

type ChildEv = ParentMsg | { type: "finish" };

const Child = defineMachine<{ log: string[]; greeting?: string }, ChildEv>()({
  name: "Child",
  context: () => ({ log: [] }),
  states: {
    initial_state: {
      enter(ctx, fx) {
        fx.notifyParent(ctx.greeting ?? "hello");
      },
      on: {
        "parent:msg": (ev, ctx, fx) => {
          if (ev.payload === "finish") return success("asked to finish");
          ctx.log.push(String(ev.payload));
          fx.notifyParent(`echo:${String(ev.payload)}`);
          return stay();
        },
        finish: () => success("child done"),
      },
    },
  },
});

type ParentEv =
  ChildMsg | ChildExit | { type: "respawn" } | { type: "tell"; text: string };

const Parent = defineMachine<{ msgs: string[]; exits: string[] }, ParentEv>()({
  name: "Parent",
  context: () => ({ msgs: [], exits: [] }),
  states: {
    initial_state: {
      enter(_ctx, fx) {
        fx.spawn(Child, { as: "callee" });
      },
      on: {
        "child:msg": (ev, ctx) => {
          ctx.msgs.push(`${ev.from}:${String(ev.payload)}`);
          return stay();
        },
        "child:exit": (ev, ctx) => {
          ctx.exits.push(`${ev.from}:${ev.outcome}:${ev.reason}`);
          return stay();
        },
        tell: (ev, _ctx, fx) => {
          fx.notify("callee", ev.text);
          return stay();
        },
        respawn: (_ev, _ctx, fx) => {
          fx.spawn(Child, { as: "callee", args: { greeting: "again" } });
          return stay();
        },
      },
    },
  },
});

describe("spec §8.1 — sub-machines", () => {
  it("spawns a child whose first notifyParent arrives before start returns", () => {
    const p = Parent.start();
    expect(p.context.msgs).toEqual(["callee:hello"]);
  });

  it("fx.notify / fx.notifyParent carry the conversation both ways", () => {
    const p = Parent.start();
    p.send({ type: "tell", text: "ring" });
    expect(p.context.msgs).toEqual(["callee:hello", "callee:echo:ring"]);
  });

  it("child termination delivers child:exit synchronously and frees the name", () => {
    const p = Parent.start();
    p.send({ type: "tell", text: "finish" });
    expect(p.context.exits).toEqual(["callee:success:asked to finish"]);
    // the name is free again: respawning does not fail
    p.send({ type: "respawn" });
    expect(p.state).toBe("initial_state");
    expect(p.context.msgs).toContain("callee:again"); // args reached the child
  });

  it("spawning a live duplicate name is a runtime error ⇒ failure", async () => {
    const Dup = defineMachine<Record<string, never>, ParentEv>()({
      name: "Dup",
      context: () => ({}),
      states: {
        initial_state: {
          enter(_ctx, fx) {
            fx.spawn(Child, { as: "twin" });
            fx.spawn(Child, { as: "twin" });
          },
        },
      },
    });
    const m = Dup.start({ logger: () => {} });
    const r = await m.done;
    expect(r.outcome).toBe("failure");
    expect(r.reason).toMatch(/child 'twin' already exists/);
  });

  it("a child machine runs standalone: notifyParent is a no-op", async () => {
    const c = Child.start();
    expect(c.state).toBe("initial_state");
    c.send({ type: "finish" });
    expect(await c.done).toEqual({
      outcome: "success",
      reason: "child done",
    });
  });

  it("children nest freely (parent → mid → leaf)", () => {
    type MidEv = ParentMsg | ChildMsg | ChildExit;
    const Mid = defineMachine<Record<string, never>, MidEv>()({
      name: "Mid",
      context: () => ({}),
      states: {
        initial_state: {
          enter(_ctx, fx) {
            fx.spawn(Child, { as: "leaf" });
          },
          on: {
            // forward the grandchild's greeting up
            "child:msg": (ev, _ctx, fx) => {
              fx.notifyParent(`leaf said ${String(ev.payload)}`);
              return stay();
            },
          },
        },
      },
    });
    type TopEv = ChildMsg | ChildExit;
    const Top = defineMachine<{ msgs: string[] }, TopEv>()({
      name: "Top",
      context: () => ({ msgs: [] }),
      states: {
        initial_state: {
          enter(_ctx, fx) {
            fx.spawn(Mid, { as: "mid" });
          },
          on: {
            "child:msg": (ev, ctx) => {
              ctx.msgs.push(String(ev.payload));
              return stay();
            },
          },
        },
      },
    });
    const t = Top.start();
    expect(t.context.msgs).toEqual(["leaf said hello"]);
  });

  it("an unmatched child:exit pends like any event (§4.2)", () => {
    const Deaf = defineMachine<Record<string, never>, ParentEv>()({
      name: "Deaf",
      context: () => ({}),
      states: {
        initial_state: {
          enter(_ctx, fx) {
            fx.spawn(Child, { as: "callee" });
          },
          on: {
            tell: (ev, _ctx, fx) => {
              fx.notify("callee", ev.text);
              return stay();
            },
            respawn: () => goto("listening"),
            "child:msg": () => undefined,
          },
        },
        listening: {
          on: { "child:exit": () => success("collected") },
        },
      },
    });
    const m = Deaf.start();
    m.send({ type: "tell", text: "finish" }); // child exits; no clause here
    expect(m.pending.map((e) => e.type)).toEqual(["child:exit"]);
    m.send({ type: "respawn" }); // moves to listening ⇒ replay
    expect(m.state).toBe("terminal_success_state");
  });
});
