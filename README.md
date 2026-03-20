# ⚡ pi-skill-interpolation

Dynamic shell interpolation for [pi](https://github.com/badlogic/pi-mono) skills. Embed `!`command`` in your SKILL.md and the output replaces the placeholder before the model sees it.

Compatible with [Claude Code's skill interpolation syntax](https://x.com/lydiahallie/status/2034337963820327017).

## What it does

```markdown
---
name: pr-summary
description: Summarize changes in a pull request
allowed-tools: Bash(git:*) Bash(gh:*)
---

- PR diff: !`gh pr diff`
- Changed files: !`gh pr diff --name-only`
- Current branch: !`git branch --show-current`
```

When you invoke `/skill:pr-summary`, the extension executes each `!`command`` and the model sees:

```
- PR diff: <actual diff output>
- Changed files: src/index.ts\nsrc/utils.ts
- Current branch: feat/my-feature
```

## Security

Interpolation only runs when the skill declares `allowed-tools` with a Bash permission in its frontmatter. Without it, `!`command`` patterns pass through as literal text.

```yaml
# These enable interpolation:
allowed-tools: Bash
allowed-tools: Bash(git:*) Bash(gh:*)
allowed-tools: Read Bash(echo:*)

# These do NOT enable interpolation:
allowed-tools: Read Write
# (or no allowed-tools at all)
```

This follows the [Agent Skills spec](https://agentskills.io/specification) `allowed-tools` field. Same trust model as npm postinstall scripts: you opt in per-skill.

## Install

```bash
pi install git:github.com/joelhooks/pi-skill-interpolation
```

Or clone and symlink:

```bash
git clone git@github.com:joelhooks/pi-skill-interpolation.git ~/Code/joelhooks/pi-skill-interpolation
ln -sfn ~/Code/joelhooks/pi-skill-interpolation ~/.pi/agent/extensions/skill-interpolation
```

## How it works

Two extension hooks, no core changes:

**`input` hook** - Intercepts `/skill:name` before pi's built-in expansion. Finds the skill file, checks `allowed-tools` for Bash, interpolates `!`command`` patterns, and returns the expanded `<skill>` block. Falls through to pi's normal expansion when there's nothing to interpolate.

**`tool_result` hook on `read`** - When the model reads a SKILL.md via the read tool (on-demand from the system prompt skill list), checks for `!`command`` patterns and `allowed-tools`, interpolates in the result content.

## Behavior

- Commands run in the skill's directory (where SKILL.md lives)
- 10-second timeout per command
- Failed commands produce an inline error: `[error: \`command\` failed: ...]`
- Regular backticks (`` `not interpolated` ``) are unaffected
- No-op when `allowed-tools` is absent or doesn't include Bash
