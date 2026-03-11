# Contributing to claude-check

Thanks for your interest. Contributions are welcome.

---

## Running locally

```bash
git clone https://github.com/fayzan123/claude-check.git
cd claude-check
npm install
```

Build the TypeScript source:

```bash
npm run build
```

Run directly from the compiled output:

```bash
node dist/index.js "your prompt here"
```

Or run without a global install by invoking the entry point:

```bash
npm run build && node dist/index.js setup
```

---

## Running the test script

The test script runs analysis on five sample prompts and prints raw JSON results:

```bash
npx tsx scripts/test-analyse.ts
```

Requires a saved API key (`claude-check setup`) or a `ANTHROPIC_API_KEY` environment variable.

---

## The one hard rule

**No hardcoded API keys anywhere in the codebase. Ever.**

PRs containing real or test API keys will be rejected immediately, regardless of the rest of the change. API keys belong in the user's local config (written by `claude-check setup`) or in environment variables — never in source files.

This applies to all files: `.ts` source, scripts, test fixtures, config examples, and documentation.

---

## Submitting a PR

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Confirm `npm run build` exits with zero errors
4. Open a PR against `main`
5. Describe what changed and why — a sentence or two is enough for small changes, more context for larger ones

There are no formal tests yet. Manual verification against the build is sufficient for now.
