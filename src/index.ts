#!/usr/bin/env node

import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import ora from 'ora';
import Anthropic from '@anthropic-ai/sdk';
import { getApiKey, setApiKey } from './config.js';
import { getAutoUsage } from './usage.js';
import { analysePrompt } from './analyse.js';
import { renderResult } from './display.js';

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => { data += chunk; });
    stdin.on('end', () => resolve(data.trim()));
  });
}

const program = new Command();

program
  .name('claude-check')
  .description(
    'Analyse a prompt before sending it to Claude — estimates complexity, cost, and recommends the best model.'
  )
  .version('1.0.0')
  .argument('[prompt]', 'The prompt to analyse')
  .option('--limit <number>', 'Your remaining usage limit as a percentage (e.g. --limit 20)')
  .option('--breakdown', 'Always show task breakdown suggestions, even for LOW complexity')
  .option('--json', 'Output raw JSON instead of formatted terminal output')
  .option('--no-color', 'Plain text output, no terminal colours')
  .option('--model <model>', 'Override which Claude model to use for the analysis call')
  .action(async (promptArg: string | undefined, opts: {
    limit?: string;
    breakdown?: boolean;
    json?: boolean;
    color?: boolean;
    model?: string;
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

    // --- Auto-fetch claude.ai usage limit via Claude Code OAuth ---
    let limitPct: number | undefined;
    let limitAutoFetched = false;
    if (opts.limit !== undefined) {
      limitPct = Number(opts.limit);
    } else {
      const usage = await getAutoUsage();
      if (usage) {
        limitPct = 100 - usage.weeklyPct;
        limitAutoFetched = true;
      }
    }

    // --- Run analysis with spinner ---
    const spinner = opts.json || !process.stdout.isTTY
      ? null
      : ora({ text: 'Analysing prompt…', color: 'cyan' }).start();

    try {
      const result = await analysePrompt({ apiKey }, prompt, opts.model);
      spinner?.stop();

      if (opts.json) {
        console.log(JSON.stringify({ ...result, limit_pct: limitPct ?? null }, null, 2));
        return;
      }

      console.log(renderResult(result, {
        limitPct,
        limitAutoFetched,
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
  .description('Configure your Anthropic API key')
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
    rl.close();

    const trimmed = key.trim();
    if (!trimmed) {
      console.log('No key provided. Setup cancelled.');
      process.exit(1);
    }

    setApiKey(trimmed);
    console.log();
    console.log('API key saved successfully! You can now use claude-check.');
  });

program.parse();
