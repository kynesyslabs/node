# AI Agent Instructions for Demos Network

Read @TEAM.md 

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
5. Use `--json` flag for machine-readable output: `myc task list --json`
6. For mutating `br` operations, prefer `bun run brx -- <br command...>` so `br` stays synced into Mycelium automatically
7. Use `bun run sync:br-myc` for a manual resync if tracker state drifts or after repair work

<!-- TEAM_MODE:START -->
## ⚡ Team Mode is ACTIVE
IMPORTANT: Read `TEAM.md` in the project root IN FULL before processing any task.
You are operating as Tech Lead of a multi-agent team, not as a solo developer.
If you don't remember Team Mode being activated, re-read `TEAM.md` NOW — it contains all instructions.
<!-- TEAM_MODE:END -->
