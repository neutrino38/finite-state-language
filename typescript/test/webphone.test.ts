/**
 * The spec §2 example, headless (M1 exit criterion).
 * The `after` timeout clauses of the original arrive with M3 and are
 * omitted here; everything else is the spec machine verbatim, driven
 * by scripted events against a fake SIP stack.
 */
import { describe, expect, it } from "vitest";
import { defineMachine, failure, goto, loop, stay } from "../src/index.js";

// ---- fake comm stack (FSL never sees its type — spec §1.3) -----------------

class FakeSession {
  terminated = false;
  answered = false;
  terminate() {
    this.terminated = true;
  }
  answer() {
    this.answered = true;
  }
}

class FakeUA {
  started = false;
  calls: string[] = [];
  start() {
    this.started = true;
  }
  call(number: string): FakeSession {
    this.calls.push(number);
    return new FakeSession();
  }
}

// ---- the typed vocabulary of this machine ----------------------------------

interface PhoneCtx {
  ua?: FakeUA;
  session?: FakeSession;
  callee?: string;
  lastError?: string;
}

type PhoneEvent =
  | { type: "ui:call"; number: string }
  | { type: "ui:answer" }
  | { type: "ui:hangup" }
  | { type: "sip:registered" }
  | { type: "sip:registrationFailed"; cause: string }
  | { type: "sip:progress" }
  | { type: "sip:accepted" }
  | { type: "sip:incoming"; session: FakeSession; from: string }
  | { type: "sip:ended"; cause: string };

// ---- the machine (spec §2, minus `after`) ----------------------------------

const WebPhone = defineMachine<PhoneCtx, PhoneEvent>()({
  name: "WebPhone",

  context: () => ({}),

  states: {
    initial_state: {
      enter(ctx) {
        ctx.ua = new FakeUA();
        ctx.ua.start();
        return goto("registering");
      },
    },

    registering: {
      on: {
        "sip:registered": () => goto("ready", "REGISTER OK"),
        "sip:registrationFailed": (ev) => failure(`registration: ${ev.cause}`),
      },
    },

    ready: {
      on: {
        "ui:call": (ev, ctx) => {
          ctx.callee = ev.number;
          ctx.session = ctx.ua!.call(ev.number);
          return goto("calling_out", `calling ${ev.number}`);
        },
        "sip:incoming": (ev, ctx) => {
          ctx.session = ev.session;
          return goto("ringing_in", `incoming from ${ev.from}`);
        },
      },
    },

    calling_out: {
      on: {
        "sip:progress": () => loop("ringing"),
        "sip:accepted": () => goto("connected", "200 OK"),
        "sip:ended": (ev, ctx) => {
          ctx.lastError = ev.cause;
          return goto("call_failed", ev.cause);
        },
        "ui:hangup": (_ev, ctx) => {
          ctx.session?.terminate();
          return goto("ready", "caller gave up");
        },
      },
    },

    ringing_in: {
      on: {
        "ui:answer": (_ev, ctx) => {
          ctx.session!.answer();
          return stay();
        },
        "sip:accepted": () => goto("connected"),
        "ui:hangup": (_ev, ctx) => {
          ctx.session?.terminate();
          return goto("ready", "rejected");
        },
        "sip:ended": () => goto("ready", "caller hung up"),
      },
    },

    connected: {
      on: {
        "ui:hangup": (_ev, ctx) => {
          ctx.session?.terminate();
          return stay();
        },
        "sip:ended": () => goto("ready", "call ended"),
      },
    },

    call_failed: {
      on: {
        "ui:call": "ready", // shorthand: re-dispatch after moving there
      },
    },
  },
});

// ---- scripted scenarios -----------------------------------------------------

describe("spec §2 — the web phone, headless", () => {
  it("starts its stack and registers", () => {
    const phone = WebPhone.start();
    expect(phone.state).toBe("registering");
    expect(phone.context.ua?.started).toBe(true);
    phone.send({ type: "sip:registered" });
    expect(phone.state).toBe("ready");
  });

  it("fails the scenario when registration fails", async () => {
    const phone = WebPhone.start();
    phone.send({ type: "sip:registrationFailed", cause: "403 Forbidden" });
    expect(await phone.done).toEqual({
      outcome: "failure",
      reason: "registration: 403 Forbidden",
    });
  });

  it("places an outgoing call through to connected and back to ready", () => {
    const phone = WebPhone.start();
    phone.send({ type: "sip:registered" });
    phone.send({ type: "ui:call", number: "sip:alice@example.com" });
    expect(phone.state).toBe("calling_out");
    expect(phone.context.callee).toBe("sip:alice@example.com");
    expect(phone.context.ua?.calls).toEqual(["sip:alice@example.com"]);

    phone.send({ type: "sip:progress" }); // 180 — loop("ringing")
    expect(phone.state).toBe("calling_out");
    phone.send({ type: "sip:accepted" }); // 200 OK
    expect(phone.state).toBe("connected");

    phone.send({ type: "ui:hangup" }); // stay(); BYE goes out
    expect(phone.state).toBe("connected");
    expect(phone.context.session?.terminated).toBe(true);
    phone.send({ type: "sip:ended", cause: "BYE" });
    expect(phone.state).toBe("ready");
  });

  it("answers an incoming call", () => {
    const phone = WebPhone.start();
    phone.send({ type: "sip:registered" });
    const session = new FakeSession();
    phone.send({ type: "sip:incoming", session, from: "bob" });
    expect(phone.state).toBe("ringing_in");
    phone.send({ type: "ui:answer" });
    expect(session.answered).toBe(true);
    expect(phone.state).toBe("ringing_in"); // stay() until 200 OK
    phone.send({ type: "sip:accepted" });
    expect(phone.state).toBe("connected");
  });

  it("redials from call_failed via the string shorthand", () => {
    const phone = WebPhone.start();
    phone.send({ type: "sip:registered" });
    phone.send({ type: "ui:call", number: "sip:busy@example.com" });
    phone.send({ type: "sip:ended", cause: "486 Busy Here" });
    expect(phone.state).toBe("call_failed");
    expect(phone.context.lastError).toBe("486 Busy Here");

    // shorthand: move to ready, re-dispatch ui:call there ⇒ dials again
    phone.send({ type: "ui:call", number: "sip:carol@example.com" });
    expect(phone.state).toBe("calling_out");
    expect(phone.context.ua?.calls).toEqual([
      "sip:busy@example.com",
      "sip:carol@example.com",
    ]);
  });

  it("does not lose an INVITE racing a state change (§4.2)", () => {
    const phone = WebPhone.start();
    phone.send({ type: "sip:registered" });
    phone.send({ type: "ui:call", number: "sip:alice@example.com" });
    phone.send({ type: "sip:accepted" });
    expect(phone.state).toBe("connected");

    // an incoming call arrives while connected: no clause ⇒ pended
    const invite = new FakeSession();
    phone.send({ type: "sip:incoming", session: invite, from: "dave" });
    expect(phone.pending.map((e) => e.type)).toEqual(["sip:incoming"]);

    // the current call ends ⇒ ready ⇒ the pended INVITE replays
    phone.send({ type: "sip:ended", cause: "BYE" });
    expect(phone.state).toBe("ringing_in");
    expect(phone.context.session).toBe(invite);
  });
});
