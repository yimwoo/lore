import type { RawSessionEvent } from "./bridge/events";
import { LoreDaemon } from "./core/daemon";
import { FileMemoryStore } from "./core/memory-store";
import { ObservationLogWriter } from "./promotion/observation-log";
import { SidecarStore } from "./ui/sidecar-store";

export const appName = "Lore";

type CreateLoreAppOptions = {
  projectId: string;
  storageDir: string;
  sessionId?: string;
  observationDir?: string;
  now?: () => string;
  createId?: () => string;
};

export const createLoreApp = (options: CreateLoreAppOptions) => {
  const memoryStore = new FileMemoryStore({
    storageDir: options.storageDir,
    now: options.now,
  });

  const sessionId =
    options.sessionId ??
    `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const observationWriter =
    options.observationDir
      ? new ObservationLogWriter({
          observationDir: options.observationDir,
          sessionId,
        })
      : undefined;

  const daemon = new LoreDaemon({
    projectId: options.projectId,
    memoryStore,
    sessionId,
    observationWriter,
    now: options.now,
    createEventId: options.createId,
  });

  const sidecar = new SidecarStore({
    events: [],
    memories: [],
    latestHint: null,
    activity: [],
  });

  const ready = daemon.getSnapshot().then((snapshot) => {
    const current = sidecar.getSnapshot();
    const isInitialSnapshot =
      current.events.length === 0 &&
      current.memories.length === 0 &&
      current.latestHint === null &&
      current.activity.length === 0;

    if (isInitialSnapshot) {
      sidecar.setSnapshot(snapshot);
    }

    return snapshot;
  });

  return {
    daemon,
    sidecar,
    ready,
    async ingest(rawEvent: RawSessionEvent) {
      await daemon.ingest(rawEvent);
      const snapshot = await daemon.getSnapshot();
      sidecar.setSnapshot(snapshot);
      return snapshot;
    },
  };
};
