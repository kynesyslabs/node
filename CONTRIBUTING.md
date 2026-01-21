# Contributing to Demos Network Node Software

Thank you for your interest in contributing to the Demos Network Node Software! This guide will help you get started with contributing to our project.

## 📚 Essential Documentation

Before contributing, please review our guidelines:

- **[Coding Guidelines](GUIDELINES/CODING.md)** - Code style, naming conventions, and best practices
- **[Pull Request Guidelines](GUIDELINES/PR.md)** - **MANDATORY** pre-PR review process with CodeRabbit CLI
- **[Set Up Guidelines](INSTALL.md)** - Set up the repo and its dependencies
- **[AI-Assisted Development Guidelines](GUIDELINES/VIBES.md)** - If you plan to use any AI coding tool, please refer to these guidelines

## 🚀 Getting Started

### Prerequisites

- **Bun** (latest version) - Our primary runtime and package manager
- **Node.js 20.x+** - For compatibility
- **Docker** - For running PostgreSQL database
- **Git** - Version control

### Setting Up Your Environment

Please refer to [INSTALL.md](INSTALL.md) for all the necessary informations on how to set up, run and develop on this repository.

## 🌟 Development Workflow

**IMPORTANT**: If you are using any AI coding tool (Claude Code, Copilot, etc.), you should definitely check [AI-Assisted Development Guidelines](GUIDELINES/VIBES.md) for essential setup and workflow instructions.

### 1. Create a Feature Branch

Always create a feature branch for your work:

```bash
git checkout -b feature/your-feature-name
```

Branch naming conventions:

- `feature/` - New features
- `fix/` - Bug fixes
- `refactor/` - Code refactoring
- `docs/` - Documentation updates
- `test/` - Test additions or fixes

### 2. Development Process

1. **Plan your implementation** - For complex features, create a `*_PHASES.md` file with implementation steps
2. **Write clean code** - Follow our [Coding Guidelines](GUIDELINES/CODING.md)
3. **Test your changes** - Ensure all tests pass
4. **Lint your code** - Run `bun run lint:fix` before committing

### 3. Code Quality Checks

Before submitting your changes, ensure:

```bash
# Run linting
bun run lint
bun run lint:fix  # Auto-fix issues
```

### 4. Commit Guidelines

Write clear, descriptive commit messages:

- Use present tense ("Add feature" not "Added feature")
- Keep the first line under 50 characters
- Reference issues when applicable (`Fixes #123`)

Example:

```
Add multichain transaction validation

- Implement validation logic for cross-chain transactions
- Add unit tests for validation functions
- Update SDK integration

Fixes #456
```

## 📝 Pull Request Process

**MANDATORY**: Before submitting your PR, you MUST run the CodeRabbit CLI locally. See [Pull Request Guidelines](GUIDELINES/PR.md) for detailed instructions.

**IMPORTANT**: This repository integrates CodeRabbit and Qodo as automatic PR review services. As their insights are usually very valuable, please check them out BEFORE considering your PR ready.

1. **Run pre-PR review** - Use `coderabbit` CLI to catch issues early (see [PR Guidelines](GUIDELINES/PR.md))
2. **Update documentation** - If you've added functionality, update relevant docs
3. **Ensure CI passes** - All automated checks must pass
4. **Assess review** - CodeRabbit and Qodo will automatically generate a review of your PR. Please check it out as they often spot hidden bugs and provide solutions
5. **Address feedback** - Respond to and resolve review comments

### Pull Request Template

When opening a PR, please include:

- **Description** - What does this PR do?
- **Motivation** - Why is this change needed?
- **Testing** - How has this been tested?
- **Breaking changes** - Does this break existing functionality?
- **Issues** - Link to related issues

### Key Principles

- **Modularity** - Keep features isolated and reusable
- **Type Safety** - Leverage TypeScript for full type coverage
- **Error Handling** - Comprehensive error handling and validation
- **Documentation** - Document complex logic and APIs

## 🐛 Reporting Issues

### Bug Reports

Include:

- Clear description of the bug
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Bun version, etc.)
- Relevant logs or error messages

### Feature Requests

Include:

- Use case and motivation
- Proposed solution
- Alternative solutions considered
- Potential impact on existing functionality

## 💡 Development Tips

### Using Bun Effectively

- **Always use Bun** for package management (`bun add`, not `npm install`)
- Run TypeScript directly with Bun (`bun src/index.ts`)
- Leverage Bun's built-in test runner (`bun test`)

### Code Style

- Use double quotes for strings
- No semicolons at statement ends
- camelCase for variables and functions
- PascalCase for types and classes
- See [GUIDELINES/CODING.md](GUIDELINES/CODING.md) for complete style guide

### Performance Considerations

- Optimize for readability first, then performance
- Use async/await for asynchronous operations
- Implement proper caching strategies
- Monitor memory usage in long-running processes

## 🤝 Community

### Code of Conduct

- Be respectful and inclusive
- Welcome newcomers and help them get started
- Focus on constructive feedback
- Report unacceptable behavior to maintainers

### Getting Help

- Review existing documentation
- Search through existing issues
- Ask questions in discussions
- Join our community channels

## 📄 License

By contributing to this project, you agree that your contributions will be licensed under the CC BY-NC-ND 4.0 License.

## 🙏 Thank You!

Your contributions help make the Demos Network better for everyone. We appreciate your time and effort in improving this project!

---

**Questions?** Feel free to open an issue or reach out to the maintainers.
