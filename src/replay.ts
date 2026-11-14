import { readFile } from "node:fs/promises";
import { execute } from "./commands.js";
import { parseCommand } from "./resp.js";
import type { Store } from "./store.js";

export type ReplayResult = {
  commandsApplied: number;
  stoppedOnIncompleteTail: boolean;
};

/** Apply AOF RESP records into a store. Stops cleanly on a truncated/corrupt tail. */
export function replayAofBuffer(data: Buffer, store: Store): ReplayResult {
  let offset = 0;
  let commandsApplied = 0;

  while (offset < data.length) {
    const parsed = parseCommand(data.subarray(offset));
    if (parsed.status !== "complete") {
      return { commandsApplied, stoppedOnIncompleteTail: true };
    }
    offset += parsed.consumed;
    const result = execute(parsed.args, store, true).response;
    if (result[0] === 0x2d) {
      // Skip invalid historical commands without aborting the rest of a valid prefix.
      continue;
    }
    commandsApplied += 1;
  }

  return { commandsApplied, stoppedOnIncompleteTail: false };
}

export async function replayAofFile(filePath: string, store: Store): Promise<ReplayResult> {
  let data: Buffer;
  try {
    data = await readFile(filePath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { commandsApplied: 0, stoppedOnIncompleteTail: false };
    }
    throw cause;
  }
  return replayAofBuffer(data, store);
}
