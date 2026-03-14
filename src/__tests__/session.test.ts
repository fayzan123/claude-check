import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectClaudeCodeSession,
  parseJsonl,
  applySessionModifiers,
  EMPTY_SESSION,
  SESSION_MODIFIER_CONFIG,
} from '../session.js';
import type { SessionContext } from '../session.js';
import type { AnalysisResult } from '../analyse.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    complexity: 'LOW',
    estimated_messages_min: 2,
    estimated_messages_max: 4,
    interrupt_risk: 'LOW',
    interrupt_risk_reason: 'Additive task, no destructive operations',
    recommended_model: 'claude-haiku-4-5',
    recommended_model_reason: 'Simple additive task, fast response',
    breakdown: null,
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    available: true,
    turnCount: 0,
    distinctFilesTouched: 0,
    priorTaskInterrupted: false,
    compactCount: 0,
    modelsUsed: [],
    sessionAgeHours: 0,
    sessionId: 'test-session',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// detectClaudeCodeSession
// ---------------------------------------------------------------------------

describe('detectClaudeCodeSession', () => {
  let originalEnv: string | undefined;

  before(() => {
    originalEnv = process.env['CLAUDECODE'];
  });

  after(() => {
    if (originalEnv === undefined) {
      delete process.env['CLAUDECODE'];
    } else {
      process.env['CLAUDECODE'] = originalEnv;
    }
  });

  test('returns true when CLAUDECODE=1', () => {
    process.env['CLAUDECODE'] = '1';
    assert.equal(detectClaudeCodeSession(), true);
  });

  test('returns false when CLAUDECODE is unset and no session file exists', () => {
    delete process.env['CLAUDECODE'];
    // Pass a nonexistent cwd so the filesystem fallback finds nothing
    assert.equal(detectClaudeCodeSession('/nonexistent/path/that/has/no/session'), false);
  });

  test('returns false when CLAUDECODE is not exactly "1" and no session file exists', () => {
    const fakeCwd = '/nonexistent/path/that/has/no/session';
    process.env['CLAUDECODE'] = 'true';
    assert.equal(detectClaudeCodeSession(fakeCwd), false);
    process.env['CLAUDECODE'] = '0';
    assert.equal(detectClaudeCodeSession(fakeCwd), false);
    process.env['CLAUDECODE'] = '';
    assert.equal(detectClaudeCodeSession(fakeCwd), false);
  });
});

// ---------------------------------------------------------------------------
// parseJsonl — synthetic JSONL strings
// ---------------------------------------------------------------------------

