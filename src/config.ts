import Conf from 'conf';
import type { UsageSnapshot } from './usage.js';

const config = new Conf({
  projectName: 'claude-check',
});

const USAGE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface UsageCache {
  snapshot: UsageSnapshot;
  fetchedAt: number;
}

export function getCachedUsage(): UsageSnapshot | null {
  const cached = config.get('usageCache') as UsageCache | undefined;
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > USAGE_CACHE_TTL_MS) return null;
  return cached.snapshot;
}

export function setCachedUsage(snapshot: UsageSnapshot): void {
  config.set('usageCache', { snapshot, fetchedAt: Date.now() });
  // Clear any rate-limit cooldown on success
  config.delete('usageRateLimitedUntil');
}

const RATE_LIMIT_COOLDOWN_MS = 60 * 1000; // 1 minute

export function isUsageRateLimited(): boolean {
  const until = config.get('usageRateLimitedUntil') as number | undefined;
  return until !== undefined && Date.now() < until;
}

export function setUsageRateLimited(): void {
  config.set('usageRateLimitedUntil', Date.now() + RATE_LIMIT_COOLDOWN_MS);
}

export function getApiKey(): string | undefined {
  return config.get('apiKey') as string | undefined;
}

export function setApiKey(key: string): void {
  config.set('apiKey', key);
}

export function getAuthToken(): string | undefined {
  return config.get('authToken') as string | undefined;
}

export function setAuthToken(token: string): void {
  config.set('authToken', token);
}

export function getPlanMultiplier(): number {
  return (config.get('planMultiplier') as number | undefined) ?? 1;
}

export function setPlanMultiplier(multiplier: number): void {
  config.set('planMultiplier', multiplier);
}

export function getAnalysisModel(): string {
  return (config.get('analysisModel') as string | undefined) ?? 'claude-haiku-4-5';
}

export function setAnalysisModel(model: string): void {
  config.set('analysisModel', model);
}
