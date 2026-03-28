# Lore Design Overview

This document covers how Lore works under the hood — the architecture, memory model, whisper system, promotion workflow, and storage layout. For usage and installation, see the [README](../README.md).

## Table of Contents

- [Architecture](#architecture)
- [Memory Tiers](#memory-tiers)
- [Delivery Layers](#delivery-layers)
- [SessionStart Injection](#sessionstart-injection)
- [Whisper System](#whisper-system)
- [MCP Recall Tools](#mcp-recall-tools)
- [Promotion Workflow](#promotion-workflow)
- [Shared Knowledge Kinds](#shared-knowledge-kinds)
- [Validation](#validation)
- [Storage](#storage)
- [CLI](#cli)
- [Configuration Reference](#configuration-reference)

## Architecture

<p align="center">
  <img src="assets/lore-architecture.svg" alt="Lore architecture — two memory tiers, four delivery layers" width="680" />
</p>

Lore is structured as five layers with strict separation:

| Layer | Directory | Responsibility |
| --- | --- | --- |
| **Core library** | `src/core/`, `src/bridge/`, `src/shared/` | Reusable engine — memory store, shared store, hint engine, daemon, candidate extractor, types, validators. No plugin runtime assumptions. |
| **Plugin integration** | `src/plugin/` | SessionStart injection, capability-aware instruction template, pre-prompt whisper, stop observer, context building, whisper scoring. Plugin-facing only. |
| **Promotion** | `src/promotion/` | Promoter, policy, approval store, observation log, draft store, consolidator. |
| **MCP surface** | `src/mcp/` | Thin adapter exposing domain services as MCP recall tools via JSON-RPC 2.0 over stdio. |
| **Config** | `src/config.ts` | Single source for all paths, thresholds, scoring weights, and policy defaults. |

## Memory Tiers

Lore keeps two tiers of memory that serve different purposes:

### Project memory

Per-repo session context — active files, recent errors, tool usage. This is short-term working memory that stays local to each project. Managed by `FileMemoryStore`, which stores entries in per-project JSON files keyed by `sha256(projectId)`.

Project memory entries have three kinds:

| Kind | What it captures |
| --- | --- |
| `decision` | Architectural choices, naming conventions, user preferences |
| `working_context` | Active files, recent errors, inferred objectives |
| `reminder` | Follow-up tasks, known risks, unfinished threads |

The `CandidateExtractor` derives memory candidates from session events. For example, a `tool_run_failed` event produces both a `reminder` (risk/follow-up) and a `working_context` (working-set) candidate. Deduplication is by normalized content (trim, lowercase, collapse whitespace) within a project.

### Shared knowledge

Cross-project facts — domain rules, architecture decisions, coding preferences, glossary terms. This is long-term memory you build over time and that travels across all your projects. Managed by `FileSharedStore`.

Knowledge flows one direction: project memory can be **promoted** to shared knowledge (with your approval), but shared knowledge never flows back down into project memory.

## Delivery Layers

Shared knowledge reaches the Codex agent through three runtime delivery layers, each tuned for a different moment in the session lifecycle:

| Layer | Hook | When | What it delivers |
| --- | --- | --- | --- |
| **SessionStart** | `SessionStart` | Once, at session open | Top 10 stable facts, scored across 5 dimensions and biased toward the current workspace. Wrapped in a capability-aware instruction template. |
| **Whisper** | `UserPromptSubmit` | Before each prompt | 0-4 adaptive bullets. Shared knowledge first, plus light high-confidence session nudges when useful. Silent when nothing is relevant. |
| **MCP Recall** | On demand | When the agent calls a tool | Deep search across all shared knowledge via 4 MCP tools. |

A fourth internal component, the **hint engine** (`src/core/hint-engine.ts`), builds advisory bullets from project memories and shared knowledge. These hint bullets feed into the whisper system as secondary candidates — they are not a separate delivery surface.

### Hook lifecycle

Three Codex hooks drive the runtime:

1. **SessionStart** — fires once when a session opens. Selects high-value shared knowledge entries, initializes whisper state with `injectedContentHashes` for downstream dedup, and renders the instruction template.
2. **UserPromptSubmit** (sync, targets <200ms) — fires before each prompt. Scores shared entries and hint bullets against the current prompt, applies repetition decay, formats the `[Lore]` whisper block. Owns all whisper state writes.
3. **Stop** (async) — fires after each turn completes. Updates session context (turn index, recent files, recent tool names) and may draft candidate shared knowledge asynchronously. Does not write whisper decisions.

If `session_id` is missing from hook stdin, all whisper hooks no-op silently.

## SessionStart Injection

### Scoring

The context builder (`src/plugin/context-builder.ts`) scores each approved shared knowledge entry across five weighted dimensions:

| Dimension | Weight | Computation |
| --- | --- | --- |
| **Confidence** | 0.25 | `entry.confidence` (0-1) |
| **Stability** | 0.20 | `0.5 * min(sessionCount/10, 1) + 0.5 * min(projectCount/3, 1)` |
| **Recency** | 0.10 | `1.0 - daysSince(lastSeenAt) / 90` (decays to 0 at 90 days) |
| **Kind priority** | 0.15 | Predefined: domain_rule (1.0), glossary_term (0.9), architecture_fact (0.8), user_preference (0.6), decision_record (0.5) |
| **Relevance** | 0.30 | `0.5 * projectMatch + 0.3 * tagOverlap + 0.2 * universalFlag` |

Relevance sub-scores:
- **projectMatch** — 1.0 if the current project is in `sourceProjectIds`, else 0.0
- **tagOverlap** — Jaccard similarity between current tags and entry tags
- **universalFlag** — 1.0 if entry has the `"universal"` tag or is a `domain_rule`

### Selection

1. **Hard gate** — confidence >= 0.7 and non-empty title/content
2. **Score** all passing entries
3. **Deduplicate** by `contentHash` (keep highest score)
4. **Sort** by score descending
5. **Select** greedily with per-kind caps and a total item limit (10) plus token budget (2000 tokens estimated as `ceil((title.length + content.length) / 4)`)
6. **Diversity pass** — fill remaining budget with underrepresented kinds

Per-kind caps: domain_rule (4), glossary_term (2), architecture_fact (3), user_preference (2), decision_record (1).

### Capability-aware template

The template module (`src/plugin/session-start-template.ts`) is a pure function with no I/O. It takes selected entries and a `LoreCapabilities` object, and returns a markdown instruction block — or `null` if no entries were selected.

```typescript
type LoreCapabilities = {
  recall: boolean;   // agent can call MCP recall tools
  promote: boolean;  // agent can promote knowledge inline
  demote: boolean;   // agent can demote knowledge inline
  cliAvailable: boolean; // CLI fallback text
};
```

Tool-specific instruction sections (recall guidance, promote/demote workflows, CLI fallback) are gated behind the corresponding capability flag. The agent never sees references to tools that are not available.

Template sections rendered in order:
1. Lore introduction (adapts delivery mode count to capabilities)
2. Usage guidance (cite naturally, stay silent if irrelevant)
3. Recall tools section (gated by `recall`)
4. Correction section (demote gated by `demote`, CLI fallback by `cliAvailable`)
5. Promotion section (gated by `promote`)
6. Conflict resolution (user instruction always wins)
7. Session knowledge entries (grouped by kind)
8. Whisper format reference
9. Behavior summary table (rows filtered by capabilities)
10. Configuration notes

Knowledge entries are grouped and ordered: Domain Rules, Architecture, Glossary, Preferences, Decisions.

## Whisper System

<p align="center">
  <img src="assets/lore-whisper-flow.svg" alt="Whisper flow — scoring, threshold, and adaptive output" width="680" />
</p>

The whisper system is Lore's key differentiator. It fires before every prompt via the `UserPromptSubmit` hook and adaptively injects relevant knowledge — or stays completely silent.

### How scoring works

For each shared knowledge entry, the whisper scorer (`src/plugin/whisper-scorer.ts`, a pure function with no I/O) computes a turn relevance score:

```
turnRelevance = 0.40 * keywordScore
              + 0.30 * tagScore
              + 0.20 * sessionAffinityScore
              + 0.10 * kindPriority
```

**Keyword score** — harmonic mean of recall (`matchingTokens / promptTokens`) and precision (`matchingTokens / entryTokens`). Tokens are lowercased, stripped of non-alphanumeric characters, and filtered through a 44-word stopword list. Minimum token length is configurable (default: 3 characters).

**Tag score** — Jaccard similarity between inferred prompt tags and entry tags. Prompt tags are inferred from three sources:
- File extensions in the prompt text and `recentFiles` (e.g., `.ts` maps to `typescript`, `.sql` to `database`)
- Tool/command names in the prompt text and `recentToolNames` (e.g., `npm`/`vitest` map to `testing`, `docker`/`kubectl` to `infrastructure`)
- Domain keywords in the prompt text (e.g., `billing`, `auth`, `migration`, `security`)

**Session affinity** — `0.5 * projectMatch + 0.5 * tagAffinity`, where `projectMatch` is 1.0 if the entry's source projects include the current project, and `tagAffinity` is the overlap between entry tags and tags inferred from recent files.

**Kind priority** — domain_rule (1.0), glossary_term (0.9), architecture_fact (0.8), user_preference (0.6), decision_record (0.5).

### Repetition control

To avoid nagging, the system applies two forms of decay:

- **Hard block** — entries whispered in the last 2 turns are completely suppressed (penalty = 1.0)
- **Recent whisper penalty** — decays by distance: turns <= 5 (0.4), turns <= 10 (0.15), turns > 10 (0.0)
- **Frequency penalty** — `min(0.3, whisperCount * 0.08)` for entries whispered many times

The effective score: `turnRelevance - recentWhisperPenalty - frequencyPenalty`

### Selection

Entries that clear the threshold (default: 0.35) are selected:

- Up to **2 shared knowledge bullets** (highest effective scores)
- Up to **2 hint bullets** from the hint engine, subject to strict gating:
  - Only `risk`, `next_step`, and `focus` categories (not `recall`)
  - Confidence >= 0.7
  - Further gated by session context strength — hints appear only when session context is strong (has recent files or tools) or when no shared bullets were selected and the prompt is not weak (has tags or > 4 tokens)
  - High-confidence hints (>= 0.9) get priority

### Deduplication

Entries already injected at SessionStart (tracked by `injectedContentHashes`) are excluded from whisper candidates. Within a single whisper payload, shared entries and hint bullets are also deduplicated against each other.

### Output format

When entries clear the threshold, the hook outputs:

```
[Lore]
- **rule**: DB columns use snake_case across all services.
- **architecture**: Postgres is the source of truth for billing state.
```

Labels are derived from kind: domain_rule maps to `rule`, architecture_fact to `architecture`, decision_record to `decision`, user_preference to `preference`, glossary_term to `term`.

When nothing is relevant, the hook outputs nothing — the agent doesn't even know Lore is there.

### Session state

Whisper state is per-session and tracked in `~/.lore/whisper-sessions/whisper-<sessionKey>.json`, where `sessionKey = sha256(session_id + ":" + cwd).slice(0, 12)`.

State contents:

| Field | Capacity | Description |
| --- | --- | --- |
| `turnIndex` | — | Current turn number, incremented by the Stop hook |
| `recentFiles` | 20 | Files seen in recent events |
| `recentToolNames` | 10 | Tools used in recent events |
| `whisperHistory` | 50 | Records of what was whispered (contentHash, kind, source, topReason, turnIndex, whisperCount) |
| `injectedContentHashes` | — | Content hashes from SessionStart injection, used for dedup |

The `UserPromptSubmit` hook owns all whisper decision writes. The `Stop` hook updates session context only (turn index, files, tools). This separation ensures dedup state survives crashes.

## MCP Recall Tools

Four tools are exposed via a JSON-RPC 2.0 stdio transport (`src/mcp/server.ts`, `src/mcp/stdio-transport.ts`). All return only `approved` entries.

| Tool | Filters | Description |
| --- | --- | --- |
| `lore.recall_rules` | `domain_rule` + `glossary_term` | Domain rules and vocabulary |
| `lore.recall_architecture` | `architecture_fact` | Architecture facts and platform assumptions |
| `lore.recall_decisions` | `decision_record` | Decision records with rationale |
| `lore.search_knowledge` | All kinds, freeform query | Cross-kind search with substring matching |

All tools accept an optional `limit` parameter (clamped to 1-25, default 10) and optional `tags` for filtering.

`lore.search_knowledge` ranks results by match quality: exact title match (100), title substring (80), tag match (60), content substring (40), with confidence as tiebreaker.

## Promotion Workflow

Lore never adds shared knowledge automatically. Every entry requires your explicit approval.

### State transitions

```
explicit promote  -->  [approved]  -->  demote  -->  [demoted]
suggested         -->  [pending]   -->  approve -->  [approved]  -->  demote  -->  [demoted]
                                   -->  reject  -->  [rejected]
```

No transitions from `rejected` or `demoted`. Re-promoting creates a new entry.

### Paths to shared knowledge

- **Explicit promotion** — you promote knowledge manually via CLI (`lore promote`). Auto-approved with `confidence: 1.0`, skips pending state.
- **Draft + consolidate** — the Stop hook drafts candidate knowledge from recent turns, and SessionStart consolidation merges and rewrites those drafts into evidence-backed pending entries with `promotionSource: "suggested"`.
- **Demotion** — soft-delete with full audit trail. Nothing is ever hard-deleted. The ledger preserves the complete history.

### Deduplication on promote

When promoting, the system checks for existing entries with the same `contentHash + kind`:
- If an **approved** entry exists: merges provenance (project IDs, memory IDs, tags) into the existing entry
- If a **pending** entry exists: upgrades it to approved
- If a **rejected** or **demoted** entry exists: creates a new entry (no resurrection)

### Ledger-first writes

All state-changing operations (promote, demote, approve, reject) write to the approval ledger **before** updating the shared store. This enables crash recovery — if the process dies between the ledger write and the store update, reconciliation can replay the ledger to restore consistency. Reconciliation is idempotent and runs on first access.

### Consolidation-backed pending drafts

Pending entries are produced by the consolidator, which combines two signal sources:

- **Draft candidates** from the Stop hook's async extraction path
- **Observation evidence** from the per-session observation logs

The observation layer still provides cross-session strength signals:

| Kind | Eligibility | Min Confidence | Min Sessions | Min Projects |
| --- | --- | --- | --- | --- |
| `domain_rule` | suggest_allowed | 0.90 | 3 | 1 |
| `glossary_term` | suggest_allowed | 0.85 | 2 | 1 |
| `architecture_fact` | suggest_allowed | 0.90 | 3 | 2 |
| `user_preference` | suggest_allowed | 0.92 | 5 | 2 |
| `decision_record` | explicit_only | 0.95 | 3 | 2 |

`decision_record` entries require explicit promotion and are never auto-suggested.

Observations are written by the daemon during event ingestion (when an observation directory is configured). Each session writes to its own JSONL file at `~/.lore/observations/<sessionId>.jsonl`. The consolidator uses these files to derive `sessionCount`, `projectCount`, and `lastSeenAt`.

Draft candidates are written separately to `~/.lore/drafts/<sessionId>.jsonl`, and SessionStart consolidation advances a watermark stored in `~/.lore/consolidation-state.json`.

## Shared Knowledge Kinds

| Kind | What it captures | Example |
| --- | --- | --- |
| `domain_rule` | Stable rules that rarely change | "All DB columns use snake_case" |
| `architecture_fact` | Stack and platform assumptions | "PostgreSQL is source of truth" |
| `decision_record` | Past decisions with rationale | "Chose Postgres over Mongo for ACID" |
| `user_preference` | Coding style and tool choices | "Prefer named exports over default" |
| `glossary_term` | Domain vocabulary | "SOR: Source of Record" |

## Validation

Content is validated at system boundaries using multiple checks:

- **Title**: max 200 characters, no control characters
- **Content**: max 2000 characters, no control characters
- **Tags**: max 10 tags, each <= 50 characters
- **Content hash**: SHA-256 of normalized content (trimmed, lowercased, whitespace-collapsed)
- **forbidPatterns**: entries that match any of the following are rejected:
  - Absolute file paths (`/...`)
  - Common file extensions (`.ts`, `.js`, `.json`, `.yaml`)
  - Branch name prefixes (`main`, `master`, `dev`)

This keeps shared knowledge focused on stable, reusable facts rather than project-specific artifacts.

## Storage

All data lives locally on your machine:

```
~/.lore/
  shared.json              Shared knowledge entries
  approval-ledger.json     Append-only audit trail
  observations/            Per-session observation logs (JSONL)
  drafts/                  Per-session extracted draft candidates (JSONL)
  consolidation-state.json SessionStart consolidation watermark
  whisper-sessions/        Per-session whisper state
  projects/                Per-project memory files (keyed by sha256(projectId))
```

### Design principles

- **Ledger-first writes** — state changes write to the ledger before updating the shared store, enabling crash recovery via idempotent reconciliation.
- **Soft delete only** — `remove()` sets `approvalStatus: "demoted"`. The ledger preserves the full audit trail.
- **Per-session files** — concurrent sessions write to separate observation and whisper state files, avoiding contention.
- **Atomic writes** — all file writes use a temp file + rename pattern with exclusive lock files for concurrent access safety.
- **File locking** — exclusive lock files with retry (25ms delay, up to 80 attempts) prevent concurrent write corruption.

## CLI

The CLI (`src/cli.ts`) provides all management operations:

| Command | Description |
| --- | --- |
| `lore promote` | Promote knowledge explicitly (requires `--kind`, `--title`, `--content`) |
| `lore list-shared` | List shared knowledge entries (filter with `--kind`, `--status`) |
| `lore inspect <id>` | Show full entry details and approval ledger history |
| `lore demote <id>` | Soft-delete an entry (requires `--reason`) |
| `lore approve <id>` | Approve a pending suggestion |
| `lore reject <id>` | Reject a pending suggestion (requires `--reason`) |
| `lore suggest` | Show observation/debug info for the retired suggestion path |
| `lore demo` | Run a simulated session with sample events |
| `lore serve` | Read newline-delimited JSON events from stdin |
| `lore memories` | Print stored project memories |

All commands support `--json` for machine-readable output and `--shared-dir` to override the storage directory.

## Configuration Reference

All defaults are defined in `src/config.ts` via `resolveConfig()`.

### SessionStart scoring weights

| Dimension | Weight |
| --- | --- |
| Confidence | 0.25 |
| Stability | 0.20 |
| Recency | 0.10 |
| Kind priority | 0.15 |
| Relevance | 0.30 |

### SessionStart limits

| Parameter | Default |
| --- | --- |
| Max items | 10 |
| Token budget | 2000 |
| Min confidence gate | 0.7 |

### Whisper tuning

| Parameter | Default | Description |
| --- | --- | --- |
| `whisperThreshold` | 0.35 | Minimum effective score for inclusion |
| `maxBullets` | 4 | Total cap per turn |
| `maxSharedBullets` | 2 | Max shared knowledge bullets |
| `maxHintBullets` | 2 | Max hint bullets |
| `hardBlockTurns` | 2 | Suppress entries whispered within this many turns |
| `hintConfidenceThreshold` | 0.7 | Minimum confidence for hint bullets |
| `keywordMinTokenLength` | 3 | Minimum characters for keyword tokens |
| `recentFilesCapacity` | 20 | Max recent files tracked in session state |
| `recentToolNamesCapacity` | 10 | Max recent tool names tracked |
| `whisperHistoryCapacity` | 50 | Max whisper history records |
