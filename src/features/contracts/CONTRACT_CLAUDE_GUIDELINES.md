# Contract Development Guidelines for Claude

## Essential Rules

### 1. Phase Completion Protocol
- **ALWAYS** commit changes after completing each phase
- Use meaningful commit messages that reference the phase number and description
- Example: `feat(contracts): Phase 1 - Add contract column to GCR_Main entity`

### 2. Documentation Updates
After completing each phase, update the relevant documentation:

#### CONTRACT_PHASES.md Updates:
- Mark the completed phase with ✅
- Add references to files created/modified
- Note any deviations or additional work done
- Example:
  ```markdown
  ## Phase 1: Database Foundation ✅
  **Goal**: Update GCR_Main entity to support contracts
  **Status**: Completed on 2024-XX-XX
  
  1. Add `contract` JSONB column to GCR_Main entity ✅
     - Modified: `src/model/entities/GCRv2/GCR_Main.ts`
  2. Create TypeORM migration for the new column ✅
     - Created: `src/migrations/XXXXXX-AddContractColumn.ts`
  ```

#### CONTRACT_PLAN.md Updates:
- Update any architectural decisions that changed during implementation
- Add references to actual implementation files
- Document any discovered constraints or considerations

#### CONTRACT_DIAGRAM.md Updates:
- Update diagrams if the actual implementation differs
- Add new diagrams for complex implementations

### 3. Development Workflow
1. Read the current phase requirements
2. Implement the phase following existing patterns
3. Test the implementation
4. Update documentation with results
5. Commit with meaningful message
6. Report completion before moving to next phase

### 4. Code Quality Standards
- Follow existing code patterns in the repository
- Use `@/` imports instead of relative paths
- Add `// REVIEW:` comments for significant new features
- Include JSDoc comments for new methods
- Ensure TypeScript types are properly defined

### 5. When in Doubt
- **STOP** and ask for clarification
- Do not make assumptions about business logic
- Verify reusability of existing code before creating new implementations

## Commit Message Format
```
feat(contracts): Phase X - Brief description

- Detailed change 1
- Detailed change 2
- References: #phase-X
```

## Progress Tracking
- Use todo list to track sub-tasks within phases
- Report completion of each major step
- Maintain clear communication about blockers or questions