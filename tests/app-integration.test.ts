import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createLoreApp } from "../src/app";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

describe("createLoreApp", () => {
  it("pushes promoted hints into the sidecar store after a short session", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "lore-app-"));
    tempDirs.push(storageDir);

    const timestamps = [
      "2026-03-26T18:00:00.000Z",
      "2026-03-26T18:01:00.000Z",
      "2026-03-26T18:02:00.000Z",
      "2026-03-26T18:03:00.000Z",
      "2026-03-26T18:04:00.000Z",
      "2026-03-26T18:05:00.000Z",
      "2026-03-26T18:06:00.000Z",
      "2026-03-26T18:07:00.000Z",
    ];

    const app = createLoreApp({
      projectId: "project-alpha",
      storageDir,
      now: () => timestamps.shift() ?? "2026-03-26T18:08:00.000Z",
      createId: (() => {
        let counter = 0;
        return () => `event-${++counter}`;
      })(),
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

    expect(snapshot.latestHint).not.toBeNull();
    expect(snapshot.latestHint?.bullets.map((bullet) => bullet.category)).toEqual([
      "recall",
      "risk",
      "focus",
      "next_step",
    ]);
    expect(snapshot.memories).toHaveLength(5);
    expect(snapshot.activity[0]?.type).toBe("hint_promoted");
  });

  it("hydrates persisted memories into the sidecar on startup", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "lore-app-"));
    tempDirs.push(storageDir);

    const firstApp = createLoreApp({
      projectId: "project-alpha",
      storageDir,
      now: () => "2026-03-26T19:00:00.000Z",
      createId: () => "event-1",
    });

    await firstApp.ingest({
      kind: "user_prompt_submitted",
      prompt: "Let's keep memory project scoped for v1.",
      files: ["src/shared/types.ts"],
    });

    const secondApp = createLoreApp({
      projectId: "project-alpha",
      storageDir,
      now: () => "2026-03-26T19:05:00.000Z",
      createId: () => "event-2",
    });

    await secondApp.ready;

    const snapshot = secondApp.sidecar.getSnapshot();

    expect(snapshot.memories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "decision",
          content: "Keep memory project scoped for v1.",
        }),
      ]),
    );
    expect(snapshot.events).toEqual([]);
  });
});
