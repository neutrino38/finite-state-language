/**
 * MachineInstance — the runtime (design §4).
 *
 * One instance per Machine.start(). Internally the definition is handled
 * untyped (InternalDef); the generic surface is restored at the Instance
 * boundary. The event loop is synchronous run-to-completion (spec §4.1):
 * `send` from outside a handler fully processes the event before
 * returning; sends made during a dispatch hit the drain latch and queue.
 */

import type { Transition } from "./transition.js";
import type {
  AnyEvent,
  DoneResult,
  Fx,
  Instance,
  Listener,
  Outcome,
  Snapshot,
  StartOpts,
  TerminalStateName,
  TransitionNotification,
} from "./types.js";
import { TERMINAL_STATES } from "./types.js";
import { PendingQueue } from "./pending.js";
import { TransitionLog, type LogEntry } from "./log.js";
import { TimerBag } from "./timers.js";
import { TaskManager, type TaskOpts } from "./tasks.js";

/** Bound on synchronous transition chains (design §4.8). */
const MAX_CHAIN = 1000;
const DEFAULT_PENDING_MAX = 32;
const DEFAULT_LOG_SIZE = 50;

/** Sentinel returned by guard() when the user callback threw. */
const FAILED = Symbol("fsl-guard-failed");

type AnyHandler = (
  ev: AnyEvent,
  ctx: unknown,
  fx: unknown,
) => Transition | void;

interface InternalAfter {
  delay: number;
  then: (ctx: unknown, fx: unknown) => Transition | void;
}

interface InternalStateDef {
  enter?: (ctx: unknown, fx: unknown) => Transition | void;
  on?: Record<string, AnyHandler | string | undefined>;
  after?: InternalAfter;
  meta?: Record<string, unknown>;
}

/** Pseudo-event used to label after-timer transitions in logs. */
const AFTER_EVENT: AnyEvent = Object.freeze({ type: "after" });

export interface InternalDef {
  name: string;
  context: () => unknown;
  states: Record<string, InternalStateDef>;
  pending?: { max?: number };
  cleanup?: (ctx: unknown) => void;
}

export class MachineInstance<
  Ctx,
  Ev extends AnyEvent,
  SN extends string,
