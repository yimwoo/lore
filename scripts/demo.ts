import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createLoreApp } from "../src/app";

const run = async () => {
  const storageDir = join(tmpdir(), "lore-demo");
  await rm(storageDir, { recursive: true, force: true });
  await mkdir(storageDir, { recursive: true });

  const app = createLoreApp({
    projectId: "demo-project",
    storageDir,
  });

  await app.ingest({
    kind: "user_prompt_submitted",
    prompt: "Let's keep memory project scoped for v1.",
    files: ["src/shared/types.ts"],
  });

  await app.ingest({
    kind: "tool_run_failed",
    toolName: "npm test",
    summary: "npm test failed while running the hint suite.",
  });

  await app.ingest({
    kind: "assistant_response_completed",
    response: "Next I will inspect src/echo/hint-engine.ts.",
    files: ["src/echo/hint-engine.ts"],
  });

  const snapshot = app.sidecar.getSnapshot();

  console.log("Lore demo snapshot");
  console.log(JSON.stringify(snapshot, null, 2));
  console.log(`\nMemory files written to: ${storageDir}`);
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
