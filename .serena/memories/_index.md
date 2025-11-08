# Serena Memory Index - Demos Network Node

## Quick Navigation Guide

This index helps Serena efficiently locate and load the most relevant memories for any task. Memories are organized by domain and purpose.

## Core Project Knowledge (Always Load First)

### Foundation
- **`project_core`** - Project identity, architecture, tech stack, naming conventions
- **`development_guidelines`** - Code style, workflow, quality standards, best practices

### Essential References
- **`suggested_commands`** - Development commands and utilities
- **`task_completion_guidelines`** - DEPRECATED (merged into development_guidelines)

## Feature Implementation Memories

### Storage Programs (Complete)
- **`storage_programs`** - Complete implementation reference, architecture patterns, usage
  - Covers: Two-phase validation, access control, size limits, data flow
  - Commits: b0b062f1, 1bbed306, 7a5062f1, 28412a53
  - Status: Production ready ✅

### Telegram Identity System (Complete)
- **`telegram_identity`** - Dual-signature verification, bot authorization, points system
  - Covers: Demos address=public key pattern, group membership points
  - SDK: v2.4.18+
  - Status: Production ready ✅

## Quality & Review Memories

### Code Reviews
- **`pr_review_tg_identities_complete`** - PR #468 complete analysis and resolutions
  - All CRITICAL and HIGH priority issues resolved
  - Security decisions documented
  - Lessons learned from automated reviews

### Session Checkpoints (Keep Most Recent)
- **`session_storage_review_2025_10_11`** - Storage Programs review session
  - Automated review analysis (GLM, QWEN)
  - Bug verification and false positive identification
  - Production readiness assessment

- **`session_final_2025_01_31`** - Telegram identities final checkpoint
  - All high priority issues complete
  - Security analysis and decisions
  - Implementation milestones

## Deprecated Memories (Delete After Verification)

### Superseded by Consolidated Memories
- `project_purpose` → Merged into `project_core`
- `tech_stack` → Merged into `project_core`
- `codebase_structure` → Merged into `project_core`
- `code_style_conventions` → Merged into `development_guidelines`
- `development_patterns` → Merged into `development_guidelines`
- `project_context_consolidated` → Replaced by `project_core`

### Storage Programs (Consolidated)
- `storage_programs_complete` → Merged into `storage_programs`
- `storage_programs_specification` → Merged into `storage_programs`
- `storage_programs_architectural_patterns` → Merged into `storage_programs`
- `storage_programs_access_control_patterns` → Merged into `storage_programs`
- `storage_programs_implementation_phases` → Merged into `storage_programs`
- `storage_programs_phases_commits_guide` → Merged into `storage_programs`
- `storage_programs_phase2_complete` → Merged into `storage_programs`
- `storage_programs_phase3_complete` → Merged into `storage_programs`
- `storage_programs_phase4_complete` → Merged into `storage_programs`
- `storage_programs_review_fixes_complete` → Merged into `storage_programs`
- `storage_programs_review_lessons_learned` → Merged into `storage_programs`

### Telegram Identity (Consolidated)
- `telegram_identity_system_complete` → Merged into `telegram_identity`
- `project_patterns_telegram_identity_system` → Merged into `telegram_identity`
- `session_2025_10_10_telegram_group_membership` → Merged into `telegram_identity`
- `telegram_points_implementation_decision` → Merged into `telegram_identity`
- `telegram_points_conditional_requirement` → Merged into `telegram_identity`

### PR Review (Consolidated)
- `pr_review_point_system_fixes_completed` → Merged into `pr_review_tg_identities_complete`
- `pr_review_analysis_complete` → Merged into `pr_review_tg_identities_complete`
- `pr_review_corrected_analysis` → Merged into `pr_review_tg_identities_complete`
- `pr_review_all_high_priority_completed` → Merged into `pr_review_tg_identities_complete`
- `pr_review_import_fix_completed` → Merged into `pr_review_tg_identities_complete`
- `pr_review_json_canonicalization_dismissed` → Merged into `pr_review_tg_identities_complete`
- `genesis_caching_security_dismissed` → Merged into `pr_review_tg_identities_complete`
- `data_structure_robustness_completed` → Merged into `pr_review_tg_identities_complete`
- `input_validation_improvements_completed` → Merged into `pr_review_tg_identities_complete`

### Session Checkpoints (Superseded)
- `checkpoint_2025_10_11_session_complete` → Keep as `session_storage_review_2025_10_11`
- `session_2025_10_11_storage_branch_review` → Merged into `session_storage_review_2025_10_11`
- `session_2025-10-11_storage_programs_review_fixes` → Merged into `session_storage_review_2025_10_11`
- `session_2025_10_11_storage_programs_fixes` → Merged into `session_storage_review_2025_10_11`
- `session_checkpoint_2025_01_31` → Keep as `session_final_2025_01_31`
- `session_final_checkpoint_2025_01_31` → Merged into `session_final_2025_01_31`

## Memory Loading Strategy

### For New Tasks
1. Load `project_core` and `development_guidelines` first
2. Identify task domain and load relevant feature memory
3. Load session checkpoints only if resuming interrupted work

### For Feature Development
- **Storage Programs**: Load `storage_programs`
- **Telegram Identity**: Load `telegram_identity`
- **New Feature**: Start with core memories only

### For Code Review
- Load `pr_review_tg_identities_complete` for patterns and lessons
- Load feature-specific memory for context

### For Bug Fixes
- Load relevant feature memory
- Load session checkpoints if issue is known
- Load core memories for context

## Optimization Results

### Before Consolidation
- **Total Memories**: 40
- **Estimated Size**: ~150KB
- **Redundancy**: High (70%+ duplicate information)

### After Consolidation
- **Total Memories**: 10 (8 consolidated + 2 reference)
- **Estimated Size**: ~50KB
- **Redundancy**: Minimal (atomic, non-overlapping domains)
- **Space Savings**: 67% fewer memories, 66% size reduction

## Maintenance Guidelines

### When to Add New Memories
- Major feature completion (add feature-specific memory)
- Significant session milestones (add checkpoint)
- Important lessons learned (add to relevant feature memory)

### When to Update Memories
- Feature enhancement (update feature memory)
- Pattern changes (update core memories)
- Guideline updates (update development_guidelines)

### When to Delete Memories
- After successful consolidation verification
- When superseded by updated memory
- After confirming no unique information loss
