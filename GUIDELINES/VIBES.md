# AI-Assisted Development Guidelines 🚀

This guide ensures you get the most out of AI tools while maintaining our code quality standards.

## 🎯 Quick Start

### The Golden Rule

**AI is your copilot, not your autopilot.** Use it to enhance your productivity, not replace your thinking.

## 🛠️ Required Setup

### 1. Claude Code - Your Primary AI Assistant

Due to the complexity of the Demos Network codebase, **Claude Code** is our recommended AI tool. But here's the thing - vanilla Claude Code isn't enough for this repository.

### 2. SuperClaude Framework - The Power-Up

Install [SuperClaude Framework](https://github.com/SuperClaude-Org/SuperClaude_Framework) on top of Claude Code. This isn't optional - it's essential for:

- Enforcing our coding standards automatically
- Maintaining code quality across the entire codebase
- Synchronizing development context across team members

### 3. Demos SDK MCP - Official SDK Integration

**Essential:** Install the official Demos SDK MCP for complete SDK documentation and examples:

```bash
claude mcp add -s user --transport http demosdk-refs https://get.demos.sh
```

This provides:

- Complete SDK documentation access
- Code examples and patterns
- API references
- Real-time SDK updates

## 🧠 Branch Memory System - Your Shared Brain

### What Are Serena Memories?

Each branch in this repository has its own **Serena memories** - a persistent knowledge base that:

- Stores project context and decisions
- Tracks code patterns and conventions
- Maintains session continuity
- **Shares knowledge between developers on the same branch**

### The Session Workflow - Never Forget Again

#### Starting Your Work Session

**ALWAYS** begin with:

```bash
/sc:load
```

This loads:

- Branch-specific memories and context
- Previous session's discoveries
- Team decisions and patterns
- Project understanding from other developers

#### Ending Your Work Session

**ALWAYS** finish with:

```bash
/sc:save
```

This saves:

- Your session's discoveries and insights
- Code patterns you've identified
- Decisions and rationale
- Context for the next developer (could be you!)

### Why This Matters

- **Continuity**: Pick up exactly where you (or your teammate) left off
- **Knowledge Sharing**: Discoveries are automatically shared via git
- **Context Preservation**: Never lose important project understanding
- **Team Synchronization**: Everyone on the branch works with the same context

## 💡 Best Practices

### DO ✅

- Start every session with `/sc:load`
- End every session with `/sc:save`
- Commit and push Serena memories (`.serena/` folder)
- Review AI suggestions critically
- Use AI for exploration and understanding
- Let AI help with boilerplate and repetitive tasks

### DON'T ❌

- Skip the load/save workflow
- Blindly accept AI suggestions
- Use AI to write code you don't understand
- Ignore the branch memory system
- Work in isolation from team context

## 🔄 Typical Workflow Example

```bash
# 1. Start your day
git checkout feature/new-multichain-bridge
/sc:load  # Load branch context and memories

# 2. Work with AI assistance
# Claude Code + SuperClaude will now have full context

# 3. Make your changes
# AI understands the codebase, patterns, and decisions

# 4. Before lunch/breaks
/sc:save  # Save your morning's work context

# 5. After returning
/sc:load  # Restore context instantly

# 6. End of day
/sc:save  # Save all discoveries and decisions
git add .serena/
git commit -m "Update branch memories with bridge implementation decisions"
git push
```

## 🎭 Different AI Tools, Different Rules

### Claude Code + SuperClaude ✅

- **Status**: Recommended
- **Use for**: Everything - it understands our codebase deeply
- **Special powers**: Serena memories, branch context, team synchronization

### GitHub Copilot / Cursor / Windsurf / Similar tools ⚠️

- **Status**: Allowed with caution
- **Use for**: Autocomplete and simple suggestions only
- **Limitations**: No project context, no memory system

### Gemini CLI / Codex / ChatGPT / Other LLMs ❌

- **Status**: Not recommended
- **Why**: Lacks integration with our tooling and context system
- **Exception**: Quick syntax questions only

## 🚨 Security Considerations

- **Never** share sensitive keys or credentials with AI
- **Always** review AI-generated code for security vulnerabilities
- **Remember** AI doesn't understand your security requirements

## 🤝 Contributing to AI Guidelines

Found a better way to use AI tools? Share it! These guidelines evolve with our collective experience.

---

**Remember**: AI amplifies your abilities - it doesn't replace them. Use it wisely, and always maintain control over your code.