> implements Instance<Ctx, Ev, SN> {
  readonly done: Promise<DoneResult>;

  private readonly def: InternalDef;
  private readonly successor: Readonly<Record<string, string | undefined>>;
  private readonly ctx: Ctx;
  private stateName: string = "(start)";
  private phase: "running" | "done" = "running";

  private readonly inbox: AnyEvent[] = [];
  private draining = false;
  private chain = 0;
  private replayGen = 0;

  private readonly pendingQ: PendingQueue<AnyEvent>;
  private readonly timers = new TimerBag();
  private readonly tasks = new TaskManager((ev) => this.send(ev as Ev));
  private readonly subscribers = new Set<Listener<Ctx, Ev, SN>>();
  private snapshot!: Snapshot<Ctx, Ev, SN>;
  private readonly translog: TransitionLog;
  private readonly fx: Fx<Ev>;

  private readonly debug: boolean;
  private readonly debugLogger: (line: string) => void;
  private readonly warnLogger: (line: string) => void;
  private doneResolve!: (r: DoneResult) => void;

  constructor(
    def: InternalDef,
    successor: Readonly<Record<string, string | undefined>>,
    opts: StartOpts<Ctx> = {},
  ) {
    this.def = def;
    this.successor = successor;
    this.debug = opts.debug ?? false;
    this.debugLogger = opts.logger ?? ((line) => console.debug(line));
    this.warnLogger = opts.logger ?? ((line) => console.warn(line));
    this.translog = new TransitionLog(opts.logSize ?? DEFAULT_LOG_SIZE);
    this.pendingQ = new PendingQueue<AnyEvent>(
      def.pending?.max ?? DEFAULT_PENDING_MAX,
      (ev) =>
        this.warn(`pending queue overflow: dropped oldest event '${ev.type}'`),
    );
    this.done = new Promise((resolve) => {
      this.doneResolve = resolve;
    });

    const base = def.context() as Ctx;
    this.ctx = opts.args
      ? (Object.assign(base as object, opts.args) as Ctx)
      : base;

    this.fx = {
      send: (ev) => this.send(ev),
      delay: (ev, ms, opts) =>
        this.timers.delay(ms, opts?.sticky ?? false, () => this.send(ev)),
      task: (work, tag, opts) =>
        this.tasks.run(work, tag, opts as TaskOpts<unknown>),
      cancel: (tag) => this.tasks.cancel(tag),
      dropPending: (sel) =>
        this.pendingQ.drop(sel as string | ((ev: AnyEvent) => boolean)),
    };

    // Enter initial_state under the drain latch so fx.send from its
    // `enter` queues instead of re-entering (design §4.1).
    this.draining = true;
    this.enterState("initial_state", "start", undefined);
    this.draining = false;
    this.drain();
  }

  // ---- public surface (spec §6) -------------------------------------------

  get state(): SN | TerminalStateName {
    return this.stateName as SN | TerminalStateName;
  }

  get context(): Ctx {
    return this.ctx;
  }

  get log(): readonly LogEntry[] {
    return this.translog.list();
  }

  get pending(): readonly Ev[] {
    return this.pendingQ.list() as readonly Ev[];
  }

  send(ev: Ev): void {
    if (this.phase !== "running") {
      this.logDebug(`event '${ev.type}' dropped: machine is done`);
      return;
    }
    this.inbox.push(ev);
    this.drain();
  }

  subscribe(fn: Listener<Ctx, Ev, SN>): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  getSnapshot(): Snapshot<Ctx, Ev, SN> {
    return this.snapshot;
  }

  matches(s: SN | TerminalStateName): boolean {
    return this.stateName === s;
  }

  // ---- event loop (design §4.1–4.2) ----------------------------------------

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.inbox.length > 0 && this.phase === "running") {
        this.chain = 0;
        this.dispatch(this.inbox.shift() as AnyEvent);
      }
    } finally {
      this.draining = false;
    }
  }

  private dispatch(ev: AnyEvent): void {
    const clause = this.clauseFor(ev);
    if (clause === undefined) {
      this.pendingQ.push(ev);
      this.logDebug(`event '${ev.type}' pended in state '${this.stateName}'`);
      return;
    }
    this.runClause(clause, ev);
  }

  private clauseFor(ev: AnyEvent): AnyHandler | string | undefined {
    const on = this.def.states[this.stateName]?.on;
    return on?.[ev.type] ?? on?.["*"];
  }

  private runClause(clause: AnyHandler | string, ev: AnyEvent): void {
    if (typeof clause === "string") {
      // String shorthand: move there, then re-dispatch the event once
      // in the target state (spec §2, design §11.2).
      this.enterState(clause, `on ${ev.type}`, ev, ev);
      return;
    }
    const t = this.guard(() => clause(ev, this.ctx, this.fx));
    if (t === FAILED) return;
    this.applyTransition(t, ev);
  }

  // ---- transitions (design §4.3–4.4) ---------------------------------------

  private applyTransition(
    t: Transition | void | undefined,
    ev?: AnyEvent,
  ): void {
    if (this.phase !== "running" || t == null) return; // void ⇒ silent stay
    switch (t.kind) {
      case "stay":
        // Explicit stay notifies and logs (design §11.3).
        this.record(this.stateName, this.stateName, ev, t.desc);
        this.notify(ev, t.desc);
        return;
      case "goto":
        this.enterState(t.to, t.desc, ev);
        return;
      case "loop":
        this.enterState(this.stateName, t.desc, ev);
        return;
      case "next": {
        const succ = this.successor[this.stateName];
        if (succ === undefined) {
          this.finalize(
            "failure",
            `next() from last declared state '${this.stateName}'`,
            ev,
          );
          return;
        }
        this.enterState(succ, t.desc, ev);
        return;
      }
      case "final":
        this.finalize(t.outcome, t.reason, ev);
        return;
    }
  }

  private enterState(
    target: string,
    desc: string | undefined,
    ev: AnyEvent | undefined,
    redispatch?: AnyEvent,
  ): void {
    if (++this.chain > MAX_CHAIN) {
      this.finalize(
        "failure",
        `transition livelock around state '${this.stateName}'`,
        ev,
      );
      return;
    }
    const sd = this.def.states[target];
    if (sd === undefined) {
      // unreachable from TS (typed goto), reachable from plain JS
      this.finalize("failure", `goto unknown state '${target}'`, ev);
      return;
    }
    // State exit: cancel the after timer and non-sticky delays (§3.2).
    this.timers.onExit();
    this.record(this.stateName, target, ev, desc);
    this.stateName = target;
    // Notify on entry, before `enter` runs: subscribers see every hop of
    // a synchronous chain, in agreement with the transition log.
    this.notify(ev, desc);

    const t = this.guard(() => sd.enter?.(this.ctx, this.fx));
    if (t === FAILED || this.phase !== "running") return;
    if (t != null && t.kind !== "stay") {
      // enter returned a moving transition: the deeper entry owns the rest.
      this.applyTransition(t, ev);
      return;
    }
    // stay/void from enter are equivalent: the entry already notified.
    // Arm `after` only once the state settles (an enter that immediately
    // transitions never leaks a timer — design §4.4).
    const afterSpec = sd.after;
    if (afterSpec !== undefined) {
      this.timers.armAfter(afterSpec.delay, () => this.fireAfter(afterSpec));
    }
    this.replayPending();
    if (this.phase === "running" && redispatch) this.dispatch(redispatch);
  }

  /** Replay pended events against the (new) current state (spec §4.2). */
  private replayPending(): void {
    const gen = ++this.replayGen;
    let i = 0;
    while (this.phase === "running" && i < this.pendingQ.length) {
      const ev = this.pendingQ.at(i);
      const clause = this.clauseFor(ev);
      if (clause === undefined) {
        i++; // stays pended, arrival order preserved
        continue;
      }
      this.pendingQ.removeAt(i);
      this.logDebug(
        `replaying pended event '${ev.type}' in state '${this.stateName}'`,
      );
      this.runClause(clause, ev);
      // A transition during replay already replayed the remainder
      // against the new state (generation bumped): stop here.
      if (this.replayGen !== gen) return;
    }
  }

  /** The state's `after` timer fired (spec §3.2). */
  private fireAfter(spec: InternalAfter): void {
    if (this.phase !== "running") return;
    // Same discipline as an external event: fresh chain budget, drain
    // latch held so fx.send from `then` queues instead of re-entering.
    this.draining = true;
    this.chain = 0;
    try {
      const t = this.guard(() => spec.then(this.ctx, this.fx));
      if (t !== FAILED) this.applyTransition(t, AFTER_EVENT);
    } finally {
      this.draining = false;
    }
    this.drain();
  }

  // ---- termination (design §4.9) -------------------------------------------

  private finalize(outcome: Outcome, reason?: string, ev?: AnyEvent): void {
    if (this.phase !== "running") return;
    this.phase = "done";
    const terminal = TERMINAL_STATES[outcome];
    this.inbox.length = 0;
    this.pendingQ.clear();
    this.record(this.stateName, terminal, ev, reason);
    this.stateName = terminal;
    this.timers.cancelAll();
    this.tasks.cancelAll();
    // M4 adds child teardown here.
    try {
      this.def.cleanup?.(this.ctx);
    } catch (err) {
      this.warn(`exception in cleanup: ${String(err)}`);
    }
    this.notify(ev, reason);
    this.doneResolve({ outcome, reason });
  }

  // ---- plumbing -------------------------------------------------------------

  /**
   * Run a user callback; an exception is logged and converted to
   * `failure(String(err))` (spec §5).
   */
  private guard<T>(f: () => T): T | typeof FAILED {
    try {
      return f();
    } catch (err) {
      const msg = String(err);
      this.warn(`exception in state '${this.stateName}': ${msg}`);
      this.finalize("failure", msg);
      return FAILED;
    }
  }

  private record(
    from: string,
    to: string,
    ev: AnyEvent | undefined,
    desc?: string,
  ): void {
    this.translog.push({ from, to, event: ev?.type, desc });
    if (this.debug) {
      const evLabel = ev?.type ?? "";
      this.debugLogger(
        `${evLabel}: (${from}) -> (${to})${desc ? ` "${desc}"` : ""}`,
      );
    }
  }

  private notify(ev: AnyEvent | undefined, desc?: string): void {
    this.snapshot = Object.freeze({
      state: this.stateName as SN | TerminalStateName,
      context: this.ctx,
      pending: this.pendingQ.list() as readonly Ev[],
      meta: this.def.states[this.stateName]?.meta,
    });
    const note: TransitionNotification<Ctx, Ev, SN> = {
      state: this.stateName as SN | TerminalStateName,
      context: this.ctx,
      event: ev as Ev | undefined,
      desc,
    };
    for (const fn of [...this.subscribers]) {
      try {
        fn(note);
      } catch (err) {
        this.warn(`exception in subscriber: ${String(err)}`);
      }
    }
  }

  private logDebug(line: string): void {
    if (this.debug) this.debugLogger(line);
  }

  private warn(line: string): void {
    this.warnLogger(`[${this.def.name}] ${line}`);
  }
}
