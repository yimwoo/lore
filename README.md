# Lore — Cross-Project Memory for Codex

**A Codex plugin that gives your AI coding agent persistent, shared knowledge across every project and session.**

Lore watches your sessions, learns your patterns, and whispers the right context — naming conventions, architecture decisions, past choices — before each prompt. Automatically. You just install it and code.

---

## Quick Start

```bash
git clone https://github.com/yimwoo/lore.git /tmp/lore && bash /tmp/lore/install.sh
```

Restart Codex, open **Local Plugins**, find **Lore**, and click **Install**.

**That's it. Start coding. Lore starts learning.**

> Already have a `CLAUDE.md`, `.cursorrules`, or `CONVENTIONS.md`? Run `lore init` to import your existing rules in seconds. See [Cold Start](#cold-start-instant-setup).

---

## What Lore Does

Every time you start a new Codex session, your agent forgets everything — your naming conventions, your architecture decisions, why you chose library A over B. You re-explain the same context every session, every project, every day.

Lore fixes this. It maintains persistent, cross-project memory and delivers it automatically:

```text
You type: "fix the billing migration"

Your agent sees (you don't have to):
  [Lore]
  - rule: DB columns use snake_case across all services.
  - architecture: MySQL is the source of truth for billing state.

Your agent responds:
  "Since your project uses snake_case for DB columns, I'll name the
   new field payment_status_code. And I'll write directly to MySQL
   rather than going through the Redis cache."
```

No extra prompts. No copy-pasting context. Your agent just *knows*.

---

## How Lore Learns

Most users never write a single command. Here's what happens after you install:

**Sessions 1–2:** Lore observes silently. It maps your files, tools, and recurring patterns.

**Session 3+:** Lore starts whispering. Before each prompt, it injects the most relevant context — rules, decisions, preferences — your agent picks up automatically.

**Over time:** Lore drafts pending knowledge from recent turns, merges repeated patterns at session start, and surfaces what needs review in a lightweight SessionStart digest.

Approved knowledge becomes permanent — shared across every future project, forever.

> **You always stay in control.** Lore never adds knowledge to your store without your explicit approval. Suggestions stay *pending* until you say so. See [You Control Everything](#you-control-everything).

---

## How It Works

<p align="center">
  <img src="docs/assets/lore-architecture.svg" alt="Lore architecture diagram showing two memory tiers and four delivery layers" width="680" />
</p>

Lore keeps two tiers of memory:

- **Project memory** — per-repo session context (active files, recent errors). Short-term working memory.
- **Shared knowledge** — cross-project facts (domain rules, architecture decisions, preferences). Long-term memory that builds over time.

Shared knowledge reaches your agent through three runtime delivery layers:

| Layer | When | What |
|---|---|---|
| **SessionStart** | Once per session | Top 5–15 stable facts, biased toward your current workspace |
| **Whisper** | Before each prompt | 0–4 adaptive bullets — most relevant shared knowledge, plus light high-confidence session nudges |
| **MCP Recall** | On demand | Deep search across all shared knowledge |

The **whisper system** is the key feature. It scores each knowledge entry against your current prompt using keyword overlap, tag matching, session affinity, and recent signals — then applies repetition decay so it never nags. If nothing is relevant, it says nothing. Your agent doesn't even know Lore is there.

For a deeper dive, see the [Design Overview](docs/design.md).

---

## Cold Start — Instant Setup

Already have convention files? Lore can import them immediately:

```bash
lore init                    # Scan project, import found convention files interactively
lore init --yes              # Auto-import all found files (scripted setup)
```

`lore init` scans for `.cursorrules`, `CLAUDE.md`, `.clinerules`, `.windsurfrules`, `AGENTS.md`, `CONVENTIONS.md`, and more. Each file is parsed into individual knowledge entries as `pending` suggestions for your review.

Or import specific files directly:

```bash
lore import CLAUDE.md                      # Import as pending entries
lore import .cursorrules --approve-all     # Import and auto-approve
lore import AGENTS.md --dry-run            # Preview without importing
lore import CONVENTIONS.md --kind domain_rule --tag-prefix team
```

---

## Real-World Examples

**Cross-project recall** — You're in Project B debugging a billing service. Lore whispers that three weeks ago in Project A, you decided Postgres is the source of truth for billing state — not Redis. Without Lore, you'd spend 30 minutes rediscovering that.

**Language switching** — You switch between a TypeScript API and a Python ML pipeline. Lore remembers your naming conventions, preferred test frameworks, and architecture boundaries for each. It whispers the right conventions for whichever project you're in.

**Team onboarding** — A new teammate onboards using your shared Codex setup. Your Lore knowledge store acts as living documentation — every rule, decision, and preference your agent already knows.

---

## Shared Knowledge Kinds

| Kind | What it captures | Example |
|---|---|---|
| `domain_rule` | Stable rules that rarely change | "All DB columns use snake_case" |
| `architecture_fact` | Stack and platform assumptions | "PostgreSQL is source of truth" |
| `decision_record` | Past decisions with rationale | "Chose Postgres over Mongo for ACID" |
| `user_preference` | Coding style and tool choices | "Prefer named exports over default" |
| `glossary_term` | Domain vocabulary | "SOR: Source of Record" |

---

## You Control Everything

Lore **never** adds shared knowledge automatically. Every entry requires your explicit approval.

| Path | How it works |
|---|---|
| **SessionStart digest** | Lore tells you when pending suggestions exist and points you to `lore list-shared --status pending` |
| **Inline correction** | Tell your agent "that rule is outdated" — it demotes the entry on the spot |
| **CLI promotion** | Power users can promote knowledge directly via CLI (no approval step needed) |
| **Demotion** | Soft-delete with full audit trail — nothing is ever hard-deleted |

Your knowledge store is yours. Lore earns its place by being useful, not by taking over.

---

## MCP Recall Tools

Your agent can proactively search Lore for deeper context:

| Tool | Returns |
|---|---|
| `lore.recall_rules` | Domain rules and glossary terms |
| `lore.recall_architecture` | Architecture facts and platform assumptions |
| `lore.recall_decisions` | Decision records with rationale |
| `lore.search_knowledge` | Cross-kind freeform search |
| `lore.dashboard` | Knowledge base overview (counts, tags, health) |

Bundled with the plugin install — no separate MCP configuration needed.

---

## Managing Knowledge

Most users start with `lore init` and let Lore learn on its own after that. For direct control, the CLI provides full management:

### Import existing conventions

```bash
lore init                                   # Scan project + import interactively
lore import CLAUDE.md                       # Import a specific file
lore import .cursorrules --approve-all      # Import and auto-approve
```

### Promote a rule manually

```bash
lore promote \
  --kind domain_rule \
  --title "Use snake_case for DB columns" \
  --content "All database columns must use snake_case naming across services and migrations." \
  --tags "naming,database"
```

### See what Lore knows

```bash
lore list-shared                            # All entries
lore list-shared --tag database             # Filter by tag
lore list-shared --stale                    # Entries not seen in 60+ days
lore list-shared --contradictions           # Entries with conflicts
lore dashboard                              # Full knowledge base overview
```

### Resolve conflicts

When Lore detects contradictory rules, it surfaces them at session start:

```bash
lore resolve <idA> <idB> --keep <id>        # Keep one, demote other
lore resolve <idA> <idB> --scope <id> --project api  # Make one project-specific
lore resolve <idA> <idB> --merge            # Combine into one entry
lore history <id>                           # Trace supersession chain
```

### Remove outdated knowledge

```bash
lore demote <entry-id> --reason "migrated to camelCase"
```

> The `lore` CLI is available after running `install.sh`. If you installed manually, run `npm link` from `~/.codex/plugins/lore-source/` to register the command.

---

## Installation

**Prerequisites:** Node.js 18+, npm

```bash
git clone https://github.com/yimwoo/lore.git /tmp/lore && bash /tmp/lore/install.sh
```

This clones Lore to `~/.codex/plugins/lore-source/`, runs `npm install`, registers a marketplace entry in `~/.agents/plugins/marketplace.json`, and refreshes Codex's local plugin cache.

### For Contributors

Use `--local` to point the marketplace at your working copy:

```bash
bash install.sh --local
```

### Manual Installation

```bash
git clone https://github.com/yimwoo/lore.git ~/.codex/plugins/lore-source
cd ~/.codex/plugins/lore-source
npm install
```

Then add a marketplace entry to `~/.agents/plugins/marketplace.json`:

```json
{
  "name": "lore",
  "source": { "source": "local", "path": "~/.codex/plugins/lore-source" },
  "policy": { "installation": "AVAILABLE" },
  "category": "Productivity"
}
```

Restart Codex after installing.

### Hooks

| Hook | Purpose |
|---|---|
| `SessionStart` | Runs bounded consolidation, injects shared knowledge, initializes whisper state |
| `UserPromptSubmit` | Whispers relevant shared knowledge before each prompt |
| `Stop` (async) | Updates session context and drafts candidate knowledge after each turn |

Hooks are auto-discovered from `.codex/hooks.json` in your repo. For global use, copy to `~/.codex/hooks.json`.

### Storage

All data lives locally on your machine:

```text
~/.lore/
  shared.json              Shared knowledge entries
  approval-ledger.json     Append-only audit trail
  conflicts.json           Detected knowledge conflicts
  observations/            Per-session observation logs
  drafts/                  Per-session extracted draft candidates
  consolidation-state.json SessionStart consolidation watermark
  whisper-sessions/        Per-session whisper state
```

Every state change writes to the ledger first — crash-safe, nothing ever hard-deleted.

### Updating

```bash
bash ~/.codex/plugins/lore-source/install.sh
```

---

## Development

```bash
npm test            # 624 tests
npm run test:watch  # watch mode
npm run typecheck   # tsc --noEmit
npm run demo        # simulated session
```

### Project Structure

```text
src/
  core/               Memory store, hint engine, daemon, markdown parser, dashboard aggregator
  plugin/             SessionStart, instruction template, whisper, stop observer
  promotion/          Promote, demote, approve, draft store, consolidator, conflict detection
  extraction/         LLM provider interfaces, signal classifier
  mcp/                MCP recall tool handlers + dashboard tool
  shared/             Types, validators, semantic normalizer
  cli/                Init onboarding flow
  ui/                 React sidecar component (experimental)
tests/                Vitest coverage — 624 tests across 42 files
```

---

## Design

See the [Design Overview](docs/design.md) for architecture diagrams, whisper scoring details, promotion workflow, and storage layout.

---

## Uninstalling

```bash
rm -rf ~/.codex/plugins/lore-source     # remove plugin
rm -rf ~/.lore                           # remove stored data (optional)
```

Edit `~/.agents/plugins/marketplace.json` to remove the Lore entry, then restart Codex.

---

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

## License

MIT
