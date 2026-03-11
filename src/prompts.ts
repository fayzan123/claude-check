export function preparePrompt(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= 500) return trimmed;
  return trimmed.slice(0, 500) + ' [truncated]';
}

export function buildMetaPrompt(userPrompt: string): string {
  const prepared = preparePrompt(userPrompt);
  return `Analyse this prompt. Reply with JSON only, no other text.

PROMPT: """${prepared}"""

JSON fields:
- complexity: LOW|MEDIUM|HIGH
- estimated_messages_min: int
- estimated_messages_max: int
- interrupt_risk: LOW|MEDIUM|HIGH
- interrupt_risk_reason: string (max 10 words)
- recommended_model: claude-haiku-4-5|claude-sonnet-4-6|claude-opus-4-6
- recommended_model_reason: string (max 10 words)
- breakdown: array of 2-4 strings (max 8 words each)`;
}
