import type {
  LoreCapabilities,
  SelectedEntry,
  SessionStartTemplateInput,
  SharedKnowledgeKind,
} from "../shared/types";
import { whisperLabelMap } from "../shared/types";

const KIND_HEADERS: Record<SharedKnowledgeKind, string> = {
  domain_rule: "Domain Rules",
  architecture_fact: "Architecture",
  glossary_term: "Glossary",
  user_preference: "Preferences",
  decision_record: "Decisions",
};

const KIND_ORDER: SharedKnowledgeKind[] = [
  "domain_rule",
  "architecture_fact",
  "glossary_term",
  "user_preference",
  "decision_record",
];

const renderLoreIntro = (capabilities: LoreCapabilities): string => {
  const deliveryLines = [
    "1. **Session knowledge** (below): high-confidence facts selected for this session.",
    "2. **Whisper context** (per-turn): situational hints injected before individual prompts, marked with [Lore].",
  ];

  if (capabilities.recall) {
    deliveryLines.push(
      "3. **Recall tools** (on-demand): lore.recall_rules, lore.recall_architecture, lore.recall_decisions, lore.search_knowledge.",
    );
  }

  return `# Lore — Cross-Project Knowledge

You have access to Lore, a persistent knowledge system that tracks domain rules,
architecture decisions, user preferences, and glossary terms across projects.
Lore provides context in ${capabilities.recall ? "three" : "two"} ways:

${deliveryLines.join("\n")}`;
};

const renderUsageGuidance = (): string =>
  `## How to use Lore context

### Cite naturally when you use it

When a Lore entry influences your response, weave it into your reasoning naturally.
Do not list all Lore context — only mention entries you actually relied on.

Good:
  "Since your project uses snake_case for all DB columns, I'll name this \`user_account_id\`."
  "Your architecture rule says Postgres is the source of truth for billing — I'll write directly there instead of going through the Redis cache."

Bad:
  "According to Lore entry #abc123, the rule states..."  — too mechanical
  "Lore says: DB columns use snake_case. Lore says: Postgres is source of truth. Lore says: ..."  — don't dump everything

### Stay silent about Lore when it's not relevant

If none of the Lore entries below are relevant to the current task, do not mention Lore at all.
Never say "Lore didn't have anything relevant" or "I checked Lore but found nothing."
Just respond normally.

### Emit Lore tags only for visible items

When the user states a general rule in their own words, you may capture it with:
  - \`[lore:capture kind=<kind>]\`

When the user confirms a currently visible Lore suggestion:
  - \`[lore:approve]\`

When the user rejects a currently visible Lore receipt or suggestion:
  - \`[lore:dismiss]\`

Only emit these tags when the referenced Lore item is visible in the current context.
Do not emit them speculatively.`;

const renderRecallSection = (capabilities: LoreCapabilities): string => {
  if (!capabilities.recall) return "";

  return `### Use recall tools for deeper questions

If the user's request involves domain knowledge that isn't in the session context
or whisper, proactively call the Lore recall tools:

- \`lore.recall_rules\` — domain rules and glossary terms
- \`lore.recall_architecture\` — architecture facts
- \`lore.recall_decisions\` — past decision records and their rationale
- \`lore.search_knowledge\` — freeform search across all knowledge types

Use these the same way you'd use any other tool — when the task warrants it.
You don't need to ask permission. Cite what you find naturally.`;
};

const renderCorrectionSection = (capabilities: LoreCapabilities): string => {
  const lines = [
    `### Support inline corrections`,
    ``,
    `If the user says something like:`,
    `  - "That rule is outdated"`,
    `  - "We don't do that anymore"`,
    `  - "Demote that, it's wrong"`,
    `  - "That convention changed"`,
    ``,
    `Acknowledge the correction and stop applying that rule for the rest of this session.`,
  ];

  if (capabilities.demote) {
    lines.push(
      ``,
      `If the \`lore.demote\` tool is available, offer to demote the entry immediately:`,
      ``,
      `  "Got it — I'll stop applying the snake_case rule for this session. Want me to`,
      `   demote it from Lore so it doesn't come up again?"`,
      ``,
      `If the user confirms, call the demote tool.`,
    );
  } else if (capabilities.cliAvailable) {
    lines.push(
      ``,
      `To remove the entry permanently, the user can run \`lore demote <id>\`.`,
    );
  }

  return lines.join("\n");
};

const renderPromotionSection = (capabilities: LoreCapabilities): string => {
  if (!capabilities.promote) return "";

  return `### Support inline promotion

If the user states a new rule, convention, or decision during the conversation:
  - "From now on, all API responses should use camelCase"
  - "We decided to use DynamoDB instead of Postgres for the event store"
  - "Always run lint before committing"

And the \`lore.promote\` tool is available, offer to save it:

  "Noted — want me to save this as a Lore rule so it applies across your projects?"

Only offer once per conversation for a given topic. Don't nag. If the user declines,
move on.`;
};

const renderConflictSection = (capabilities: LoreCapabilities): string => {
  const lines = [
    `### Conflict resolution`,
    ``,
    `If a Lore entry conflicts with something the user just said, the user's current`,
    `instruction always wins. Apply the user's instruction, then optionally flag`,
    `the conflict:`,
    ``,
    `  "I'll use camelCase as you asked. Just a heads up — Lore has a rule that says`,
    `   snake_case for DB columns.`,
  ];

  if (capabilities.demote || capabilities.promote) {
    lines.push(`   Want me to update that, or is this a one-time exception?"`);
  } else if (capabilities.cliAvailable) {
    lines.push(
      `   If you'd like to update that rule, you can run \`lore demote <id>\`."`,
    );
  } else {
    lines.push(`   Is this a one-time exception?"`);
  }

  lines.push(``, `Never silently override the user based on Lore context.`);

  return lines.join("\n");
};

