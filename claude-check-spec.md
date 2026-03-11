# claude-check — CLI Build Specification

> A CLI tool that analyses a prompt before you send it to Claude, estimating task complexity, usage cost, and recommending the most efficient model to use. Open source. Zero cost to maintain — users bring their own Anthropic API key.

---

## Project Overview

**Problem:** When users are running low on their Claude.ai usage limits, starting a complex task is risky — it can be cut off halfway through, leaving work incomplete. There is currently no way to know how "expensive" a task will be before running it.

**Solution:** A CLI tool called `claude-check` that accepts a prompt as input, sends it to the Anthropic API for meta-analysis, and returns a structured estimate of complexity, message cost, interrupt risk, and a recommended model — before the user commits to running the task.

**Key constraint:** The tool must be free to maintain as an open source project. There is no backend, no hosted service, and no cost to the maintainer. Users authenticate with their own Anthropic API key.

---

## Core Features

### 1. Complexity Analysis
Analyse the prompt and return:
- Complexity rating: `LOW`, `MEDIUM`, or `HIGH`
- Estimated number of Claude messages/replies needed to complete the task
- Interrupt risk if the task is cut off mid-way (e.g. a partial code refactor is worse than a partial summary)

### 2. Usage Limit Warning
- Accept an optional `--limit` flag where the user tells the tool how much of their limit remains (e.g. `--limit 20` for 20% remaining)
- If provided, give a clear recommendation: safe to proceed, proceed with caution, or do not start

### 3. Model Recommendation
Recommend the most efficient Claude model for the task based on complexity:
- `claude-haiku-4-5` — simple, fast, cheap tasks (Q&A, summaries, rewrites)
- `claude-sonnet-4-6` — moderate complexity (code tasks, analysis, structured output)
- `claude-opus-4-6` — high complexity, long reasoning, multi-step tasks

Explain briefly why that model is recommended.

### 4. Task Breakdown Suggestions
For MEDIUM and HIGH complexity tasks, suggest how to break the prompt into smaller, self-contained steps that are each safer to run independently.

---

## CLI Interface

### Basic usage
```bash
claude-check "refactor my entire Express app to use TypeScript and add tests"
```

### Pipe support
```bash
cat myprompt.txt | claude-check
```

### Flags
| Flag | Description |
|---|---|
| `--limit <number>` | Your remaining usage limit as a percentage (e.g. `--limit 20`) |
| `--breakdown` | Always show task breakdown suggestions, even for LOW complexity |
| `--json` | Output raw JSON instead of formatted terminal output |
| `--no-color` | Plain text output, no terminal colours |
| `--model <model>` | Override which Claude model to use for the analysis call |

### First-run setup
```bash
claude-check setup
```
Prompts the user for their Anthropic API key and saves it to a local config file (`~/.claude-check`). The key is never transmitted anywhere other than directly to `api.anthropic.com`.

### Example output
```
┌─ claude-check ────────────────────────────────────────┐
│                                                        │
│  Complexity:       HIGH                                │
│  Est. messages:    5–8                                 │
│  Interrupt risk:   HIGH — partial refactor = broken    │
│                                                        │
│  Recommended model: claude-sonnet-4-6                  │
│  Reason: Multi-file code task with structured output.  │
│          Sonnet handles this well without Opus cost.   │
│                                                        │
│  ⚠️  With 20% limit remaining: DO NOT START           │
│  Wait for your limit to reset before running this.     │
│                                                        │
│  Safer breakdown:                                      │
│   1. Rename files and update imports only (2–3 msgs)   │
│   2. Add TypeScript types incrementally (2–3 msgs)     │
│   3. Write tests as a separate task (2–3 msgs)         │
│                                                        │
└────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Language | TypeScript | Type safety, good SDK support, natural fit for CLI tooling |
| Runtime | Node.js (v18+) | Wide availability, `npm install -g` distribution |
| CLI framework | `commander` | Lightweight, well maintained, simple API |
| API | `@anthropic-ai/sdk` | Official Anthropic SDK |
| Terminal output | `chalk` + `boxen` | Coloured output and bordered boxes |
| Spinner | `ora` | Loading indicator while API call is in progress |
| Config storage | `conf` | Cross-platform config file for API key persistence |
| Package manager | `npm` | Standard, no extra tooling required |

---

## Project Structure

```
claude-check/
├── src/
│   ├── index.ts          # Entry point — CLI definition using commander
│   ├── analyse.ts        # Core logic — sends prompt to API, returns structured result
│   ├── display.ts        # Formats and renders terminal output
│   ├── config.ts         # API key read/write using conf
│   └── prompts.ts        # The meta-prompt template used for analysis
├── package.json
├── tsconfig.json
├── .gitignore
└── README.md
```

---

## The Meta-Prompt

This is the most critical piece of the tool. The meta-prompt is sent to the Anthropic API with the user's prompt as input. It must return structured JSON only — no preamble, no markdown formatting.

**Token efficiency is a first-class concern.** The meta-prompt must be as short as possible while still producing reliable structured output. Every token spent on the analysis call is a token the user isn't spending on their actual task.

### Prompt pre-processing (before sending to API)

Before inserting the user's prompt into the meta-prompt template, the tool must:

1. **Trim** leading and trailing whitespace
2. **Truncate to 500 characters maximum** — the analyser only needs to understand what *kind* of task it is, not read every detail of a long prompt
3. **Append `[truncated]`** if the prompt was cut, so the model knows it has partial context

```typescript
function preparePrompt(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= 500) return trimmed;
  return trimmed.slice(0, 500) + ' [truncated]';
}
```

### Meta-prompt template

Keep this prompt as terse as possible. Do not add explanations, examples, or field guidance — the model doesn't need them and they waste tokens.

```
Analyse this prompt. Reply with JSON only, no other text.

