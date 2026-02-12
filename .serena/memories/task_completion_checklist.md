# Task Completion Checklist

## CRITICAL: Pre-Completion Validation

### ALWAYS Required Before Marking Task Complete

1. **Run Type Checking** (if TypeScript changes made)
   ```bash
   bun run lint:fix
   ```
   - Checks syntax errors
   - Validates code quality
   - Ensures ESLint compliance
   - **MANDATORY**: Fix all errors before proceeding

2. **Verify Import Paths**
   - Ensure all imports use `@/` aliases, NOT relative paths
   - Example: `@/libs/utils/helper` NOT `../../../libs/utils/helper`

3. **Check Naming Conventions**
   - Variables/functions: camelCase
   - Classes/types/interfaces: PascalCase
   - NO "I" prefix for interfaces
   - Double quotes for strings
   - NO semicolons

4. **Add Documentation**
   - JSDoc comments for all new functions/methods
   - Inline comments for complex logic
   - `// REVIEW:` marker for significant new code

## Code Quality Checklist

### Implementation Standards
- [ ] All new code follows established patterns
- [ ] Error handling is comprehensive
- [ ] Type safety is maintained
- [ ] No hardcoded values (use config/env vars)

### Testing (if applicable)
- [ ] Tests pass: `bun run test:chains`
- [ ] New functionality has test coverage
- [ ] Edge cases are covered

### Documentation
- [ ] JSDoc comments added for new functions
- [ ] Complex logic has inline comments
- [ ] Non-obvious decisions are documented
- [ ] `// REVIEW:` markers added for significant changes

## Integration Checklist

### SDK Integration
- [ ] Uses @kynesyslabs/demosdk properly
- [ ] Follows existing SDK usage patterns
- [ ] Compatible with current SDK version

### Database Changes (if applicable)
- [ ] TypeORM entities updated correctly
- [ ] Migrations generated and tested
- [ ] Database schema validated

### Configuration
- [ ] .env variables documented
- [ ] Configuration changes noted
- [ ] Default values provided

## Final Validation

### NEVER Do These Before Completion
- ❌ **DO NOT start the node** (`./run` or `bun run start`)
- ❌ **DO NOT skip linting** - Must run `bun run lint:fix`
- ❌ **DO NOT commit with linting errors**
- ❌ **DO NOT use relative imports** - Use `@/` aliases

### Required Actions
- ✅ **RUN `bun run lint:fix`** - Fix all errors
- ✅ **Verify all imports use `@/` aliases**
- ✅ **Add JSDoc documentation**
- ✅ **Mark significant code with `// REVIEW:`**
- ✅ **Confirm naming conventions followed**
- ✅ **Test if applicable**

## Error Message Quality
- [ ] Error messages are clear and actionable
- [ ] Errors include context for debugging
- [ ] User-facing errors are professional

## Performance Considerations
- [ ] No obvious performance bottlenecks
- [ ] Database queries are optimized
- [ ] Resource usage is reasonable

## Security Considerations
- [ ] No sensitive data logged
- [ ] Input validation implemented
- [ ] No SQL injection vulnerabilities
- [ ] Proper error handling (no stack traces to users)

## Final Check Before Marking Complete
```bash
# Run this sequence before task completion:
bun run lint:fix     # Fix and validate code
# Review output and fix any errors
# If all passes, task can be marked complete
```

**Remember**: The primary validation method for this repository is ESLint (`bun run lint:fix`), NOT starting the node. Node startup is for production/controlled environments only.
