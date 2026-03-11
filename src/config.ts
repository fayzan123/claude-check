import Conf from 'conf';

const config = new Conf({
  projectName: 'claude-check',
});

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
