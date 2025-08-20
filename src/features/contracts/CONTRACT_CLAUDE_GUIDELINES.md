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

## Current Status (Last Updated: 2025-01-31)

### ✅ COMPLETED PHASES:
- **Phase 1**: Database Foundation - Added contract column to GCR_Main entity
- **Phase 2**: Contract Types and Validation - Created ContractTypes, ContractABI, ContractValidator
- **Phase 3a**: SDK Cleanup - Removed old implementation, created new ContractDeploy/CallTransaction types  
- **Phase 3b**: Node Transaction Handling - Created handleContractDeploy/Call handlers, integrated with endpointHandlers

### 🎯 NEXT PHASE: Phase 4 - Basic Execution Environment
**Goal**: Create sandboxed execution for contracts using Bun Workers

**Tasks**:
1. Create `src/features/contracts/execution/Sandbox.ts` using Bun Workers
2. Implement execution context injection
3. Add function call counting for fees
4. Implement 60-second timeout protection  
5. Test sandbox isolation and limits

### 📁 Key Files Created/Modified:
- `src/model/entities/GCRv2/GCR_Main.ts` - Added contract column
- `src/features/contracts/types/ContractTypes.ts` - Core contract interfaces
- `src/features/contracts/types/ContractABI.ts` - ABI type definitions
- `src/features/contracts/validation/ContractValidator.ts` - Contract validation utilities
- `../sdks/src/types/blockchain/TransactionSubtypes/ContractDeployTransaction.ts` - SDK deploy type
- `../sdks/src/types/blockchain/TransactionSubtypes/ContractCallTransaction.ts` - SDK call type
- `src/libs/network/routines/transactions/handleContractDeploy.ts` - Deploy handler
- `src/libs/network/routines/transactions/handleContractCall.ts` - Call handler
- `src/libs/network/endpointHandlers.ts` - Transaction routing integration

### 🧠 Key Technical Decisions Made:
- Smart contracts stored as JSONB in existing GCR_Main entity (no separate table)
- Deterministic addressing: hash(creatorPubkey + nonce + sourceCodeHash)
- Fee structure: 1 DEM per 32KB deployment, 1 DEM per function call
- Contract size limits: 256KB source, 64KB storage
- Security: Banned APIs (fs, network, process, eval), sandboxed execution
- TypeScript contracts executed directly by Bun (no compilation to JS)

### 🔗 Integration Points:
- Transaction system: Added contractDeploy/contractCall to main switch statement
- GCR system: Contracts are accounts with contract column filled
- SDK system: New transaction types properly integrated with existing patterns
- Validation: Reuses existing transaction validation flow with contract-specific handlers

### ⚠️ Important Notes for Phase 4:
- handleContractCall has placeholder execution (returns null) - needs actual Bun Worker execution
- Contract ABI is minimal placeholder - needs TypeScript AST analysis for method extraction
- Execution context injection pattern needs to be established for contract base class
- State management integration with GCR updates needed