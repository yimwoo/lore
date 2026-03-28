# Lore Design Overview

This document covers how Lore works under the hood — the architecture, memory model, whisper system, promotion workflow, and storage layout. For usage and installation, see the [README](../README.md).

## Table of Contents

- [Architecture](#architecture)
- [Memory Tiers](#memory-tiers)
- [Delivery Layers](#delivery-layers)
- [Whisper System](#whisper-system)
- [Promotion Workflow](#promotion-workflow)
- [Shared Knowledge Kinds](#shared-knowledge-kinds)
- [Storage](#storage)
- [Detailed Design Documents](#detailed-design-documents)

## Architecture

<p align="center">
  <img src="assets/lore-architecture.svg" alt="Lore architecture — two memory tiers, four delivery layers" width="680" />
</p>

Lore is structured as four layers with strict separation:

| Layer | Directory | Responsibility |
| --- | --- | --- |
| **Core library** | `src/core/`, `src/bridge/`, `src/shared/` | Reusable engine — memory store, hint engine, daemon, types. No plugin runtime assumptions. |
| **Plugin integration** | `src/plugin/` | SessionStart injection, pre-prompt whisper, stop observer, context building, whisper scoring. Plugin-facing only. |
| **Promotion** | `src/promotion/` | Promoter, policy, approval store, observation log, suggestion engine. |
| **MCP surface** | `src/mcp/` | Thin adapter exposing domain services as MCP recall tools. |

Configuration lives in `src/config.ts` — a single source for all paths, thresholds, and policy defaults.

## Memory Tiers

Lore keeps two tiers of memory that serve different purposes:

### Project memory

Per-repo session context — active files, recent errors, tool usage. This is short-term working memory that stays local to each project. Managed by `FileMemoryStore`.

### Shared knowledge

Cross-project facts — domain rules, architecture decisions, coding preferences, glossary terms. This is long-term memory you build over time and that travels across all your projects. Managed by `FileSharedStore`.

Knowledge flows one direction: project memory can be **promoted** to shared knowledge (with your approval), but shared knowledge never flows back down into project memory.

## Delivery Layers

Shared knowledge reaches the Codex agent through four layers, each tuned for a different moment in the session lifecycle:

| Layer | Hook | When | What it delivers |
| --- | --- | --- | --- |
| **SessionStart** | `SessionStart` | Once, at session open | Top 5-15 stable facts, scored across 5 dimensions (confidence, stability, recency, kind priority, relevance) and biased toward the current workspace. |
| **Whisper** | `UserPromptSubmit` | Before each prompt | 0-4 adaptive bullets. Scores entries against the current prompt, applies repetition decay, deduplicates against SessionStart. Silent when nothing is relevant. |
| **MCP Recall** | On demand | When the agent calls a tool | Deep search across all shared knowledge via 4 MCP tools. |
| **Hints** | Pre-turn | Before each turn | Advisory nudges combining project memory and shared knowledge context. |

### SessionStart scoring

The context builder (`src/plugin/context-builder.ts`) scores each approved shared knowledge entry across five weighted dimensions:

- **Confidence** (0.25) — how confident we are in the entry
- **Stability** (0.20) — session count + project count
- **Recency** (0.10) — days since last seen (decays over 90 days)
- **Kind priority** (0.15) — domain rules score higher than preferences
- **Relevance** (0.30) — project match, tag overlap, universal flag

Entries are deduplicated by content hash, sorted by score, and selected with per-kind caps and a token budget.

## Whisper System

<p align="center">
  <img src="assets/lore-whisper-flow.svg" alt="Whisper flow — scoring, threshold, and adaptive output" width="680" />
</p>

The whisper system is Lore's key differentiator. It fires before every prompt via the `UserPromptSubmit` hook and adaptively injects relevant knowledge — or stays completely silent.

### How scoring works

For each shared knowledge entry, the whisper scorer (`src/plugin/whisper-scorer.ts`, a pure function with no I/O) computes:

1. **Keyword overlap** — tokens from the user's prompt matched against entry content and tags
2. **Tag match** — overlap between inferred prompt tags (from file paths, tool names) and entry tags
3. **Session affinity** — whether the entry's source projects match the current workspace
4. **Kind priority** — domain rules and glossary terms score higher

### Repetition control

To avoid nagging, the system applies two forms of decay:

- **Hard block** — entries whispered in the last 2 turns are completely suppressed
- **Frequency penalty** — entries whispered many times get progressively penalized

### Deduplication

Entries already injected at SessionStart (tracked by content hash) are excluded from whisper. Within a single whisper payload, shared entries and hint bullets are also deduplicated against each other.

### Output format

When entries clear the threshold, the hook outputs:

```
[Lore]
- **rule**: DB columns use snake_case across all services.
- **architecture**: Postgres is the source of truth for billing state.
```

When nothing is relevant, the hook outputs nothing — the agent doesn't even know Lore is there.

### Session state

Whisper state is per-session and tracked in `~/.lore/whisper-sessions/`. The `UserPromptSubmit` hook owns all whisper state writes (not the Stop hook). The `Stop` hook updates session context (recent files, tool names, turn index) so the next whisper decision has fresh signals.

If `session_id` is missing from hook stdin, all whisper hooks no-op silently.

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

- **Explicit promotion** — you promote knowledge manually via CLI (`lore promote`). Auto-approved, no extra step.
- **Suggestion engine** — Lore scans observation logs for high-confidence patterns across sessions and projects. Candidates enter as `pending` and require your explicit `approve`.
- **Demotion** — soft-delete with full audit trail. Nothing is ever hard-deleted. The ledger preserves the complete history.

### Ledger-first writes

All state-changing operations (promote, demote, approve, reject) write to the approval ledger **before** updating the shared store. This enables crash recovery — if the process dies between the ledger write and the store update, reconciliation can replay the ledger to restore consistency.

## Shared Knowledge Kinds

| Kind | What it captures | Example |
| --- | --- | --- |
| `domain_rule` | Stable rules that rarely change | "All DB columns use snake_case" |
| `architecture_fact` | Stack and platform assumptions | "PostgreSQL is source of truth" |
| `decision_record` | Past decisions with rationale | "Chose Postgres over Mongo for ACID" |
| `user_preference` | Coding style and tool choices | "Prefer named exports over default" |
| `glossary_term` | Domain vocabulary | "SOR: Source of Record" |

### Validation

Content is validated at system boundaries using `forbidPatterns` — entries that look like file paths, branch names, or file extensions are rejected. This keeps shared knowledge focused on stable, reusable facts rather than project-specific artifacts.

## Storage

All data lives locally on your machine:

```
~/.lore/
  shared.json              Shared knowledge entries
  approval-ledger.json     Append-only audit trail
  observations/            Per-session observation logs (JSONL)
  whisper-sessions/        Per-session whisper state
```

### Design principles

- **Ledger-first writes** — state changes write to the ledger before updating the shared store, enabling crash recovery.
- **Soft delete only** — `remove()` sets `approvalStatus: "demoted"`. The ledger preserves the full audit trail.
- **Per-session files** — concurrent sessions write to separate observation and whisper state files, avoiding contention.
- **Atomic writes** — all file writes use a temp file + rename pattern with exclusive lock files for concurrent access safety.

## Detailed Design Documents

For deeper implementation details, see the original design documents:

- [Plugin architecture](plans/2026-03-27-lore-plugin-design.md) — two-tier memory, scoring, MCP tools, promotion workflow
- [Whisper system](plans/2026-03-27-lore-whisper-design.md) — adaptive pre-prompt injection, scoring, session state
- [Original sidecar design](plans/2026-03-26-lore-design.md) — project-scoped memory and hinting model
