# BYOK + $3 1회 결제 잠금 해제 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 워커를 "라이선스 + 단어장 서버"로 재작성하고, 확장을 BYOK 전용으로 전환하며, $3 1회 결제로 저장 무제한·Leitner 복습·xlsx 내보내기를 잠금 해제한다.

**Architecture:** 확장은 AI 제공자를 사용자 키로 직접 호출한다(코드 이미 존재). 워커는 Google 토큰 검증 + Stripe 1회 결제 + KV 단어장(`words:<sub>` 값 하나)만 담당한다. 확장 서비스 워커가 로컬 미러 + 디바운스 큐로 서버와 동기화한다.

**Tech Stack:** Cloudflare Workers(KV, ESM), Stripe(`mode: 'payment'`), Chrome MV3, node:test(워커 순수 로직).

**Spec:** `branden/docs/superpowers/specs/2026-08-31-byok-one-time-unlock-design.md`

## Global Constraints

- **불변 조건: 워커에 AI 제공자 호출 코드 금지.** 완료 시 워커에서 `api.anthropic.com`·`generativelanguage`·`api.openai.com` 문자열이 grep 0건이어야 한다.
- 시크릿 `CLAUDE_API_KEY`·`ACCESS_CODES`는 삭제하고 재생성하지 않는다.
- 무료 저장 한도 **200**, 유료 상한 **20000**, 복습 무료 체험 **하루 3장**, 상세 스냅샷 항목당 **8192바이트**.
- Leitner 간격: box1=1일, box2=3일, box3=7일. `good`→box+1(최대3), `again`→box1.
- `/v1/*`는 전부 **POST**. 기존 라우터의 exact-match switch 스타일 유지.
- 확장 버전 **2.0.0**. `/success` 페이지는 **영어**. 확장 UI 문구는 한국어 유지.
- 워커 KV 네임스페이스는 기존 `LICENSES`(edf6a884…)를 그대로 쓴다.
- Stripe(sandbox): 1회성 Price **`price_1UARX7AFgSt5HQHAZdwbPvD1`** ($3, prod_VAn7E7IebYDblJ). 웹훅 엔드포인트 `we_1UAKkmAFgSt5HQHAGgOUkv5e`.
- 커밋 메시지 끝: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` (프로젝트 관례), 커밋은 `/home/branden/agent/chrome-extensions-samples` 루트에서.

---

### Task 1: 워커 순수 로직 모듈 (`lib.js`) — TDD

**Files:**
- Create: `branden/worker/lib.js`
- Create: `branden/worker/test/lib.test.js`
- Modify: `branden/worker/package.json` (test 스크립트)

**Interfaces:**
- Produces (Task 2가 import):
  - `FREE_WORD_LIMIT = 200`, `PAID_WORD_CAP = 20000`, `DETAIL_MAX_BYTES = 8192`, `BOX_INTERVAL_MS = {1: 86400000, 2: 259200000, 3: 604800000}`
  - `wordLimit(paid: boolean): number`
  - `applySaves(words, incoming, {paid, migrate, now}) → {words, saved: string[], rejected: string[]}`
  - `applyDeletes(words, list: string[]) → {words, removed: string[]}`
  - `applyReview(entry, grade: 'good'|'again', now) → {box, nextDue}`
- 단어 엔트리 형태: `{ savedAt, ko, detail|null, box, nextDue }`

- [ ] **Step 1: 실패하는 테스트 작성** — `branden/worker/test/lib.test.js`

```js
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
```

- [ ] **Step 2: `package.json`에 `"scripts": {"test": "node --test test/"}` 추가 후 실패 확인**

Run: `cd branden/worker && npm test`
Expected: FAIL — `Cannot find module '../lib.js'`

- [ ] **Step 3: `branden/worker/lib.js` 구현**

```js
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
    const word = String(item.word || '').trim().toLowerCase().slice(0, 60);
    if (!word) continue;

    let detail = item.detail ?? null;
    if (detail && JSON.stringify(detail).length > DETAIL_MAX_BYTES) detail = null;

    if (out[word]) {
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
    out[word] = { savedAt: now, ko: item.ko ?? null, detail, box: 1, nextDue: now };
    count += 1;
    saved.push(word);
  }
  return { words: out, saved, rejected };
}