describe('parseJsonl — empty and malformed input', () => {
  test('empty string returns EMPTY_SESSION', () => {
    const ctx = parseJsonl('', 'sess-1');
    assert.equal(ctx.available, false);
    assert.equal(ctx.turnCount, 0);
  });

  test('whitespace-only string returns EMPTY_SESSION', () => {
    const ctx = parseJsonl('   \n  \n', 'sess-1');
    assert.equal(ctx.available, false);
  });

  test('single malformed line returns EMPTY_SESSION', () => {
    const ctx = parseJsonl('{not valid json}', 'sess-1');
    assert.equal(ctx.available, false);
  });

  test('mix of valid and malformed lines: malformed lines skipped', () => {
    const lines = [
      '{not valid}',
      JSON.stringify({ type: 'user', isMeta: false, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hello' } }),
      'also not valid',
    ].join('\n');
    const ctx = parseJsonl(lines, 'sess-1');
    assert.equal(ctx.available, true);
    assert.equal(ctx.turnCount, 1);
  });
});

describe('parseJsonl — turnCount', () => {
  function makeUserTurn(content: string): string {
    return JSON.stringify({
      type: 'user',
      isMeta: false,
      timestamp: '2026-01-01T00:01:00Z',
      message: { role: 'user', content },
    });
  }

  function makeToolResultTurn(): string {
    return JSON.stringify({
      type: 'user',
      isMeta: false,
      timestamp: '2026-01-01T00:02:00Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'abc', content: 'result text' }],
      },
    });
  }

  function makeMetaTurn(): string {
    return JSON.stringify({
      type: 'user',
      isMeta: true,
      timestamp: '2026-01-01T00:03:00Z',
      message: { role: 'user', content: 'IDE injected context' },
    });
  }

  test('counts real user turns', () => {
    const lines = [makeUserTurn('hello'), makeUserTurn('now add tests')].join('\n');
    const ctx = parseJsonl(lines, 's');
    assert.equal(ctx.turnCount, 2);
  });

  test('excludes isMeta turns from turnCount', () => {
    const lines = [makeUserTurn('hello'), makeMetaTurn()].join('\n');
    const ctx = parseJsonl(lines, 's');
    assert.equal(ctx.turnCount, 1);
  });

  test('excludes tool result turns from turnCount', () => {
    const lines = [makeUserTurn('run the build'), makeToolResultTurn()].join('\n');
    const ctx = parseJsonl(lines, 's');
    assert.equal(ctx.turnCount, 1);
  });

  test('all-tool-result turns yields turnCount 0', () => {
    const lines = [makeToolResultTurn(), makeToolResultTurn()].join('\n');
    const ctx = parseJsonl(lines, 's');
    assert.equal(ctx.turnCount, 0);
  });
});

describe('parseJsonl — distinctFilesTouched', () => {
  function makeSnapshot(paths: string[]): string {
    return JSON.stringify({
      type: 'file-history-snapshot',
      timestamp: '2026-01-01T00:01:00Z',
      files: paths.map(p => ({ path: p, operation: 'write' })),
    });
  }

  test('deduplicates paths across multiple snapshots', () => {
    const lines = [
      makeSnapshot(['/src/a.ts', '/src/b.ts']),
      makeSnapshot(['/src/b.ts', '/src/c.ts']),
    ].join('\n');
    const ctx = parseJsonl(lines, 's');
    assert.equal(ctx.distinctFilesTouched, 3); // a, b, c
  });

  test('empty files array contributes 0', () => {
    const lines = makeSnapshot([]);
    const ctx = parseJsonl(lines, 's');
    assert.equal(ctx.distinctFilesTouched, 0);
  });

  test('single snapshot with unique paths', () => {
    const lines = makeSnapshot(['/a.ts', '/b.ts', '/c.ts']);
    const ctx = parseJsonl(lines, 's');
    assert.equal(ctx.distinctFilesTouched, 3);
  });
});

describe('parseJsonl — compactCount', () => {
  function makeCompactBoundary(): string {
    return JSON.stringify({
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: '2026-01-01T00:10:00Z',
      compactMetadata: { trigger: 'manual', preTokens: 100000 },
    });
  }

  function makeOtherSystem(): string {
    return JSON.stringify({
      type: 'system',
      subtype: 'session_start',
      timestamp: '2026-01-01T00:00:00Z',
    });
  }

  test('counts compact_boundary entries', () => {
    const lines = [makeCompactBoundary(), makeCompactBoundary()].join('\n');
    const ctx = parseJsonl(lines, 's');
    assert.equal(ctx.compactCount, 2);
  });

  test('ignores other system subtypes', () => {
    const lines = [makeCompactBoundary(), makeOtherSystem()].join('\n');
    const ctx = parseJsonl(lines, 's');
    assert.equal(ctx.compactCount, 1);
  });
});

describe('parseJsonl — modelsUsed', () => {
  function makeAssistantTurn(model: string, stopReason: string | null): string {
    return JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:01:00Z',
      message: { model, stop_reason: stopReason, content: [], usage: {} },
    });
  }

  test('collects unique models from completed assistant turns', () => {
    const lines = [
      makeAssistantTurn('claude-haiku-4-5', 'end_turn'),
      makeAssistantTurn('claude-haiku-4-5', 'tool_use'),
      makeAssistantTurn('claude-sonnet-4-6', 'end_turn'),
    ].join('\n');
    const ctx = parseJsonl(lines, 's');
    assert.equal(ctx.modelsUsed.length, 2);
    assert.ok(ctx.modelsUsed.includes('claude-haiku-4-5'));
    assert.ok(ctx.modelsUsed.includes('claude-sonnet-4-6'));
  });

  test('excludes streaming chunks (null stop_reason)', () => {
    const lines = [
      makeAssistantTurn('claude-haiku-4-5', null),
      makeAssistantTurn('claude-haiku-4-5', null),
    ].join('\n');
    const ctx = parseJsonl(lines, 's');
    assert.equal(ctx.modelsUsed.length, 0);
  });
});