const renderSessionKnowledge = (entries: SelectedEntry[]): string => {
  const lines = [
    `## Session Knowledge`,
    ``,
    `The following entries were selected for this session based on relevance to the`,
    `current workspace. They are high-confidence, user-approved facts.`,
    ``,
  ];

  const grouped = new Map<SharedKnowledgeKind, SelectedEntry[]>();
  for (const entry of entries) {
    const list = grouped.get(entry.kind) ?? [];
    list.push(entry);
    grouped.set(entry.kind, list);
  }

  for (const kind of KIND_ORDER) {
    const kindEntries = grouped.get(kind);
    if (!kindEntries || kindEntries.length === 0) continue;

    lines.push(`### ${KIND_HEADERS[kind]}`);
    for (const entry of kindEntries) {
      lines.push(`- **${entry.title}**: ${entry.content}`);
    }
    lines.push(``);
  }

  return lines.join("\n").trimEnd();
};

const renderPendingDigest = (pendingCount: number): string => {
  if (pendingCount <= 0) {
    return "";
  }

  return `## Pending Suggestions

Lore has ${pendingCount} pending suggestion${pendingCount === 1 ? "" : "s"}.
-> \`lore list-shared --status pending\``;
};

const renderSavedReceipt = (
  savedReceipt: SessionStartTemplateInput["savedReceipt"],
): string => {
  if (!savedReceipt) {
    return "";
  }

  return `[Lore · saved ${savedReceipt.handle}]
- **${whisperLabelMap[savedReceipt.kind]}**: ${savedReceipt.content} (\`${savedReceipt.undoCommand}\` to undo)`;
};

const renderWhisperReference = (): string =>
  `## Whisper Format Reference

When the \`UserPromptSubmit\` hook fires and entries clear the whisper threshold,
the agent sees this block prepended to the user's prompt context:

\`\`\`markdown
[Lore]
- **rule**: DB columns use snake_case across all services.
- **architecture**: Postgres is the source of truth for billing state.
- **risk**: Recent test failures in the billing migration area.
\`\`\`

The agent behavior instructions above (already injected at SessionStart) tell the
agent how to handle these whispers — no additional per-turn instructions needed.`;

const renderBehaviorTable = (capabilities: LoreCapabilities): string => {
  const rows: Array<[string, string]> = [
    [
      "Lore entry is relevant to the task",
      "Cite naturally in reasoning",
    ],
    [
      "Lore entry is not relevant",
      "Say nothing about Lore",
    ],
    [
      "[Lore] whisper arrives with prompt",
      "Use if relevant, never echo the block",
    ],
  ];

  if (capabilities.recall) {
    rows.push([
      "User needs deeper domain context",
      "Call lore.recall_* tools proactively",
    ]);
  }

  rows.push([
    "User contradicts a Lore entry",
    "Follow the user, flag the conflict once",
  ]);

  if (capabilities.promote) {
    rows.push([
      "User states a new rule/decision",
      "Offer to promote once, don't nag",
    ]);
  }

  if (capabilities.demote) {
    rows.push([
      "User says \"that rule is wrong\"",
      "Acknowledge, offer to demote",
    ]);
  } else if (capabilities.cliAvailable) {
    rows.push([
      "User says \"that rule is wrong\"",
      "Acknowledge, mention `lore demote <id>`",
    ]);
  } else {
    rows.push([
      "User says \"that rule is wrong\"",
      "Acknowledge, stop applying for this session",
    ]);
  }

  rows.push([
    "No Lore context this session",
    "Behave as if Lore doesn't exist",
  ]);

  const header = "| Situation | Agent behavior |";
  const separator = "|---|---|";
  const body = rows.map(([s, b]) => `| ${s} | ${b} |`).join("\n");

  return `## Behavior Summary Table\n\n${header}\n${separator}\n${body}`;
};

const renderConfigurationNotes = (): string =>
  `## Configuration Notes

The instruction template is stored at:
\`\`\`text
skills/lore/SKILL.md          — references this instruction behavior
src/plugin/session-start.ts   — assembles the full injection payload
src/plugin/context-builder.ts — selects and formats shared knowledge entries
\`\`\`

The instruction text itself should be treated as a tunable artifact. After
integration testing, review:

1. **Verbosity of citations** — if agents over-cite ("Lore says X, Lore says Y"),
   tighten the "only mention entries you actually relied on" instruction.
2. **Promotion nagging** — if agents offer to promote too often, add a stricter
   "offer at most once per session" rule.
3. **Conflict escalation** — if agents flag conflicts too aggressively, soften to
   "only flag if the conflict could cause a real problem."

These are UX-level tuning decisions that should be reviewed after real-world usage.`;

export const renderSessionStartTemplate = (
  input: SessionStartTemplateInput,
): string | null => {
  const { entries, capabilities, pendingCount = 0, savedReceipt } = input;

  if (entries.length === 0 && pendingCount === 0 && !savedReceipt) return null;

  const sections = [
    renderLoreIntro(capabilities),
    renderUsageGuidance(),
    renderRecallSection(capabilities),
    renderCorrectionSection(capabilities),
    renderPromotionSection(capabilities),
    renderConflictSection(capabilities),
    entries.length > 0 ? renderSessionKnowledge(entries) : "",
    renderSavedReceipt(savedReceipt),
    renderPendingDigest(pendingCount),
    renderWhisperReference(),
    renderBehaviorTable(capabilities),
    renderConfigurationNotes(),
  ].filter((s) => s !== "");

  return sections.join("\n\n");
};
