# Using FSL in a Node.js service

FSL was designed for the browser, but its core is platform-neutral: it
uses `setTimeout`, `AbortController` and promises, nothing else. This
guide is about the case this repository did not write down yet — a
long-lived Node process that handles **many calls at once**, one state
machine per call.

Everything below was measured on Node **v20.20.2** against
`finite-state-language@0.2.0`, not inferred from the source.

## 1. Does it run on your Node?

Yes, from Node 18 up. `engines` declares `>=18`, CI runs 20 and 22, and
the full suite (16 files, 180 tests, type-level assertions included)
passes on v20.20.2.

The core needs `setTimeout` / `clearTimeout`, `AbortController` and
promises. The `finite-state-language/http` subpath needs global `fetch`,
which Node has had since 18. No DOM, no Node-only API, so the same
machine file runs in the bot, in a worker thread and in a test.

### One thing to settle first: the package is ESM-only

`package.json` declares `"type": "module"` and its `exports` map has an
`import` condition only. A `require()` from a CommonJS bot fails:

```
ERR_PACKAGE_PATH_NOT_EXPORTED — No "exports" main defined
```

That is true even on Node 20.19+, which does support `require()` of ESM:
the missing `require` condition stops resolution before the loader gets
a chance.

If your bot is ESM already, import normally. If it is CommonJS, load the
library once at startup with a dynamic `import()` and keep the handle:

```js
// fsl.cjs — the single bridge between the CJS bot and the ESM library
let mod;
async function fsl() {
  return (mod ??= await import("finite-state-language"));
}
module.exports = { fsl };
```

```js
const { fsl } = require("./fsl.cjs");

async function main() {
  const { defineMachine, goto, success } = await fsl();
  const Call = defineMachine()({ /* … */ });
  startBot(Call);
}
main();
```

Define your machines inside that async startup path, not at module load,
and the rest of the bot stays plain CommonJS.

## 2. One definition, one instance per call

The definition is a constant. The instance is the call.

```js
// call-machine.js — loaded once
export const Call = defineMachine()({
  name: "TeamsCall",
  context: () => ({ callId: "?", session: null, participants: 0 }),
  cleanup: (ctx) => ctx.session?.dispose(),
  states: {
    initial_state: { enter: () => goto("ringing") },
    ringing: {
      on: { "teams:answered": () => goto("connected") },
      after: { delay: 30_000, then: () => failure("no answer") },
    },
    connected: {
      on: { "teams:hangup": () => success("caller hung up") },
      after: { delay: 3_600_000, then: () => success("max duration") },
    },
  },
});
```

```js
const instance = Call.start({ args: { callId, session } });
```

`Machine.start()` calls the `context` factory again for every instance,
so each call gets its own context object. Two rules keep that guarantee
intact.

**The factory must build a new object.** Closing over a shared one turns
every call into the same call:

```js
const SHARED = { ticks: 0 };
context: () => SHARED;        // WRONG — call B reads call A's counter
context: () => ({ ticks: 0 }); // right
```

**`args` is a shallow merge.** `Object.assign` copies top-level keys, so
a nested object is replaced whole, not merged:

```js
context: () => ({ sdk: { session: null, codec: "opus" } });
Call.start({ args: { sdk: { session } } });
// ctx.sdk is now { session } — codec is gone
```

Keep the keys you pass through `args` flat, or merge the nested part
yourself in `enter`.

Defining the machine per call is not a leak — the internal registries
are `WeakMap`s — but it buys nothing. `defineMachine()` costs ~12 µs and
`start()` ~21 µs; the definition is the part that never changes.

## 3. The call registry, and how events find their machine

The bot needs one map from the SDK's call identity to the instance, and
that map is the only place a call lives.

