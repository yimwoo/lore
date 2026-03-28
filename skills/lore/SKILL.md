---
name: lore
description: Lore — shared cross-project knowledge. Use when you need to recall domain rules, architecture facts, decisions, preferences, or glossary terms that apply across projects.
---

## Lore

Lore maintains shared knowledge across your projects. It injects high-value facts at session start and provides recall tools for deeper queries.

### Shared Knowledge Kinds

- **domain_rule** — naming conventions, compliance constraints, "never do X"
- **architecture_fact** — platform assumptions, service patterns, data store roles
- **decision_record** — past decisions with rationale
- **user_preference** — coding style, tool preferences
- **glossary_term** — domain vocabulary

### CLI Commands (M2+)

```
lore promote     Promote a memory to shared knowledge
lore list-shared  List shared knowledge entries
lore inspect      Show full entry + history
lore demote       Remove a shared knowledge entry
```

### MCP Recall Tools (M3+)

- `lore.recall_rules` — domain rules and glossary terms
- `lore.recall_architecture` — architecture facts
- `lore.recall_decisions` — decision records with rationale
- `lore.search_knowledge` — cross-kind freeform search
