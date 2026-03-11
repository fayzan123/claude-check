import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getCachedUsage, setCachedUsage, isUsageRateLimited, setUsageRateLimited } from './config.js';

const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

interface ClaudeCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface RateWindow {
  utilization: number;
  resets_at?: string;
}

interface UsageResponse {
  five_hour?: RateWindow;
  seven_day?: RateWindow;
  seven_day_opus?: RateWindow;
  seven_day_oauth_apps?: RateWindow;
}

export interface UsageSnapshot {
  sessionPct: number;
  weeklyPct: number;
  sessionResetsAt?: string;
  weeklyResetsAt?: string;
}

function parseCredentialJson(raw: string): ClaudeCredentials | null {
  const parsed = JSON.parse(raw) as {
    claudeAiOauth?: {
      accessToken?: string;
      refreshToken?: string;
      expiresAt?: number;
    };
  };
  const oauth = parsed.claudeAiOauth;
  if (!oauth?.accessToken || !oauth?.refreshToken || !oauth?.expiresAt) return null;
  return {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
  };
}

export function readClaudeCredentials(): ClaudeCredentials | null {
  // 1. Try macOS Keychain (used by Claude Code on macOS)
  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      ).toString().trim();
      return parseCredentialJson(raw);
    } catch {
      // keychain entry not found or security command failed — fall through
    }
  }

  // 2. Try credentials file (Linux / Windows / older Claude Code versions)
  try {
    const raw = readFileSync(CREDENTIALS_PATH, 'utf8');
    return parseCredentialJson(raw);
  } catch {
    return null;
  }
}

async function refreshAccessToken(refreshToken: string): Promise<string | null> {
  try {
    const res = await fetch('https://platform.claude.com/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: string };
    return data.access_token ?? null;
  } catch {
    return null;
  }
}

async function fetchUsage(accessToken: string, debug = false): Promise<UsageSnapshot | null> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'claude-code/1.1.0',
        },
      });

      if (res.status === 429) {
        if (attempt < MAX_ATTEMPTS - 1) {
          if (debug) process.stderr.write(`[claude-check debug] usage fetch rate-limited (attempt ${attempt + 1}), retrying…\n`);
          await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        // All retries exhausted — set cooldown so next run skips the API call
        if (debug) process.stderr.write('[claude-check debug] usage fetch rate-limited on all attempts, setting 1-min cooldown\n');
        setUsageRateLimited();
        return null;
      }

      if (!res.ok) {
        if (debug) {
          const body = await res.text().catch(() => '(unreadable)');
          process.stderr.write(`[claude-check debug] usage fetch failed: HTTP ${res.status} — ${body}\n`);
        }
        return null;
      }

      const data = (await res.json()) as UsageResponse;
      const toPercent = (v: number) => v > 1 ? Math.round(v) : Math.round(v * 100);
      return {
        sessionPct: toPercent(data.five_hour?.utilization ?? 0),
        weeklyPct: toPercent(data.seven_day?.utilization ?? 0),
        sessionResetsAt: data.five_hour?.resets_at,
        weeklyResetsAt: data.seven_day?.resets_at,
      };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Attempts to read Claude Code OAuth credentials and fetch current usage.
 * Returns null silently if Claude Code is not installed or credentials are invalid.
 */
export async function getAutoUsage(debug = false): Promise<UsageSnapshot | null> {
  // Return cached value if fresh (avoids rate limits on repeated runs)
  const cached = getCachedUsage();
  if (cached) {
    if (debug) process.stderr.write('[claude-check debug] using cached usage (< 5 min old)\n');
    return cached;
  }

  // Skip API call if we were recently rate-limited (1-min cooldown)
  if (isUsageRateLimited()) {
    if (debug) process.stderr.write('[claude-check debug] usage API rate-limit cooldown active, skipping fetch\n');
    return null;
  }

  const creds = readClaudeCredentials();
  if (!creds) {
    if (debug) process.stderr.write('[claude-check debug] no Claude Code credentials found\n');
    return null;
  }

  const now = Date.now();
  let token = creds.accessToken;

  // Refresh if expired (with 60s buffer)
  if (creds.expiresAt - 60_000 < now) {
    if (debug) process.stderr.write('[claude-check debug] token expired, attempting refresh\n');
    const refreshed = await refreshAccessToken(creds.refreshToken);
    if (!refreshed) {
      if (debug) process.stderr.write('[claude-check debug] token refresh failed\n');
      return null;
    }
    token = refreshed;
  }

  const snapshot = await fetchUsage(token, debug);
  if (snapshot) setCachedUsage(snapshot);
  return snapshot;
}
