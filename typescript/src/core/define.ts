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
import { MachineInstance, type InternalDef } from "./instance.js";

const RESERVED = new Set<string>(Object.values(TERMINAL_STATES));

export function defineMachine<Ctx, Ev extends AnyEvent>() {
  return <SN extends string>(
    def: MachineDef<Ctx, Ev, SN>,
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
    }

    // Declaration order defines next() (spec §3.1).
    const successor: Record<string, string | undefined> = {};
    for (let i = 0; i < names.length - 1; i++) {
      successor[names[i] as string] = names[i + 1];
    }

    const internal = def as unknown as InternalDef;
    return {
      name: def.name,
      start: (opts?: StartOpts<Ctx>): Instance<Ctx, Ev, SN> =>
        new MachineInstance<Ctx, Ev, SN>(internal, successor, opts),
    };
  };
}
