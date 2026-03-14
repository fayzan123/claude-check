# SESSION_CONTEXT_PLAN.md
# Session-Aware Verdicts for claude-check

**Status:** Design plan — no code changed.
**Target version:** v1.2.0
**Author:** Autonomous Optimization Architect
**Date:** 2026-03-13

---

## 0. Framing: What This Feature Is Actually Solving

claude-check verdicts are about whether a task will consume enough claude.ai usage
(weekly/session plan limits) to risk a hard cutoff mid-task. The verdict lives entirely
in the domain of **plan usage budget** — not context window management.

Session context is useful here for one reason only: it tells us how complex the incoming
prompt actually is, in practice, given what is already in progress. That complexity
estimate feeds `estimated_messages_min/max` and `interrupt_risk`, which in turn feed
`computeVerdict`.

A prompt like "now add tests for all of that" is ambiguous in isolation. Against a cold
session it might be 3 messages. Against turn 30 of a session where 20 files have already
been modified it is materially more expensive — the task Claude is completing is larger,
more context is live in the request, and the chance of needing to continue across a
usage cutoff is higher.

**What session context enables:** more accurate complexity estimates → better verdicts
against the usage limit.

**What session context does NOT address:**
- Token counts in the JSONL
- Context window fill percentage or pressure
- Compact boundary events as a token-pressure signal
- Whether the context window will overflow

These are orthogonal to plan usage limits. They are not inputs to this feature.

---

## 1. What the Research Actually Found

### 1.1 Claude Code Local Storage — Confirmed Paths

All paths confirmed by direct filesystem inspection on a live macOS installation
running Claude Code v2.1.72.

```
~/.claude/
  settings.json                     # Sparse user prefs (e.g. skipDangerousModePermissionPrompt)
  history.jsonl                     # Slash-command history: display text + sessionId + project cwd
  stats-cache.json                  # Aggregate lifetime stats: dailyActivity, modelUsage, totalSessions
  mcp-needs-auth-cache.json         # MCP auth state — not relevant here
  .credentials.json                 # OAuth tokens on Linux/Windows (absent on macOS — keychain used)
  projects/
    {encoded-cwd}/                  # One directory per project. Encoding = cwd.replace('/', '-')
      {session-uuid}.jsonl          # One file per session. All events appended as newline-delimited JSON.
      {session-uuid}/               # Sub-directory for tool result blobs (not needed here)
  session-env/
    {session-uuid}                  # Raw shell environment dump for that session (binary/text)
  shell-snapshots/
    snapshot-{shell}-{ts}-{id}.sh   # Full shell function/alias state at session start
  todos/
    {session-uuid}-agent-{uuid}.json
  plans/, agents/, debug/, telemetry/, ...
```

**Credential storage (macOS):**
macOS Keychain entry, service name `Claude Code-credentials`, stores a JSON blob:
```json
{
  "claudeAiOauth": {
    "accessToken": "...",
    "refreshToken": "...",
    "expiresAt": 1234567890000
  },
  "organizationUuid": "..."
}
```
This is already read by `src/usage.ts` via `readClaudeCredentials()`.

### 1.2 The Session JSONL — Verified Schema

Each line in `{session-uuid}.jsonl` is an independent JSON object. The `type` field
determines the shape. Confirmed event types and frequencies (from the current
claude-check project session, 2087 lines, 53-hour multi-day session):

| type | count | what it is |
|---|---|---|
| `progress` | 963 | Streaming token deltas and hook events — not useful for our purposes |
| `assistant` | 553 | One entry per API response chunk. Contains `message.model`, `message.usage`, `message.stop_reason` |
| `user` | 353 | Human turns and tool results. `isMeta: true` entries are injected IDE context, not real user input |
| `queue-operation` | 116 | Internal task queue bookkeeping |
| `file-history-snapshot` | 95 | File state checkpoints — useful for distinct-files-touched signal |
| `last-prompt` | 4 | Snapshot of the most recent prompt text |
| `system` | 3 | Compact boundary events and session metadata |

