# Pull Request Guidelines 🚀

**MANDATORY**: Run CodeRabbit following this guide to code review BEFORE submitting your PR to catch issues early and save everyone's time.

## 🔍 Pre-PR Review Process

### Why Pre-Review Matters

Running a local AI review before submitting your PR helps:
- **Catch bugs early** - Find logical errors, code smells, and potential issues
- **Improve code quality** - Get senior-engineer level feedback instantly
- **Save review time** - Address issues before human reviewers see them
- **Learn and improve** - Understand best practices and patterns
- **Ship with confidence** - Know your code meets quality standards

## 🛠️ Required Tool: CodeRabbit CLI

### Installation

Install the CodeRabbit CLI tool (one-time setup and free):

```bash
# macOS and Linux
curl -fsSL https://cli.coderabbit.ai/install.sh | sh
```

### Running Pre-PR Review

**BEFORE creating your pull request**, run CodeRabbit in your feature branch:

```bash
# Make sure you're on your feature branch
git checkout feature/your-feature-name

# Run CodeRabbit review
coderabbit

# Review and address the feedback
# Make necessary fixes based on the suggestions
# Commit your improvements
```

## 📋 Pre-PR Checklist

Before submitting your PR, ensure you have:

1. ✅ **Run CodeRabbit CLI** and addressed critical feedback
2. ✅ **Run linting** with `bun run lint:fix`
5. ✅ **Updated documentation** if you've added new features
6. ✅ **Saved AI session memories** with `/sc:save` (if using Claude Code)

## 🤖 What CodeRabbit Checks

The AI review will analyze your code for:

- **Logic errors** - Incorrect conditions, unreachable code, infinite loops
- **Security issues** - Potential vulnerabilities, unsafe patterns
- **Code smells** - Anti-patterns, unnecessary complexity, duplication
- **Missing tests** - Untested edge cases, missing unit tests
- **Performance issues** - Inefficient algorithms, unnecessary operations
- **Best practices** - Naming conventions, error handling, documentation
- **AI hallucinations** - Code that doesn't make sense or won't work

## 💡 How to Use the Feedback

### Priority Levels

1. **🔴 Critical** - Must fix before PR (security, bugs, broken functionality)
2. **🟡 Important** - Should fix before PR (code quality, maintainability)
3. **🟢 Suggestions** - Consider improving (style, minor optimizations)

### Addressing Feedback

- **Fix critical issues** immediately
- **Consider important suggestions** and implement if they make sense
- **Document your decisions** if you disagree with suggestions
- **Re-run after fixes** to ensure issues are resolved

## 🔄 Post-PR Review

After submitting your PR:

1. **CodeRabbit Bot** will automatically review your PR on GitHub
2. **Qodo** will provide additional automated insights
3. **Human reviewers** will provide final feedback

Having run the CLI review first means:
- Fewer issues in the automated PR review
- Faster approval from human reviewers
- Higher quality code merged to main

## 🚨 Common Issues Caught by Pre-Review

- Unused variables and imports
- Inconsistent error handling
- Missing null/undefined checks
- Potential race conditions
- Incorrect async/await usage
- Memory leaks
- Security vulnerabilities
- Incomplete implementations

## 📚 Additional Resources

- [Our Coding Guidelines](CODING.md)
- [Contributing Guide](../CONTRIBUTING.md)

## ❓ Troubleshooting

### CodeRabbit CLI Issues

- **Installation fails**: Check your system requirements (macOS/Linux)
- **Rate limits**: Free tier has limits; wait or upgrade if needed
- **No feedback**: Ensure you have uncommitted changes or recent commits
- **False positives**: Use your judgment; not all suggestions apply

### Getting Help

- Create a draft PR if you need early human feedback
- Document why you're not addressing certain suggestions

---

**Remember**: The goal is to merge high-quality code quickly. Pre-PR reviews help achieve this by catching issues early when they're easiest to fix.