export function applyDeletes(words, list) {
  const out = { ...words };
  const removed = [];
  for (const raw of list) {
    const word = String(raw || '').trim().toLowerCase();
    if (out[word]) {
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
```

- [ ] **Step 4: 테스트 통과 확인** — `cd branden/worker && npm test` → 전부 PASS
- [ ] **Step 5: 커밋** — `git add branden/worker/lib.js branden/worker/test/ branden/worker/package.json` 후 커밋 (메시지: 순수 로직을 분리해 node:test로 검증)

---

### Task 2: 워커 재작성 (`index.js`, `wrangler.toml`)

**Files:**
- Rewrite: `branden/worker/index.js` (전체 교체)
- Modify: `branden/worker/wrangler.toml`

**Interfaces:**
- Consumes: Task 1의 `lib.js` 전부
- Produces (확장이 호출, 전부 POST):
  - `POST /v1/me` → `{signedIn, email, paid, wordCount, limit}` (미로그인도 200)
  - `POST /v1/checkout` (auth) → `{url}` | 409 `{error:'ALREADY_PAID'}` | 401 `{error:'SIGN_IN_REQUIRED'}`
  - `POST /v1/words/list` (auth) → `{words: {<word>: entry}}`
  - `POST /v1/words/save` (auth) body `{words:[{word,ko?,detail?}], migrate?}` → `{saved, rejected, wordCount, limit}`
  - `POST /v1/words/delete` (auth) body `{words:[...]}` → `{removed, wordCount}`
  - `POST /v1/words/review` (auth) body `{word, grade:'good'|'again'}` → `{word, box, nextDue}` | 404 `{error:'NOT_SAVED'}`
  - `POST /stripe/webhook`, `GET /success`
- KV: `user:<sub>`, `words:<sub>`, `payment:<pi>`, `tok:<hash>` (스펙 데이터 모델 그대로)

- [ ] **Step 1: `index.js` 전체를 아래로 교체**

```js
// License + word-list server for the English→Korean Translator extension.
//
// INVARIANT: this Worker never calls an AI provider. Lookups run in the
// extension on the user's own key (BYOK); a $3 one-time payment unlocks
// software features only. Storing word text below is a KV write, not an
// AI call. If you find yourself adding a provider fetch here, the pricing
// model's premises (no lookup caps, no server cache, one-time charge)
// stop holding — see the spec before doing that.

import Stripe from 'stripe';
import {
  wordLimit, applySaves, applyDeletes, applyReview
} from './lib.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case '/v1/me':
          return await handleMe(request, env);
        case '/v1/checkout':
          return await handleCheckout(request, env);
        case '/v1/words/list':
          return await handleWordsList(request, env);
        case '/v1/words/save':
          return await handleWordsSave(request, env);
        case '/v1/words/delete':
          return await handleWordsDelete(request, env);
        case '/v1/words/review':
          return await handleWordsReview(request, env);
        case '/stripe/webhook':
          return await handleWebhook(request, env);
        case '/success':
          return handleSuccess(request);
        default:
          return json({ error: 'NOT_FOUND' }, 404);
      }
    } catch (err) {
      console.error(err.stack || String(err));
      return json({ error: 'SERVER_ERROR', message: err.message }, 500);
    }
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// --- Google identity ----------------------------------------
// Verifies an access token and pins the audience to our OAuth client so a
// token minted for another app cannot authenticate here. Verified results
// are cached 5 minutes so a burst of saves is one Google round trip.

async function verifyGoogleToken(env, token) {
  if (!token) return null;

  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token)
  );
  const cacheKey = `tok:${[...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;

  const cached = await env.LICENSES.get(cacheKey, 'json');
  if (cached) return cached;

  const res = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`
  );
  if (!res.ok) return null;

  const info = await res.json();
  if (info.aud !== env.GOOGLE_CLIENT_ID) {
    console.error('token audience mismatch', info.aud);
    return null;
  }
  if (!info.sub) return null;

  const user = { sub: info.sub, email: info.email || null };
  await env.LICENSES.put(cacheKey, JSON.stringify(user), {
    expirationTtl: 300
  });
  return user;
}

function bearer(request) {
  const h = request.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

async function requireUser(request, env) {
  if (request.method !== 'POST') return { resp: json({ error: 'METHOD' }, 405) };
  const user = await verifyGoogleToken(env, bearer(request));
  if (!user) return { resp: json({ error: 'SIGN_IN_REQUIRED' }, 401) };
  return { user };
}

async function loadRec(env, sub) {
  return (await env.LICENSES.get(`user:${sub}`, 'json')) || null;
}

async function loadWords(env, sub) {
  return (await env.LICENSES.get(`words:${sub}`, 'json')) || {};
}

// --- /v1/me -------------------------------------------------
// Never an error for signed-out callers: the extension probes this on
// startup and "not signed in" is a normal state, not a failure.

async function handleMe(request, env) {
  if (request.method !== 'POST') return json({ error: 'METHOD' }, 405);
  const user = await verifyGoogleToken(env, bearer(request));
  if (!user) {
    return json({ signedIn: false, email: null, paid: false, wordCount: 0, limit: wordLimit(false) });
  }
  const rec = await loadRec(env, user.sub);
  const paid = !!rec?.paid;
  return json({
    signedIn: true,
    email: user.email,
    paid,
    wordCount: rec?.wordCount ?? 0,
    limit: wordLimit(paid)
  });
}

// --- Words --------------------------------------------------

async function handleWordsList(request, env) {
  const { user, resp } = await requireUser(request, env);
  if (resp) return resp;
  return json({ words: await loadWords(env, user.sub) });
}

async function handleWordsSave(request, env) {
  const { user, resp } = await requireUser(request, env);
  if (resp) return resp;

  const body = await request.json().catch(() => ({}));
  const incoming = Array.isArray(body.words) ? body.words.slice(0, 100) : [];
  if (!incoming.length) return json({ error: 'BAD_REQUEST' }, 400);

  const rec = (await loadRec(env, user.sub)) || {
    sub: user.sub, email: user.email, paid: false, wordCount: 0
  };
  const words = await loadWords(env, user.sub);
  const result = applySaves(words, incoming, {
    paid: !!rec.paid,
    migrate: !!body.migrate,
    now: Date.now()
  });

  rec.email = user.email || rec.email;
  rec.wordCount = Object.keys(result.words).length;
  await env.LICENSES.put(`words:${user.sub}`, JSON.stringify(result.words));
  await env.LICENSES.put(`user:${user.sub}`, JSON.stringify(rec));

  return json({
    saved: result.saved,
    rejected: result.rejected,
    wordCount: rec.wordCount,
    limit: wordLimit(!!rec.paid)
  });
}

async function handleWordsDelete(request, env) {
  const { user, resp } = await requireUser(request, env);
  if (resp) return resp;

  const body = await request.json().catch(() => ({}));
  const list = Array.isArray(body.words) ? body.words.slice(0, 100) : [];
  if (!list.length) return json({ error: 'BAD_REQUEST' }, 400);

  const rec = (await loadRec(env, user.sub)) || {
    sub: user.sub, email: user.email, paid: false, wordCount: 0
  };
  const words = await loadWords(env, user.sub);
  const result = applyDeletes(words, list);

  rec.wordCount = Object.keys(result.words).length;
  await env.LICENSES.put(`words:${user.sub}`, JSON.stringify(result.words));
  await env.LICENSES.put(`user:${user.sub}`, JSON.stringify(rec));

  return json({ removed: result.removed, wordCount: rec.wordCount });
}

async function handleWordsReview(request, env) {
  const { user, resp } = await requireUser(request, env);
  if (resp) return resp;

  const body = await request.json().catch(() => ({}));
  const word = String(body.word || '').trim().toLowerCase();
  const grade = body.grade === 'again' ? 'again' : 'good';

  const words = await loadWords(env, user.sub);
  if (!words[word]) return json({ error: 'NOT_SAVED' }, 404);

  const next = applyReview(words[word], grade, Date.now());
  words[word] = { ...words[word], ...next };
  await env.LICENSES.put(`words:${user.sub}`, JSON.stringify(words));

  return json({ word, ...next });
}

// --- Stripe -------------------------------------------------

function getStripe(env) {
  // The default http client uses Node APIs that don't exist on Workers.
  // Pinned so responses keep one shape as the account default moves; note
  // webhook payloads follow the API version set on the ENDPOINT, not this
  // pin — we only read cs.payment_intent / charge.payment_intent, which
  // are stable across versions.
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
    apiVersion: '2024-11-20.acacia'
  });
}

