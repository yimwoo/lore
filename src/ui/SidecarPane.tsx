import type { LoreSnapshot } from "../core/daemon";

type SidecarPaneProps = {
  snapshot: LoreSnapshot;
};

export const SidecarPane = ({ snapshot }: SidecarPaneProps) => {
  const hint = snapshot.latestHint;

  return (
    <aside aria-label="Lore sidecar">
      <section>
        <h2>Lore</h2>
        {hint ? (
          <ul>
            {hint.bullets.map((bullet, index) => (
              <li key={`${bullet.category}-${index}`}>
                {bullet.source === "shared" && <span>[shared] </span>}
                <strong>{bullet.category}:</strong> {bullet.text}
              </li>
            ))}
          </ul>
        ) : (
          <p>No advisory hint yet.</p>
        )}
      </section>

      <section>
        <h3>Recent Activity</h3>
        <ul>
          {snapshot.activity.map((activity, index) => (
            <li key={`${activity.type}-${index}`}>{activity.message}</li>
          ))}
        </ul>
      </section>

      <section>
        <h3>Memory</h3>
        <ul>
          {snapshot.memories.map((memory) => (
            <li key={memory.id}>
              <strong>{memory.kind}:</strong> {memory.content}
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
};
