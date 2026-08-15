/**
 * defineMachine (spec §3.1, design §3.2).
 *
 * Curried so that state names are inferred from the `states` literal
 * while Ctx and Ev stay explicit (TypeScript's all-or-nothing type
 * argument inference — design §11.1):
 *
 *   const M = defineMachine<Ctx, Ev>()({ name, context, states: {...} });
 *
 * SN (the state-name union) is inferred from the keys of `states`
 * against `Record<SN, StateDef<Ctx, Ev, SN>>`: keys resolve in
 * TypeScript's first inference pass, so handlers are contextually typed
 * with the full union and `goto("typo")` fails to compile.
 *
 * Runtime validation mirrors the type-level rules for plain-JS
 * consumers: violations throw at module load, not at first transition.
 */

import type {
  AnyEvent,
  Instance,
  Machine,
  MachineDef,
  StartOpts,
  StateDef,
} from "./types.js";
import { TERMINAL_STATES } from "./types.js";
import {
  MachineInstance,
  registerMachine,
  type InternalDef,
} from "./instance.js";
import { renderMermaid } from "./mermaid.js";

const RESERVED = new Set<string>(Object.values(TERMINAL_STATES));

// The defaults are the zero-effort JavaScript tier (spec §1.1): a JS
// consumer calling defineMachine() bare still gets typed state names,
// while ctx/events stay loose. TS consumers pass Ctx and Ev explicitly.
export function defineMachine<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Ctx = Record<string, any>,
  Ev extends AnyEvent = AnyEvent,
>() {
  return <SN extends string>(
    // The intersection requires `initial_state` at compile time without
    // adding an inference site for SN (the Record keys stay the only one).
    def: MachineDef<Ctx, Ev, SN> & {
      states: { initial_state: StateDef<Ctx, Ev, NoInfer<SN>> };
    },
  ): Machine<Ctx, Ev, SN> => {
    if (typeof def.name !== "string" || def.name.length === 0) {
      throw new TypeError("defineMachine: 'name' must be a non-empty string");
    }
    if (typeof def.context !== "function") {
      throw new TypeError(
        `machine '${def.name}': 'context' must be a factory function`,
      );
    }
    const states = def.states as Record<string, StateDef<Ctx, Ev, SN>>;
    if (states === null || typeof states !== "object") {
      throw new TypeError(`machine '${def.name}': 'states' must be an object`);
    }
    const names = Object.keys(states);
    if (!names.includes("initial_state")) {
      throw new TypeError(
        `machine '${def.name}': states must declare 'initial_state'`,
      );
    }
    for (const n of names) {
      if (RESERVED.has(n)) {
        throw new TypeError(
          `machine '${def.name}': state name '${n}' is reserved`,
        );
      }
    }
    for (const [stateName, stateDef] of Object.entries(states)) {
      for (const [evType, clause] of Object.entries(stateDef.on ?? {})) {
        if (typeof clause === "string" && !names.includes(clause)) {
          throw new TypeError(
            `machine '${def.name}': state '${stateName}' routes ` +
              `'${evType}' to unknown state '${clause}'`,
          );
        }
      }
      const after = stateDef.after;
      if (after !== undefined) {
        if (typeof after.delay !== "number" || after.delay < 0) {
          throw new TypeError(
            `machine '${def.name}': state '${stateName}' has an invalid ` +
              `after.delay`,
          );
        }
        if (typeof after.then !== "function") {
          throw new TypeError(
            `machine '${def.name}': state '${stateName}' after.then ` +
              `must be a function`,
          );
        }
      }
    }

    // Declaration order defines next() (spec §3.1).
    const successor: Record<string, string | undefined> = {};
    for (let i = 0; i < names.length - 1; i++) {
      successor[names[i] as string] = names[i + 1];
    }

    if (def.onShutdown !== undefined && typeof def.onShutdown !== "function") {
      throw new TypeError(
        `machine '${def.name}': 'onShutdown' must be a function`,
      );
    }

    const internal = def as unknown as InternalDef;
    const machine: Machine<Ctx, Ev, SN> = {
      name: def.name,
      start: (opts?: StartOpts<Ctx>): Instance<Ctx, Ev, SN> =>
        new MachineInstance<Ctx, Ev, SN>(internal, successor, opts),
      toMermaid: () => renderMermaid(internal),
    };
    // fx.spawn resolves the machine back to its internals through this
    // registry (design §6).
    registerMachine(machine, { def: internal, successor });
    return machine;
  };
}