async function handleCheckout(request, env) {
  const { user, resp } = await requireUser(request, env);
  if (resp) return resp;

  const rec = await loadRec(env, user.sub);
  if (rec?.paid) return json({ error: 'ALREADY_PAID' }, 409);

  const stripe = getStripe(env);
  const base = env.PUBLIC_BASE_URL;
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
    allow_promotion_codes: true,
    // The link between the Google account and the payment. The webhook
    // reads it back, so the two can never drift apart even if the user
    // pays with a different email than they signed in with.
    client_reference_id: user.sub,
    customer_email: user.email || undefined,
    success_url: `${base}/success`,
    cancel_url: `${base}/success?canceled=1`
  });
  return json({ url: session.url });
}

async function handleWebhook(request, env) {
  if (request.method !== 'POST') return json({ error: 'METHOD' }, 405);

  const stripe = getStripe(env);
  const sig = request.headers.get('stripe-signature');
  const body = await request.text();

  let event;
  try {
    // constructEventAsync, NOT constructEvent — Workers has no sync crypto.
    event = await stripe.webhooks.constructEventAsync(
      body, sig, env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return json({ error: 'BAD_SIGNATURE', message: err.message }, 400);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const cs = event.data.object;
      if (cs.mode !== 'payment') break;
      if (!cs.client_reference_id) {
        // Without it we cannot tell whose account this payment belongs to —
        // record the orphan loudly rather than silently dropping a paid unlock.
        console.error('checkout completed with no client_reference_id', cs.id);
        break;
      }
      const sub = cs.client_reference_id;
      const pi = typeof cs.payment_intent === 'string'
        ? cs.payment_intent
        : cs.payment_intent?.id || null;

      const rec = (await loadRec(env, sub)) || { sub, wordCount: 0 };
      rec.email = cs.customer_details?.email || rec.email || null;
      rec.paid = true;
      rec.purchasedAt = Date.now();
      rec.paymentIntentId = pi;
      await env.LICENSES.put(`user:${sub}`, JSON.stringify(rec));
      if (pi) await env.LICENSES.put(`payment:${pi}`, sub);
      break;
    }
    case 'charge.refunded': {
      const pi = event.data.object.payment_intent;
      if (!pi) break;
      const sub = await env.LICENSES.get(`payment:${pi}`);
      if (!sub) {
        console.error('refund for unknown payment_intent', pi);
        break;
      }
      const rec = await loadRec(env, sub);
      if (rec) {
        // Lock the features, keep the words — the data is the user's.
        rec.paid = false;
        await env.LICENSES.put(`user:${sub}`, JSON.stringify(rec));
      }
      break;
    }
  }
  return json({ received: true });
}

// --- /success -----------------------------------------------

