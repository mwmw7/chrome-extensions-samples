// Pure entitlement / word-list / review logic. No I/O, no Date.now() —
// callers pass `now` so this stays testable and the Worker stays thin.

export const FREE_WORD_LIMIT = 200;
export const PAID_WORD_CAP = 20000;
export const DETAIL_MAX_BYTES = 8192;
export const BOX_INTERVAL_MS = { 1: 86400000, 2: 259200000, 3: 604800000 };

export function wordLimit(paid) {
  return paid ? PAID_WORD_CAP : FREE_WORD_LIMIT;
}

/**
 * Merge incoming saves into the word map. Existing words update their
 * snapshot (ko/detail) without touching review state and without counting
 * against the limit; only NEW words consume quota. `migrate` lifts the free
 * limit (bulk import must never drop a user's existing collection) but the
 * abuse cap still applies.
 */
export function applySaves(words, incoming, { paid, migrate = false, now }) {
  const limit = migrate ? PAID_WORD_CAP : wordLimit(paid);
  const out = { ...words };
  const saved = [];
  const rejected = [];
  let count = Object.keys(out).length;

  for (const item of incoming) {
    const word = String(item.word || '')
      .trim()
      .toLowerCase()
      .slice(0, 60);
    if (!word) continue;

    let detail = item.detail ?? null;
    if (detail && JSON.stringify(detail).length > DETAIL_MAX_BYTES)
      detail = null;

    if (Object.prototype.hasOwnProperty.call(out, word)) {
      out[word] = {
        ...out[word],
        ko: item.ko ?? out[word].ko ?? null,
        detail: detail ?? out[word].detail ?? null
      };
      saved.push(word);
      continue;
    }

    if (count >= limit) {
      rejected.push(word);
      continue;
    }
    out[word] = {
      savedAt: now,
      ko: item.ko ?? null,
      detail,
      box: 1,
      nextDue: now
    };
    count += 1;
    saved.push(word);
  }
  return { words: out, saved, rejected };
}

export function applyDeletes(words, list) {
  const out = { ...words };
  const removed = [];
  for (const raw of list) {
    const word = String(raw || '')
      .trim()
      .toLowerCase()
      .slice(0, 60);
    if (Object.prototype.hasOwnProperty.call(out, word)) {
      delete out[word];
      removed.push(word);
    }
  }
  return { words: out, removed };
}

export function applyReview(entry, grade, now) {
  const box = grade === 'good' ? Math.min((entry.box || 1) + 1, 3) : 1;
  return { box, nextDue: now + BOX_INTERVAL_MS[box] };
}