**Key fields on `assistant` entries (completed turns only — where `stop_reason` is not null):**
```jsonc
{
  "type": "assistant",
  "timestamp": "2026-03-13T12:02:03.912Z",
  "sessionId": "31c35285-...",
  "cwd": "/Users/fayzanmalik/Documents/GitHub/claude-check",
  "gitBranch": "main",
  "version": "2.1.72",
  "isSidechain": false,
  "message": {
    "model": "claude-sonnet-4-6",
    "stop_reason": "tool_use",   // null on streaming chunks; only final has a real stop_reason
    "usage": {
      "input_tokens": 3,
      "cache_creation_input_tokens": 1042,
      "cache_read_input_tokens": 30740,
      "output_tokens": 453
    }
  }
}
```

**Key fields on `user` entries (real prompts only — `isMeta: false`):**
```jsonc
{
  "type": "user",
  "isMeta": false,
  "timestamp": "...",
  "message": {
    "role": "user",
    "content": "now add tests for all of that"
  }
}
```

Tool result turns have `content` as an array containing objects with
`"type": "tool_result"`. These must be excluded from the real turn count.

**Key fields on `user` entries that are tool results:**
```jsonc
{
  "type": "user",
  "isMeta": false,
  "message": {
    "role": "user",
    "content": [{ "type": "tool_result", "tool_use_id": "...", "content": "..." }]
  }
}
```

**Key fields on `file-history-snapshot` entries:**
```jsonc
{
  "type": "file-history-snapshot",
  "timestamp": "...",
  "files": [
    { "path": "/Users/.../src/session.ts", "operation": "write" },
    { "path": "/Users/.../src/index.ts",   "operation": "write" }
  ]
}
```
The `files` array contains the paths modified during the turn that triggered this
snapshot. Collecting all unique paths across all snapshots gives `distinctFilesTouched`.

**Key fields on `system` compact boundary entries:**
```jsonc
{
  "type": "system",
  "subtype": "compact_boundary",
  "timestamp": "2026-03-11T07:47:23.544Z",
  "compactMetadata": {
    "trigger": "manual",
    "preTokens": 146924
  }
}
```
A compact event signals that the session was long and heavy enough to require
compaction. The token data in `compactMetadata` is not used — only the presence and
count of compact events matter, as a proxy for session work volume.

### 1.3 Environment Variables Set by Claude Code

Confirmed present in all subprocesses spawned from a Claude Code terminal:

| Variable | Value observed | Meaning |
|---|---|---|
| `CLAUDECODE` | `1` | Primary detection signal — always present |
| `CLAUDE_CODE_ENTRYPOINT` | `claude-vscode` or `cli` | How Claude Code was launched |
| `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` | `true` | SDK flag — not relevant |
| `CLAUDE_AGENT_SDK_VERSION` | `0.2.74` | SDK version string |

There is NO `SESSION_ID` environment variable. The active session must be identified
by finding the most recently modified `.jsonl` under the project directory.

**No session ID env var is a design constraint.** Identifying the "active" session
is done by mtime heuristic (confirmed reliable: the active session's file is updated
continuously as tool calls stream in).

### 1.4 Project Directory Encoding

Claude Code encodes the working directory path to a flat directory name by replacing
every `/` with `-`. This is a simple string replace, not URL-encoding or base64.

```
cwd:     /Users/alice/projects/my-app
encoded: -Users-alice-projects-my-app
path:    ~/.claude/projects/-Users-alice-projects-my-app/
```

This is exact — confirmed by comparing the live filesystem against `process.cwd()`.

### 1.5 File Locking

The JSONL file is **not exclusively locked** while Claude Code is running. A parallel
`fs.readFileSync` or streaming read succeeds immediately. This was confirmed by reading
the active session file mid-conversation. No advisory lock, flock, or exclusive open
was observed.

### 1.6 File Sizes

A heavy 53-hour session (553 completed assistant turns, 3 compact events) produces a
4.4 MB JSONL file. A tail-read of the last 200 KB parses in ~50ms including Python
interpreter startup. A Node.js implementation will be faster.

A fresh session (6 completed turns) produces ~56 KB.

### 1.7 Stats Cache

`~/.claude/stats-cache.json` is a pre-aggregated lifetime stats file. It does NOT
contain per-session signals useful for complexity estimation. It contains daily
`messageCount`, `toolCallCount`, and aggregate `modelUsage` (all-time). Not suitable
as the session signal source.