function handleSuccess(request) {
  const url = new URL(request.url);
  const canceled = url.searchParams.get('canceled');
  const body = canceled
    ? '<h1>Payment canceled</h1><p>No charge was made. You can close this tab.</p>'
    : `<h1>Payment complete</h1>
       <p>Pro features are now unlocked.</p>
       <p class="hint">Close this tab and return to the extension. The unlock
       applies to the Google account you signed in with.<br>
       If it does not show up right away, use Refresh in Settings.</p>`;
  return new Response(
    `<!doctype html><meta charset="utf-8">
     <style>body{font-family:system-ui;max-width:28rem;margin:15vh auto;padding:0 1rem}
     .hint{color:#666;font-size:.9rem}</style>${body}`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}
```

- [ ] **Step 2: `wrangler.toml` 수정**
  - `STRIPE_PRICE_ID = "price_1UARX7AFgSt5HQHAZdwbPvD1"` 로 교체, 주석을 "1회성 Pro Unlock $3"로 갱신
  - `[[durable_objects.bindings]]` 블록 제거
  - 기존 `[[migrations]] tag="v1"`은 유지하고 **아래를 추가** (DO 클래스 제거에는 삭제 마이그레이션이 필요):

```toml
[[migrations]]
tag = "v2"
deleted_classes = ["UsageCounter"]
```

  - 시크릿 주석을 `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` 두 개만 남김

- [ ] **Step 3: 검증**

```bash
cd branden/worker && npm test && node --check index.js && npx wrangler deploy --dry-run
grep -cE "api\.anthropic\.com|generativelanguage|api\.openai\.com" index.js   # → 0 (grep exit 1)
```
Expected: 테스트 PASS, dry-run에 USAGE 바인딩 없음, grep 0건.

- [ ] **Step 4: 커밋** — index.js, wrangler.toml

---

### Task 3: 배포 + Stripe 웹훅 교체 + 시크릿 정리 (ops)

**Files:** 없음 (운영 작업)

- [ ] **Step 1: 배포** — `cd branden/worker && npx wrangler deploy`
- [ ] **Step 2: 웹훅 이벤트 교체**

```bash
stripe -p snaplingo webhook_endpoints update we_1UAKkmAFgSt5HQHAGgOUkv5e \
  -d "enabled_events[]=checkout.session.completed" \
  -d "enabled_events[]=charge.refunded"
```

- [ ] **Step 3: 시크릿 삭제** — `npx wrangler secret delete CLAUDE_API_KEY`, `npx wrangler secret delete ACCESS_CODES` (각각 확인 프롬프트 승인). `npx wrangler secret list` 결과에 `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`만 남아야 함.
- [ ] **Step 4: 스모크 테스트**

```bash
curl -s -X POST https://eng-ko-translator-proxy.mwmw77.workers.dev/v1/me
# → {"signedIn":false,"email":null,"paid":false,"wordCount":0,"limit":200}
curl -s -X POST https://eng-ko-translator-proxy.mwmw77.workers.dev/v1/words/list
# → 401 {"error":"SIGN_IN_REQUIRED"}
curl -s -X POST https://eng-ko-translator-proxy.mwmw77.workers.dev/v1/complete
# → 404 {"error":"NOT_FOUND"}   ← 프록시가 사라졌음을 확인
```

---

### Task 4: 확장에서 프록시·모드·미터링 제거

**Files:**
- Modify: `branden/manifest.json` (version → `2.0.0`)
- Modify: `branden/service-worker.js`
- Modify: `branden/options.html`, `branden/options.js`
- Modify: `branden/sidepanel.js`, `branden/sidepanel.html`

**Interfaces:**
- Produces: `resolveBackend()`는 항상 own-key. 반환 `{provider, settings}` 또는 `{error:'NO_API_KEY', provider}`.
- `proxyPost(path, body, token?)`은 **유지** (라이선스·단어장 호출용).

- [ ] **Step 1: `service-worker.js` 정리**
  - `getDeviceId()` 삭제, `SETTING_KEYS`에서 `'accessMode'` 제거
  - `resolveBackend()`에서 `accessMode` 분기 삭제 — 곧장 provider/키 검사로:

```js
async function resolveBackend() {
  const settings = await chrome.storage.sync.get(SETTING_KEYS);
  const provider = settings.aiProvider || 'gemini';
  const keyMap = {
    claude: settings.apiKey,
    gemini: settings.geminiKey,
    openai: settings.openaiKey
  };
  if (!keyMap[provider]) return { error: 'NO_API_KEY', provider };
  return { provider, settings };
}
```
  - `fetchWordDetail`/`fetchPhraseDetail`에서 `mode === 'pro'` 분기와 `quota` 수집 삭제 — 항상 `callOwnKey(...)`, 반환에서 `quota` 필드 제거
  - `callProxy()` 삭제. `proxyPost()`와 `getMe()`는 유지하되 `getMe()`에서 `deviceId` 전달 제거: `proxyPost('/v1/me', {}, await getCachedGoogleToken())`
  - `openCheckout()` 유지 (그대로 동작 — 워커가 payment 모드로 바뀜)
  - 온인스톨 정리 추가 (파일 상단 `chrome.sidePanel...` 아래):

```js
chrome.runtime.onInstalled.addListener(() => {
  // v1 stored an accessMode toggle; the proxy it selected no longer exists.
  chrome.storage.sync.remove('accessMode');
});
```

- [ ] **Step 2: `options.html`** — Mode 섹션(라디오 2개 + 힌트) 삭제, `own-key-sections`의 `hidden` 클래스 제거(항상 표시). Pro 섹션(plan-box, upgrade-btn, portal-btn, account-links)은 **삭제하지 말고 id 유지** — Task 8이 구매 UI로 재구성한다. `upgrade-hint` 문구만 "$3 한 번 결제로 저장 무제한·복습·내보내기가 열립니다. AI 사용료는 본인 API 키로 별도 청구됩니다."로 교체.
- [ ] **Step 3: `options.js`** — `accessMode` 저장·로드·토글 코드 삭제, `applyMe()`에서 구독 문구(`이번 결제 주기`, `해지 예정`, `past_due`) 삭제(Task 8에서 재작성하므로 최소만 유지: signedIn 표시), `portalBtn` 리스너와 `OPEN_PORTAL` 참조 삭제.
- [ ] **Step 4: `sidepanel.html`/`sidepanel.js`** — `quota-badge` 요소·`updateQuotaBadge()`와 그 호출(36, 239, 242, 419, 684행 부근) 삭제. `ai-badge`는 provider 표시로 유지.
- [ ] **Step 5: `manifest.json`** — `"version": "2.0.0"`.
- [ ] **Step 6: 검증** — `node --check`(sw/options/sidepanel), `grep -n "accessMode\|callProxy\|deviceId" *.js` → 0건. Chrome에서 확장 새로고침 → Gemini 키로 단어 조회 동작.
- [ ] **Step 7: 커밋**

---

### Task 5: 서비스 워커 — 단어장 동기화 클라이언트

**Files:**
- Modify: `branden/service-worker.js`

**Interfaces:**
- Produces (sidepanel/options가 sendMessage로 사용):
  - `GET_ME {refresh?}` → `{signedIn, email, paid, wordCount, limit}` (storage.local `me` 캐시, refresh 시 서버 재조회)
  - `SAVE_WORD {word, ko?, detail?}` → `{ok:true}` | `{error:'SIGN_IN_REQUIRED'}` | `{error:'LIMIT_REACHED', wordCount, limit}`
  - `DELETE_WORD {word}` → `{ok:true}` | `{error:'SIGN_IN_REQUIRED'}`
  - `REVIEW_GRADE {word, grade}` → `{ok:true, box, nextDue}`
  - `SYNC_WORDS` → `{ok:true, wordCount}` | `{error:'SIGN_IN_REQUIRED'}`
- Produces (storage.local 키 — sidepanel이 onChanged로 구독):
  - `savedWords: {word: savedAt}` (미러), `reviewMeta: {word:{box,nextDue}}`
  - `me: {...서버응답, fetchedAt}`, `pendingWordOps: []`, `wordsMigrated: bool`, `limitNotice: {rejected, at}`
- 로컬 한도 선검사: `Object.keys(savedWords).length >= me.limit`이면 즉시 `LIMIT_REACHED` (서버는 백스톱)

- [ ] **Step 1: 동기화 모듈 추가** — `signOut()` 아래에:

```js
// --- Word-list sync ----------------------------------------
// The server owns the word list; storage.local holds a mirror so the panel
// renders instantly and works offline. Writes are optimistic: mirror first,
// queue the op, flush after a debounce (KV allows ~1 write/sec per key).
// A rejected save (limit) reverts the mirror and posts a limitNotice.

let flushTimer = null;
const FLUSH_DELAY_MS = 1500;

async function localGet(keys) {
  return chrome.storage.local.get(keys);
}

async function getMeCached(refresh = false) {
  const { me } = await localGet('me');
  if (me && !refresh && Date.now() - (me.fetchedAt || 0) < 60_000) return me;
  try {
    const token = await getCachedGoogleToken();
    const fresh = await proxyPost('/v1/me', {}, token);
    const stamped = { ...fresh, fetchedAt: Date.now() };
    await chrome.storage.local.set({ me: stamped });
    return stamped;
  } catch (err) {
    // Server unreachable: trust the last known answer. A network blip must
    // never lock a paying user out of their own word list (spec: 오류 처리).
    if (me) return me;
    return { signedIn: false, email: null, paid: false, wordCount: 0, limit: 200 };
  }
}

async function enqueueOp(op) {
  const { pendingWordOps = [] } = await localGet('pendingWordOps');
  pendingWordOps.push(op);
  await chrome.storage.local.set({ pendingWordOps });
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => flushOps().catch(console.error), FLUSH_DELAY_MS);
}