```js
const calls = new Map();

export function openCall(callId, session) {
  const instance = Call.start({
    args: { callId, session },
    debug: process.env.FSL_DEBUG === "1",
    logger: (line) => log.debug(`[call ${callId}] ${line}`),
  });
  calls.set(callId, instance);
  // the only place a call is forgotten
  instance.done.then(({ outcome, reason }) => {
    calls.delete(callId);
    log.info(`[call ${callId}] ${outcome}${reason ? `: ${reason}` : ""}`);
  });
  return instance;
}

export function onSdkEvent(callId, event) {
  const instance = calls.get(callId);
  if (instance === undefined) {
    log.warn(`[call ${callId}] event ${event.type} for an unknown call`);
    return;
  }
  instance.send(event);
}
```

Three properties of `send()` make this safe:

- It is synchronous and run-to-completion. The event is fully processed —
  transition, `enter`, pending replay — before `send()` returns.
- An event the current state does not handle is **not** dropped. It waits
  in the pending queue and is replayed on every state change (spec §4.2).
  The `teams:answered` that arrives a millisecond early still lands.
- Sending to an instance that already terminated is a no-op. It does not
  throw. Racing SDK callbacks after a hangup need no guard of their own.

Delete on `done`, never anywhere else. A machine you drop from the map
while it is still running keeps its timers armed and stays alive.

## 4. Timers hold the event loop open

This is the one Node-specific behaviour that surprises people.

FSL arms a real `setTimeout` for every `after` clause and every
`fx.delay`, and it does not `unref()` them. A process with one machine
waiting on a 30 s `after` will not exit for 30 s, even with nothing else
to do. Measured: the probe below stayed alive past 6 s; the same probe
that awaits `shutdown()` first exits in 7 ms.

For a call bot this is the behaviour you want — a live call should keep
the process up. It does mean **shutdown has to be explicit**:

```js
async function drain(signal) {
  log.info(`${signal}: draining ${calls.size} calls`);
  const live = [...calls.values()];
  await Promise.all(live.map((i) => i.shutdown(signal)));
  // every timer is cancelled now; the loop is free and Node exits
}
process.on("SIGTERM", () => drain("SIGTERM"));
process.on("SIGINT", () => drain("SIGINT"));
```

`shutdown()` gives the machine its say. Without an `onShutdown` hook the
machine ends `aborted` with your reason. With one it decides:

```js
onShutdown: (ctx) => {
  if (ctx.session === null) return success("nothing to hang up");
  ctx.session.bye();
  return goto("terminating"); // keep running toward its own end
};
```

A non-terminal answer means the machine finishes its business; the
caller's patience on `done`, or the parent's grace period (5 s by
default, `graceMs`), is the backstop. Draining 5 000 machines took 44 ms.

Both `cleanup` and `onShutdown` are where SDK handles get released.
`cleanup` runs after **any** terminal transition — hangup, failure,
shutdown alike — which makes it the right place for the release your bot
must never skip.

## 5. Async work goes through `fx.task`, never a bare promise

A bare `await` inside a handler breaks run-to-completion and puts an
unhandled rejection one bad response away from your process. `fx.task`
turns any promise into exactly one event:

```js
connected: {
  enter: (ctx, fx) => {
    fx.task((signal) => transcribe(ctx.stream, { signal }), "asr", { timeout: 5_000 });
  },
  on: {
    "task:asr": (ev) =>
      ev.ok ? goto("routing", ev.value.intent) : goto("fallback", ev.error),
  },
}
```

Verified on Node, with `unhandledRejection` and `uncaughtException`
wired to fail the probe:

- a promise that rejects arrives as `{ ok: false, error }` — no crash;
- a promise slower than `timeout` arrives as `{ ok: false, error: "timeout" }`
  and its `AbortSignal` fires, so the work is really cancelled;
- a promise that rejects **after** its machine terminated is swallowed —
  the process survives.

That last one matters for a bot: calls end while requests are in flight,
every single day.

## 6. Backpressure is per call, and it is bounded

Each instance has its own pending queue, capped at 32 events by default.
Overflow drops the **oldest** event and logs a warning through that
instance's logger. Confirmed: 40 unmatched events in, queue holds 32,
8 warnings out.

Raise it per machine when a call legitimately buffers more:

