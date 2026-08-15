/**
 * Cooperative shutdown, grace period and teardown ordering
 * (spec §8.2–8.3, design §6).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aborted,
  defineMachine,
  goto,
  success,
  type ChildExit,
  type ChildMsg,
} from "../src/index.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

type Ev = { type: "sip:ended" } | ChildMsg | ChildExit;

describe("§8.2 cooperative shutdown", () => {
  it("without onShutdown, terminates immediately with outcome aborted", async () => {
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "Plain",
      context: () => ({}),
      states: { initial_state: {} },
    });
    const m = M.start();
    expect(await m.shutdown("user quit")).toEqual({
      outcome: "aborted",
      reason: "user quit",
    });
    expect(m.state).toBe("terminal_aborted_state");
  });

  it("onShutdown may finish business first: non-terminal transition, then exit", async () => {
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "Graceful",
      context: () => ({}),
      onShutdown: () => goto("hanging_up", "sending BYE"),
      states: {
        initial_state: {},
        hanging_up: {
          on: { "sip:ended": () => aborted("BYE completed") },
        },
      },
    });
    const m = M.start();
    const p = m.shutdown("user quit");
    expect(m.state).toBe("hanging_up"); // still running
    m.send({ type: "sip:ended" });
    expect(await p).toEqual({ outcome: "aborted", reason: "BYE completed" });
  });

  it("onShutdown may decide a different outcome", async () => {
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "Proud",
      context: () => ({}),
      onShutdown: () => success("all flushed"),
      states: { initial_state: {} },
    });
    const m = M.start();
    expect(await m.shutdown()).toEqual({
      outcome: "success",
      reason: "all flushed",
    });
  });

  it("an exception in onShutdown becomes failure (§5)", async () => {
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "Broken",
      context: () => ({}),
      onShutdown: () => {
        throw new Error("shutdown broke");
      },
      states: { initial_state: {} },
    });
    const m = M.start({ logger: () => {} });
    expect((await m.shutdown("bye")).outcome).toBe("failure");
  });

  it("shutdown on a finished machine just returns done", async () => {
    const M = defineMachine<Record<string, never>, Ev>()({
      name: "Done",
      context: () => ({}),
      states: {
        initial_state: {
          enter() {
            return success("instant");
          },
        },
      },
    });
    const m = M.start();
    await m.done;
    expect(await m.shutdown("too late")).toEqual({
      outcome: "success",
      reason: "instant",
    });
  });
});

describe("§8.1/§8.3 child teardown on parent termination", () => {
  function politeChild(cleaned: string[]) {
    return defineMachine<Record<string, never>, Ev>()({
      name: "Polite",
      context: () => ({}),
      cleanup() {
        cleaned.push("polite");
      },
      states: { initial_state: {} },
    });
  }

  function stubbornChild(cleaned: string[]) {
    return defineMachine<Record<string, never>, Ev>()({
      name: "Stubborn",
      context: () => ({}),
      onShutdown: () => goto("lingering", "ignoring shutdown"),
      cleanup() {
        cleaned.push("stubborn");
      },
      states: { initial_state: {}, lingering: {} },
    });
  }

  it("cooperative children let the parent settle without the grace period", async () => {
    const cleaned: string[] = [];
    const P = defineMachine<Record<string, never>, Ev>()({
      name: "P",
      context: () => ({}),
      cleanup() {
        cleaned.push("parent");
      },
      states: {
        initial_state: {
          enter(_ctx, fx) {
            fx.spawn(politeChild(cleaned), { as: "kid" });
          },
        },
      },
    });
    const m = P.start();
    expect(await m.shutdown("bye")).toEqual({
      outcome: "aborted",
      reason: "bye",
    });
    // §8.3 ordering: children down before the parent's cleanup
    expect(cleaned).toEqual(["polite", "parent"]);
    expect(vi.getTimerCount()).toBe(0); // grace timer was cleared
  });

  it("a straggler is force-stopped after the grace period", async () => {
    const cleaned: string[] = [];
    const P = defineMachine<Record<string, never>, Ev>()({
      name: "P",
      context: () => ({}),
      cleanup() {
        cleaned.push("parent");
      },
      states: {
        initial_state: {
          enter(_ctx, fx) {
            fx.spawn(stubbornChild(cleaned), { as: "kid" });
          },
        },
      },
    });
    const m = P.start();
    let settled = false;
    const p = m.shutdown("bye").then((r) => {
      settled = true;
      return r;
    });
    await Promise.resolve(); // flush microtasks: still waiting on the child
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000); // grace expires
    expect(await p).toEqual({ outcome: "aborted", reason: "bye" });
    expect(cleaned).toEqual(["stubborn", "parent"]); // forced, but cleaned up
  });

  it("teardown cascades through nested children", async () => {
    const cleaned: string[] = [];
    const Mid = defineMachine<Record<string, never>, Ev>()({
      name: "Mid",
      context: () => ({}),
      cleanup() {
        cleaned.push("mid");
      },
      states: {
        initial_state: {
          enter(_ctx, fx) {
            fx.spawn(politeChild(cleaned), { as: "leaf" });
          },
        },
      },
    });
    const Top = defineMachine<Record<string, never>, Ev>()({
      name: "Top",
      context: () => ({}),
      cleanup() {
        cleaned.push("top");
      },
      states: {
        initial_state: {
          enter(_ctx, fx) {
            fx.spawn(Mid, { as: "mid" });
          },
        },
      },
    });
    const m = Top.start();
    await m.shutdown("stack down");
    expect(cleaned).toEqual(["polite", "mid", "top"]);
  });

  it("the final notification reaches subscribers only after the children are down", async () => {
    const order: string[] = [];
    const P = defineMachine<Record<string, never>, Ev>()({
      name: "P",
      context: () => ({}),
      states: {
        initial_state: {
          enter(_ctx, fx) {
            fx.spawn(politeChild(order), { as: "kid" });
          },
        },
      },
    });
    const m = P.start();
    m.subscribe((n) => order.push(`notified:${n.state}`));
    await m.shutdown("bye");
    expect(order).toEqual(["polite", "notified:terminal_aborted_state"]);
  });
});
