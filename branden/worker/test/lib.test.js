import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FREE_WORD_LIMIT, PAID_WORD_CAP, DETAIL_MAX_BYTES, BOX_INTERVAL_MS,
  wordLimit, applySaves, applyDeletes, applyReview
} from '../lib.js';

const NOW = 1788200000000;

test('wordLimit: free 200, paid 20000', () => {
  assert.equal(wordLimit(false), 200);
  assert.equal(wordLimit(true), 20000);
});

test('applySaves: new word gets box 1, due immediately', () => {
  const { words, saved, rejected } = applySaves({}, [{ word: 'agent', ko: '대리인' }], { paid: false, now: NOW });
  assert.deepEqual(saved, ['agent']);
  assert.deepEqual(rejected, []);
  assert.equal(words.agent.savedAt, NOW);
  assert.equal(words.agent.box, 1);
  assert.equal(words.agent.nextDue, NOW);
  assert.equal(words.agent.ko, '대리인');
});

test('applySaves: free user rejected past 200, counts only NEW words', () => {
  const existing = {};
  for (let i = 0; i < 199; i++) existing[`w${i}`] = { savedAt: 1, box: 1, nextDue: 1 };
  const { saved, rejected } = applySaves(
    existing,
    [{ word: 'w0' }, { word: 'a' }, { word: 'b' }],  // w0 은 기존 → 카운트 제외
    { paid: false, now: NOW }
  );
  assert.deepEqual(saved, ['w0', 'a']);   // 199 + a = 200 (한도 도달), b 거부
  assert.deepEqual(rejected, ['b']);
});

test('applySaves: existing word updates ko/detail, keeps review state', () => {
  const existing = { agent: { savedAt: 1, ko: null, detail: null, box: 3, nextDue: 99 } };
  const { words } = applySaves(existing, [{ word: 'agent', ko: '대리인', detail: { korean: '대리인' } }], { paid: false, now: NOW });
  assert.equal(words.agent.box, 3);
  assert.equal(words.agent.nextDue, 99);
  assert.equal(words.agent.savedAt, 1);
  assert.equal(words.agent.ko, '대리인');
  assert.deepEqual(words.agent.detail, { korean: '대리인' });
});

test('applySaves: migrate bypasses free limit but not the 20k cap', () => {
  const existing = {};
  for (let i = 0; i < 250; i++) existing[`w${i}`] = { savedAt: 1, box: 1, nextDue: 1 };
  const { saved } = applySaves(existing, [{ word: 'extra' }], { paid: false, migrate: true, now: NOW });
  assert.deepEqual(saved, ['extra']);
});

test('applySaves: oversized detail is dropped, word still saved', () => {
  const big = { x: 'y'.repeat(DETAIL_MAX_BYTES) };
  const { words, saved } = applySaves({}, [{ word: 'agent', detail: big }], { paid: true, now: NOW });
  assert.deepEqual(saved, ['agent']);
  assert.equal(words.agent.detail, null);
});

test('applyDeletes removes and reports', () => {
  const { words, removed } = applyDeletes({ a: {}, b: {} }, ['a', 'zzz']);
  assert.deepEqual(removed, ['a']);
  assert.deepEqual(Object.keys(words), ['b']);
});

test('applyReview: good climbs to 3 and holds; again drops to 1', () => {
  assert.deepEqual(applyReview({ box: 1 }, 'good', NOW), { box: 2, nextDue: NOW + BOX_INTERVAL_MS[2] });
  assert.deepEqual(applyReview({ box: 3 }, 'good', NOW), { box: 3, nextDue: NOW + BOX_INTERVAL_MS[3] });
  assert.deepEqual(applyReview({ box: 3 }, 'again', NOW), { box: 1, nextDue: NOW + BOX_INTERVAL_MS[1] });
  assert.deepEqual(applyReview({}, 'good', NOW), { box: 2, nextDue: NOW + BOX_INTERVAL_MS[2] }); // box 없음 = 1 취급
});