### 1.8 What Is NOT Available Locally

The following are not readable from disk without an API call:

- Real-time rate limit state (requires the `getAutoUsage()` OAuth call already in `usage.ts`)
- Whether the current Claude Code session is still "open" vs. abandoned

---

## 2. Session State Schema

The new module `src/session.ts` reads the JSONL and returns this shape.
Every field is derived from data confirmed readable above. Nothing speculative.

```typescript
export interface SessionContext {
  // Was any session data found at all?
  available: boolean;

  // How many real human prompts have been sent in this session (excluding tool
  // results, isMeta entries, and injected IDE context).
  turnCount: number;

  // Number of distinct file paths that appear in file-history-snapshot entries
  // across this session. Represents the breadth of work already in progress.
  // A high number means many files are in play — "now add tests for all of that"
  // is much more expensive when distinctFilesTouched is 20 than when it is 2.
  distinctFilesTouched: number;

  // Whether there is evidence of a prior interrupted or failed task in this session.
  // Derived from: assistant entries where stop_reason is 'end_turn' preceded by
  // a tool_use block that has no matching tool_result in the following user turn
  // (i.e. the user interrupted mid-tool), OR queue-operation entries with a
  // failed/cancelled status if the schema exposes that.
  // When true, the current prompt may be attempting to recover or clean up from a
  // partial edit — which is inherently more expensive than a fresh task.
  priorTaskInterrupted: boolean;

  // Number of /compact events (subtype: compact_boundary) in this session.
  // Each compact signals the session was long and work-heavy enough to require it.
  // A session with 2 compacts has done substantially more work than a fresh session
  // even if the turn count since the last compact is low.
  compactCount: number;

  // Model names used in this session (from message.model on completed assistant turns).
  // E.g. ["claude-sonnet-4-6", "claude-opus-4-6"]
  modelsUsed: string[];

  // Session wall-clock age in hours, derived from first and last timestamps.
  sessionAgeHours: number;

  // UUID of the session file this was derived from (for cache-key purposes).
  sessionId: string;
}
```

**Default (unavailable) value:**
```typescript
const EMPTY_SESSION: SessionContext = {
  available: false,
  turnCount: 0,
  distinctFilesTouched: 0,
  priorTaskInterrupted: false,
  compactCount: 0,
  modelsUsed: [],
  sessionAgeHours: 0,
  sessionId: '',
};
```

When `available: false`, no scoring adjustments are applied. Zero regression.

**Fields intentionally omitted:**
- `peakContextTokens`, `contextPressure` — context window fill is not a plan usage
  signal. Excluded on framing grounds. The JSONL contains this data but it is not
  relevant to the verdict.
- `lastPromptText` — readable from `last-prompt` entries, but injecting prior prompt
  content into the meta-prompt creates prompt injection surface. The last prompt might
  itself contain adversarial instructions. Excluded on security grounds.
- `gitBranch` — readable but does not meaningfully affect complexity scoring.
- `sessionPct` from the OAuth API — this already exists in the codebase as
  `UsageSnapshot.sessionPct`. Not duplicated here.

---

## 3. Complexity Modifier Table

The `analysePrompt` pipeline currently returns an `AnalysisResult` from the API.
Session signals modify the output **after** the API call returns, before the result
is passed to `display.ts` and `computeVerdict`. No session data enters the meta-prompt
or the API call.

All modifiers only escalate — they never reduce a rating returned by the API.
When multiple modifiers would apply simultaneously, the most severe result wins.
No additive stacking.

### 3.1 Turn Count Modifier

High turn count means the user is mid-flow on a complex task. A prompt like
"now add tests for all of that" is ambiguous in isolation but signals substantial
additional work at turn 30 — work that will consume claude.ai messages on top of
the 30 already spent this session.

| turnCount range | Effect on `estimated_messages_min/max` | Effect on `interrupt_risk` |
|---|---|---|
| 0 – 9 | None | None |
| 10 – 24 | +1 to both min and max | Escalate LOW to MEDIUM |
| 25 – 49 | +2 to both min and max | Escalate LOW to MEDIUM, MEDIUM to HIGH |
| 50+ | +3 to both min and max | Escalate to HIGH unconditionally |

