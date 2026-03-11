#!/usr/bin/env node

import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import ora from 'ora';
import Anthropic from '@anthropic-ai/sdk';
import { getApiKey, setApiKey, getPlanMultiplier, setPlanMultiplier, getAnalysisModel, setAnalysisModel } from './config.js';
import { getAutoUsage } from './usage.js';
import { analysePrompt } from './analyse.js';
import { renderResult, computeVerdict } from './display.js';
import { isPromptTruncated } from './prompts.js';

const MAX_STDIN_BYTES = 1_000_000; // 1 MB — well beyond any reasonable prompt

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      data += chunk;
      if (Buffer.byteLength(data) > MAX_STDIN_BYTES) {
        stdin.destroy();
        reject(new Error(`Input exceeds maximum size of ${MAX_STDIN_BYTES} bytes.`));
      }
    });
    stdin.on('end', () => resolve(data.trim()));
  });
}

const program = new Command();

program
  .name('claude-check')
  .description(
    'Analyse a prompt before sending it to Claude — estimates complexity, cost, and recommends the best model.'
  )
  .version('1.1.1')
  .argument('[prompt]', 'The prompt to analyse')
  .option('--limit <number>', 'Your remaining usage limit as a percentage (e.g. --limit 20)')
  .option('--breakdown', 'Always show task breakdown suggestions, even for LOW complexity')
  .option('--json', 'Output raw JSON instead of formatted terminal output')
  .option('--no-color', 'Plain text output, no terminal colours')
  .option('--model <model>', 'Override which Claude model to use for the analysis call')
  .option('--plan <plan>', 'Your claude.ai plan: pro, max5, max20, or a multiplier (e.g. 10). Saved for future runs.')
  .option('--debug', 'Print diagnostic info about usage auto-fetch')
  .action(async (promptArg: string | undefined, opts: {
    limit?: string;
    breakdown?: boolean;
    json?: boolean;
    color?: boolean;
    model?: string;
    plan?: string;
    debug?: boolean;
  }) => {
    // --- Resolve prompt (arg or stdin pipe) ---
    let prompt = promptArg;
    if (!prompt) {
      // Check if stdin has data (pipe mode)
      if (!process.stdin.isTTY) {
        prompt = await readStdin();
      }
    }

    if (!prompt) {
      program.help();
      return;
    }

    // --- Resolve auth ---
    const apiKey = getApiKey();
    if (!apiKey) {
      console.error(
        'No API key configured. Run `claude-check setup` to save your Anthropic API key.\n' +
        'Get one at: https://console.anthropic.com'
      );
      process.exit(1);
    }

    // --- Resolve plan multiplier ---
    let planMultiplier: number;
    if (opts.plan !== undefined) {
      const named: Record<string, number> = { pro: 1, max5: 5, max20: 20 };
      const n = Number(opts.plan);
      planMultiplier = named[opts.plan] ?? (Number.isInteger(n) && n >= 1 ? n : 1);
      setPlanMultiplier(planMultiplier); // persist for future runs
    } else {
      planMultiplier = getPlanMultiplier();
    }

    // --- Validate --limit ---
    let limitPct: number | undefined;
    let limitAutoFetched = false;
    let sessionPct: number | undefined;

    if (opts.limit !== undefined) {
      limitPct = Number(opts.limit);
      if (!Number.isFinite(limitPct) || limitPct < 0 || limitPct > 100) {
        console.error('--limit must be a number between 0 and 100 (e.g. --limit 20)');
        process.exit(1);
      }
    } else {
      // --- Auto-fetch claude.ai usage limit via Claude Code OAuth ---
      const usage = await getAutoUsage(opts.debug);
      if (usage) {
        limitPct = 100 - usage.weeklyPct;
        sessionPct = usage.sessionPct;
        limitAutoFetched = true;
      } else if (process.stdout.isTTY && !opts.json) {
        // Auto-fetch unavailable — ask interactively so the verdict is never skipped
        const rl = createInterface({ input: stdin, output: stdout });
        const answer = await rl.question(
          'How much of your weekly claude.ai limit is remaining? (% from claude.ai dashboard, or Enter to skip): '
        );
        rl.close();
        const parsed = Number(answer.trim());
        if (answer.trim() && Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) {
          limitPct = parsed;
        }
      }
    }

    // --- Check for prompt truncation ---
    const truncated = isPromptTruncated(prompt);

    // --- Run analysis with spinner ---
    const spinner = opts.json || !process.stdout.isTTY
      ? null
      : ora({ text: 'Analysing prompt…', color: 'cyan' }).start();

    try {
      const result = await analysePrompt({ apiKey }, prompt, opts.model ?? getAnalysisModel());
      spinner?.stop();

      if (opts.json) {
        const verdict = limitPct !== undefined
          ? computeVerdict(limitPct, planMultiplier, result.recommended_model, sessionPct)
          : null;
        console.log(JSON.stringify({
          ...result,
          limit_pct: limitPct ?? null,
          session_pct: sessionPct ?? null,
          plan_multiplier: planMultiplier,
          limit_auto_fetched: limitAutoFetched,
          truncated,
          verdict,
        }, null, 2));
        return;
      }

      if (truncated) {
        console.log('Note: prompt truncated to 2000 characters — analysis based on partial input.');
      }

      console.log(renderResult(result, {
        limitPct,
        sessionPct,
        limitAutoFetched,
        planMultiplier,
        showBreakdown: opts.breakdown,
        noColor: !opts.color,
      }));
    } catch (err) {
      spinner?.stop();

      if (err instanceof Anthropic.AuthenticationError) {
        console.error(
          'Invalid API key.\n' +
          'Check your key at https://console.anthropic.com or run `claude-check setup` to save a new one.'
        );
      } else if (err instanceof Anthropic.APIConnectionTimeoutError) {
        console.error('Request timed out. Check your connection and try again.');
      } else if (err instanceof Anthropic.APIConnectionError) {
        console.error('Could not reach the Anthropic API. Check your internet connection and try again.');
      } else if (err instanceof Error && err.name === 'ParseError') {
        console.error(err.message);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Analysis failed: ${msg}`);
      }

      process.exit(1);
    }
  });

program
  .command('setup')
  .description('Configure your Anthropic API key and claude.ai plan')
  .action(async () => {
    console.log();

    // Detect Claude Code credentials and inform user
    const usage = await getAutoUsage();
    if (usage) {
      console.log('Claude Code detected — your claude.ai usage will be fetched automatically.');
      console.log(`Current usage: ${usage.weeklyPct}% of weekly limit used.`);
      console.log();
    }

    const rl = createInterface({ input: stdin, output: stdout });

    console.log('An Anthropic API key is required to run analyses.');
    console.log('Get one at: https://console.anthropic.com');
    console.log();

    const key = await rl.question('Enter your Anthropic API key: ');

    const trimmed = key.trim();
    if (!trimmed) {
      rl.close();
      console.log('No key provided. Setup cancelled.');
      process.exit(1);
    }

    // Warn on unexpected key format (non-fatal)
    if (!trimmed.startsWith('sk-ant-')) {
      console.log();
      console.log('Warning: this does not look like an Anthropic API key (expected prefix: sk-ant-...).');
      console.log('Continuing — if incorrect, you will see an auth error when running analysis.');
    }

    console.log();
    console.log('Your claude.ai plan:');
    console.log('  1. Pro (default)');
    console.log('  2. Max 5x');
    console.log('  3. Max 20x');
    console.log();

    const planInput = await rl.question('Enter plan [1]: ');

    console.log();
    console.log('Analysis model:');
    console.log('  1. Haiku (default) — fast and cheap (~$0.001/run). Accurate for most prompts.');
    console.log('  2. Sonnet — higher accuracy on complex or nuanced prompts (~$0.01/run).');
    console.log('     Use this if you find Haiku verdicts are consistently off for your tasks.');
    console.log('     You can also override per-run with --model.');
    console.log();

    const modelInput = await rl.question('Enter model [1]: ');
    rl.close();

    // Validate the API key before saving
    const validationSpinner = ora({ text: 'Validating API key…', color: 'cyan' }).start();
    try {
      const client = new Anthropic({ apiKey: trimmed });
      await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      });
      validationSpinner.succeed('API key valid.');
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        validationSpinner.fail('Invalid API key — not saved.');
        console.error('Get a valid key at: https://console.anthropic.com');
        process.exit(1);
      }
      // Network errors: warn but still save (key may be valid)
      validationSpinner.warn('Could not validate key (network error) — saving anyway.');
    }

    const planChoice = planInput.trim() || '1';
    const planMap: Record<string, number> = { '1': 1, '2': 5, '3': 20, pro: 1, max5: 5, max20: 20 };
    const multiplier = planMap[planChoice.toLowerCase()] ?? 1;
    const planName: Record<number, string> = { 1: 'Pro', 5: 'Max 5x', 20: 'Max 20x' };

    const modelChoice = modelInput.trim() || '1';
    const analysisModel = modelChoice === '2' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5';
    const modelName: Record<string, string> = {
      'claude-haiku-4-5': 'Haiku (fast)',
      'claude-sonnet-4-6': 'Sonnet (accurate)',
    };

    setApiKey(trimmed);
    setPlanMultiplier(multiplier);
    setAnalysisModel(analysisModel);
    console.log();
    console.log(`API key saved. Plan set to: ${planName[multiplier] ?? `${multiplier}x`}. Model set to: ${modelName[analysisModel]}.`);
    console.log('You can now use claude-check.');
  });

program.parse();
