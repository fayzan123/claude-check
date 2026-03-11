import { analysePrompt } from '../src/analyse.js';
import { getApiKey } from '../src/config.js';
import { getAutoUsage } from '../src/usage.js';

const prompts = [
  'what is the capital of France',
  'summarise this paragraph for me',
  'refactor my entire Express app to use TypeScript and add tests',
  'build me a full e-commerce site with auth, payments, and an admin dashboard',
  'fix the typo in line 3 of my file',
];

async function main() {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.error('No API key configured. Run `claude-check setup` first.');
    process.exit(1);
  }

  // Show auto-fetched usage if available
  const usage = await getAutoUsage();
  if (usage) {
    console.log(`Auto-fetched claude.ai usage: ${usage.weeklyPct}% weekly used (${100 - usage.weeklyPct}% remaining)`);
  } else {
    console.log('No Claude Code credentials found — usage auto-fetch unavailable');
  }

  for (const prompt of prompts) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`PROMPT: "${prompt}"`);
    console.log('='.repeat(60));

    try {
      const result = await analysePrompt({ apiKey }, prompt);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error('ERROR:', err instanceof Error ? err.message : err);
    }
  }
}

main();
