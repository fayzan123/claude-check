import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AnalysisResult } from './analyse.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionContext {
  available: boolean;
  turnCount: number;
  distinctFilesTouched: number;
  priorTaskInterrupted: boolean;
  compactCount: number;
  modelsUsed: string[];
  sessionAgeHours: number;
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EMPTY_SESSION: SessionContext = {
  available: false,
  turnCount: 0,
  distinctFilesTouched: 0,
  priorTaskInterrupted: false,
  compactCount: 0,
  modelsUsed: [],
  sessionAgeHours: 0,
  sessionId: '',
};

const TAIL_READ_BYTES = 500_000; // 500 KB cap for recent activity signals

// Modifier table constants — extracted so they can be tuned without hunting for
// magic numbers in conditionals.
//
// riskFloor: the minimum risk level index this modifier enforces.
//   0 = no floor (LOW is fine), 1 = floor at MEDIUM, 2 = floor at HIGH.
//   When multiple modifiers fire, the highest riskFloor wins (most severe).
//   This matches the spec: "10–24: Escalate LOW to MEDIUM" means the modifier
//   raises LOW to MEDIUM but does not raise MEDIUM to HIGH.
export const SESSION_MODIFIER_CONFIG = {
  turnCount: [
    { min: 0,  max: 9,  msgAdd: 0, riskFloor: 0 },
    { min: 10, max: 24, msgAdd: 1, riskFloor: 1 },
    { min: 25, max: 49, msgAdd: 2, riskFloor: 2 },
    { min: 50, max: Infinity, msgAdd: 3, riskFloor: 2 },
  ],
  filesCount: [
    { min: 0,  max: 4,  msgAdd: 0, riskFloor: 0 },
    { min: 5,  max: 14, msgAdd: 1, riskFloor: 1 },
    { min: 15, max: 29, msgAdd: 2, riskFloor: 2 },
    { min: 30, max: Infinity, msgAdd: 3, riskFloor: 2 },
  ],
  compactCountBoost: [0, 20, 40] as const,
  maxMsgAddend: 4,
};

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const SESSION_STALE_MS = 2 * 60 * 60 * 1000; // 2 hours

export function detectClaudeCodeSession(cwd?: string): boolean {
  // Prefer the env var when available (set by Claude Code in its own subprocesses)
  if (process.env['CLAUDECODE'] === '1') return true;

  // Fallback: check if a session file exists and was modified recently.
  // Covers the common case of running claude-check from a regular terminal
  // while Claude Code is open in the same project.
  try {
    const workingDir = cwd ?? process.cwd();
    const encoded = workingDir.replace(/[/\\]/g, '-');
    const projectDir = join(homedir(), '.claude', 'projects', encoded);
    const files = readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
    if (files.length === 0) return false;
    const mostRecentMtime = Math.max(
      ...files.map(f => {
        try { return statSync(join(projectDir, f)).mtimeMs; } catch { return 0; }
      })
    );
    return Date.now() - mostRecentMtime < SESSION_STALE_MS;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

interface JsonlEntry {
  type?: string;
  subtype?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: {
    role?: string;
    model?: string;
    stop_reason?: string | null;
    content?: unknown;
    usage?: unknown;
  };
  // file-history-snapshot v2 schema (actual Claude Code): snapshot.trackedFileBackups keys are paths
  snapshot?: {
    trackedFileBackups?: Record<string, unknown>;
  };
  // file-history-snapshot v1 schema (older/test): files array with {path, operation} objects
  files?: Array<{ path?: string; operation?: string }>;
  compactMetadata?: unknown;
}

function isToolResultContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(
    (item): item is { type: string } =>
      typeof item === 'object' &&
      item !== null &&
      (item as Record<string, unknown>)['type'] === 'tool_result'
  );
}

function isToolUseContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(
    (item): item is { type: string } =>
      typeof item === 'object' &&
      item !== null &&
      (item as Record<string, unknown>)['type'] === 'tool_use'
  );
}

/**
 * Parse a raw JSONL string (tail-read) into a SessionContext.
 * Malformed lines are silently skipped.
 */