async function flushOps() {
  const token = await getCachedGoogleToken();
  if (!token) return; // stays queued until next sign-in/flush

  const { pendingWordOps = [] } = await localGet('pendingWordOps');
  if (!pendingWordOps.length) return;
  await chrome.storage.local.set({ pendingWordOps: [] });

  const saves = pendingWordOps.filter((o) => o.op === 'save');
  const dels = pendingWordOps.filter((o) => o.op === 'delete').map((o) => o.word);
  const grades = pendingWordOps.filter((o) => o.op === 'review');

  try {
    if (saves.length) {
      const res = await proxyPost('/v1/words/save', {
        words: saves.map(({ word, ko, detail }) => ({ word, ko, detail })),
        migrate: saves.some((s) => s.migrate) || undefined
      }, token);
      if (res.rejected?.length) {
        const { savedWords = {} } = await localGet('savedWords');
        for (const w of res.rejected) delete savedWords[w];
        await chrome.storage.local.set({
          savedWords,
          limitNotice: { rejected: res.rejected, at: Date.now() }
        });
      }
      if (typeof res.wordCount === 'number') {
        const me = await getMeCached();
        await chrome.storage.local.set({ me: { ...me, wordCount: res.wordCount } });
      }
    }
    if (dels.length) await proxyPost('/v1/words/delete', { words: dels }, token);
    for (const g of grades) {
      await proxyPost('/v1/words/review', { word: g.word, grade: g.grade }, token);
    }
  } catch (err) {
    // Network failure: put everything back for the next flush.
    const { pendingWordOps: cur = [] } = await localGet('pendingWordOps');
    await chrome.storage.local.set({ pendingWordOps: [...pendingWordOps, ...cur] });
    throw err;
  }
}

async function syncWords() {
  const token = await getCachedGoogleToken();
  if (!token) return { error: 'SIGN_IN_REQUIRED' };

  await migrateLegacySaved(token);
  await flushOps();

  const res = await proxyPost('/v1/words/list', {}, token);
  if (res.error) return res;

  const savedWords = {};
  const reviewMeta = {};
  const { wordDetails = {} } = await localGet('wordDetails');
  for (const [word, entry] of Object.entries(res.words || {})) {
    savedWords[word] = entry.savedAt;
    reviewMeta[word] = { box: entry.box || 1, nextDue: entry.nextDue || 0 };
    if (entry.detail && !wordDetails[word]) wordDetails[word] = entry.detail;
  }
  await chrome.storage.local.set({ savedWords, reviewMeta, wordDetails });
  const me = await getMeCached(true);
  return { ok: true, wordCount: me.wordCount };
}

