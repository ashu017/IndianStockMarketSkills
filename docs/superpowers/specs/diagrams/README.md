# Diagrams

PlantUML sources for the portfolio re-platform (companion to `../2026-07-06-portfolio-replatform-design.md`).

| File | What it shows |
|---|---|
| `schema.puml` | SQLite data schema (ERD) — user-scoped vs global tables, keys, unique constraints, INTEGER-money/TEXT-date notes |
| `architecture.puml` | Overall architecture — Next.js RSC read path, ingestion write path, single-writer SQLite |
| `refresh-sequence.puml` | Refresh flow — on-demand ingestion sequence (Kite → Screener → LLM → transactional upsert → revalidate) |

## Rendering

No local PlantUML renderer is bundled. Any of:

```bash
# Docker (no install)
docker run --rm -v "$PWD":/work -w /work plantuml/plantuml -tsvg "*.puml"

# Homebrew
brew install plantuml && plantuml -tsvg *.puml

# VS Code: "PlantUML" extension → Alt+D to preview
```

Or paste into the web server at https://www.plantuml.com/plantuml. Generated `*.svg`/`*.png` are gitignored — render locally.