export function parseJsonl(raw: string, sessionId: string, debug = false): SessionContext {
  const lines = raw.split('\n');
  const entries: JsonlEntry[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as JsonlEntry);
    } catch {
      // Silently skip malformed lines (e.g. partial final line during active write)
    }
  }

  if (entries.length === 0) {
    return { ...EMPTY_SESSION };
  }

  let turnCount = 0;
  const filePaths = new Set<string>();
  let compactCount = 0;
  const modelsUsed = new Set<string>();
  const timestamps: number[] = [];
  let priorTaskInterrupted = false;
  let fhsEntries = 0; // for debug warning: track file-history-snapshot presence

  // Walk entries to collect signals
  // Also track sequence for prior-interrupted detection
  let lastAssistantHadToolUse = false;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const { type, subtype, timestamp, isMeta, message, snapshot, files } = entry;

    // Collect timestamps for sessionAgeHours
    if (timestamp) {
      const ts = Date.parse(timestamp);
      if (!isNaN(ts)) timestamps.push(ts);
    }

    if (type === 'user') {
      if (isMeta) continue; // Skip injected IDE context
      const role = message?.role;
      if (role !== 'user') continue;
      const content = message?.content;

      if (isToolResultContent(content)) {
        // This is a tool result turn — check if the PREVIOUS assistant had tool_use
        // If we get a matching tool_result, the prior task was NOT interrupted
        if (lastAssistantHadToolUse) {
          lastAssistantHadToolUse = false;
        }
        continue; // Not a real human prompt
      }

      // Real human turn
      turnCount++;
      // If we arrive at a real human turn after an assistant with tool_use
      // and no intervening tool_result, the task was interrupted
      if (lastAssistantHadToolUse) {
        priorTaskInterrupted = true;
        lastAssistantHadToolUse = false;
      }
    } else if (type === 'assistant') {
      const stopReason = message?.stop_reason;
      if (stopReason == null) continue; // Streaming chunk — not a completed turn

      const model = message?.model;
      if (typeof model === 'string' && model.length > 0) {
        modelsUsed.add(model);
      }

      const content = message?.content;
      lastAssistantHadToolUse = isToolUseContent(content);
    } else if (type === 'file-history-snapshot') {
      fhsEntries++;
      // v2 schema (real Claude Code): snapshot.trackedFileBackups keys are file paths
      const backups = snapshot?.trackedFileBackups;
      if (backups && typeof backups === 'object') {
        for (const filePath of Object.keys(backups)) {
          if (filePath.length > 0) filePaths.add(filePath);
        }
      }
      // v1 schema (older/tests): files array with {path} objects
      if (Array.isArray(files)) {
        for (const f of files) {
          if (typeof f?.path === 'string' && f.path.length > 0) filePaths.add(f.path);
        }
      }
    } else if (type === 'system' && subtype === 'compact_boundary') {
      compactCount++;
    }
  }

  if (debug && entries.length > 50 && fhsEntries === 0) {
    process.stderr.write(
      '[claude-check debug] session: no file-history-snapshot entries in JSONL tail — schema may have changed\n'
    );
  }

  const sessionAgeHours =
    timestamps.length >= 2
      ? (Math.max(...timestamps) - Math.min(...timestamps)) / 3_600_000
      : 0;

  return {
    available: true,
    turnCount,
    distinctFilesTouched: filePaths.size,
    priorTaskInterrupted,
    compactCount,
    modelsUsed: Array.from(modelsUsed),
    sessionAgeHours,
    sessionId,
  };
}

// ---------------------------------------------------------------------------
// File reader
// ---------------------------------------------------------------------------

function readFileChunk(filePath: string, offset: number, length: number): string {
  const fd = openSync(filePath, 'r');
  const buf = Buffer.alloc(length);
  let bytesRead = 0;
  try {
    bytesRead = readSync(fd, buf, 0, length, offset);
    closeSync(fd);
  } catch {
    try { closeSync(fd); } catch { /* ignore */ }
    return '';
  }
  return buf.slice(0, bytesRead).toString('utf8');
}

/**
 * Count compact_boundary events in the entire file via a fast string scan.
 * Reads the whole file but only does a string search per line — no JSON parsing.
 * For a 7.5MB file this takes ~20ms on SSD.
 */