// One-time import of the v1 chrome.storage.sync word list. Uploads
// EVERYTHING (migrate flag lifts the free limit — never drop a user's
// collection), then clears the old key so this can't run twice.
async function migrateLegacySaved(token) {
  const { wordsMigrated } = await localGet('wordsMigrated');
  if (wordsMigrated) return;

  const { savedWords: legacy = {} } = await chrome.storage.sync.get('savedWords');
  const entries = Object.entries(legacy);
  if (entries.length) {
    const { wordDetails = {}, translations = {} } = await localGet(['wordDetails', 'translations']);
    for (let i = 0; i < entries.length; i += 50) {
      const batch = entries.slice(i, i + 50).map(([word]) => ({
        word,
        ko: translations[word] || null,
        detail: wordDetails[word] || null
      }));
      await proxyPost('/v1/words/save', { words: batch, migrate: true }, token);
    }
    await chrome.storage.sync.remove('savedWords');
  }
  await chrome.storage.local.set({ wordsMigrated: true });
}
```

- [ ] **Step 2: 메시지 핸들러 추가** — 기존 onMessage 리스너에:

```js
if (message.type === 'GET_ME') {
  getMeCached(message.refresh).then(sendResponse);
  return true;
}
if (message.type === 'SAVE_WORD') {
  (async () => {
    const me = await getMeCached();
    if (!me.signedIn) return { error: 'SIGN_IN_REQUIRED' };
    const { savedWords = {} } = await localGet('savedWords');
    if (!savedWords[message.word] && Object.keys(savedWords).length >= me.limit) {
      return { error: 'LIMIT_REACHED', wordCount: Object.keys(savedWords).length, limit: me.limit };
    }
    const now = Date.now();
    savedWords[message.word] = now;
    const { reviewMeta = {} } = await localGet('reviewMeta');
    if (!reviewMeta[message.word]) reviewMeta[message.word] = { box: 1, nextDue: now };
    await chrome.storage.local.set({ savedWords, reviewMeta });
    await enqueueOp({ op: 'save', word: message.word, ko: message.ko, detail: message.detail });
    return { ok: true };
  })().then(sendResponse);
  return true;
}
if (message.type === 'DELETE_WORD') {
  (async () => {
    const me = await getMeCached();
    if (!me.signedIn) return { error: 'SIGN_IN_REQUIRED' };
    const { savedWords = {}, reviewMeta = {} } = await localGet(['savedWords', 'reviewMeta']);
    delete savedWords[message.word];
    delete reviewMeta[message.word];
    await chrome.storage.local.set({ savedWords, reviewMeta });
    await enqueueOp({ op: 'delete', word: message.word });
    return { ok: true };
  })().then(sendResponse);
  return true;
}
if (message.type === 'REVIEW_GRADE') {
  (async () => {
    const BOX_MS = { 1: 86400000, 2: 259200000, 3: 604800000 }; // lib.js와 동일 값
    const { reviewMeta = {} } = await localGet('reviewMeta');
    const cur = reviewMeta[message.word] || { box: 1 };
    const box = message.grade === 'good' ? Math.min((cur.box || 1) + 1, 3) : 1;
    const nextDue = Date.now() + BOX_MS[box];
    reviewMeta[message.word] = { box, nextDue };
    await chrome.storage.local.set({ reviewMeta });
    await enqueueOp({ op: 'review', word: message.word, grade: message.grade });
    return { ok: true, box, nextDue };
  })().then(sendResponse);
  return true;
}
if (message.type === 'SYNC_WORDS') {
  syncWords().then(sendResponse);
  return true;
}
```

  기존 `GET_ME` 핸들러(`getMe()` 호출)는 위로 대체, `getMe()` 함수 삭제. `signIn()`/`signOut()` 끝에 `me` 캐시 무효화 추가: `await chrome.storage.local.remove('me');` (기존 `notifyPlanChanged()` 앞).
- [ ] **Step 3: 검증** — `node --check service-worker.js`. 확장 새로고침 → SW 콘솔에서 `chrome.runtime.sendMessage({type:'GET_ME'}, console.log)` → limit 200 응답.
- [ ] **Step 4: 커밋**

---

### Task 6: 사이드패널 — 저장 흐름·카운터·내보내기 잠금

**Files:**
- Modify: `branden/sidepanel.js`, `branden/sidepanel.html`, `branden/sidepanel.css`

**Interfaces:**
- Consumes: Task 5의 메시지·storage.local 키 전부

- [ ] **Step 1: savedWords 소스를 sync → local로**
  - 초기 로드(98행): `chrome.storage.sync.get(['savedWords', ...])` → savedWords는 `chrome.storage.local.get('savedWords')`로 분리
  - sync.onChanged의 savedWords 블록(158행 부근) → local.onChanged 리스너로 이동, `limitNotice` 변경 시 알림 표시 추가
  - 패널 열릴 때 `chrome.runtime.sendMessage({type:'SYNC_WORDS'})` 1회 (PANEL_OPENED 옆)

- [ ] **Step 2: 별(저장) 클릭을 메시지로** — `toggleSaved(word)` 교체:

```js
function toggleSaved(word) {
  const saving = !savedWords[word];
  const type = saving ? 'SAVE_WORD' : 'DELETE_WORD';
  const payload = saving
    ? { type, word, ko: translations[word] || null, detail: wordDetails[word] || null }
    : { type, word };
  chrome.runtime.sendMessage(payload, (res) => {
    if (res?.error === 'SIGN_IN_REQUIRED') {
      showToast('단어 저장은 Google 로그인이 필요합니다. 설정에서 로그인하세요.');
      return;
    }
    if (res?.error === 'LIMIT_REACHED') {
      showToast(`무료는 ${res.limit}개까지 저장됩니다. $3 결제로 제한 없이 저장하세요.`);
      return;
    }
    // mirror 변경이 storage.onChanged로 되돌아와 렌더됨
  });
}
```
  `showToast(msg)`: `#status`에 4초 표시하는 8줄 헬퍼 (기존 statusEl 재사용).