describe('parseJsonl — sessionAgeHours', () => {
  function makeEntry(timestamp: string): string {
    return JSON.stringify({ type: 'progress', timestamp });
  }

  test('calculates age from first and last timestamps', () => {
    const lines = [
      makeEntry('2026-01-01T00:00:00Z'),
      makeEntry('2026-01-01T02:00:00Z'),
    ].join('\n');
    const ctx = parseJsonl(lines, 's');
    assert.ok(Math.abs(ctx.sessionAgeHours - 2) < 0.01);
  });

  test('zero age when only one timestamp', () => {
    const lines = makeEntry('2026-01-01T00:00:00Z');
    const ctx = parseJsonl(lines, 's');
    assert.equal(ctx.sessionAgeHours, 0);
  });
});

describe('parseJsonl — priorTaskInterrupted', () => {
  function makeAssistantWithToolUse(): string {
    return JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:01:00Z',
      message: {
        model: 'claude-haiku-4-5',
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu1', name: 'bash', input: {} }],
      },
    });
  }

  function makeToolResultTurn(): string {
    return JSON.stringify({
      type: 'user',
      isMeta: false,
      timestamp: '2026-01-01T00:02:00Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'done' }],
      },
    });
  }

  function makeUserTurn(content: string): string {
    return JSON.stringify({
      type: 'user',
      isMeta: false,
      timestamp: '2026-01-01T00:03:00Z',
      message: { role: 'user', content },
    });
  }

  test('no interruption when tool_result follows tool_use', () => {
    const lines = [
      makeAssistantWithToolUse(),
      makeToolResultTurn(),
    ].join('\n');
    const ctx = parseJsonl(lines, 's');
    assert.equal(ctx.priorTaskInterrupted, false);
  });

  test('interruption detected when real user turn follows assistant tool_use', () => {
    const lines = [
      makeAssistantWithToolUse(),
      makeUserTurn('stop, go in a different direction'),
    ].join('\n');
    const ctx = parseJsonl(lines, 's');
    assert.equal(ctx.priorTaskInterrupted, true);
  });

  test('no interruption when no tool_use in session', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T00:01:00Z',
        message: { model: 'claude-haiku-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
      }),
      makeUserTurn('thanks'),
    ].join('\n');
    const ctx = parseJsonl(lines, 's');
    assert.equal(ctx.priorTaskInterrupted, false);
  });
});

describe('parseJsonl — sessionId preserved', () => {
  test('sessionId is the value passed in', () => {
    const line = JSON.stringify({ type: 'progress', timestamp: '2026-01-01T00:00:00Z' });
    const ctx = parseJsonl(line, 'my-session-uuid');
    assert.equal(ctx.sessionId, 'my-session-uuid');
  });
});

// ---------------------------------------------------------------------------
// applySessionModifiers — pure function, no filesystem
// ---------------------------------------------------------------------------

describe('applySessionModifiers — available: false returns unchanged result', () => {
  test('EMPTY_SESSION passes through result unchanged', () => {
    const result = makeResult();
    const modified = applySessionModifiers(result, EMPTY_SESSION);
    assert.deepEqual(modified, result);
  });

  test('does not mutate input result', () => {
    const result = makeResult();
    const copy = { ...result };
    applySessionModifiers(result, makeSession({ turnCount: 50 }));
    assert.deepEqual(result, copy);
  });
});

