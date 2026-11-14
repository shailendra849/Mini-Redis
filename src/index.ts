import { start } from "./server.js";

void start().catch((cause: unknown) => {
  console.error("Could not start Mini Redis:", cause);
  process.exitCode = 1;
});