- [ ] **Step 3: 카운터** — `updateSavedCount()` 확장:

```js
function updateSavedCount() {
  const n = Object.keys(savedWords).length;
  chrome.runtime.sendMessage({ type: 'GET_ME' }, (me) => {
    savedCountEl.textContent = me?.paid ? `${n}` : `${n}/${me?.limit ?? 200}`;
  });
}
```

- [ ] **Step 4: 내보내기 잠금** — export 리스너를:

```js
exportBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'GET_ME' }, (me) => {
    if (!me?.paid) {
      if (confirm('xlsx 내보내기는 Pro 기능입니다. $3 한 번 결제로 영구 해제할까요?\n(AI 사용료는 본인 API 키로 별도 청구됩니다)')) {
        chrome.runtime.sendMessage({ type: 'OPEN_CHECKOUT' }, () => {});
      }
      return;
    }
    exportToExcel();
  });
});
```

- [ ] **Step 5: 검증** — 새로고침 후: 미로그인 저장 → 로그인 안내 토스트. 로그인 후 저장 → 카운터 `1/200`, KV `words:<sub>`에 반영(`wrangler kv key get`). 삭제 → 카운터 감소.
- [ ] **Step 6: 커밋**

---

### Task 7: 복습 재작성 — Leitner + 무료 체험 3장

**Files:**
- Modify: `branden/sidepanel.js`, `branden/sidepanel.html`, `branden/sidepanel.css`

**Interfaces:**
- Consumes: `reviewMeta`, `REVIEW_GRADE`, `GET_ME`, `wordDetails`, `savedWords`

- [ ] **Step 1: `sidepanel.html`** — review-view 안 버튼 교체: `review-show`(정답 보기)는 유지, `review-next` 자리에 두 버튼:

```html
<button id="review-again" class="review-grade hidden">몰랐어요</button>
<button id="review-good" class="review-grade hidden">알았어요</button>
```
  잠금 오버레이 추가 (review-view 마지막):

```html
<div id="review-lock" class="hidden">
  <p>오늘의 무료 복습 3장을 모두 사용했습니다.</p>
  <p class="hint">$3 한 번 결제로 복습을 제한 없이 사용하세요.<br>AI 사용료는 본인 API 키로 별도 청구됩니다.</p>
  <button id="review-buy" class="primary-btn">$3로 잠금 해제</button>
</div>
```

- [ ] **Step 2: 세션 구성** — Review 탭 진입 시:

```js
function buildReviewSession() {
  const now = Date.now();
  reviewList = Object.keys(savedWords)
    .filter((w) => (reviewMeta[w]?.nextDue ?? 0) <= now)
    .sort((a, b) => (reviewMeta[a]?.nextDue ?? 0) - (reviewMeta[b]?.nextDue ?? 0));
  reviewIndex = 0;
  againQueue = [];
}
```
  (`reviewMeta`는 local.onChanged로 동기화되는 모듈 변수로 추가.) due 0건이면 `review-empty`에 "오늘 복습할 단어가 없습니다. 다음 복습: <가장 이른 nextDue 날짜>" 표시.

- [ ] **Step 3: 채점 흐름** — `알았어요/몰랐어요` 공통 핸들러:

```js
async function gradeCard(grade) {
  const word = reviewList[reviewIndex];
  chrome.runtime.sendMessage({ type: 'REVIEW_GRADE', word, grade }, () => {});
  if (grade === 'again') againQueue.push(word);
  advanceCard();
  await bumpTrialAndMaybeLock();
}

function advanceCard() {
  reviewIndex += 1;
  if (reviewIndex >= reviewList.length) {
    if (againQueue.length) {
      // Missed cards come back at the end of the same session (spec: 복습 설계).
      reviewList = againQueue;
      againQueue = [];
      reviewIndex = 0;
    } else {
      reviewCard.classList.add('hidden');
      reviewEmpty.classList.remove('hidden');
      reviewEmpty.textContent = '오늘 복습 완료!';
      return;
    }
  }
  showReviewCard(); // 기존 렌더 함수 재사용 (sidepanel.js:557)
}
```

  기존 함수와의 접합부 (정확한 수정 지점):
  - `startReview()`(543행): `reviewList = shuffle(...)` 를 `buildReviewSession()` 호출로 교체
  - `showReviewCard()`(557행): `reviewNextBtn.classList.add('hidden')` → 두 grade 버튼 hide로 교체
  - `review-show` 클릭 핸들러: 정답 표시 후 `reviewNextBtn` 대신 두 grade 버튼 show
  - `reviewNextBtn` 요소·리스너는 제거 (grade 버튼이 진행을 겸함)

- [ ] **Step 4: 무료 체험** —

```js
async function bumpTrialAndMaybeLock() {
  const me = await new Promise((r) => chrome.runtime.sendMessage({ type: 'GET_ME' }, r));
  if (me?.paid) return;
  const today = new Date().toDateString();
  const { reviewTrial = {} } = await chrome.storage.local.get('reviewTrial');
  const count = reviewTrial.date === today ? (reviewTrial.count || 0) + 1 : 1;
  await chrome.storage.local.set({ reviewTrial: { date: today, count } });
  if (count >= 3) showReviewLock();
}
```
  `showReviewLock()`: 카드 숨기고 `#review-lock` 표시. Review 탭 진입 시에도 count 확인해 이미 3이면 즉시 잠금. `review-buy` 클릭 → `OPEN_CHECKOUT`, 응답 error 시 `signInErrorMessage`류 안내(미로그인 → 로그인 유도).