describe('applySessionModifiers — turn count modifier (section 3.1)', () => {
  test('0–9 turns: no change', () => {
    const result = makeResult();
    const modified = applySessionModifiers(result, makeSession({ turnCount: 9 }));
    assert.equal(modified.estimated_messages_min, 2);
    assert.equal(modified.estimated_messages_max, 4);
    assert.equal(modified.interrupt_risk, 'LOW');
  });

  test('10–24 turns: +1 to messages, LOW escalates to MEDIUM', () => {
    const result = makeResult();
    const modified = applySessionModifiers(result, makeSession({ turnCount: 10 }));
    assert.equal(modified.estimated_messages_min, 3);
    assert.equal(modified.estimated_messages_max, 5);
    assert.equal(modified.interrupt_risk, 'MEDIUM');
  });

  test('10–24 turns: MEDIUM stays MEDIUM (cannot downgrade)', () => {
    const result = makeResult({ interrupt_risk: 'MEDIUM' });
    const modified = applySessionModifiers(result, makeSession({ turnCount: 15 }));
    assert.equal(modified.interrupt_risk, 'MEDIUM');
  });

  test('25–49 turns: +2 to messages, LOW escalates to HIGH (2 levels)', () => {
    const result = makeResult();
    const modified = applySessionModifiers(result, makeSession({ turnCount: 25 }));
    assert.equal(modified.estimated_messages_min, 4);
    assert.equal(modified.estimated_messages_max, 6);
    assert.equal(modified.interrupt_risk, 'HIGH');
  });

  test('25–49 turns: MEDIUM escalates to HIGH', () => {
    const result = makeResult({ interrupt_risk: 'MEDIUM' });
    const modified = applySessionModifiers(result, makeSession({ turnCount: 30 }));
    assert.equal(modified.interrupt_risk, 'HIGH');
  });

  test('50+ turns: +3 to messages, risk escalates to HIGH unconditionally', () => {
    const result = makeResult({ interrupt_risk: 'LOW' });
    const modified = applySessionModifiers(result, makeSession({ turnCount: 50 }));
    assert.equal(modified.estimated_messages_min, 5);
    assert.equal(modified.estimated_messages_max, 7);
    assert.equal(modified.interrupt_risk, 'HIGH');
  });

  test('50+ turns: HIGH stays HIGH', () => {
    const result = makeResult({ interrupt_risk: 'HIGH' });
    const modified = applySessionModifiers(result, makeSession({ turnCount: 100 }));
    assert.equal(modified.interrupt_risk, 'HIGH');
  });
});

describe('applySessionModifiers — distinct files modifier (section 3.2)', () => {
  test('0–4 files: no change', () => {
    const result = makeResult();
    const modified = applySessionModifiers(result, makeSession({ distinctFilesTouched: 4 }));
    assert.equal(modified.estimated_messages_min, 2);
    assert.equal(modified.interrupt_risk, 'LOW');
  });

  test('5–14 files: +1 to messages, LOW to MEDIUM', () => {
    const result = makeResult();
    const modified = applySessionModifiers(result, makeSession({ distinctFilesTouched: 5 }));
    assert.equal(modified.estimated_messages_min, 3);
    assert.equal(modified.interrupt_risk, 'MEDIUM');
  });

  test('15–29 files: +2 to messages, LOW to HIGH', () => {
    const result = makeResult();
    const modified = applySessionModifiers(result, makeSession({ distinctFilesTouched: 15 }));
    assert.equal(modified.estimated_messages_min, 4);
    assert.equal(modified.interrupt_risk, 'HIGH');
  });

  test('30+ files: +3 to messages, HIGH unconditionally', () => {
    const result = makeResult();
    const modified = applySessionModifiers(result, makeSession({ distinctFilesTouched: 30 }));
    assert.equal(modified.estimated_messages_min, 5);
    assert.equal(modified.interrupt_risk, 'HIGH');
  });
});

describe('applySessionModifiers — message addend cap (section 3.5)', () => {
  test('turn+files addends are capped at +4', () => {
    // 50+ turns (+3) + 30+ files (+3) = 6 → capped at 4
    const result = makeResult({ estimated_messages_min: 2, estimated_messages_max: 4 });
    const modified = applySessionModifiers(result, makeSession({ turnCount: 50, distinctFilesTouched: 30 }));
    assert.equal(modified.estimated_messages_min, 2 + SESSION_MODIFIER_CONFIG.maxMsgAddend);
    assert.equal(modified.estimated_messages_max, 4 + SESSION_MODIFIER_CONFIG.maxMsgAddend);
  });

  test('addends below cap are not clamped', () => {
    // 10 turns (+1) + 5 files (+1) = 2 → under cap
    const result = makeResult({ estimated_messages_min: 2, estimated_messages_max: 4 });
    const modified = applySessionModifiers(result, makeSession({ turnCount: 10, distinctFilesTouched: 5 }));
    assert.equal(modified.estimated_messages_min, 4);
    assert.equal(modified.estimated_messages_max, 6);
  });
});

describe('applySessionModifiers — interrupt risk: most severe wins (section 3.5)', () => {
  test('turn HIGH + files MEDIUM → HIGH wins', () => {
    // 50+ turns → HIGH; 5–14 files → MEDIUM; max wins
    const result = makeResult({ interrupt_risk: 'LOW' });
    const modified = applySessionModifiers(result, makeSession({ turnCount: 50, distinctFilesTouched: 5 }));
    assert.equal(modified.interrupt_risk, 'HIGH');
  });
});

