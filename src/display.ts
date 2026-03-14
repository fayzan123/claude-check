import chalk, { Chalk } from 'chalk';
import boxen from 'boxen';
import type { AnalysisResult } from './analyse.js';
import { MODEL_THRESHOLD_BONUS } from './models.js';
import type { SessionContext } from './session.js';

export interface DisplayOptions {
  limitPct?: number;
  sessionPct?: number;      // % USED in the 5-hour window (0–100); auto-fetched only
  limitAutoFetched?: boolean;
  planMultiplier?: number;
  showBreakdown?: boolean;
  noColor?: boolean;
  sessionContext?: SessionContext;
}

export type Verdict = 'safe' | 'caution' | 'do-not-start';

/**
 * Pure verdict computation — used by both renderResult and --json output.
 * limitPct is remaining %; sessionPct is % used in the 5-hour window.
 *
 * Session limits are smaller in absolute terms than weekly limits, so a task
 * consumes a larger fraction of the session budget than the weekly budget.
 * We apply SESSION_PENALTY points extra required headroom on the session window
 * to account for this scale difference.
 */
const SESSION_PENALTY = 15;

export function computeVerdict(
  limitPct: number,
  planMultiplier: number,
  recommendedModel: string,
  sessionPct?: number,
): Verdict {
  const bonus = MODEL_THRESHOLD_BONUS[recommendedModel] ?? 0;
  const weeklyEffective = limitPct * planMultiplier;
  const sessionEffective = sessionPct !== undefined
    ? Math.max(0, (100 - sessionPct) - SESSION_PENALTY) * planMultiplier
    : Infinity;
  const effective = Math.min(weeklyEffective, sessionEffective);
  if (effective >= 75 + bonus) return 'safe';
  if (effective >= 40 + bonus) return 'caution';
  return 'do-not-start';
}

type Level = 'LOW' | 'MEDIUM' | 'HIGH';
type ChalkInstance = typeof chalk;

function levelColor(c: ChalkInstance, level: Level): string {
  if (level === 'LOW') return c.green(level);
  if (level === 'MEDIUM') return c.yellow(level);
  return c.red(level);
}

function planLabel(multiplier: number): string {
  if (multiplier <= 1) return '';
  if (multiplier === 5) return ' (Max 5x)';
  if (multiplier === 20) return ' (Max 20x)';
  return ` (${multiplier}x plan)`;
}

function limitWarning(
  c: ChalkInstance,
  limitPct: number,
  autoFetched: boolean,
  multiplier: number,
  recommendedModel: string,
  sessionPct?: number,
): string[] {
  const label = planLabel(multiplier);
  const verdict = computeVerdict(limitPct, multiplier, recommendedModel, sessionPct);

  let usageLine: string;
  if (autoFetched && sessionPct !== undefined) {
    const sessionRemaining = 100 - sessionPct;
    usageLine = `${limitPct}% weekly · ${sessionRemaining}% session${label}`;
  } else {
    const source = autoFetched ? 'from claude.ai' : 'remaining';
    usageLine = `${limitPct}% ${source}${label}`;
  }

  if (verdict === 'safe') {
    return [c.green(`✓  ${usageLine}: Safe to proceed`)];
  }
  if (verdict === 'caution') {
    return [c.yellow(`⚠  ${usageLine}: Proceed with caution`)];
  }
  return [
    c.red(`✗  ${usageLine}: Do not start`),
    c.red('   Wait for your limit to reset before running this.'),
  ];
}

export function renderResult(result: AnalysisResult, opts: DisplayOptions = {}): string {
  const c = opts.noColor ? new Chalk({ level: 0 }) : chalk;

  if (!(result.recommended_model in MODEL_THRESHOLD_BONUS)) {
    process.stderr.write(
      `Warning: recommended model "${result.recommended_model}" is not in the known model list — verdict thresholds may be inaccurate.\n`
    );
  }

  const lines: string[] = [];

  lines.push(`Complexity:        ${levelColor(c, result.complexity)}`);
  lines.push(`Est. messages:     ${result.estimated_messages_min}–${result.estimated_messages_max}`);

  lines.push(`Interrupt risk:    ${levelColor(c, result.interrupt_risk)} — ${result.interrupt_risk_reason}`);

  // Session context line — only shown when session data is available
  if (opts.sessionContext?.available) {
    const sc = opts.sessionContext;
    lines.push(`Session context:   Turn ${sc.turnCount} · ${sc.distinctFilesTouched} files · ${sc.compactCount} compacts`);
  }

  lines.push('');

  lines.push(`Recommended model: ${c.cyan(result.recommended_model)}`);
  lines.push(`Reason:            ${result.recommended_model_reason}`);

  // Limit warning
  if (opts.limitPct !== undefined) {
    lines.push('');
    for (const line of limitWarning(
      c,
      opts.limitPct,
      opts.limitAutoFetched ?? false,
      opts.planMultiplier ?? 1,
      result.recommended_model,
      opts.sessionPct,
    )) {
      lines.push(line);
    }
  }

  // Breakdown — only show for MEDIUM/HIGH complexity tasks when verdict is do-not-start
  const verdictResult = opts.limitPct !== undefined
    ? computeVerdict(opts.limitPct, opts.planMultiplier ?? 1, result.recommended_model, opts.sessionPct)
    : null;
  const isComplexEnough = result.complexity === 'MEDIUM' || result.complexity === 'HIGH';
  const showBreakdown =
    opts.showBreakdown ||
    (verdictResult === 'do-not-start' && isComplexEnough);

  if (showBreakdown && result.breakdown && result.breakdown.length > 0) {
    lines.push('');
    lines.push('Safer breakdown:');
    result.breakdown.forEach((step, i) => {
      lines.push(`  ${i + 1}. ${step}`);
    });
  }

  const content = lines.join('\n');

  return boxen(content, {
    title: 'claude-check',
    titleAlignment: 'left',
    padding: { top: 1, bottom: 1, left: 2, right: 2 },
    borderStyle: 'round',
    borderColor: 'gray',
  });
}
