import type { LoreSnapshot } from "../core/daemon";

type Listener = (snapshot: LoreSnapshot) => void;

export class SidecarStore {
  private snapshot: LoreSnapshot;
  private readonly listeners = new Set<Listener>();

  constructor(initialSnapshot: LoreSnapshot) {
    this.snapshot = initialSnapshot;
  }

  getSnapshot(): LoreSnapshot {
    return this.snapshot;
  }

  setSnapshot(snapshot: LoreSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