describe('applySessionModifiers — compact count boost (section 3.4)', () => {
  test('0 compacts: no boost', () => {
    // 8 turns + 0 compacts = effective 8 → no modifier
    const result = makeResult();
    const modified = applySessionModifiers(result, makeSession({ turnCount: 8, compactCount: 0 }));
    assert.equal(modified.interrupt_risk, 'LOW');
    assert.equal(modified.estimated_messages_min, 2);
  });

  test('1 compact: +20 effective turns boost', () => {
    // 8 turns + 20 boost = effective 28 → 25–49 range → +2 msg, LOW to HIGH
    const result = makeResult();
    const modified = applySessionModifiers(result, makeSession({ turnCount: 8, compactCount: 1 }));
    assert.equal(modified.estimated_messages_min, 4);
    assert.equal(modified.interrupt_risk, 'HIGH');
  });

  test('2+ compacts: +40 effective turns boost', () => {
    // 8 turns + 40 boost = effective 48 → 25–49 range → +2 msg, LOW to HIGH
    const result = makeResult();
    const modified = applySessionModifiers(result, makeSession({ turnCount: 8, compactCount: 2 }));
    assert.equal(modified.estimated_messages_min, 4);
    assert.equal(modified.interrupt_risk, 'HIGH');
  });

  test('example from spec: 8 turns + 2 compacts → effective 48, 25-49 range', () => {
    const result = makeResult({ estimated_messages_min: 2, estimated_messages_max: 4 });
    const modified = applySessionModifiers(result, makeSession({ turnCount: 8, compactCount: 2 }));
    assert.equal(modified.estimated_messages_min, 4); // +2
    assert.equal(modified.estimated_messages_max, 6); // +2
    assert.equal(modified.interrupt_risk, 'HIGH');    // LOW → HIGH (2 escalation levels)
  });

  test('3+ compacts: uses the same boost as 2 (capped at index 2)', () => {
    // compact boost index capped at length-1 = 2 (value 40)
    const result = makeResult();
    const mod2 = applySessionModifiers(result, makeSession({ turnCount: 8, compactCount: 2 }));
    const mod5 = applySessionModifiers(result, makeSession({ turnCount: 8, compactCount: 5 }));
    assert.equal(mod2.estimated_messages_min, mod5.estimated_messages_min);
    assert.equal(mod2.interrupt_risk, mod5.interrupt_risk);
  });
});

describe('applySessionModifiers — priorTaskInterrupted (section 3.3)', () => {
  test('false: no interrupt_risk change', () => {
    const result = makeResult({ interrupt_risk: 'LOW' });
    const modified = applySessionModifiers(result, makeSession({ priorTaskInterrupted: false }));
    assert.equal(modified.interrupt_risk, 'LOW');
    assert.equal(modified.interrupt_risk_reason, result.interrupt_risk_reason);
  });

  test('true: LOW escalates to MEDIUM', () => {
    const result = makeResult({ interrupt_risk: 'LOW' });
    const modified = applySessionModifiers(result, makeSession({ priorTaskInterrupted: true }));
    assert.equal(modified.interrupt_risk, 'MEDIUM');
  });

  test('true: MEDIUM escalates to HIGH', () => {
    const result = makeResult({ interrupt_risk: 'MEDIUM' });
    const modified = applySessionModifiers(result, makeSession({ priorTaskInterrupted: true }));
    assert.equal(modified.interrupt_risk, 'HIGH');
  });

  test('true: HIGH stays HIGH', () => {
    const result = makeResult({ interrupt_risk: 'HIGH' });
    const modified = applySessionModifiers(result, makeSession({ priorTaskInterrupted: true }));
    assert.equal(modified.interrupt_risk, 'HIGH');
  });

  test('true: appends reason suffix', () => {
    const result = makeResult({ interrupt_risk_reason: 'Targeted fix, small scope' });
    const modified = applySessionModifiers(result, makeSession({ priorTaskInterrupted: true }));
    assert.ok(
      modified.interrupt_risk_reason.startsWith('Targeted fix, small scope'),
      'should preserve original reason'
    );
    assert.ok(
      modified.interrupt_risk_reason.includes('prior task was interrupted'),
      'should append interrupted suffix'
    );
  });

  test('spec case B: turn=6, interrupted=true, files=2 → MEDIUM risk', () => {
    // Case B from spec: turn 6 (no turn modifier), files=2 (no files modifier),
    // but priorTaskInterrupted escalates LOW → MEDIUM
    const result = makeResult({
      interrupt_risk: 'LOW',
      interrupt_risk_reason: 'Targeted fix, small scope',
      estimated_messages_min: 1,
      estimated_messages_max: 3,
    });
    const session = makeSession({
      turnCount: 6,
      distinctFilesTouched: 2,
      priorTaskInterrupted: true,
    });
    const modified = applySessionModifiers(result, session);
    assert.equal(modified.interrupt_risk, 'MEDIUM');
    assert.equal(modified.estimated_messages_min, 1); // no message change
    assert.equal(modified.estimated_messages_max, 3); // no message change
    assert.ok(modified.interrupt_risk_reason.includes('prior task was interrupted'));
  });
});

