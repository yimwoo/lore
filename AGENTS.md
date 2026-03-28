# AGENTS.md

Instructions for AI coding agents (Codex, Cline, Cursor, Copilot) working in this repository.

## Project Overview

Lore is a Codex plugin providing shared cross-project knowledge. It has two memory tiers (project-scoped and shared) and four delivery layers (SessionStart injection, pre-prompt whispers, MCP recall tools, advisory hints).

## Before You Start

1. Run `npm test` to confirm baseline — all 277 tests should pass.
2. Run `npm run typecheck` to confirm no type errors.
3. Read the design doc at `docs/plans/2026-03-27-lore-plugin-design.md` if you need architectural context.

## Rules

### Do

- Run `npm test` after every change to verify nothing broke.
- Run `npm run typecheck` before claiming work is done.
- Write tests for new functionality in `tests/<module>.test.ts`.
- Use the existing patterns: inject `now`/`createId` for determinism, use temp dirs for isolation.
- Follow the ledger-first write protocol: write to approval ledger before updating shared store.
- Use `validatePromotionInput`, `validateForbidPatterns`, and `validateFilterInput` at all system boundaries.
- Keep the core library (`src/core/`, `src/bridge/`, `src/shared/`) free of plugin runtime assumptions.

### Do Not

- Do not hard-delete shared knowledge entries. Use `remove()` which sets status to `demoted`.
- Do not bypass the `SharedKnowledgeStore` interface to write directly to `shared.json`.
- Do not create shared knowledge entries with `approvalStatus: "approved"` from the suggestion engine. Suggestions must always be `pending`.
- Do not put plugin-specific logic (SessionStart, MCP, hooks, whisper) in core library modules.
- Do not add dependencies without discussing — the project intentionally has a minimal dependency footprint.
- Do not modify the approval ledger format — it is append-only and used for crash recovery.
- Do not add I/O calls to `whisper-scorer.ts` — it must remain a pure scoring module.
- Do not record whisper decisions in the Stop hook — the UserPromptSubmit hook owns whisper state writes.

## TypeScript Style

- **Arrow functions only**, no `function` declarations.
- **Named exports only**, no default exports.
- **Explicit return types** on every function.
- **`import type`** for type-only imports; **`node:` prefix** for Node.js built-ins.
- **Result types** (`{ ok: true } | { ok: false; reason: string }`) instead of throwing.
- **No `any`** in production code. Minimize `!` and `as` casts.
- **`const`** everywhere; `private readonly` for class fields.
- **`SCREAMING_SNAKE_CASE`** for constants, **`kebab-case`** for file names.
- **Comments explain "why"**, not "what". No JSDoc.
- **`??`** for defaults, not `||`.

## Architecture Quick Reference

```
src/shared/types.ts           All domain types
src/shared/validators.ts      Boundary validation (use at every entry point)
src/config.ts                 Config defaults (paths, thresholds, policy)
src/core/shared-store.ts      SharedKnowledgeStore interface
src/core/file-shared-store.ts JSON file implementation (lock + atomic write)
src/core/hint-engine.ts       Hint generation (project + shared knowledge aware)
src/core/daemon.ts            Core daemon orchestration
src/plugin/context-builder.ts SessionStart scoring (5 dimensions) + injection
src/plugin/session-start.ts   SessionStart hook entrypoint
src/plugin/pre-prompt-whisper.ts UserPromptSubmit hook (adaptive whisper)
src/plugin/stop-observer.ts   Stop hook (session context update, async)
src/plugin/whisper-scorer.ts  Pure turn-relevance scoring (NO I/O)
src/plugin/whisper-state.ts   Atomic session state read/write
src/promotion/policy.ts       State transition rules + forbidPatterns
src/promotion/approval-store.ts Ledger-first write protocol + reconciliation
src/promotion/promoter.ts     Promote, demote, approve, reject
src/promotion/observation-log.ts Per-session JSONL writer/reader
src/promotion/suggestion-engine.ts Candidate generation from observations
src/mcp/server.ts             4 MCP tool handlers (thin adapter)
src/mcp/stdio-transport.ts    JSON-RPC STDIO transport
```

## State Transitions

```
explicit promote → [approved] → demote → [demoted]
suggested        → [pending]  → approve → [approved] → demote → [demoted]
                              → reject  → [rejected]
```

No transitions from `rejected` or `demoted`. Re-promoting creates a new entry.

## Shared Knowledge Kinds

- `domain_rule` — naming conventions, compliance constraints
- `architecture_fact` — platform assumptions, service patterns
- `decision_record` — past decisions with rationale
- `user_preference` — coding style, tool preferences
- `glossary_term` — domain vocabulary

## Testing

- Framework: Vitest
- Pattern: real stores in temp dirs, not mocks
- Run all: `npm test`
- Run one: `npx vitest run tests/<file>.test.ts`
- 23 test files, 277 tests total