Rationale: At turn 50+, any additional task is extending a large compound task.
The session has already committed substantial budget. Even a "simple" add-tests prompt
at turn 50 is not simple from the usage-limit perspective.

### 3.2 Distinct Files Touched Modifier

The number of distinct files already modified this session measures the actual scope
of ongoing work. When many files are in play, follow-on prompts ("refactor that",
"add tests", "fix the types") touch a broader surface and require more messages to
complete safely.

| distinctFilesTouched | Effect on `estimated_messages_min/max` | Effect on `interrupt_risk` |
|---|---|---|
| 0 – 4 | None | None |
| 5 – 14 | +1 to both min and max | Escalate LOW to MEDIUM |
| 15 – 29 | +2 to both min and max | Escalate LOW to MEDIUM, MEDIUM to HIGH |
| 30+ | +3 to both min and max | Escalate to HIGH unconditionally |

Rationale: 30+ distinct files in a single session means a large-scale refactor or
feature is underway. Any incremental prompt in that session carries elevated message
cost because Claude must reason about a wide dependency graph.

### 3.3 Prior Task Interrupted Modifier

When there is evidence that a previous task in this session was interrupted mid-run
(tool call started but no result returned, or user cancelled), the current prompt may
be a recovery or cleanup attempt. Recovery tasks are structurally more expensive: Claude
must re-read partial state, decide what to redo, and handle inconsistencies.

| priorTaskInterrupted | Effect on `interrupt_risk` | Effect on `interrupt_risk_reason` |
|---|---|---|
| false | None | None |
| true | Escalate LOW to MEDIUM; escalate MEDIUM to HIGH | Append ": prior task was interrupted — recovery work is costlier" |

This modifier does not affect `estimated_messages_min/max` directly — the API estimate
already accounts for what the prompt itself requires. The escalation is to interrupt
risk specifically, because a recovery session is more likely to hit the usage limit
mid-run again.

### 3.4 Compact Count Modifier

Each compact event signals the session was long and work-heavy enough to require
compaction. After compacting, the current turn count since the last compact may look
low, but the user is clearly in a large, sustained task.

The compact count is used to amplify the turn count modifier: when compacts are
present, the effective turn count for modifier purposes is boosted by a fixed offset.
The actual displayed `turnCount` is not changed — only the modifier threshold lookup
uses the boosted value.

| compactCount | Effective turn count boost for modifier lookup |
|---|---|
| 0 | No boost |
| 1 | +20 to effective turn count |
| 2+ | +40 to effective turn count |

Example: if the current session shows 8 turns since the last compact but has 2 compact
events, the effective turn count for the modifier table is 8 + 40 = 48, which falls
into the 25–49 range and triggers +2 to message estimates.

Rationale: a session with 2 compacts and 8 current turns represents substantially more
total work than a fresh 8-turn session. The compact count makes the escalation table
sensitive to the full session history, not just the post-compact slice.

### 3.5 Combined Priority

When multiple modifiers would apply simultaneously, the most severe result wins.
No additive stacking of interrupt_risk levels. If turn count pushes `interrupt_risk`
to HIGH and files touched independently pushes it to HIGH, the result is HIGH once.

For `estimated_messages_min/max`, the addends from each modifier (3.1 and 3.2) are
summed, but capped: the total addend must not exceed +4 to either bound regardless
of how many modifiers fire. This prevents unrealistic message estimates on sessions
where all signals are high simultaneously.

### 3.6 Modifier Floor

Modifiers only escalate. If the API returns HIGH complexity, nothing in the session
context can lower it to MEDIUM. If the API returns MEDIUM interrupt_risk, session
modifiers can only move it to HIGH — never to LOW.

---

## 4. Prompt Enrichment

The session context does NOT enter the API prompt. This is a deliberate constraint.

**Reasoning:**
1. The meta-prompt already has `max_tokens: 512`. Adding session context tokens
   costs money on every run and the spec demands token efficiency as a first-class concern.
2. The LLM is not needed to interpret session signals — the modifier table in section 3
   is fully deterministic. LLM judgment is not superior to a lookup table for
   "30 files touched escalates interrupt_risk one level."
3. Passing the last prompt text into the API prompt is a prompt injection vector (see
   security note in section 2).

