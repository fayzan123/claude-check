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

This walks you through three questions and saves your config locally. You only need to do this once.

Your API key is stored only on your machine using [`conf`](https://github.com/sindresorhus/conf) (a standard local config library). It is never sent anywhere except directly to `api.anthropic.com` when you run an analysis.

```
An Anthropic API key is required to run analyses.
Get one at: https://console.anthropic.com

Your key is stored locally on this machine only.
It is never sent anywhere except directly to api.anthropic.com when you run an analysis.

Enter your Anthropic API key: sk-ant-...

Your claude.ai plan:
  1. Pro (default)
  2. Max 5x
  3. Max 20x

Enter plan [1]: 2

Analysis model:
  1. Haiku (default) — fast and cheap (~$0.001/run). Accurate for most prompts.
  2. Sonnet — higher accuracy on complex or nuanced prompts (~$0.01/run).
     Use this if you find Haiku verdicts are consistently off for your tasks.
     You can also override per-run with --model.

Enter model [1]: 1

API key saved. Plan set to: Max 5x. Model set to: Haiku (fast).
```

Your plan tier is used to calibrate the safe/caution/do-not-start verdict — a Max 20x user at 20% remaining has far more absolute capacity than a Pro user at 20%. You can change it at any time by re-running `claude-check setup` or passing `--plan` on any run.

If you have [Claude Code](https://claude.ai/code) installed, `claude-check` will automatically detect your credentials and fetch your claude.ai usage limits — no `--limit` flag needed.

---

## Quick config changes

Change just your plan or model without re-running the full setup:

```bash
claude-check plan    # interactive picker
claude-check model   # interactive picker
```

Or pass the value directly to skip the prompt:

```bash
claude-check plan pro      # switch to Pro
claude-check plan max5     # switch to Max 5x
claude-check plan max20    # switch to Max 20x

claude-check model haiku   # use Haiku (~$0.001/run)
claude-check model sonnet  # use Sonnet (~$0.01/run)
```

---

## Check your configuration

```bash
claude-check status
```

Shows your current API key (masked), plan, analysis model, and whether Claude Code usage auto-fetch is active:

```
API key:        sk-ant-api0...a1b2 ✓
Plan:           Max 5x
Analysis model: Haiku (fast)
Claude Code:    detected — usage auto-fetch active (42% of weekly limit used)
```

If no key is configured, you'll see `not set — run claude-check setup` instead.

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
╭─ claude-check ───────────────────────────────────────────────────────────╮
│                                                                           │
│  Complexity:        HIGH                                                  │
│  Est. messages:     8–12                                                  │
│  Interrupt risk:    HIGH — partial refactor = broken code                 │
│  Session context:   Turn 32 · 18 files · 1 compact                       │
│                                                                           │
│  Recommended model: claude-sonnet-4-6                                     │
│  Reason:            Multi-file code task needs reasoning                  │
│                                                                           │
│  ✗  18% weekly · 12% session (Max 5x): Do not start                      │
│     Wait for your limit to reset before running this.                     │
│                                                                           │
│  Safer breakdown:                                                         │
│    1. Rename files and update imports first                               │
│    2. Add TypeScript types file by file                                   │
│    3. Write tests as a separate task                                      │
│                                                                           │
╰───────────────────────────────────────────────────────────────────────────╯
```

---

## Flags

| Flag | Description |
|------|-------------|
| `--limit <number>` | Your remaining claude.ai usage as a percentage (e.g. `--limit 20`). Auto-fetched if Claude Code is installed. |
| `--plan <plan>` | Override your plan for this run only: `pro`, `max5`, `max20`, or a numeric multiplier. Use `claude-check plan` to save permanently. |
| `--breakdown` | Always show the safer breakdown, even when the verdict is not `do-not-start` |
| `--json` | Output raw JSON instead of formatted terminal output |
| `--no-color` | Plain text output, no terminal colours |
| `--model <model>` | Override which Claude model is used for the analysis call (default: `claude-haiku-4-5`) |
| `--debug` | Print diagnostic info about usage auto-fetch (credentials found, HTTP status, cache hits) |

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

The safe/caution/do-not-start verdict accounts for four factors:

1. **Your weekly remaining %** — raw usage left on your 7-day plan window
2. **Your session remaining %** — usage left in the current 5-hour window (fetched automatically if Claude Code is installed). Session limits are smaller in absolute terms, so the verdict applies stricter thresholds here — a task that uses 20% of your weekly budget uses a much larger fraction of your session budget
3. **Your plan tier** — a Max 20x user at 20% remaining has far more absolute capacity than a Pro user at 20%
4. **The recommended model** — Opus tasks consume more of your limit per message than Haiku tasks, so the threshold adjusts accordingly

The verdict uses the more conservative of your weekly and session constraints. If either window is close to exhausted, you'll get a `do-not-start` even if the other window looks healthy.

Your plan is set during `claude-check setup` and remembered for all future runs. You can override it for a single run with `--plan max5` (or `max20`, `pro`).

---

## Session context awareness

When Claude Code is open in the same project directory, `claude-check` reads your active session to make the complexity estimate more accurate. A prompt like "now add tests for all of that" means something completely different at turn 2 of a fresh session versus turn 30 of a session where 20 files have already been modified.

### What it reads

Claude Code stores every session as a log file at `~/.claude/projects/{your-project}/`. `claude-check` reads the most recently active session for the current directory and extracts three signals:

| Signal | What it measures |
|--------|-----------------|
| **Turn count** | How many real prompts you've sent in this session (tool call results don't count) |
| **Distinct files touched** | How many unique files have been modified via Claude Code in this session |
| **Compact count** | How many times `/compact` has been run — each compact signals the session was long and heavy enough to require a history summary |

### How it affects the verdict

These signals apply post-analysis modifiers to the API result:

- High turn count → message estimate increases; interrupt risk escalates
- Many files touched → same escalation (broad surface area = more messages to complete safely)
- Compact events → boost to effective turn count (1 compact ≈ 20 turns of erased history; 2+ ≈ 40)
- Prior task interrupted → interrupt risk escalates specifically

Modifiers only escalate — they never lower a rating the API already returned. If the prompt is genuinely simple, a high turn count will push interrupt risk up but won't invent complexity that isn't there.

### How detection works

`claude-check` checks whether a session file for the current directory was modified within the last 4 hours. If yes, it reads and uses the session. If not (Claude Code is closed or you're in a different project), session context is silently skipped and the output is identical to a run without session data — **zero regression for users without Claude Code**.

### Known limitations

- **Turn and file counts reflect only the most recent activity.** For very large sessions (>500 KB of log data), only the tail is read. In practice, the compact count compensates: a session large enough to truncate the tail will have had at least one compact event, which already triggers aggressive escalation.
- **Session context is per-project-directory.** It only activates when you run `claude-check` from the same directory Claude Code is open in.
- **No context from other AI tools.** Only Claude Code sessions are read. Cursor, Copilot, and other editors are not detected.

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
