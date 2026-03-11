import chalk, { Chalk } from 'chalk';
import boxen from 'boxen';
import type { AnalysisResult } from './analyse.js';

export interface DisplayOptions {
  limitPct?: number;
  limitAutoFetched?: boolean;
  planMultiplier?: number;
  showBreakdown?: boolean;
  noColor?: boolean;
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

function limitWarning(c: ChalkInstance, pct: number, autoFetched: boolean, multiplier: number): string[] {
  const source = autoFetched ? 'from claude.ai' : 'remaining';
  const label = planLabel(multiplier);
  // Normalize against Pro baseline: higher-tier plans have proportionally more absolute capacity
  const effective = pct * multiplier;
  if (effective >= 75) {
    return [c.green(`✓  ${pct}% ${source}${label}: Safe to proceed`)];
  }
  if (effective >= 40) {
    return [c.yellow(`⚠  ${pct}% ${source}${label}: Proceed with caution`)];
  }
  return [
    c.red(`✗  ${pct}% ${source}${label}: Do not start`),
    c.red('   Wait for your limit to reset before running this.'),
  ];
}

export function renderResult(result: AnalysisResult, opts: DisplayOptions = {}): string {
  const c = opts.noColor ? new Chalk({ level: 0 }) : chalk;

  const lines: string[] = [];

  // Complexity
  lines.push(
    `Complexity:        ${levelColor(c, result.complexity)}`
  );

  // Estimated messages
  lines.push(
    `Est. messages:     ${result.estimated_messages_min}–${result.estimated_messages_max}`
  );

  // Interrupt risk — truncate reason so line stays within box width
  // "Interrupt risk:    HIGH — " = 26 chars, leaving ~30 for reason
  const riskReason = truncate(result.interrupt_risk_reason, BOX_WIDTH - 26);
  lines.push(
    `Interrupt risk:    ${levelColor(c, result.interrupt_risk)} — ${riskReason}`
  );

  lines.push('');

  // Model recommendation
  lines.push(
    `Recommended model: ${c.cyan(result.recommended_model)}`
  );
  // "Reason:            " = 19 chars, leaving ~37 for reason
  lines.push(
    `Reason:            ${truncate(result.recommended_model_reason, BOX_WIDTH - 19)}`
  );

  // Limit warning
  if (opts.limitPct !== undefined) {
    lines.push('');
    for (const line of limitWarning(c, opts.limitPct, opts.limitAutoFetched ?? false, opts.planMultiplier ?? 1)) {
      lines.push(line);
    }
  }

  // Breakdown — show for MEDIUM/HIGH, --breakdown flag, or when limit is in danger zone
  const limitIsLow = opts.limitPct !== undefined && (opts.limitPct * (opts.planMultiplier ?? 1)) < 40;
  const showBreakdown =
    opts.showBreakdown ||
    result.complexity === 'MEDIUM' ||
    result.complexity === 'HIGH' ||
    limitIsLow;

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