**What "prompt enrichment" looks like instead:**

The enrichment is in the `interrupt_risk_reason` and `recommended_model_reason` strings
that `session.ts` overwrites on the result object post-API-call. These strings are what
the user reads in the terminal output. Here is the before/after for two representative
cases.

**Case A: "now add tests for all of that" at turn 32, distinctFilesTouched = 18**

Before (API output alone):
```json
{
  "complexity": "LOW",
  "estimated_messages_min": 2,
  "estimated_messages_max": 4,
  "interrupt_risk": "LOW",
  "interrupt_risk_reason": "Additive task, no destructive operations",
  "recommended_model": "claude-haiku-4-5",
  "recommended_model_reason": "Simple additive task, fast response"
}
```

After (session modifiers applied):
```json
{
  "complexity": "LOW",
  "estimated_messages_min": 5,
  "estimated_messages_max": 8,
  "interrupt_risk": "HIGH",
  "interrupt_risk_reason": "Turn 32, 18 files in play — usage budget already committed",
  "recommended_model": "claude-haiku-4-5",
  "recommended_model_reason": "Simple additive task, fast response"
}
```

Turn count is in the 25–49 range (+2 to estimates, escalates LOW to MEDIUM then MEDIUM
to HIGH). Files touched is in the 15–29 range (+2 to estimates, escalates LOW to MEDIUM).
Combined: the more severe interrupt_risk (HIGH from turn count) wins, and estimate
addends sum to +3 (capped below +4). Model recommendation is unchanged — Haiku is
correct for the task content; the budget signal is surfaced via interrupt_risk.

**Case B: "fix the failing tests" at turn 6, priorTaskInterrupted = true, distinctFilesTouched = 2**

Before:
```json
{
  "complexity": "LOW",
  "estimated_messages_min": 1,
  "estimated_messages_max": 3,
  "interrupt_risk": "LOW",
  "interrupt_risk_reason": "Targeted fix, small scope",
  "recommended_model": "claude-haiku-4-5",
  "recommended_model_reason": "Simple fix, fast response"
}
```

After:
```json
{
  "complexity": "LOW",
  "estimated_messages_min": 1,
  "estimated_messages_max": 3,
  "interrupt_risk": "MEDIUM",
  "interrupt_risk_reason": "Targeted fix, small scope: prior task was interrupted — recovery work is costlier",
  "recommended_model": "claude-haiku-4-5",
  "recommended_model_reason": "Simple fix, fast response"
}
```

Only the prior-interrupted modifier fires. Message estimates are unchanged (the task
scope is genuinely small). interrupt_risk escalates from LOW to MEDIUM.

---

## 5. File-by-File Change Map

### NEW: `src/session.ts`

Entirely new module. Responsible for:
1. Detecting whether Claude Code is running (`CLAUDECODE` env var).
2. Locating the active session JSONL (CWD to encoded project dir to most recent .jsonl by mtime).
3. Tail-reading (last 500 KB) and parsing the JSONL.
4. Computing and returning `SessionContext`.
5. Caching the result in memory for the duration of a single `claude-check` invocation
   (one run = one read; no cross-invocation cache needed since session.ts is stateless).

Key function signatures:
```typescript
export function detectClaudeCodeSession(): boolean
export async function readSessionContext(cwd?: string): Promise<SessionContext>
export function applySessionModifiers(
  result: AnalysisResult,
  session: SessionContext
): AnalysisResult
```

`applySessionModifiers` is a pure function. Given `AnalysisResult` and `SessionContext`,
it returns a new `AnalysisResult` with modifiers applied. It does not mutate the input.

Error contract: any filesystem error, parse error, or unexpected shape results in
returning `EMPTY_SESSION` (the zero-value) and logging to stderr only if `--debug` is
passed. No thrown exceptions propagate to the caller.

### MODIFIED: `src/analyse.ts`

No changes to `analysePrompt()` itself. One new import and one new call site.

After `analysePrompt` returns and before the result is passed to `renderResult`,
call `applySessionModifiers(result, session)`. The session is passed in as a parameter
(not fetched inside `analyse.ts`) so the function remains pure and testable.

No API call changes. No prompt changes. No `max_tokens` changes.

