// Shared model definitions. Update here when Anthropic releases new model versions.
// Both prompts.ts and display.ts reference this to stay in sync.

export const MODEL_THRESHOLD_BONUS: Record<string, number> = {
  'claude-haiku-4-5': 0,
  'claude-sonnet-4-6': 10,
  'claude-opus-4-6': 20,
};
