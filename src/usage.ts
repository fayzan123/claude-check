import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
  accessToken: string;
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
      const raw = execSync(
        `security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`,
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

async function fetchUsage(accessToken: string): Promise<UsageSnapshot | null> {
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as UsageResponse;
    const toPercent = (v: number) => v > 1 ? Math.round(v) : Math.round(v * 100);
    return {
      sessionPct: toPercent(data.five_hour?.utilization ?? 0),
      weeklyPct: toPercent(data.seven_day?.utilization ?? 0),
      sessionResetsAt: data.five_hour?.resets_at,
      weeklyResetsAt: data.seven_day?.resets_at,
      accessToken,
    };
  } catch {
    return null;
  }
}

/**
 * Attempts to read Claude Code OAuth credentials and fetch current usage.
 * Returns null silently if Claude Code is not installed or credentials are invalid.
 */
export async function getAutoUsage(): Promise<UsageSnapshot | null> {
  const creds = readClaudeCredentials();
  if (!creds) return null;

  const now = Date.now();
  let token = creds.accessToken;

  // Refresh if expired (with 60s buffer)
  if (creds.expiresAt - 60_000 < now) {
    const refreshed = await refreshAccessToken(creds.refreshToken);
    if (!refreshed) return null;
    token = refreshed;
  }

  return fetchUsage(token);
}