### MODIFIED: `src/index.ts`

Three additions:

1. Import `readSessionContext` and `applySessionModifiers` from `./session.js`.
2. Before the spinner starts, call `readSessionContext()` — it is fast (< 100ms on
   a 5 MB file due to tail-read) and does not need to be behind the spinner.
3. After `analysePrompt` returns, call `applySessionModifiers(result, session)` and
   use the returned value everywhere downstream (JSON output, `renderResult`).

When `--json` output is requested, add `session_context` to the JSON output blob:
```jsonc
{
  // ... existing fields ...
  "session_context": {
    "available": true,
    "turn_count": 32,
    "distinct_files_touched": 18,
    "prior_task_interrupted": false,
    "compact_count": 0,
    "session_age_hours": 4.1
  }
}
```

If `session.available === false`, emit `"session_context": null`.

### MODIFIED: `src/display.ts`

One addition only: when `SessionContext` is passed and `session.available === true`,
append a single line to the output box below the interrupt risk line:

```
Session context:   Turn 32 · 18 files · 0 compacts
```

This line is omitted entirely when `session.available === false`. No layout changes
to existing fields. The line is always plain text (no chalk colouring needed — it
is informational, not a verdict).

Add `sessionContext?: SessionContext` to `DisplayOptions`.

### MODIFIED: `src/config.ts`

No changes needed. Session context is ephemeral (not persisted). The existing `conf`
store already handles usage caching. Session state is read fresh on every invocation
and is never written back. This is correct: the JSONL is the source of truth.

**Decision: session state does NOT go in conf storage.**
The conf store is for user preferences and API cache (things that should survive
across invocations and machine restarts). Session state is tied to a specific live
Claude Code session. Persisting it to conf would require invalidation logic (TTL,
session ID check) that adds complexity with no benefit — the JSONL read is cheap enough
to do fresh every time.

### NOT MODIFIED: `src/prompts.ts`, `src/models.ts`

No changes. The meta-prompt does not change. Model thresholds do not change.

### MODIFIED: `src/__tests__/` — new file `session.test.ts`

Unit tests for:
- `detectClaudeCodeSession()`: true when `CLAUDECODE=1` is set, false otherwise.
- `applySessionModifiers()`: table-driven tests covering all escalation branches,
  including the compact-count boost to effective turn count.
  Uses synthetic `SessionContext` objects — no filesystem reads required.
- JSONL parsing: test with synthetic JSONL strings exercising all edge cases
  (isMeta filtering, tool result filtering, null stop_reason filtering,
  file-history-snapshot path deduplication, prior-interrupted detection).

No integration tests that read real `~/.claude/` data. Tests must pass on CI where
`CLAUDECODE` is unset and `~/.claude/` does not exist.

---

## 6. Graceful Degradation

This is the most important constraint: users who do not use Claude Code must experience
zero change in behavior.

### Detection gate

```typescript
if (process.env.CLAUDECODE !== '1') {
  return EMPTY_SESSION; // available: false
}
```

This is the outermost check. If `CLAUDECODE` is not set, no filesystem access is
attempted, no errors can occur, and the returned session context has `available: false`.
All downstream code checks `session.available` before applying anything.

### Filesystem failures

If `CLAUDECODE=1` is set but the project directory does not exist (possible if the
user is running Claude Code but has never used it in this directory):

```typescript
if (!projectDir.exists()) return EMPTY_SESSION;
if (files.length === 0) return EMPTY_SESSION;
```

If the JSONL file exists but cannot be read (permissions, corruption, concurrent write
collision):

```typescript
try {
  // parse...
} catch {
  return EMPTY_SESSION;
}
```

### Parse failures

Individual malformed JSONL lines are silently skipped. A single corrupt line does not
abort the read. The parser collects what it can and returns a `SessionContext` with
whatever was successfully parsed.

### Maximum read limit

The tail-read is capped at 500 KB. For a 4.4 MB file, this covers approximately the
last 200 lines. For `turnCount` and `distinctFilesTouched`, a tail-read may miss events
from early in a very long session. This is an acceptable trade-off: the signals from
recent turns are the most relevant to the current prompt's complexity, and the compact
count (derived from `system` entries, which are infrequent) will be present in the tail
if compaction happened recently. If compaction happened early and there are many turns
since, the turn count alone will trigger appropriate escalation.