function scanCompactCount(filePath: string): number {
  try {
    const size = statSync(filePath).size;
    if (size === 0) return 0;
    const fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(size);
    let count = 0;
    try {
      readSync(fd, buf, 0, size, 0);
      closeSync(fd);
      const text = buf.toString('utf8');
      let pos = 0;
      while (pos < text.length) {
        const nl = text.indexOf('\n', pos);
        const end = nl >= 0 ? nl : text.length;
        const line = text.slice(pos, end);
        if (line.includes('"compact_boundary"')) count++;
        pos = end + 1;
      }
    } catch {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Returns the tail string chunk for recent activity parsing.
 * For files smaller than TAIL_READ_BYTES, returns the full content.
 */
function readSessionFile(filePath: string): string {
  const size = statSync(filePath).size;
  if (size === 0) return '';

  if (size <= TAIL_READ_BYTES) {
    return readFileChunk(filePath, 0, size);
  }

  const tailRaw = readFileChunk(filePath, size - TAIL_READ_BYTES, TAIL_READ_BYTES);
  const firstNewline = tailRaw.indexOf('\n');
  return firstNewline >= 0 ? tailRaw.slice(firstNewline + 1) : tailRaw;
}

// ---------------------------------------------------------------------------
// Main public API
// ---------------------------------------------------------------------------

/**
 * Locate and parse the active Claude Code session for the given cwd.
 * Returns EMPTY_SESSION (available: false) on any error.
 */
export async function readSessionContext(cwd?: string, debug = false): Promise<SessionContext> {
  const workingDir = cwd ?? process.cwd();

  if (!detectClaudeCodeSession(workingDir)) {
    return { ...EMPTY_SESSION };
  }

  // Encode cwd to project directory name: replace all '/' and '\' with '-'
  const encoded = workingDir.replace(/[/\\]/g, '-');
  const projectDir = join(homedir(), '.claude', 'projects', encoded);

  // Find the most recently modified .jsonl in the project directory
  let files: string[];
  try {
    files = readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
  } catch {
    if (debug) {
      process.stderr.write(`[claude-check debug] session: project directory not found: ${projectDir}\n`);
    }
    return { ...EMPTY_SESSION };
  }

  if (files.length === 0) {
    if (debug) {
      process.stderr.write(`[claude-check debug] session: no .jsonl files in ${projectDir}\n`);
    }
    return { ...EMPTY_SESSION };
  }

  // Pick the most recently modified session file
  let mostRecentFile = '';
  let mostRecentMtime = 0;
  for (const file of files) {
    const filePath = join(projectDir, file);
    try {
      const st = statSync(filePath);
      if (st.mtimeMs > mostRecentMtime) {
        mostRecentMtime = st.mtimeMs;
        mostRecentFile = filePath;
      }
    } catch {
      // Stat error — skip
    }
  }

  if (!mostRecentFile) {
    return { ...EMPTY_SESSION };
  }

  const sessionId = mostRecentFile.replace(/^.*\/(.+)\.jsonl$/, '$1');

  if (debug) {
    process.stderr.write(`[claude-check debug] session: reading ${mostRecentFile}\n`);
  }

  let tail: string;
  let compactCount: number;
  try {
    tail = readSessionFile(mostRecentFile);
    // Compact events may be scattered throughout a large file — scan the whole file
    // with a fast string search rather than parsing every JSON entry
    compactCount = scanCompactCount(mostRecentFile);
  } catch {
    if (debug) {
      process.stderr.write(`[claude-check debug] session: failed to read JSONL file\n`);
    }
    return { ...EMPTY_SESSION };
  }

  if (debug) {
    process.stderr.write(`[claude-check debug] session: tail=${tail.length} bytes, compactScan=${compactCount}\n`);
  }

  try {
    const ctx = parseJsonl(tail, sessionId, debug);
    const merged: SessionContext = { ...ctx, compactCount };

    if (debug) {
      process.stderr.write(
        `[claude-check debug] session: turns=${merged.turnCount} files=${merged.distinctFilesTouched} compacts=${merged.compactCount} interrupted=${merged.priorTaskInterrupted}\n`
      );
    }
    return merged;
  } catch {
    if (debug) {
      process.stderr.write(`[claude-check debug] session: JSONL parse failed\n`);
    }
    return { ...EMPTY_SESSION };
  }
}

// ---------------------------------------------------------------------------
// Modifier helpers
// ---------------------------------------------------------------------------

type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

const RISK_ORDER: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH'];

/** Return the higher of two risk levels (never lower). */
function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
}

/** Raise risk by one level (floor at HIGH). Used for priorTaskInterrupted. */
function escalateRiskByOne(current: RiskLevel): RiskLevel {
  const idx = RISK_ORDER.indexOf(current);
  return RISK_ORDER[Math.min(idx + 1, RISK_ORDER.length - 1)];
}

/** Apply a risk floor: the result is at least the floor level. */
function applyRiskFloor(current: RiskLevel, floorIdx: number): RiskLevel {
  return maxRisk(current, RISK_ORDER[floorIdx] ?? 'LOW');
}

function lookupTurnModifier(effectiveTurns: number): { msgAdd: number; riskFloor: number } {
  for (const row of SESSION_MODIFIER_CONFIG.turnCount) {
    if (effectiveTurns >= row.min && effectiveTurns <= row.max) {
      return { msgAdd: row.msgAdd, riskFloor: row.riskFloor };
    }
  }
  return { msgAdd: 0, riskFloor: 0 };
}

function lookupFilesModifier(files: number): { msgAdd: number; riskFloor: number } {
  for (const row of SESSION_MODIFIER_CONFIG.filesCount) {
    if (files >= row.min && files <= row.max) {
      return { msgAdd: row.msgAdd, riskFloor: row.riskFloor };
    }
  }
  return { msgAdd: 0, riskFloor: 0 };
}

// ---------------------------------------------------------------------------
// applySessionModifiers — pure function, no mutation
// ---------------------------------------------------------------------------

/**
 * Apply session context modifiers to an AnalysisResult.
 * Returns a new AnalysisResult — does not mutate the input.
 * Only escalates — never reduces ratings returned by the API.
 */
export function applySessionModifiers(
  result: AnalysisResult,
  session: SessionContext,
): AnalysisResult {
  if (!session.available) {
    return result;
  }

  // --- Compute effective turn count (boosted by compact events) ---
  const compactBoostIdx = Math.min(session.compactCount, SESSION_MODIFIER_CONFIG.compactCountBoost.length - 1);
  const compactBoost = SESSION_MODIFIER_CONFIG.compactCountBoost[compactBoostIdx];
  const effectiveTurns = session.turnCount + compactBoost;

  // --- Turn count modifier ---
  const turnMod = lookupTurnModifier(effectiveTurns);

  // --- Distinct files modifier ---
  const filesMod = lookupFilesModifier(session.distinctFilesTouched);

  // --- Cap total message addend at +4 ---
  const totalMsgAdd = Math.min(
    turnMod.msgAdd + filesMod.msgAdd,
    SESSION_MODIFIER_CONFIG.maxMsgAddend,
  );

  // --- Interrupt risk: apply floor from each modifier; most severe floor wins ---
  const combinedFloor = Math.max(turnMod.riskFloor, filesMod.riskFloor);
  let newRisk: RiskLevel = applyRiskFloor(result.interrupt_risk, combinedFloor);
  const riskWasEscalated = RISK_ORDER.indexOf(newRisk) > RISK_ORDER.indexOf(result.interrupt_risk);

  // --- Prior interrupted modifier: escalates risk by 1, appends to reason ---
  let newRiskReason = result.interrupt_risk_reason;
  if (session.priorTaskInterrupted) {
    newRisk = escalateRiskByOne(newRisk);
    newRiskReason = `${newRiskReason}: prior task was interrupted — recovery work is costlier`;
  } else if (riskWasEscalated) {
    // Build a contextual reason when session signals upgraded the risk
    const parts: string[] = [];
    if (session.turnCount > 0 || session.compactCount > 0) {
      parts.push(`Turn ${session.turnCount}`);
    }
    if (session.distinctFilesTouched > 0) {
      parts.push(`${session.distinctFilesTouched} files in play`);
    }
    if (parts.length > 0) {
      newRiskReason = `${parts.join(', ')} — usage budget already committed`;
    }
  }

  return {
    ...result,
    estimated_messages_min: result.estimated_messages_min + totalMsgAdd,
    estimated_messages_max: result.estimated_messages_max + totalMsgAdd,
    interrupt_risk: newRisk,
    interrupt_risk_reason: newRiskReason,
  };
}