describe('applySessionModifiers — spec case A', () => {
  test('turn=32, files=18 → messages +3 (capped from +4), risk HIGH', () => {
    // From spec: turn 32 (25–49, +2 msg, escalate 2), files 18 (15–29, +2 msg, escalate 2)
    // Combined addend: 2+2=4 = cap. Risk: max(2,2)=2 levels from LOW → HIGH
    const result = makeResult({
      complexity: 'LOW',
      estimated_messages_min: 2,
      estimated_messages_max: 4,
      interrupt_risk: 'LOW',
      interrupt_risk_reason: 'Additive task, no destructive operations',
    });
    const session = makeSession({
      turnCount: 32,
      distinctFilesTouched: 18,
      priorTaskInterrupted: false,
    });
    const modified = applySessionModifiers(result, session);
    // Addend: min(2+2, 4) = 4
    assert.equal(modified.estimated_messages_min, 6);
    assert.equal(modified.estimated_messages_max, 8);
    assert.equal(modified.interrupt_risk, 'HIGH');
    // recommended_model unchanged
    assert.equal(modified.recommended_model, 'claude-haiku-4-5');
  });
});

describe('applySessionModifiers — modifier floor: never reduces', () => {
  test('HIGH complexity result: session cannot lower it', () => {
    const result = makeResult({ interrupt_risk: 'HIGH' });
    const modified = applySessionModifiers(result, makeSession({ turnCount: 0, distinctFilesTouched: 0 }));
    assert.equal(modified.interrupt_risk, 'HIGH');
  });

  test('result is unchanged when all session signals are zero (available: true)', () => {
    const result = makeResult({ interrupt_risk: 'MEDIUM' });
    const modified = applySessionModifiers(result, makeSession({ turnCount: 0, distinctFilesTouched: 0 }));
    // No escalation — stays MEDIUM
    assert.equal(modified.interrupt_risk, 'MEDIUM');
  });
});

describe('applySessionModifiers — does not mutate input', () => {
  test('input AnalysisResult is not mutated', () => {
    const result = makeResult({ estimated_messages_min: 2, estimated_messages_max: 4, interrupt_risk: 'LOW' });
    const resultCopy = { ...result };
    applySessionModifiers(result, makeSession({ turnCount: 50, distinctFilesTouched: 30 }));
    assert.deepEqual(result, resultCopy);
  });

  test('input SessionContext is not mutated', () => {
    const session = makeSession({ turnCount: 50 });
    const sessionCopy = { ...session };
    applySessionModifiers(makeResult(), session);
    assert.deepEqual(session, sessionCopy);
  });
});

describe('applySessionModifiers — other fields pass through unchanged', () => {
  test('complexity, recommended_model, recommended_model_reason, breakdown are unchanged', () => {
    const result = makeResult({
      complexity: 'MEDIUM',
      recommended_model: 'claude-sonnet-4-6',
      recommended_model_reason: 'Complex reasoning required',
      breakdown: ['Step 1', 'Step 2'],
    });
    const modified = applySessionModifiers(result, makeSession({ turnCount: 50 }));
    assert.equal(modified.complexity, 'MEDIUM');
    assert.equal(modified.recommended_model, 'claude-sonnet-4-6');
    assert.equal(modified.recommended_model_reason, 'Complex reasoning required');
    assert.deepEqual(modified.breakdown, ['Step 1', 'Step 2']);
  });
});