### Timeout

The session read does not make any network call. The worst case is reading 500 KB from
a local SSD, which is under 10ms. No timeout is needed, but if this ever blocks (e.g.
network-mounted home directory — unusual but possible), the `readSessionContext` call
must be wrapped with a 500ms wall-clock timeout in `index.ts` using `Promise.race`.

### Output change

When `session.available === false`, the output box is byte-for-byte identical to the
current v1.1.3 output. The "Session context" line is only appended when
`session.available === true`. Existing tests must continue to pass unchanged.

---

## 7. Phased Implementation

### Phase 1 — Read and expose, no scoring changes (scope: ~4 hours)

1. Create `src/session.ts` with `detectClaudeCodeSession`, `readSessionContext`.
   Hard-code `applySessionModifiers` as identity function (returns input unchanged).
2. Integrate into `index.ts`: read session, pass to `renderResult`, append the
   "Session context: Turn X · Y files · Z compacts" line to display.
3. Add `session_context` field to `--json` output.
4. Write `src/__tests__/session.test.ts` covering detection and JSONL parsing only.

**Acceptance criteria:** Running `claude-check` inside a Claude Code session shows the
new session context line in the box. Running it outside Claude Code shows no new line.
All existing tests pass.

### Phase 2 — Apply scoring modifiers (scope: ~3 hours)

1. Implement `applySessionModifiers` with the full modifier table from section 3.
2. Add modifier tests to `session.test.ts` (table-driven, no filesystem).
3. Update the `--json` output to show which fields were modified by session context
   (add `session_modified: boolean` flag to JSON output for observability).

**Acceptance criteria:** At turn 32 with 18 files touched in a real Claude Code session,
a LOW complexity prompt is upgraded to HIGH interrupt_risk in the terminal output.
With `priorTaskInterrupted: true`, LOW interrupt_risk escalates to MEDIUM.
All modifier branches covered by tests.

### Phase 3 — Harden and document (scope: ~2 hours)

1. Add the 500ms timeout guard around `readSessionContext` in `index.ts`.
2. Wire `--debug` flag through to session.ts to print which JSONL file was read,
   parsed line count, and derived session signals (matching the debug style already
   used in `usage.ts`).
3. Update README with a one-paragraph description of session-aware scoring and the
   note that it activates automatically when Claude Code is detected.
4. Bump version to 1.2.0 in `package.json` and `index.ts`.

---

## 8. Open Questions and Risks

### 8.1 Session identity heuristic (medium risk)

The active session is identified by most-recently-modified `.jsonl` in the project
directory. This is a heuristic. Edge cases:

- **User has two Claude Code windows open on the same project simultaneously.** Both
  sessions write to the same project directory. The mtime winner is whichever received
  the most recent tool response. This is acceptable: both sessions share the same
  codebase context. Reading either session's stats is correct to within a few turns.

- **User ran claude-check immediately after closing a Claude Code session.** The
  most recent JSONL still belongs to the completed session. `sessionAgeHours` would
  be non-zero but could be large. Consider: if `lastTs` is more than 2 hours ago, treat
  as `available: false` because the session is likely stale. This threshold is
  speculative — needs real-world validation before hardcoding it.

- **No `CLAUDECODE` env var but `~/.claude/projects/{cwd}/` exists.** A past session
  left files. The `CLAUDECODE` env var gate prevents accidental reads in this case.
  Do not fall through to filesystem detection without the env var. The env var is the
  correct gate.

### 8.2 JSONL file locking during active write (low risk)

Confirmed: no locking. However, a tail-read during a period of rapid streaming (many
`progress` events per second) could encounter a partial final line. The JSON parser
must treat any line that fails to parse as silently skipped (confirmed in the design
above). This is safe because `progress` events are not used in our computation anyway.

### 8.3 Large session files (low risk)

A 50-hour session produced a 4.4 MB file and tail-read at 500 KB in ~50ms. A 200-hour
continuous session (theoretically possible on a Max plan) could produce a ~20 MB file.
The 500 KB tail cap means file size does not affect read performance. The only risk is
if `file-history-snapshot` entries from early in a very long session are not in the
tail. In this case, `distinctFilesTouched` will be an undercount. The compact count
and turn count signals will still reflect total session volume correctly via the boost
mechanism in section 3.4.

