# AI Agent Instructions for Demos Network

Semantic map: see `repository-semantic-map/`.

## Checks (no tests)

- Use `bun run check` as the canonical “magic” check (authoritative `tsc` via `tsconfig.check.json` + a Bun bundling sanity check).
- Use `bun run check:full` when you need to type-check the full repository.
## Task Tracking

**IMPORTANT**: Use **Mycelium (`myc`)** as the repo-visible task tracker. Do NOT create markdown TODOs, and do not reintroduce committed `.beads/` or `.beadspace/` state.

### Optional br interoperability

`br` remains available as a local interoperability layer when explicitly needed, but it is secondary to `myc` in this repository.

- Prefer `bun run brx -- <br command...>` for mutating `br` operations.

### Managing AI-Generated Planning Documents

AI assistants often create planning and design documents during development:
- PLAN.md, IMPLEMENTATION.md, ARCHITECTURE.md
- DESIGN.md, CODEBASE_SUMMARY.md, INTEGRATION_PLAN.md
- TESTING_GUIDE.md, TECHNICAL_DESIGN.md, and similar files

**Best Practice: Use a dedicated directory for these ephemeral files**

**Recommended approach:**
- Create a `history/` directory in the project root
- Store ALL AI-generated planning/design docs in `history/`
- Keep the repository root clean and focused on permanent project files
- Only access `history/` when explicitly asked to review past planning

**Example .gitignore entry (optional):**
```
# AI planning documents (ephemeral)
history/
```

**Benefits:**
- Clean repository root
- Clear separation between ephemeral and permanent documentation
- Easy to exclude from version control if desired
- Preserves planning history for archeological research
- Reduces noise when browsing the project

### Important Rules

- Use `myc` for repo-visible task tracking
- Store AI planning docs in `history/` directory
- Do NOT create markdown TODO lists
- Do NOT use external issue trackers
- Do NOT duplicate tracking systems
- Do NOT clutter repo root with planning documents

For more details, see README.md and QUICKSTART.md.


## Project Management with Mycelium

This project uses [Mycelium](https://github.com/tcsenpai/mycelium) (`myc`) for task and epic management.

### Quick Reference

```bash
# Initialize mycelium in this project (creates .mycelium/ directory)
myc init

# Create an epic (a large body of work)
myc epic create --title "Feature X" --description "Build feature X"

# Create tasks within an epic
myc task create --title "Implement Y" --epic 1 --priority high --due 2025-12-31

# Task priorities: low, medium, high, critical
# Task status: open, closed

# List tasks
myc task list
myc task list --epic 1
myc task list --overdue
myc task list --blocked

# Manage dependencies (task 1 blocks task 2)
myc task link blocks --task 1 2
myc deps show 2

# Close tasks (blocked tasks cannot be closed without --force)
myc task close 1

# Assign tasks
myc assignee create --name "Alice" --github "alice"
myc task assign 1 1

# Link to external resources
myc task link github-issue --task 1 "owner/repo#123"
myc task link github-pr --task 1 "owner/repo#456"
myc task link url --task 1 "https://example.com"

# Project overview
myc summary

# Export data
myc export json
myc export csv
```

### Data Model

- **Epic**: A large body of work (e.g., a feature or milestone)
- **Task**: A unit of work within an epic
- **Dependency**: Task A blocks Task B (B cannot close until A is closed)
- **Assignee**: Person assigned to a task (can have GitHub username)
- **External Ref**: Link to GitHub issues/PRs or URLs

### Git Tracking

The `.mycelium/` directory contains the SQLite database and should be committed to git:

```bash
git add .mycelium/
git commit -m "Add mycelium project tracking"
```

### For AI Agents

When working on this project:

1. Check existing tasks: `myc task list`
2. Check blocked tasks: `myc task list --blocked`
3. Create tasks for new work: `myc task create --title "..." --epic N`
4. Mark tasks complete when done: `myc task close N`
5. Use `--format json` for machine-readable output: `myc task list --format json`
6. Prefer committing `.mycelium/` updates together with the code changes they describe
7. If `br` is used locally for interoperability, mirror any durable task state back into `myc`
