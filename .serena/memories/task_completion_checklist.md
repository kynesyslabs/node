# Task Completion Checklist

## Before Committing Code Changes

### 1. Code Quality Checks
```bash
bun run lint                  # REQUIRED: Check ESLint rules
bun run format               # REQUIRED: Format with Prettier  
```

### 2. Type Safety Validation
```bash
# TypeScript compilation check
bun run build               # If build script exists
# OR manually check
npx tsc --noEmit           # Type check without emission
```

### 3. Testing (When Applicable)
```bash
bun run test:chains        # Run blockchain-specific tests
# Only if tests exist and are relevant to changes
```

### 4. Documentation Updates
- Update JSDoc comments for new/modified functions
- Add inline comments for complex business logic
- Update README.md if API changes affect usage
- Add REVIEW comments for significant new features

## Development Guidelines

### Code Review Preparation
- Add `// REVIEW:` comments before newly added features
- Ensure descriptive function/variable names
- Document non-obvious implementation decisions
- Provide clear, actionable error messages

### Database Changes
```bash
bun run migration:generate   # If database schema changes
bun run migration:run       # Apply new migrations
```

### SDK Integration
- Verify @kynesyslabs/demosdk version compatibility
- Test SDK method calls if modified
- Check for breaking changes in SDK updates

## Project-Specific Considerations

### Demos Network Context
- Reference GCRv2 methods (not GCRv1) unless specified
- Use PoRBFTv2 consensus references when applicable  
- Follow established patterns in src/features/
- Maintain consistency with existing SDK integration

### Branch Strategy
- Work on feature branches, merge to main
- Never work directly on main branch
- Ensure clean git history before merging

## Final Verification
1. All lint errors resolved
2. Code formatted consistently  
3. Types compile without errors
4. Tests pass (if applicable)
5. Documentation updated
6. REVIEW comments added for new features