### 8.4 `file-history-snapshot` schema stability (medium risk)

The `files` array on `file-history-snapshot` entries is internal to Claude Code and
undocumented. If this field is renamed or restructured in a future Claude Code update,
`distinctFilesTouched` will silently fall back to 0, which causes no escalation and no
user-facing error. This is acceptable graceful degradation: the other signals (turn
count, compact count, prior interrupted) continue to function.

All field accesses must use optional chaining. Log a debug warning if no
`file-history-snapshot` entries are found in a file with > 50 lines (as this is
unexpected for a session with many tool calls).

### 8.5 JSONL schema stability (medium risk)

The JSONL schema is internal to Claude Code and undocumented. It has changed before
(the `stats-cache.json` has a `version: 2` field, implying a v1 existed). A Claude
Code update could rename fields, change the `type` taxonomy, or restructure entries.

Mitigation: all field accesses in `session.ts` must use optional chaining and nullish
coalescing. Never throw on missing fields. Log a debug warning if the schema looks
unexpected (e.g. if zero assistant entries are found in a file with > 100 lines).

### 8.6 Prior-interrupted detection reliability (medium risk, speculative)

The `priorTaskInterrupted` heuristic — looking for a tool_use in an assistant turn
with no subsequent tool_result in the following user turn — is derived from observed
JSONL structure and may have edge cases. If Claude Code's event ordering changes, or if
a tool_result appears in a later turn after other intermediate events, this detection
could produce false positives or false negatives.

False positive (interrupted flagged when it was not): the user sees MEDIUM instead of
LOW interrupt_risk for a clean session. Mild over-caution — acceptable.
False negative (interrupted not flagged when it was): the modifier does not fire. The
other modifiers (turn count, files touched) still apply. Acceptable.

This signal should be treated as best-effort. If the detection logic proves unreliable
in Phase 2 testing, remove `priorTaskInterrupted` from `SessionContext` without any
other changes — the remaining modifiers cover the important cases.

### 8.7 Windows path encoding (low risk)

On Windows, `cwd.replace('/', '-')` is wrong because Windows paths use backslash.
Claude Code's encoding on Windows should use `cwd.replace(/[/\\]/g, '-')`. This needs
verification on a Windows Claude Code installation before shipping. Mark as
platform-specific TODO.

### 8.8 The modifier table constants are opinions, not measurements (flagged speculative)

The thresholds in section 3 (e.g. "15 files touched escalates interrupt_risk one level")
are engineering judgment based on observed session patterns. They have not been
validated against a dataset of real sessions. Before finalizing Phase 2, it would be
worth running `claude-check --json --debug` against a sample of 20+ real sessions
across different projects and checking whether the escalations feel correct to the
users who ran those sessions. The table constants should be extracted into a named
`SESSION_MODIFIER_CONFIG` object in `session.ts` so they can be tuned without hunting
for magic numbers in conditionals.

---

## 9. Summary of New Signals and Their Source

| Signal | Source | How derived |
|---|---|---|
| `CLAUDECODE` env var | Process environment | `process.env.CLAUDECODE === '1'` |
| Project JSONL path | `process.cwd()` | `cwd.replace('/', '-')` to `~/.claude/projects/{encoded}/` |
| Active session file | Filesystem mtime | Most recently modified `.jsonl` in project dir |
| `turnCount` | JSONL `user` entries | Count `isMeta:false, message.role:'user'` entries where content is not a tool_result array |
| `distinctFilesTouched` | JSONL `file-history-snapshot` entries | Count of unique file paths across all `files` arrays in snapshot entries |
| `priorTaskInterrupted` | JSONL `assistant` + `user` entries | Detect tool_use in assistant turn with no matching tool_result in next user turn |
| `compactCount` | JSONL `system` entries | Count `subtype:'compact_boundary'` entries — signals heavy session work volume |
| `modelsUsed` | JSONL `assistant` entries | Unique `message.model` values on completed turns (stop_reason not null) |
| `sessionAgeHours` | JSONL timestamps | `(lastTs - firstTs) / 3600_000` |
