import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeVerdict } from '../display.js';

describe('computeVerdict — haiku (bonus=0), pro plan (multiplier=1)', () => {
  test('safe when effective >= 75', () => {
    assert.equal(computeVerdict(100, 1, 'claude-haiku-4-5'), 'safe');
    assert.equal(computeVerdict(75, 1, 'claude-haiku-4-5'), 'safe');
    assert.equal(computeVerdict(80, 1, 'claude-haiku-4-5'), 'safe');
  });

  test('caution when effective is 40–74', () => {
    assert.equal(computeVerdict(74, 1, 'claude-haiku-4-5'), 'caution');
    assert.equal(computeVerdict(50, 1, 'claude-haiku-4-5'), 'caution');
    assert.equal(computeVerdict(40, 1, 'claude-haiku-4-5'), 'caution');
  });

  test('do-not-start when effective < 40', () => {
    assert.equal(computeVerdict(39, 1, 'claude-haiku-4-5'), 'do-not-start');
    assert.equal(computeVerdict(17, 1, 'claude-haiku-4-5'), 'do-not-start');
    assert.equal(computeVerdict(0, 1, 'claude-haiku-4-5'), 'do-not-start');
  });
});

describe('computeVerdict — plan multiplier scales effective capacity', () => {
  test('Max 5x: 20% remaining → effective 100 → safe', () => {
    assert.equal(computeVerdict(20, 5, 'claude-haiku-4-5'), 'safe');
  });

  test('Max 5x: 10% remaining → effective 50 → caution', () => {
    assert.equal(computeVerdict(10, 5, 'claude-haiku-4-5'), 'caution');
  });

  test('Max 5x: 7% remaining → effective 35 → do-not-start', () => {
    assert.equal(computeVerdict(7, 5, 'claude-haiku-4-5'), 'do-not-start');
  });

  test('Max 20x: 5% remaining → effective 100 → safe', () => {
    assert.equal(computeVerdict(5, 20, 'claude-haiku-4-5'), 'safe');
  });
});

describe('computeVerdict — model threshold bonuses', () => {
  test('sonnet (bonus=10): safe threshold is 85', () => {
    assert.equal(computeVerdict(85, 1, 'claude-sonnet-4-6'), 'safe');
    assert.equal(computeVerdict(84, 1, 'claude-sonnet-4-6'), 'caution');
  });

  test('sonnet (bonus=10): caution threshold is 50', () => {
    assert.equal(computeVerdict(50, 1, 'claude-sonnet-4-6'), 'caution');
    assert.equal(computeVerdict(49, 1, 'claude-sonnet-4-6'), 'do-not-start');
  });

  test('opus (bonus=20): safe threshold is 95', () => {
    assert.equal(computeVerdict(95, 1, 'claude-opus-4-6'), 'safe');
    assert.equal(computeVerdict(94, 1, 'claude-opus-4-6'), 'caution');
  });

  test('opus (bonus=20): caution threshold is 60', () => {
    assert.equal(computeVerdict(60, 1, 'claude-opus-4-6'), 'caution');
    assert.equal(computeVerdict(59, 1, 'claude-opus-4-6'), 'do-not-start');
  });

  test('unknown model defaults to bonus=0 (same as haiku)', () => {
    assert.equal(computeVerdict(75, 1, 'unknown-model'), 'safe');
    assert.equal(computeVerdict(74, 1, 'unknown-model'), 'caution');
    assert.equal(computeVerdict(39, 1, 'unknown-model'), 'do-not-start');
  });
});

describe('computeVerdict — session (5-hour) window constrains verdict', () => {
  test('high weekly but nearly exhausted session → do-not-start', () => {
    // weekly 90% remaining (safe), but session 90% used → 10% session left → effective=10
    assert.equal(computeVerdict(90, 1, 'claude-haiku-4-5', 90), 'do-not-start');
  });

  test('low weekly, fresh session → weekly is the binding constraint', () => {
    // weekly 20% (do-not-start), session 0% used → session effective=100 → weekly wins
    assert.equal(computeVerdict(20, 1, 'claude-haiku-4-5', 0), 'do-not-start');
  });

  test('both high → safe', () => {
    assert.equal(computeVerdict(90, 1, 'claude-haiku-4-5', 10), 'safe');
  });

  test('session absent → only weekly used', () => {
    assert.equal(computeVerdict(80, 1, 'claude-haiku-4-5', undefined), 'safe');
    assert.equal(computeVerdict(20, 1, 'claude-haiku-4-5', undefined), 'do-not-start');
  });

  test('session + multiplier: 50% session used, Max 5x → session effective=250 → weekly binds', () => {
    // weekly=10%, Max5x → weekly eff=50 (caution); session eff=250 → min=50 → caution
    assert.equal(computeVerdict(10, 5, 'claude-haiku-4-5', 50), 'caution');
  });
});
