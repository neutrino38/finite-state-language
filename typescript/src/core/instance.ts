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
  ChildExit,
  ChildMsg,
  DoneResult,
  Fx,
  Instance,
  Listener,
  Machine,
  Outcome,
  ParentMsg,
  SbbFx,
  SbbView,
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
/**
 * Bound on the SBB stack (design §12.3). Blocks compose as a call
 * stack, and a block that enters itself would otherwise recurse until
 * the JS stack gives out, with nothing in the log to say why.
 */
const MAX_SBB_DEPTH = 16;
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
  onShutdown?: (ctx: unknown, fx: unknown) => Transition | void;
  cleanup?: (ctx: unknown) => void;
}

/** The untyped face of a block definition (spec §8.4). */
export interface InternalSbbDef {
  name: string;
  data: () => unknown;
  states: Record<string, InternalStateDef>;
  timeout?: {
    delay: number;
    then: (ctx: unknown, fx: unknown) => Transition | void;
  };
  cleanup?: (ctx: unknown, data: unknown) => void;
}

interface SbbInternals {
  def: InternalSbbDef;
  successor: Readonly<Record<string, string | undefined>>;
}

/**
 * One entry of the SBB stack (design §12.3). A stack of definitions,
 * not of instances: there is one machine, one context and one mailbox
 * throughout — which is the whole difference with fx.spawn.
 */
interface SbbFrame {
  readonly block: string;
  readonly def: InternalSbbDef;
  readonly successor: Readonly<Record<string, string | undefined>>;
  readonly data: unknown;
  /** The host state to resume, restored on return. */
  readonly hostState: string;
  fx: SbbFx<AnyEvent, unknown, unknown, AnyEvent>;
  timeoutHandle: ReturnType<typeof setTimeout> | undefined;
}

/** Pseudo-event used to label shutdown transitions in logs. */
const SHUTDOWN_EVENT: AnyEvent = Object.freeze({ type: "shutdown" });

const DEFAULT_GRACE_MS = 5000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyInstance = MachineInstance<any, AnyEvent, string>;

interface ParentLink {
  parent: AnyInstance;
  name: string;
}

interface MachineInternals {
  def: InternalDef;
  successor: Readonly<Record<string, string | undefined>>;
}

/**
 * defineMachine registers every Machine here so fx.spawn can construct
 * a child instance with its parent link in place before the child's
 * initial enter runs (design §6).
 */
const MACHINE_REGISTRY = new WeakMap<object, MachineInternals>();

export function registerMachine(
  machine: object,
  internals: MachineInternals,
): void {
  MACHINE_REGISTRY.set(machine, internals);
}

/** Same registry trick for blocks: fx.sbb resolves them through it. */
const SBB_REGISTRY = new WeakMap<object, SbbInternals>();