```js
defineMachine()({ name: "TeamsCall", pending: { max: 128 }, /* … */ });
```

Watch those warnings in production. `pending queue overflow` means either
a state that forgot a clause, or a burst larger than the bound — and the
first is far more common than the second. `fx.dropPending("media:tick")`
is how a state discards a class of events it knows it will never want.

## 7. One logger per call, or you will not be able to read anything

Debug lines carry the transition, not the call. With 300 concurrent
calls, `teams:answered: (ringing) -> (connected)` tells you nothing about
*which* call moved. Pass a closure that knows the call id:

```js
Call.start({
  args: { callId },
  debug: true,
  logger: (line) => log.debug({ callId }, line),
  logSize: 100, // per-instance transition ring buffer, default 50
});
```

`logger` receives warnings too, not just debug lines, so a per-call
logger also routes pending-queue overflows and subscriber exceptions to
the right call.

Each instance keeps its last transitions in `instance.log` — the ring
buffer is bounded, so it costs a fixed amount per call. Dump it when a
call ends badly:

```js
instance.done.then(({ outcome, reason }) => {
  if (outcome === "failure") log.error({ callId, reason, log: instance.log });
});
```

For a status endpoint, read `instance.state`, `instance.context`,
`instance.pending` and `instance.sbb` — the last one names the service
building block a call is currently inside, and where.

## 8. A failing call fails alone

An exception thrown in a handler is caught, logged, and turned into
`failure(message)` for **that instance only**. Verified across 500
concurrent calls: one machine crashed inside its handler, its `done`
settled `{ outcome: "failure", reason: "Error: SDK blew up" }`, and the
other 499 kept their state and their context untouched.

`instance.done` **resolves** with `{ outcome, reason }`; it never
rejects. Attaching a `.catch()` is unnecessary, and forgetting one is
not a source of unhandled rejections.

## 9. What it costs

Measured on this machine, 5 000 concurrent instances, each with an armed
one-hour timer:

| | |
|---|---|
| `Machine.start()` | ~45 µs per call |
| one `send()` | ~5.8 µs per event |
| heap | ~3.6 kB per live machine |
| graceful drain of 5 000 | 44 ms |

A bot holding a few thousand simultaneous calls spends single-digit
megabytes on FSL. The machine is not the part that will cost you.

## 10. Checklist

- [ ] The machine is defined once, at module scope.
- [ ] `context` returns a **new** object every call.
- [ ] Per-call data goes in `args`, top-level keys only.
- [ ] Every live call is in one registry, keyed by the SDK's call id.
- [ ] The registry entry is deleted in `done`, and nowhere else.
- [ ] `cleanup` releases every SDK handle the call owns.
- [ ] `SIGTERM` / `SIGINT` drain the registry with `shutdown()`.
- [ ] No `await` in a handler — async work goes through `fx.task`.
- [ ] Every `fx.task` that talks to the network has a `timeout`.
- [ ] Each instance gets a `logger` closure carrying its call id.
- [ ] `pending queue overflow` warnings are monitored.

## 11. Choosing between `fx.spawn` and `fx.sbb`

Both appear once a call gets complex, and they are not alternatives.

`fx.spawn` starts a **second machine** with a state of its own — the
right shape for a call leg, a media pipeline, a participant: something
that lives beside the call and can end without ending it. The parent
receives `child:exit`, and children are torn down with the parent, in
order, with a grace period.

`fx.sbb` calls a **subroutine** — same machine, same context, same
mailbox — for a sequence you wrote once and call from anywhere: play a
menu, collect a code, transfer. The call's `state` stays the host's; the
block reports through `snapshot.sbb`.

Reach for `spawn` when the thing has a lifetime. Reach for `sbb` when it
has a return value.

---

The language reference is [`spec/fsl-js-ts.md`](../../spec/fsl-js-ts.md);
how the runtime works inside is [`docs/design.md`](./design.md). When
this guide and the spec disagree, the spec wins and this file has a bug.
