import type { ActionDefinition } from "../../core/types.ts";

// EverMem's action surface is built up per implementation phase. Keep this list
// and the `EvermemActionName` union in sync with the handler map in runtime.ts.
export const evermemActions: ActionDefinition[] = [];

export type EvermemActionName = never;
