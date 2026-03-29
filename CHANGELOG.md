# Changelog

## [1.6.0] - 2026-03-29

### Added

- **Semantic deduplication (Tier 2)** — Write-time dedup using Elasticsearch-style fingerprinting (tokenize, normalize, sort, hash) combined with token-set Jaccard similarity. Near-duplicates (Jaccard >= 0.85) are auto-filtered during consolidation. Candidate duplicates (>= 0.65) are forwarded to the LLM consolidator as pairs. New `normalizedHash` field on `SharedKnowledgeEntry`.
- **Conflict detection pipeline** — Pure NegEx-adapted polarity detector with 5-step decision tree classifying conflicts as direct negation, scope mismatch, temporal supersession, specialization, or ambiguous. Runs as a post-step in the consolidator. Updates `contradictionCount` on affected entries.
- **Conflict resolution CLI** — `lore resolve <idA> <idB>` with four actions: `--keep <id>`, `--dismiss <id>`, `--scope <id> --project <name>`, `--merge`. New `"resolve"` ledger action.
- **Supersession chains** — `lore history <id>` traces the chain of entries that superseded each other. New `SupersessionReason` taxonomy.
- **`[Lore · conflict detected]` block** in SessionStart template — surfaces the highest-priority unresolved conflict (at most one per session) with resolution guidance.
- **Conflict store** — `FileConflictStore` at `~/.lore/conflicts.json` with atomic writes.
- New pure modules: `src/shared/semantic-normalizer.ts`, `src/promotion/conflict-detector.ts`.
- 100+ new tests across 4 new test files.

## [1.5.0] - 2026-03-29

### Added

- **`lore import <file>`** — Bulk import from convention files (`.cursorrules`, `CLAUDE.md`, `.clinerules`, `.windsurfrules`, `AGENTS.md`, `CONVENTIONS.md`). Includes `--dry-run`, `--approve-all`, `--kind`, `--tag-prefix` options. Parses markdown headings and bullets into individual entries with heuristic kind assignment.
- **`lore init`** — Interactive onboarding that scans the project for 9 convention file formats, offers to import each one, and creates the `~/.lore/` directory structure. Supports `--yes` for scripted setup.
- **`lore dashboard`** — Structured knowledge base overview showing entry counts by kind/status, tag coverage with strength labels, recent activity, and health indicators (stale entries, contradictions). Also available as MCP `lore.dashboard` tool.
- **Signal strength classifier** — Pure regex-based classifier that grades extraction candidates as strong/medium/weak based on user prompt tone. Strong signals (imperatives like "always", "never", "must"; corrections; convention declarations) get 0.9 confidence floor and skip the `minSessionCount` threshold. New `signalStrength` field on `DraftCandidate` and `ObservationEntry`.
- New `--tag`, `--stale`, `--contradictions` filter flags for `lore list-shared`.
- New `staleDaysThreshold` configuration option (default: 60 days).
- New pure modules: `src/core/markdown-parser.ts`, `src/extraction/signal-classifier.ts`, `src/core/dashboard-aggregator.ts`.
- 100+ new tests across 4 new test files.

## [1.4.1] - 2026-03-29

### Added

- A new live transcript harness (`npm run demo:transcript`) that runs the real Lore hook flow and prints the exact whisper payload, expected visible `[Lore · visible]` prelude, approval step, and resulting shared-knowledge state.
- New integration coverage for the transcript harness and Stop-hook directive execution paths.

### Changed

- Fixed Stop-hook `[lore:capture]` execution to use the normal promoter flow, restoring validation, forbid-pattern enforcement, and ledger-first writes.
- Tightened `LoreVisibleItem` back to the actionable surface from the approved design: pending suggestions and saved receipts only.
- Preserved normal `[Lore]` whisper output while separating it from actionable visible-item state, and hardened micro-command targeting against stale receipt state.

## [1.4.0] - 2026-03-29

### Added

- Conversational Lore approval foundations, including visible receipt and suggestion metadata, project-local suppression storage, and approval provenance for captured and convergence-approved entries.
- New suppression-store, whisper-state, stop-observer, whisper, and consolidator coverage for conversational approval flows and convergence auto-approval limits.

### Changed

- SessionStart instructions now teach the agent the conversational Lore tag surface, and SessionStart templates can render one-turn `[Lore · saved]` receipts.
- Pre-prompt whispers can now surface pending entries as `[Lore · suggested @lN]` suggestions with `lore yes` / `lore no` affordances.
- Stop-hook helpers now parse Lore directives and resolve visible-item targets deterministically, including receipt-first dismiss behavior.
- Consolidation observations now track optional context-key diversity and can auto-approve low-risk converged entries with `approvalSource: "auto:convergence"` capped at three approvals per run.
- CLI list and inspect output now show Lore approval provenance directly.

## [1.3.2] - 2026-03-28

### Added

- Developer-only structured JSONL tracing with `LORE_DEBUG` and optional `LORE_LOG_FILE`, including a shared debug logger and focused logger unit tests.

### Changed

- Added trace instrumentation for SessionStart, pre-prompt whispering, Stop-hook extraction, consolidation, promotion, MCP stdio transport, and CLI command execution.
- Added test coverage for tracing behavior while preserving stdout protocol correctness and keeping pure modules free of logging I/O.

