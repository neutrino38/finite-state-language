/**
 * finite-state-language/react — the useMachine hook (spec §7.1,
 * design §8). One hook on useSyncExternalStore; react is an optional
 * peer dependency, and nothing in the core is React-aware.
 *
 * Ownership: given a Machine, the hook owns the instance lifecycle —
 * started on first render, shut down ("unmounted") on unmount, with
 * StrictMode's simulated remount producing a fresh instance (contexts
 * are per-instance, so this is semantically clean). Given a running
 * Instance, the hook only binds to it and never starts or stops it.
 *
 * The machine argument is captured for the component's lifetime;
 * swapping it across renders restarts on the next effect — key the
 * component instead if you need a synchronous swap. `opts` is read on
 * first start only.
 */

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useSyncExternalStore,
} from "react";
import type {
  AnyEvent,
  Instance,
  Machine,
  SbbView,
  Snapshot,
  StartOpts,
  TerminalStateName,
} from "../core/types.js";

export interface UseMachineResult<
  Ctx,
  Ev extends AnyEvent,
  SN extends string = string,
> {
  state: SN | TerminalStateName;
  context: Ctx;
  /** The current state's meta block (spec §7.3). */
  meta: Record<string, unknown> | undefined;
  /**
   * Set while a Service Building Block runs (spec §8.4): which block,
   * and where inside it. `state` stays the host's throughout — a block
   * is a subroutine call, not a state the machine declared — so this is
   * what a view renders to follow a sequence as it unfolds.
   */
  sbb: SbbView | undefined;
  send: (ev: Ev) => void;
  /** The underlying instance: done, log, pending, shutdown… */
  instance: Instance<Ctx, Ev, SN>;
}

function isMachine<Ctx, Ev extends AnyEvent, SN extends string>(
  m: Machine<Ctx, Ev, SN> | Instance<Ctx, Ev, SN>,
): m is Machine<Ctx, Ev, SN> {
  return typeof (m as Machine<Ctx, Ev, SN>).start === "function";
}

export function useMachine<
  Ctx,
  Ev extends AnyEvent,
  SN extends string = string,
>(
  machine: Machine<Ctx, Ev, SN> | Instance<Ctx, Ev, SN>,
  opts?: StartOpts<Ctx>,
): UseMachineResult<Ctx, Ev, SN> {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const owned = isMachine(machine);
  const ownedRef = useRef<Instance<Ctx, Ev, SN> | null>(null);
  const optsRef = useRef(opts);

  let inst: Instance<Ctx, Ev, SN>;
  if (owned) {
    // Lazy start in a ref: StrictMode's double render shares hook
    // state, so this runs the machine exactly once per mount.
    if (ownedRef.current === null) {
      ownedRef.current = machine.start(optsRef.current);
    }
    inst = ownedRef.current;
  } else {
    inst = machine;
  }

  useEffect(() => {
    if (!owned) return;
    if (ownedRef.current === null) {
      // StrictMode remount (or machine swap): the previous cleanup shut
      // the instance down — start a fresh one and re-render onto it.
      ownedRef.current = machine.start(optsRef.current);
      force();
    }
    return () => {
      void ownedRef.current?.shutdown("unmounted");
      ownedRef.current = null;
    };
  }, [owned, machine]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => inst.subscribe(onStoreChange),
    [inst],
  );
  const getSnapshot = useCallback(
    (): Snapshot<Ctx, Ev, SN> => inst.getSnapshot(),
    [inst],
  );
  // Third argument: server snapshot — same source, SSR-safe (design §8).
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const send = useCallback((ev: Ev) => inst.send(ev), [inst]);

  return {
    state: snap.state,
    context: snap.context,
    meta: snap.meta,
    sbb: snap.sbb,
    send,
    instance: inst,
  };
}