PROMPT: """{{USER_PROMPT}}"""

JSON fields:
- complexity: LOW|MEDIUM|HIGH
- estimated_messages_min: int
- estimated_messages_max: int
- interrupt_risk: LOW|MEDIUM|HIGH
- interrupt_risk_reason: string (max 10 words)
- recommended_model: claude-haiku-4-5|claude-sonnet-4-6|claude-opus-4-6
- recommended_model_reason: string (max 10 words)
- breakdown: array of max 4 strings (max 8 words each), or null if LOW complexity
```

### API call constraints

- **No system prompt** — fold everything into a single user message. A separate system parameter adds overhead.
- **`max_tokens: 300`** — the JSON response will never legitimately exceed this. Setting a hard cap prevents runaway output and signals the model to be concise.
- **Model: `claude-haiku-4-5`** — always use Haiku for the analysis call. It is fast, cheap, and fully capable of this meta-reasoning task. Never use Sonnet or Opus for the analysis itself.

```typescript
const response = await client.messages.create({
  model: 'claude-haiku-4-5',
  max_tokens: 300,
  messages: [{ role: 'user', content: metaPrompt }],
});
```

---

## Authentication

- Users must provide their own Anthropic API key
- The key is stored locally in `~/.claude-check` using the `conf` package
- It is passed directly to the Anthropic SDK — it never touches any server other than `api.anthropic.com`
- On first run without a saved key, the CLI should prompt the user to run `claude-check setup`
- Users can get an API key at: https://console.anthropic.com

### Config file location (managed by `conf`)
```
~/.config/claude-check/config.json   # Linux/macOS
%APPDATA%\claude-check\config.json   # Windows
```

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| No API key configured | Print a friendly message directing user to run `claude-check setup` |
| Invalid API key | Surface the Anthropic API error clearly |
| Empty prompt | Print usage instructions |
| API timeout | Show error and suggest retrying |
| Non-JSON response from API | Fallback: show raw response and note the analysis could not be parsed |
| No internet connection | Clear error message |

---

## npm Publishing

The tool should be published to npm so users can install it globally with:
```bash
npm install -g claude-check
```

### package.json requirements
- `"bin": { "claude-check": "./dist/index.js" }` — registers the CLI command
- `"files": ["dist"]` — only ship compiled output
- `"engines": { "node": ">=18" }` — minimum Node version
- Build step: `tsc` compiles `src/` to `dist/`

---

## Open Source Requirements

- Licence: **MIT**
- The README must clearly explain:
  - What the tool does
  - That users need their own Anthropic API key (link to console.anthropic.com)
  - How to install (`npm install -g claude-check`)
  - How to set up (`claude-check setup`)
  - All available commands and flags
- `.gitignore` must exclude any local config or `.env` files
- No hardcoded API keys anywhere in the codebase — this must be enforced with a note in CONTRIBUTING.md

---

## Build Order (Recommended)

1. Scaffold the project: `tsconfig.json`, `package.json`, folder structure
2. Implement `config.ts` — API key storage and retrieval
3. Implement `prompts.ts` — the meta-prompt template with `{{USER_PROMPT}}` substitution
4. Implement `analyse.ts` — call the Anthropic API, parse and return structured JSON
5. Implement `display.ts` — render the result in the terminal with chalk and boxen
6. Implement `index.ts` — wire up commander with all commands and flags
7. Add pipe support — detect when stdin has data and use it as the prompt
8. Add `claude-check setup` command
9. Handle all error cases
10. Write README
11. Compile and test `npm install -g .` locally
12. Publish to npm

---

## Future Ideas (Out of Scope for v1)

- `--history` flag to log past analyses locally
- Shell integration (zsh/bash prompt showing limit status)
- A companion browser extension that uses the same analysis logic inside claude.ai
- Support for estimating cost in API dollars, not just message count
- Interactive mode: paste a long prompt with multi-line support