- [ ] **Step 5: CSS** — `.review-grade`(나란히 2버튼, again은 회색·good은 보라), `#review-lock`(중앙 정렬 카드) 각 10줄 내외.
- [ ] **Step 6: 검증** — 미결제 계정: 3장 채점 후 잠금 화면. 결제 계정(KV에 paid 수동 세팅 가능): 제한 없음, `몰랐어요` 단어가 세션 끝에 재출제, KV에서 box/nextDue 갱신 확인. due 없는 상태 문구 확인.
- [ ] **Step 7: 커밋**

---

### Task 8: 옵션 페이지 — BYOK 온보딩 + $3 구매 UI

**Files:**
- Modify: `branden/options.html`, `branden/options.js`

**Interfaces:**
- Consumes: `GET_ME {refresh:true}`, `SIGN_IN`, `SIGN_OUT`, `OPEN_CHECKOUT`, `SYNC_WORDS`

- [ ] **Step 1: `options.html` 재구성** — 순서: ① API 키 섹션(최상단, "시작하기 — 무료 API 키 받기" 헤더 + Gemini 우선 안내 + 발급 링크 `https://aistudio.google.com/apikey`, Claude·OpenAI는 접힌 하단), ② Pro Unlock 카드(기존 plan-box id 재활용):

```html
<h2>Pro Unlock</h2>
<div id="plan-box">
  <div id="plan-tier">무료</div>
  <div id="plan-account" class="hint">로그인되지 않음</div>
  <div id="plan-usage" class="hint"></div>
</div>
<button id="upgrade-btn" class="primary-btn">$3로 영구 잠금 해제</button>
<div id="upgrade-hint" class="btn-hint">
  저장 무제한 · 복습 · xlsx 내보내기가 열립니다.
  AI 사용료는 본인 API 키로 별도 청구됩니다.
</div>
<div id="account-links">
  <a href="#" id="signin-link">Google 로그인</a>
  <a href="#" id="signout-link" class="hidden">로그아웃</a>
  <span class="sep">&middot;</span>
  <a href="#" id="refresh-link">새로고침</a>
</div>
<p class="hint">이전 버전의 액세스 코드를 보유하셨다면 문의해 주세요 — 무상으로 해제해 드립니다.</p>
```

- [ ] **Step 2: `options.js`의 `applyMe()` 재작성**

```js
function applyMe(me) {
  const signedIn = !!me?.signedIn;
  const paid = !!me?.paid;
  planTierEl.textContent = paid ? 'Pro (영구)' : '무료';
  planAccountEl.textContent = signedIn ? me.email || '로그인됨' : '로그인되지 않음';
  planUsageEl.textContent = signedIn
    ? paid ? `저장한 단어 ${me.wordCount}개` : `저장한 단어 ${me.wordCount}/${me.limit}개`
    : '저장·복습·내보내기는 로그인이 필요합니다';
  upgradeBtn.classList.toggle('hidden', paid);
  upgradeHint.classList.toggle('hidden', paid);
  signinLink.classList.toggle('hidden', signedIn);
  signoutLink.classList.toggle('hidden', !signedIn);
}
function refreshPlan() {
  chrome.runtime.sendMessage({ type: 'GET_ME', refresh: true }, applyMe);
}
```
  `upgradeBtn` 리스너의 오류 매핑에서 `ALREADY_SUBSCRIBED` → `ALREADY_PAID: '이미 구매하셨습니다.'`로. 로그인 성공 콜백에 `SYNC_WORDS` 호출 추가(이관 트리거). `signInErrorMessage()`·`NO_BROWSER_SIGNIN` 문구는 유지.
- [ ] **Step 3: 검증** — 옵션 열기 → 키 섹션이 먼저, Gemini 링크 동작. 미로그인 구매 → 로그인 유도. 로그인 → 이관 실행(기존 sync 단어가 서버로) → 카운트 표시. 구매 흐름은 Task 9에서.
- [ ] **Step 4: 커밋**

---

### Task 9: E2E 검증 + 패키징

**Files:**
- Create: `branden/english-to-korean-translator-v2.0.0.zip`

- [ ] **Step 1: 결제 E2E** — 확장에서 $3 결제(테스트 카드 4242…) → `/success` 영어 페이지 → 옵션 새로고침 → `Pro (영구)` → KV `user:<sub>`에 `paid:true`·`paymentIntentId`, `payment:<pi>` 색인 확인.
- [ ] **Step 2: 환불 E2E** — `echo yes | stripe -p snaplingo refunds create -d "payment_intent=<pi>"` → 옵션 새로고침 → 무료로 강등, 단어장 유지 확인.
- [ ] **Step 3: 스펙 테스트 목록 일괄 실행** — 스펙 "테스트" 절의 나머지 항목(한도 200/삭제 후 재저장/이관/다기기/디바운스/불변 조건 grep + `wrangler secret list`)을 하나씩 확인하고 결과 기록.
- [ ] **Step 4: zip 재빌드** — 기존 절차(스크래치에 복사, `jq 'del(.key)'`, 18파일)로 `english-to-korean-translator-v2.0.0.zip` 생성.
- [ ] **Step 5: 최종 커밋 + 푸시** — zip 포함 여부는 기존 관례(릴리스 zip 커밋)를 따르고, `git push`.