## [1.3.1] - 2026-03-28

### Added

- Non-blocking SessionStart reminder when Codex is configured with `auth_mode: "chatgpt"` but no `OPENAI_API_KEY`, so users understand why LLM ingestion is inactive.
- Rate-limited runtime auth warnings for Lore's extraction path when the configured Responses API returns `401` or `403`.

### Changed

- Added coverage for the new ingestion-auth reminder paths in SessionStart and the extraction provider.

## [1.3.0] - 2026-03-28

### Added

- LLM-oriented extraction and consolidation seams for Lore ingestion, including new extraction provider interfaces, draft storage, consolidation state, and a consolidator-driven pending knowledge pipeline.
- Stop-hook drafting support and SessionStart consolidation with a lightweight pending digest.
- New test coverage for provider injection, draft-store behavior, consolidator behavior, pending-only deletion, SessionStart pending digests, and Stop-hook failure-safe extraction behavior.

### Changed

- Retired the old CLI-backed `SuggestionEngine` pending-entry writer path. Pending shared knowledge is now produced by the consolidator, with `lore suggest` repurposed as an informational/debug command.
- Updated shared types, config, and storage layout to support draft candidates, consolidation watermarks, evidence summaries, contradiction counts, source-turn counts, and pending-entry merge metadata.
- Updated README and design docs to reflect the new ingestion architecture and approval surface.

## [1.2.3] - 2026-03-28

### Changed

- Fixed the npm package `bin` metadata to use `bin/lore.js`, so npm preserves the global `lore` command during publish instead of auto-correcting it away.

## [1.2.2] - 2026-03-28

### Changed

- Fixed the global `lore` npm wrapper so it works from any current working directory by resolving the packaged `tsx` loader and CLI script relative to the installed package.
- Replaced the installer's `python3` marketplace update step with `node`, removing an unnecessary install prerequisite.
- Simplified the README to present Lore as a Codex plugin first, with plugin-installed CLI examples that match the primary install flow.
- Updated the installer success message to use `npm run cli -- ...`, matching the README and the plugin checkout workflow.

## [1.2.1] - 2026-03-28

### Added

- npm packaging metadata for the global CLI package `codex-lore`.

### Changed

- Renamed the npm package from `lore` to `codex-lore` so it can be published without colliding with the existing `lore` package on npm.
- Added a global `lore` binary via the package `bin` field so users can run `npm install -g codex-lore` and then invoke `lore` directly.
- Added npm publish metadata (`description`, `license`, `repository`, `bugs`, `author`, `engines`, and `files`) and updated the README install instructions for the global CLI flow.

## [1.2.0] - 2026-03-28

### Added

- New end-to-end coverage for Lore hook lifecycle behavior, including SessionStart injection, whisper no-op behavior without `session_id`, and cross-project sharing of a promoted Python rule across two separate Python projects.
- New scorer and whisper-selection tests covering recent tool-name context and high-confidence session nudges.

### Changed

- **Whisper scoring** now incorporates `recentToolNames` as a first-class session signal, so recent tool usage such as `npm`, `vitest`, `psql`, and `docker` can influence turn relevance.
- **Pre-prompt whisper selection** now keeps shared knowledge as the primary channel while allowing light, high-confidence session nudges only when session context is strong or the prompt is otherwise underspecified.
- Updated README delivery-layer and whisper behavior language to match the current runtime behavior and test counts.

### Removed

- Removed no-longer-needed local assets `assets/lore-icon.svg`, `assets/lore-logo.svg`, and `.codex-echo/`.

## [1.1.0] - 2026-03-28

### Added

- **Capability-aware SessionStart instruction template** (`src/plugin/session-start-template.ts`) — composable section renderers that inject Lore behavior guidance into the agent's context. Tool-specific sections (recall, promote, demote, CLI fallback) are gated behind explicit `LoreCapabilities` flags so the agent never sees references to unavailable tools.
- New types: `LoreCapabilities`, `SelectedEntry`, `ContextBuilderResult`, `SessionStartTemplateInput` in `src/shared/types.ts`.
- 26 new tests for the template module covering all capability tiers (none, recall-only, CLI-only, full), section ordering, kind grouping, and the null-for-empty invariant.

### Changed

- **context-builder.ts** now returns data (`ContextBuilderResult` with `selectedEntries: SelectedEntry[]`) instead of rendered markdown. Scoring, selection, dedup, per-kind caps, and token budget logic are unchanged.
- **session-start.ts** wires the new template module and resolves baseline capabilities (all false until MCP tools are wired in a future release).
- Updated existing tests in `context-builder.test.ts` and `session-start.test.ts` for the new data return type.
- Updated README test counts (279 -> 309, 24 -> 25 test files) and project structure description.
- Updated `docs/design.md` and `CLAUDE.md` plugin layer descriptions to mention the instruction template.

### Removed

- Removed inline `FULL_INJECTION_TEMPLATE` and `formatSessionKnowledgeEntries` from `context-builder.ts` (moved to template module).
- Removed dead links to gitignored design documents from README.md, docs/design.md, and CLAUDE.md.

## [1.0.0] - 2026-03-28

Initial release. Two-tier memory (project-scoped + shared cross-project knowledge) with four delivery layers: SessionStart injection, pre-prompt whispers, MCP recall tools, and advisory hints.
