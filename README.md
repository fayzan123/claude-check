# claude-check

[![npm version](https://img.shields.io/npm/v/claude-check)](https://www.npmjs.com/package/claude-check)
[![license](https://img.shields.io/npm/l/claude-check)](LICENSE)

**Check before you run.** Analyse any Claude prompt for complexity, interrupt risk, and model fit — before it eats your usage limit.

---

## Why this exists

When you're running low on your claude.ai subscription limit, starting a complex task is a gamble. A refactor that gets cut off halfway leaves you with broken code. A long research task abandoned mid-way is useless.

`claude-check` takes your prompt, sends it to the Anthropic API for meta-analysis, and tells you: how complex is this? How many messages will it take? What's the interrupt risk? Is it safe to start right now given your remaining limit? And if it's risky — how should you break it up?

It runs **before** you commit to the task. It never touches your main Claude session or claude.ai limit.

---

## Requirements

- Node.js 18 or higher
- An Anthropic API key — create one at [console.anthropic.com](https://console.anthropic.com) (each analysis costs ~$0.001 with Haiku)

---

## Installation

```bash
npm install -g claude-check
```

---

## Setup

```bash
claude-check setup
```

This walks you through two questions and saves your config locally. You only need to do this once.

```
Enter your Anthropic API key: sk-ant-...

Your claude.ai plan:
  1. Pro (default)
  2. Max 5x
  3. Max 20x

Enter plan [1]: 2

API key saved. Plan set to: Max 5x.
```

Your plan tier is used to calibrate the safe/caution/do-not-start verdict — a Max 20x user at 20% remaining has far more absolute capacity than a Pro user at 20%. You can change it at any time by re-running `claude-check setup` or passing `--plan` on any run.

If you have [Claude Code](https://claude.ai/code) installed, `claude-check` will automatically detect your credentials and fetch your claude.ai usage limits — no `--limit` flag needed.

---

## Usage

### Basic analysis

```bash
claude-check "refactor my entire Express app to use TypeScript and add tests"
```

### With a manual usage limit

```bash
claude-check --limit 20 "build me an admin dashboard with auth and payments"
```

### Pipe a prompt from a file

```bash
cat my-prompt.txt | claude-check
```

### JSON output (for scripting)

```bash
claude-check --json "summarise this document"
```

---

## Example output

```
╭─ claude-check ───────────────────────────────────────────────╮
│                                                               │
│  Complexity:        HIGH                                      │
│  Est. messages:     6–10                                      │
│  Interrupt risk:    HIGH — partial refactor = broken code     │
│                                                               │
│  Recommended model: claude-sonnet-4-6                         │
│  Reason:            Multi-file code task needs reasoning      │
│                                                               │
│  ✗  18% from claude.ai (Max 5x): Do not start                 │
│     Wait for your limit to reset before running this.         │
│                                                               │
│  Safer breakdown:                                             │
│    1. Rename files and update imports first                   │
│    2. Add TypeScript types file by file                       │
│    3. Write tests as a separate task                          │
│                                                               │
╰───────────────────────────────────────────────────────────────╯
```

---

## Flags

| Flag | Description |
|------|-------------|
| `--limit <number>` | Your remaining claude.ai usage as a percentage (e.g. `--limit 20`). Auto-fetched if Claude Code is installed. |
| `--plan <plan>` | Your claude.ai plan: `pro`, `max5`, `max20`, or a numeric multiplier (e.g. `10`). Saved for future runs. |
| `--breakdown` | Always show task breakdown suggestions, even for LOW complexity |
| `--json` | Output raw JSON instead of formatted terminal output |
| `--no-color` | Plain text output, no terminal colours |
| `--model <model>` | Override which Claude model is used for the analysis call (default: `claude-haiku-4-5`) |

---

## Auto-fetching your usage limit

If you have [Claude Code](https://claude.ai/code) installed and signed in, `claude-check` reads your OAuth credentials and fetches your current weekly usage automatically. You'll see `from claude.ai` in the output instead of `remaining` — no `--limit` flag needed.

### Setting up Claude Code (one-time)

**1. Install Claude Code**

```bash
npm install -g @anthropic-ai/claude-code
```

Or download from [claude.ai/code](https://claude.ai/code).

**2. Sign in**

```bash
claude
```

This opens a browser window to authenticate with your claude.ai account. Once done, Claude Code stores your credentials locally (in the macOS Keychain on macOS, or `~/.claude/.credentials.json` on other platforms).

**3. That's it** — `claude-check` will detect the credentials automatically on the next run.

### Not using Claude Code?

No problem. Pass your remaining limit manually with `--limit`:

```bash
claude-check --limit 35 "your prompt"
```

Your usage percentage is shown on your [claude.ai](https://claude.ai) dashboard.

---

## How the verdict works

The safe/caution/do-not-start verdict accounts for three factors:

1. **Your remaining %** — raw usage left on your plan
2. **Your plan tier** — a Max 20x user at 20% remaining has far more absolute capacity than a Pro user at 20%
3. **The recommended model** — Opus tasks consume more of your limit per message than Haiku tasks, so the threshold adjusts accordingly

Your plan is set during `claude-check setup` and remembered for all future runs. You can override it for a single run with `--plan max5` (or `max20`, `pro`).

---

## Constraints & caveats

**Verdicts are estimates, not guarantees.** The analysis is done by an AI model (Claude Haiku by default). It does not execute your code, read your files, or know anything about your project beyond what you write in the prompt. Complexity scores, message estimates, and interrupt risk ratings are best-effort guesses based on the prompt text alone. Use them as a sanity check, not a contract.

**You need a separate Anthropic API key.** `claude-check` does not run on your claude.ai subscription — it calls the Anthropic API directly using your own key. This is a separate billing system. The tradeoff is intentional: running a pre-check on the API costs fractions of a cent (Haiku is the cheapest Claude model at roughly $0.001 per analysis), which is a small price compared to burning 30% of your weekly subscription limit on a task that gets cut off and leaves you with nothing. The API key is free to create and you only pay for what you use.

**Usage auto-fetch only works with Claude Code.** The automatic limit detection reads credentials written by the [Claude Code](https://claude.ai/code) CLI. If you don't have Claude Code installed, you'll need to pass `--limit <number>` manually. The usage percentage shown reflects your claude.ai subscription, which is a different limit from your Anthropic API usage.

**Very long prompts are truncated.** Prompts over 20,000 characters are cut before being sent for analysis. In practice this limit is never hit by a normal claude.ai prompt — it exists only as a guard against accidentally piping a large file or codebase. A truncation notice is shown in the output when this occurs.

**Model cost weights are estimates.** The plan/model verdict logic uses approximate relative costs for Haiku, Sonnet, and Opus on the claude.ai subscription. Anthropic does not publish exact internal usage ratios, so the thresholds are calibrated conservatively rather than precisely.

---

## Privacy

`claude-check` sends your prompt **only** to `api.anthropic.com` using your own API key. Nothing is logged, stored, or sent to any third party. The tool has no backend. See the source: [github.com/fayzan123/claude-check](https://github.com/fayzan123/claude-check).

---

## License

MIT