export function registerSbb(block: object, internals: SbbInternals): void {
  SBB_REGISTRY.set(block, internals);
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
  private phase: "running" | "terminating" | "done" = "running";

  private readonly inbox: AnyEvent[] = [];
  private draining = false;
  private chain = 0;
  private replayGen = 0;

  private readonly pendingQ: PendingQueue<AnyEvent>;
  private readonly timers = new TimerBag();
  private readonly tasks = new TaskManager((ev) => this.send(ev as Ev));
  private readonly children = new Map<string, AnyInstance>();
  private readonly parentLink: ParentLink | undefined;
  private readonly graceMs: number;
  private readonly inheritedOpts: Pick<
    StartOpts<Ctx>,
    "debug" | "logger" | "logSize" | "graceMs"
  >;
  private readonly subscribers = new Set<Listener<Ctx, Ev, SN>>();
  private snapshot!: Snapshot<Ctx, Ev, SN>;
  private readonly translog: TransitionLog;
  private readonly fx: Fx<Ev, Ctx>;
  /** The SBB stack, innermost last (spec §8.4, design §12.3). */
  private readonly sbbStack: SbbFrame[] = [];

  private readonly debug: boolean;
  private readonly debugLogger: (line: string) => void;
  private readonly warnLogger: (line: string) => void;
  private doneResolve!: (r: DoneResult) => void;

  constructor(
    def: InternalDef,
    successor: Readonly<Record<string, string | undefined>>,
    opts: StartOpts<Ctx> = {},
    parentLink?: ParentLink,
  ) {
    this.def = def;
    this.successor = successor;
    this.parentLink = parentLink;
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    this.inheritedOpts = {
      debug: opts.debug,
      logger: opts.logger,
      logSize: opts.logSize,
      graceMs: opts.graceMs,
    };
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

    this.fx = this.makeFx();

    // Enter initial_state under the drain latch so fx.send from its
    // `enter` queues instead of re-entering (design §4.1).
    this.draining = true;
    this.enterState("initial_state", "start", undefined);
    this.draining = false;
    this.drain();
  }

  /**
   * The effects facade. One is built per SBB frame so that `data` and
   * `sbbReturn` address the right block; everything else is shared,
   * because there is only ever one machine underneath (design §12.3).
   */
  private makeFx(frame?: SbbFrame): Fx<Ev, Ctx> {
    const base: Fx<Ev, Ctx> = {
      send: (ev) => this.send(ev),
      delay: (ev, ms, opts) =>
        this.timers.delay(ms, opts?.sticky ?? false, () => this.send(ev)),
      task: (work, tag, opts) =>
        this.tasks.run(work, tag, opts as TaskOpts<unknown>),
      cancel: (tag) => this.tasks.cancel(tag),
      dropPending: (sel) =>
        this.pendingQ.drop(sel as string | ((ev: AnyEvent) => boolean)),
      spawn: (machine, opts) => this.spawnChild(machine, opts),
      notify: (child, payload) => this.notifyChild(child, payload),
      notifyParent: (payload) => {
        // No-op without a parent: the same machine runs standalone.
        if (this.parentLink === undefined) return;
        const msg: ChildMsg = {
          type: "child:msg",
          from: this.parentLink.name,
          payload,
        };
        this.parentLink.parent.send(msg as AnyEvent as never);
      },
      sbb: (block, opts) =>
        this.enterSbb(
          block as unknown as object,
          opts as { args?: Record<string, unknown> } | undefined,
        ),
    };
    if (frame === undefined) return base;
    const blockFx: SbbFx<AnyEvent, unknown, unknown, AnyEvent> = {
      ...(base as unknown as Fx<AnyEvent, unknown>),
      data: frame.data,
      sbbReturn: (ev) => this.sbbReturn(frame, ev),
    };
    return blockFx as unknown as Fx<Ev, Ctx>;
  }

  // ---- the current rung of the stack (design §12.3) ------------------------

  /** States of whatever is running: the host, or the innermost block. */
  private currentStates(): Record<string, InternalStateDef> {
    const top = this.sbbStack[this.sbbStack.length - 1];
    return top === undefined ? this.def.states : top.def.states;
  }

  private currentSuccessor(): Readonly<Record<string, string | undefined>> {
    const top = this.sbbStack[this.sbbStack.length - 1];
    return top === undefined ? this.successor : top.successor;
  }

  private currentFx(): Fx<Ev, Ctx> {
    const top = this.sbbStack[this.sbbStack.length - 1];
    return top === undefined ? this.fx : (top.fx as unknown as Fx<Ev, Ctx>);
  }

  /**
   * Qualify a state name with the block it belongs to, for the log and
   * the debug lines (design §12.5) — `EstablishCall/dialing` rather than
   * a `dialing` the host never declared. `depth` is the stack height the
   * name lives at, so a transition into or out of a block can label its
   * two ends differently.
   */
  private qualAt(name: string, depth: number): string {
    const frame = this.sbbStack[depth - 1];
    return frame === undefined ? name : `${frame.block}/${name}`;
  }

  private qual(name: string): string {
    return this.qualAt(name, this.sbbStack.length);
  }

  private sbbView(): SbbView | undefined {
    const top = this.sbbStack[this.sbbStack.length - 1];
    if (top === undefined) return undefined;
    return Object.freeze({
      block: top.block,
      state: this.stateName,
      depth: this.sbbStack.length,
      meta: top.def.states[this.stateName]?.meta,
    });
  }

  /**
   * The state the outside world is told about: always the host's. A
   * block is a subroutine call, not a state the scenario declared, so
   * publishing its states here would make the machine look like it
   * jumped somewhere it cannot go (design §12.5). `snapshot.sbb` is
   * where a block's own position is published.
   */
  private hostStateName(): string {
    const bottom = this.sbbStack[0];
    return bottom === undefined ? this.stateName : bottom.hostState;
  }

  // ---- public surface (spec §6) -------------------------------------------

  get state(): SN | TerminalStateName {
    return this.hostStateName() as SN | TerminalStateName;
  }

  get sbb(): SbbView | undefined {
    return this.sbbView();
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
    return this.hostStateName() === s;
  }

  /** Cooperative shutdown (spec §8.2, design §6). */
  shutdown(reason?: string): Promise<DoneResult> {
    if (this.phase !== "running") return this.done;
    // A cooperative shutdown reaching a block unwinds it and runs the
    // *host's* onShutdown (design §12.6). Ending from inside the block
    // instead would skip the hook where the host frees what the run
    // reserved, and leak it.
    if (this.sbbStack.length > 0) this.unwindSbb(reason ?? "shutdown");
    const onShutdown = this.def.onShutdown;
    if (onShutdown === undefined) {
      this.finalize("aborted", reason, SHUTDOWN_EVENT);
      return this.done;
    }
    // Same discipline as an external event; save/restore the latch so a
    // shutdown() issued from within a handler stays well-nested.
    const wasDraining = this.draining;
    this.draining = true;
    this.chain = 0;
    try {
      const t = this.guard(() => onShutdown(this.ctx, this.fx));
      if (t !== FAILED) {
        if (t == null) this.finalize("aborted", reason, SHUTDOWN_EVENT);
        else this.applyTransition(t, SHUTDOWN_EVENT);
      }
    } finally {
      this.draining = wasDraining;
    }
    this.drain();
    return this.done;
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
    const on = this.currentStates()[this.stateName]?.on;
    return on?.[ev.type] ?? on?.["*"];
  }

  private runClause(clause: AnyHandler | string, ev: AnyEvent): void {
    if (typeof clause === "string") {
      // String shorthand: move there, then re-dispatch the event once
      // in the target state (spec §2, design §11.2).
      this.enterState(clause, `on ${ev.type}`, ev, ev);
      return;
    }
    const depth = this.sbbStack.length;
    const t = this.guard(() => clause(ev, this.ctx, this.currentFx()));
    if (t === FAILED) return;
    if (!this.stillOurs(t, depth)) return;
    this.applyTransition(t, ev);
  }

  /**
   * A user callback that moved the SBB stack owns nothing after that:
   * `this.stateName` no longer names a state of the definition the
   * callback was written against. A transition returned from it would
   * be applied against the wrong states — a `goto` naming a host state,
   * resolved inside a block, or the reverse. So it is refused, loudly
   * (design §12.4).
   *
   * Returns true when the caller may go on using the transition.
   */
  private stillOurs(t: Transition | void | undefined, depth: number): boolean {
    if (this.sbbStack.length === depth) return true;
    if (t != null && t.kind !== "stay") {
      const moved = this.sbbStack.length > depth ? "fx.sbb" : "fx.sbbReturn";
      this.warn(
        `transition '${t.kind}' returned after ${moved}: ignored — ` +
          `${moved} must be the last thing a state body does`,
      );
    }
    return false;
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
        const succ = this.currentSuccessor()[this.stateName];
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
    fromLabel?: string,
  ): void {
    if (++this.chain > MAX_CHAIN) {
      this.finalize(
        "failure",
        `transition livelock around state '${this.qual(this.stateName)}'`,
        ev,
      );
      return;
    }
    const sd = this.currentStates()[target];
    if (sd === undefined) {
      // unreachable from TS (typed goto), reachable from plain JS
      this.finalize("failure", `goto unknown state '${this.qual(target)}'`, ev);
      return;
    }
    const depth = this.sbbStack.length;
    // State exit: cancel the after timer and non-sticky delays (§3.2).
    this.timers.onExit();
    this.record(
      fromLabel ?? this.qual(this.stateName),
      this.qual(target),
      ev,
      desc,
    );
    this.stateName = target;
    // Notify on entry, before `enter` runs: subscribers see every hop of
    // a synchronous chain, in agreement with the transition log.
    this.notify(ev, desc);

    const t = this.guard(() => sd.enter?.(this.ctx, this.currentFx()));
    if (t === FAILED || this.phase !== "running") return;
    // An `enter` that called fx.sbb left a block running: this state has
    // not settled, and its deadline stays suspended until the block
    // returns — which is where it gets armed afresh (design §12.4).
    if (!this.stillOurs(t, depth)) {
      // A string shorthand landed in a state whose `enter` entered a
      // block. The event it was going to re-dispatch still has to be
      // offered to whatever answers now, so it goes round the mailbox
      // rather than being dropped on the floor.
      if (this.phase === "running" && redispatch) this.send(redispatch as Ev);
      return;
    }
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

  // ---- service building blocks (spec §8.4, design §12) ---------------------

  /**
   * fx.sbb: enter a block. The machine is suspended at the call site —
   * it keeps its context, its mailbox and its children, and stops being
   * the thing that answers events until the block returns.
   */
  private enterSbb(
    block: object,
    opts?: { args?: Record<string, unknown> },
  ): void {
    if (this.phase !== "running") return;
    const internals = SBB_REGISTRY.get(block);
    if (internals === undefined) {
      throw new Error("sbb: not a block created by defineSbb");
    }
    if (this.sbbStack.length >= MAX_SBB_DEPTH) {
      this.finalize(
        "failure",
        `sbb stack deeper than ${MAX_SBB_DEPTH} entering '${internals.def.name}'`,
      );
      return;
    }
    const hostLabel = this.qual(this.stateName);
    // The host's deadline is suspended while the block runs (spec §8.4).
    // Its fx.delay handles are not: it never left its state, so their
    // "cancelled on state exit" has not happened (design §12.4).
    this.timers.cancelAfter();
    this.timers.pushScope();
    const seed = internals.def.data() as Record<string, unknown>;
    const frame: SbbFrame = {
      block: internals.def.name,
      def: internals.def,
      successor: internals.successor,
      data: Object.assign(seed, opts?.args ?? {}),
      hostState: this.stateName,
      fx: undefined as never,
      timeoutHandle: undefined,
    };
    frame.fx = this.makeFx(frame) as unknown as SbbFx<
      AnyEvent,
      unknown,
      unknown,
      AnyEvent
    >;
    this.sbbStack.push(frame);
    const timeout = internals.def.timeout;
    if (timeout !== undefined) {
      frame.timeoutHandle = setTimeout(
        () => this.fireSbbTimeout(frame),
        timeout.delay,
      );
    }
    this.enterState(
      "initial_state",
      `sbb ${frame.block}`,
      undefined,
      undefined,
      hostLabel,
    );
  }

  /** fx.sbbReturn: pop one frame and resume the host (spec §8.4). */
  private sbbReturn(frame: SbbFrame, ev: AnyEvent): void {
    if (this.phase !== "running") return;
    if (this.sbbStack[this.sbbStack.length - 1] !== frame) {
      // An fx captured in a closure and used after its block returned
      // would otherwise pop somebody else's frame.
      this.warn(
        `sbbReturn: block '${frame.block}' is not the one currently running`,
      );
      return;
    }
    const desc = `sbb return ${ev.type}`;
    const from = this.qual(this.stateName);
    this.popFrame(frame);
    this.record(from, this.qual(this.stateName), undefined, desc);
    this.notify(undefined, desc);
    // The host resumes as a stay(): its `enter` does not re-run, and the
    // deadline it never got to arm is armed now, afresh (design §12.4).
    const afterSpec = this.currentStates()[this.stateName]?.after;
    if (afterSpec !== undefined) {
      this.timers.armAfter(afterSpec.delay, () => this.fireAfter(afterSpec));
    }
    // The returned event is not privileged: whatever the block left
    // pending is replayed against the host state first, in arrival
    // order (spec §8.4).
    this.replayPending();
    if (this.phase === "running") this.send(ev as Ev);
  }

  private popFrame(frame: SbbFrame): void {
    if (frame.timeoutHandle !== undefined) clearTimeout(frame.timeoutHandle);
    frame.timeoutHandle = undefined;
    this.timers.popScope();
    this.sbbStack.pop();
    this.stateName = frame.hostState;
  }

  /**
   * Unwind the stack down to `downTo` frames, running each block's
   * cleanup on the way out, innermost first. Used by a terminal, by a
   * shutdown and by an outer block's deadline — every way of leaving a
   * block other than returning from it.
   *
   * cleanup runs outside `guard` on purpose: this is already the
   * unwinding path, and a throwing cleanup must not restart it.
   */
  private unwindSbb(reason: string, downTo = 0): void {
    while (this.sbbStack.length > downTo) {
      const frame = this.sbbStack[this.sbbStack.length - 1] as SbbFrame;
      const from = this.qual(this.stateName);
      this.popFrame(frame);
      this.record(
        from,
        this.qual(this.stateName),
        undefined,
        `sbb unwound: ${reason}`,
      );
      try {
        frame.def.cleanup?.(this.ctx, frame.data);
      } catch (err) {
        this.warn(
          `exception in cleanup of block '${frame.block}': ${String(err)}`,
        );
      }
    }
  }

  /** The block's own deadline expired (spec §8.4). */
  private fireSbbTimeout(frame: SbbFrame): void {
    if (this.phase !== "running") return;
    const idx = this.sbbStack.indexOf(frame);
    const spec = frame.def.timeout;
    if (idx < 0 || spec === undefined) return;
    frame.timeoutHandle = undefined;
    // Same discipline as an after timer: fresh chain budget, drain latch
    // held so fx.send from `then` queues instead of re-entering.
    this.draining = true;
    this.chain = 0;
    try {
      // A deadline that expires while the block sits inside another one
      // abandons that one first: the sequence it was waiting on is over.
      this.unwindSbb(`deadline of '${frame.block}'`, idx + 1);
      if (this.phase === "running") {
        const depth = this.sbbStack.length;
        const t = this.guard(() => spec.then(this.ctx, frame.fx));
        if (t !== FAILED && this.stillOurs(t, depth)) {
          this.applyTransition(t, AFTER_EVENT);
        }
      }
    } finally {
      this.draining = false;
    }
    this.drain();
  }

  // ---- sub-machines (spec §8.1, design §6) ---------------------------------

  /** Internal: true once done has settled. */
  get settled(): boolean {
    return this.phase === "done";
  }

  private spawnChild(
    machine: Machine<unknown, AnyEvent, string>,
    opts: { as: string; args?: unknown },
  ): void {
    if (this.phase !== "running") return;
    const internals = MACHINE_REGISTRY.get(machine as object);
    if (internals === undefined) {
      throw new Error(
        `spawn: '${String(opts.as)}' is not a machine created by defineMachine`,
      );
    }
    if (this.children.has(opts.as)) {
      throw new Error(`spawn: child '${opts.as}' already exists`);
    }
    const child = new MachineInstance(
      internals.def,
      internals.successor,
      {
        ...this.inheritedOpts,
        args: opts.args as never,
      },
      { parent: this as unknown as AnyInstance, name: opts.as },
    );
    // The child may have terminated synchronously during its own start
    // (childExited already fired): only register it while alive.
    if (!child.settled) this.children.set(opts.as, child as AnyInstance);
  }

  private notifyChild(name: string, payload: unknown): void {
    const child = this.children.get(name);
    if (child === undefined) {
      this.warn(`notify: no child named '${name}'`);
      return;
    }
    const msg: ParentMsg = { type: "parent:msg", payload };
    child.send(msg as AnyEvent as never);
  }

  /** Internal: called synchronously by a child when its done settles. */
  childExited(name: string, result: DoneResult): void {
    this.children.delete(name);
    const ev: ChildExit = {
      type: "child:exit",
      from: name,
      outcome: result.outcome,
      reason: result.reason,
    };
    this.send(ev as AnyEvent as Ev);
  }

  /**
   * Internal: forced teardown (design §6) — no onShutdown, no grace.
   * Cancels everything, force-stops descendants, settles done as
   * aborted "force-stopped".
   */
  forceStop(): void {
    if (this.phase === "done") return;
    if (this.sbbStack.length > 0) this.unwindSbb("force-stopped");
    this.phase = "terminating";
    this.inbox.length = 0;
    this.pendingQ.clear();
    this.timers.cancelAll();
    this.tasks.cancelAll();
    for (const child of [...this.children.values()]) child.forceStop();
    this.children.clear();
    this.record(
      this.stateName,
      TERMINAL_STATES.aborted,
      undefined,
      "force-stopped",
    );
    this.stateName = TERMINAL_STATES.aborted;
    this.completeFinalize("aborted", "force-stopped", undefined);
  }

  /** The state's `after` timer fired (spec §3.2). */
  private fireAfter(spec: InternalAfter): void {
    if (this.phase !== "running") return;
    // Same discipline as an external event: fresh chain budget, drain
    // latch held so fx.send from `then` queues instead of re-entering.
    this.draining = true;
    this.chain = 0;
    try {
      const depth = this.sbbStack.length;
      const t = this.guard(() => spec.then(this.ctx, this.currentFx()));
      if (t !== FAILED && this.stillOurs(t, depth)) {
        this.applyTransition(t, AFTER_EVENT);
      }
    } finally {
      this.draining = false;
    }
    this.drain();
  }

  // ---- termination (design §4.9) -------------------------------------------

  private finalize(outcome: Outcome, reason?: string, ev?: AnyEvent): void {
    if (this.phase !== "running") return;
    // A terminal unwinds the whole stack, host included (spec §8.4) —
    // success() is not the way back from a block, sbbReturn is. Each
    // block's cleanup runs on the way out, so unwinding leaks nothing.
    if (this.sbbStack.length > 0) this.unwindSbb(reason ?? outcome);
    this.phase = "terminating";
    const terminal = TERMINAL_STATES[outcome];
    this.inbox.length = 0;
    this.pendingQ.clear();
    this.record(this.stateName, terminal, ev, reason);
    this.stateName = terminal;
    this.timers.cancelAll();
    this.tasks.cancelAll();
    if (this.children.size === 0) {
      // The common path stays fully synchronous (design §4.9).
      this.completeFinalize(outcome, reason, ev);
      return;
    }
    void this.shutdownChildren().then(() =>
      this.completeFinalize(outcome, reason, ev),
    );
  }

  /**
   * Shut live children down cooperatively, force-stop stragglers after
   * the grace period (spec §8.1, design §6).
   */
  private async shutdownChildren(): Promise<void> {
    const kids = [...this.children.values()];
    for (const child of kids) void child.shutdown("parent terminated");
    const allDone = Promise.all(kids.map((c) => c.done)).then(
      () => "done" as const,
    );
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<"grace">((resolve) => {
      graceTimer = setTimeout(() => resolve("grace"), this.graceMs);
    });
    const winner = await Promise.race([allDone, grace]);
    clearTimeout(graceTimer);
    if (winner === "grace") {
      for (const child of [...this.children.values()]) child.forceStop();
    }
    this.children.clear();
  }

  /**
   * Last stage of any teardown (§8.3 order): cleanup, then the final
   * notification, then done settles. Idempotent — a forceStop racing a
   * graceful teardown completes only once.
   */
  private completeFinalize(
    outcome: Outcome,
    reason: string | undefined,
    ev: AnyEvent | undefined,
  ): void {
    if (this.phase === "done") return;
    this.phase = "done";
    try {
      this.def.cleanup?.(this.ctx);
    } catch (err) {
      this.warn(`exception in cleanup: ${String(err)}`);
    }
    this.notify(ev, reason);
    this.doneResolve({ outcome, reason });
    this.parentLink?.parent.childExited(this.parentLink.name, {
      outcome,
      reason,
    });
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
      this.warn(`exception in state '${this.qual(this.stateName)}': ${msg}`);
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
    const host = this.hostStateName();
    const sbb = this.sbbView();
    // `meta` follows `state`: both describe the host. A block's own meta
    // travels in `sbb`, so the two never disagree (design §12.5).
    this.snapshot = Object.freeze({
      state: host as SN | TerminalStateName,
      context: this.ctx,
      pending: this.pendingQ.list() as readonly Ev[],
      meta: this.def.states[host]?.meta,
      sbb,
    });
    const note: TransitionNotification<Ctx, Ev, SN> = {
      state: host as SN | TerminalStateName,
      context: this.ctx,
      event: ev as Ev | undefined,
      desc,
      sbb,
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
