import chalk, { Chalk } from 'chalk';
import boxen from 'boxen';
import type { AnalysisResult } from './analyse.js';
import { MODEL_THRESHOLD_BONUS } from './models.js';

export interface DisplayOptions {
  limitPct?: number;
  sessionPct?: number;      // % USED in the 5-hour window (0–100); auto-fetched only
  limitAutoFetched?: boolean;
  planMultiplier?: number;
  showBreakdown?: boolean;
  noColor?: boolean;
}

export type Verdict = 'safe' | 'caution' | 'do-not-start';

/**
 * Pure verdict computation — used by both renderResult and --json output.
 * limitPct is remaining %; sessionPct is % used in the 5-hour window.
 */
export function computeVerdict(
  limitPct: number,
  planMultiplier: number,
  recommendedModel: string,
  sessionPct?: number,
): Verdict {
  const bonus = MODEL_THRESHOLD_BONUS[recommendedModel] ?? 0;
  const weeklyEffective = limitPct * planMultiplier;
  const sessionEffective = sessionPct !== undefined
    ? (100 - sessionPct) * planMultiplier
    : Infinity;
  const effective = Math.min(weeklyEffective, sessionEffective);
  if (effective >= 75 + bonus) return 'safe';
  if (effective >= 40 + bonus) return 'caution';
  return 'do-not-start';
}

const BOX_WIDTH = 56; // inner content width (matches spec example)

type Level = 'LOW' | 'MEDIUM' | 'HIGH';
type ChalkInstance = typeof chalk;

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

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

  // "Interrupt risk:    HIGH — " = 26 chars, leaving ~30 for reason
  const riskReason = truncate(result.interrupt_risk_reason, BOX_WIDTH - 26);
  lines.push(`Interrupt risk:    ${levelColor(c, result.interrupt_risk)} — ${riskReason}`);

  lines.push('');

  lines.push(`Recommended model: ${c.cyan(result.recommended_model)}`);
  // "Reason:            " = 19 chars, leaving ~37 for reason
  lines.push(`Reason:            ${truncate(result.recommended_model_reason, BOX_WIDTH - 19)}`);

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

  // Breakdown — show for MEDIUM/HIGH, --breakdown flag, or when limit is in danger zone
  const modelBonus = MODEL_THRESHOLD_BONUS[result.recommended_model] ?? 0;
  const multiplier = opts.planMultiplier ?? 1;
  const weeklyIsLow = opts.limitPct !== undefined && (opts.limitPct * multiplier) < 40 + modelBonus;
  const sessionIsLow = opts.sessionPct !== undefined && ((100 - opts.sessionPct) * multiplier) < 40 + modelBonus;
  const showBreakdown =
    opts.showBreakdown ||
    result.complexity === 'MEDIUM' ||
    result.complexity === 'HIGH' ||
    weeklyIsLow ||
    sessionIsLow;

  if (showBreakdown && result.breakdown && result.breakdown.length > 0) {
    lines.push('');
    lines.push('Safer breakdown:');
    result.breakdown.forEach((step, i) => {
      // "  N. " = 5 chars
      lines.push(`  ${i + 1}. ${truncate(step, BOX_WIDTH - 5)}`);
    });
  }

  const content = lines.join('\n');

  return boxen(content, {
    title: 'claude-check',
    titleAlignment: 'left',
    padding: { top: 1, bottom: 1, left: 2, right: 2 },
    borderStyle: 'round',
    borderColor: 'gray',
    width: BOX_WIDTH + 8, // +8 accounts for padding and border chars
  });
}
