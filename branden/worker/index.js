import Stripe from 'stripe';

// ============================================================
//  Config — these constants are the product's unit economics.
//  Change the numbers here; nothing downstream hardcodes them.
// ============================================================
const CONFIG = {
  // Fixed server-side ON PURPOSE. Never read the model from the request
  // body: a single leaked license would otherwise let anyone bill the
  // Anthropic account for Opus-tier calls.
  MODEL: 'claude-haiku-4-5-20251001',
  MAX_TOKENS: 1024,

  // No device cap: identity is a Google account, and sharing one means
  // sharing a password. That is self-limiting in a way a copyable key is not.
  FREE_DAILY_LIMIT: 10, // AI lookups/day before signing in or subscribing
  PRO_MONTHLY_LIMIT: 1000, // AI lookups/month for a paying subscriber

  // Keep serving this long after invoice.payment_failed so a expired card
  // doesn't instantly break a paying customer's extension.
  GRACE_MS: 3 * 24 * 3600_000
};

const DAY_MS = 24 * 3600_000;
const MONTH_MS = 30 * DAY_MS;

// ============================================================
//  Router
// ============================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    }

    try {
      switch (url.pathname) {
        case '/v1/complete':
          return await handleComplete(request, env);
        case '/v1/me':
          return await handleMe(request, env);
        case '/v1/checkout':
          return await handleCheckout(request, env);
        case '/v1/portal':
          return await handlePortal(request, env);
        case '/stripe/webhook':
          return await handleWebhook(request, env);
        case '/success':
          return await handleSuccess(request, env);
        default:
          return json({ error: 'NOT_FOUND' }, 404);
      }
    } catch (err) {
      console.error(err.stack || String(err));
      return json({ error: 'SERVER_ERROR', message: err.message }, 500);
    }
  }
};

// ============================================================
//  Google identity
// ============================================================

/**
 * Verifies a Google access token server-side and returns the caller.
 *
 * The audience check is the security boundary: without it, an access token
 * minted for ANY other Google app would authenticate here. Never trust an
 * identity the client asserts — only one Google itself vouches for.
 *
 * Results are cached briefly so a burst of word lookups is one Google
 * round-trip, not twenty.
 */
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

// ============================================================
//  Entitlement — the layer that sits between Stripe and the API
// ============================================================

function isActive(rec) {
  const now = Date.now();
  if (rec.status === 'active' || rec.status === 'trialing') {
    return now < rec.periodEnd;
  }
  // Card failed but the subscription is not dead yet.
  if (rec.status === 'past_due' || rec.status === 'unpaid') {
    return now < rec.periodEnd + CONFIG.GRACE_MS;
  }
  return false; // canceled, incomplete_expired, ...
}

/**
 * Resolves who is calling and what they are allowed to spend.
 *
 * Signed out: free tier metered on the device id. That is abusable by
 * reinstalling, which is an acceptable trade for letting a new user reach the
 * "aha" moment before being asked to sign in or pay.
 *
 * Signed in without a subscription: still free tier, but metered on the Google
 * account, so reinstalling no longer resets it.
 */
async function resolveEntitlement(env, user, deviceId) {
  if (!user) {
    if (!deviceId) return { error: 'NO_DEVICE_ID', status: 400 };
    return {
      tier: 'free',
      bucket: `free:${deviceId}`,
      limit: CONFIG.FREE_DAILY_LIMIT,
      windowMs: DAY_MS
    };
  }

  const rec = await env.LICENSES.get(`user:${user.sub}`, 'json');

  if (!rec || !isActive(rec)) {
    return {
      tier: 'free',
      signedIn: true,
      bucket: `freeuser:${user.sub}`,
      limit: CONFIG.FREE_DAILY_LIMIT,
      windowMs: DAY_MS,
      rec: rec || null
    };
  }

  return {
    tier: 'pro',
    signedIn: true,
    bucket: `pro:${user.sub}`,
    limit: CONFIG.PRO_MONTHLY_LIMIT,
    windowMs: MONTH_MS,
    rec
  };
}

/** Counts a use (or peeks) against the strongly-consistent DO counter. */
async function meter(env, bucket, limit, windowMs, peek = false) {
  const id = env.USAGE.idFromName(bucket);
  const stub = env.USAGE.get(id);
  const res = await stub.fetch('https://usage/', {
    method: 'POST',
    body: JSON.stringify({ limit, windowMs, peek })
  });
  return res.json();
}

/**
 * Give a consumed unit back. Called whenever the request fails for a reason
 * that is our fault, not the user's — otherwise an upstream 500 silently
 * bills a paying subscriber for a lookup they never received.
 */
async function refund(env, bucket) {
  const stub = env.USAGE.get(env.USAGE.idFromName(bucket));
  await stub
    .fetch('https://usage/', {
      method: 'POST',
      body: JSON.stringify({ refund: true })
    })
    .catch(() => {});
}

// ============================================================
//  /v1/complete — the only route that spends Anthropic credit
// ============================================================

async function handleComplete(request, env) {
  if (request.method !== 'POST') return json({ error: 'METHOD' }, 405);

  const body = await request.json();
  const user = await verifyGoogleToken(env, bearer(request));
  const deviceId = request.headers.get('x-device-id') || '';

  const ent = await resolveEntitlement(env, user, deviceId);
  if (ent.error) return json({ error: ent.error }, ent.status);

  const used = await meter(env, ent.bucket, ent.limit, ent.windowMs);
  if (!used.ok) {
    return json(
      {
        error: ent.tier === 'free' ? 'FREE_LIMIT_REACHED' : 'QUOTA_EXCEEDED',
        tier: ent.tier,
        signedIn: !!ent.signedIn,
        limit: ent.limit,
        resetAt: used.resetAt
      },
      429
    );
  }

  // Prompts live server-side: the extension sends structured intent, not raw
  // text. This stops a leaked license from being used as a general-purpose
  // Claude proxy, and lets prompts ship without a Web Store review cycle.
  const prompt = buildPrompt(body);
  if (!prompt) {
    await refund(env, ent.bucket);
    return json({ error: 'BAD_REQUEST' }, 400);
  }

  // Past this point the unit is spent, so every failure exit must refund it.
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CONFIG.MODEL,
        max_tokens: CONFIG.MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('anthropic error', response.status, text);
      await refund(env, ent.bucket);
      return json({ error: 'UPSTREAM_ERROR', status: response.status }, 502);
    }

    const data = await response.json();
    const raw = data?.content?.[0]?.text;
    if (!raw) {
      await refund(env, ent.bucket);
      return json({ error: 'EMPTY_RESPONSE' }, 502);
    }

    // The model occasionally emits unparseable JSON; that is not the user's
    // fault either.
    let detail;
    try {
      detail = parseJSON(raw);
    } catch {
      await refund(env, ent.bucket);
      return json({ error: 'BAD_MODEL_OUTPUT' }, 502);
    }

    return json({
      detail,
      tier: ent.tier,
      signedIn: !!ent.signedIn,
      remaining: used.remaining,
      resetAt: used.resetAt
    });
  } catch (err) {
    await refund(env, ent.bucket);
    throw err;
  }
}

// ============================================================
//  Prompts (moved out of the extension)
// ============================================================

function buildPrompt(body) {
  if (body.type === 'word' && body.word) {
    return wordPrompt(String(body.word).slice(0, 60), String(body.context || '').slice(0, 300));
  }
  if (body.type === 'phrase' && body.phrase) {
    return phrasePrompt(
      String(body.phrase).slice(0, 200),
      String(body.pageText || '').slice(0, 1500)
    );
  }
  return null;
}

function wordPrompt(word, context) {
  const ctxPart = context
    ? `\nSentence from webpage: "${context}"\nInclude contextSentence, contextKorean (문맥상 번역), contextExplanation (왜 이 의미인지) fields.\n`
    : '';

  return `English-Korean dictionary. Word: "${word}"${ctxPart}
Return ONLY valid JSON (no markdown):
{"definitions":[{"pos":"품사","meaning":"한국어 뜻","example":"example sentence"}],
"korean":"대표 번역",${context ? '"contextSentence":"원문","contextKorean":"문맥 번역","contextExplanation":"설명",' : ''}
"grammar":"문법 설명","nativeUsage":"사용법/뉘앙스",
"idioms":[{"expression":"...","meaning":"..."}],
"examples":[{"en":"...","ko":"..."}],
"synonyms":["..."],"antonyms":["..."]}
2-3 definitions, 2 idioms, 2 examples, 3 synonyms, 2 antonyms. Be concise.`;
}

function phrasePrompt(phrase, pageText) {
  const ctxPart = pageText ? `\nArticle excerpt:\n"${pageText}"\n` : '';

  return `English-Korean phrase tutor for Korean learners.${ctxPart}
The learner found this phrase in the article and doesn't understand it: "${phrase}"
Even though each word may be simple, the combined meaning is confusing.

Return ONLY valid JSON (no markdown):
{"phrase":"the phrase","korean":"한국어 번역",
"meaning":"이 표현이 전체적으로 무슨 뜻인지 한국어로 쉽게 설명",
"literal":"각 단어의 개별 뜻과 왜 합치면 다른 의미가 되는지 설명",
"contextMeaning":"이 글에서 이 표현이 구체적으로 어떤 의미로 쓰였는지 설명",
"usage":"격식/비격식, 어떤 상황에서 쓰는지, 주의할 점",
"examples":[{"en":"...","ko":"..."}],
"similar":["비슷한 표현1","비슷한 표현2"]}
2 examples, 2-3 similar expressions. Be concise.`;
}

function parseJSON(raw) {
  const text = raw.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  return JSON.parse(text);
}

// ============================================================
//  Subscription records — keyed by Google account, not by a key the
//  user has to keep. Nothing to copy, lose, or re-issue.
// ============================================================

async function putSub(env, rec) {
  await env.LICENSES.put(`user:${rec.sub}`, JSON.stringify(rec));
  await env.LICENSES.put(`customer:${rec.customerId}`, rec.sub);
}

async function findSubByCustomer(env, customerId) {
  const sub = await env.LICENSES.get(`customer:${customerId}`);
  if (!sub) return null;
  return env.LICENSES.get(`user:${sub}`, 'json');
}

// --- /v1/me: identity + plan + quota, never consumes quota --

async function handleMe(request, env) {
  if (request.method !== 'POST') return json({ error: 'METHOD' }, 405);

  const { deviceId } = await request.json().catch(() => ({}));
  const user = await verifyGoogleToken(env, bearer(request));
  const ent = await resolveEntitlement(env, user, deviceId || '');
  if (ent.error) return json({ error: ent.error, tier: 'free' }, ent.status);

  const usage = await meter(env, ent.bucket, ent.limit, ent.windowMs, true);
  return json({
    tier: ent.tier,
    signedIn: !!user,
    email: user?.email ?? null,
    limit: ent.limit,
    remaining: usage.remaining,
    resetAt: usage.resetAt,
    status: ent.rec?.status ?? null,
    periodEnd: ent.rec?.periodEnd ?? null,
    cancelAtPeriodEnd: ent.rec?.cancelAtPeriodEnd ?? false
  });
}

// ============================================================
//  Stripe routes
// ============================================================

function getStripe(env) {
  // The default http client uses Node APIs that don't exist on Workers.
  return new Stripe(env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
    apiVersion: '2024-11-20.acacia'
  });
}

async function handleCheckout(request, env) {
  if (request.method !== 'POST') return json({ error: 'METHOD' }, 405);

  // Sign-in is required BEFORE paying. Otherwise we would take money with no
  // idea which account the subscription belongs to.
  const user = await verifyGoogleToken(env, bearer(request));
  if (!user) return json({ error: 'SIGN_IN_REQUIRED' }, 401);

  const existing = await env.LICENSES.get(`user:${user.sub}`, 'json');
  if (existing && isActive(existing)) {
    return json({ error: 'ALREADY_SUBSCRIBED' }, 409);
  }

  const stripe = getStripe(env);
  const base = env.PUBLIC_BASE_URL;

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
    allow_promotion_codes: true,
    // This is the link between the Google account and the Stripe customer.
    // The webhook reads it back, so the two can never drift apart even if the
    // user pays with a different email than they signed in with.
    client_reference_id: user.sub,
    customer_email: user.email || undefined,
    success_url: `${base}/success`,
    cancel_url: `${base}/success?canceled=1`
  });

  return json({ url: session.url });
}

async function handlePortal(request, env) {
  if (request.method !== 'POST') return json({ error: 'METHOD' }, 405);

  const user = await verifyGoogleToken(env, bearer(request));
  if (!user) return json({ error: 'SIGN_IN_REQUIRED' }, 401);

  const rec = await env.LICENSES.get(`user:${user.sub}`, 'json');
  if (!rec) return json({ error: 'NO_SUBSCRIPTION' }, 404);

  const stripe = getStripe(env);
  const session = await stripe.billingPortal.sessions.create({
    customer: rec.customerId,
    return_url: env.PUBLIC_BASE_URL
  });
  return json({ url: session.url });
}

// --- Webhook ------------------------------------------------

async function handleWebhook(request, env) {
  if (request.method !== 'POST') return json({ error: 'METHOD' }, 405);

  const stripe = getStripe(env);
  const sig = request.headers.get('stripe-signature');
  const body = await request.text();

  let event;
  try {
    // constructEventAsync, NOT constructEvent — Workers has no sync crypto.
    event = await stripe.webhooks.constructEventAsync(
      body,
      sig,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return json({ error: 'BAD_SIGNATURE', message: err.message }, 400);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const cs = event.data.object;
      if (cs.mode !== 'subscription' || !cs.subscription) break;

      // client_reference_id was set to the Google sub at checkout creation.
      // Without it we cannot tell whose account this payment belongs to, so
      // record the orphan loudly rather than silently dropping a paid signup.
      if (!cs.client_reference_id) {
        console.error('checkout completed with no client_reference_id', cs.id);
        break;
      }

      const subscription = await stripe.subscriptions.retrieve(cs.subscription);
      await putSub(env, {
        sub: cs.client_reference_id,
        email: cs.customer_details?.email || null,
        customerId: cs.customer,
        subscriptionId: cs.subscription,
        status: subscription.status,
        periodEnd: subscription.current_period_end * 1000,
        cancelAtPeriodEnd: !!subscription.cancel_at_period_end,
        createdAt: Date.now()
      });
      break;
    }

    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const rec = await findSubByCustomer(env, subscription.customer);
      if (rec) {
        rec.status =
          event.type === 'customer.subscription.deleted'
            ? 'canceled'
            : subscription.status;
        rec.periodEnd = subscription.current_period_end * 1000;
        rec.cancelAtPeriodEnd = !!subscription.cancel_at_period_end;
        await putSub(env, rec);
      }
      break;
    }

    case 'invoice.payment_failed': {
      const inv = event.data.object;
      const rec = await findSubByCustomer(env, inv.customer);
      if (rec) {
        rec.status = 'past_due';
        await putSub(env, rec);
      }
      break;
    }
  }

  return json({ received: true });
}

// --- /success: shows the license key, no separate site needed

async function handleSuccess(request, env) {
  const url = new URL(request.url);

  if (url.searchParams.get('canceled')) {
    return html('결제가 취소되었습니다', '<p>이 탭을 닫으셔도 됩니다.</p>');
  }

  // There is no key to hand over: the subscription is attached to the Google
  // account that started checkout, and the webhook records it.
  return html(
    '결제 완료',
    `<p>구독이 활성화되었습니다.</p>
     <p class="hint">이 탭을 닫고 확장 프로그램으로 돌아가세요.
     로그인한 Google 계정에 자동으로 적용됩니다.<br>
     바로 반영되지 않으면 설정에서 새로고침하세요.</p>`
  );
}

// ============================================================
//  Durable Object — strongly consistent usage counter
//  (an in-memory Map does not work: each isolate counts separately)
// ============================================================

export class UsageCounter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const { limit, windowMs, peek, refund } = await request.json();
    const now = Date.now();

    let data = (await this.state.storage.get('c')) || { count: 0, resetAt: 0 };

    if (refund) {
      // Do not resurrect an expired window just to refund into it.
      if (now < data.resetAt && data.count > 0) {
        data.count--;
        await this.state.storage.put('c', data);
      }
      return Response.json({ ok: true, count: data.count });
    }

    if (now >= data.resetAt) {
      data = { count: 0, resetAt: now + windowMs };
    }

    if (peek) {
      return Response.json({
        ok: data.count < limit,
        remaining: Math.max(0, limit - data.count),
        resetAt: data.resetAt
      });
    }

    if (data.count >= limit) {
      return Response.json({ ok: false, remaining: 0, resetAt: data.resetAt });
    }

    data.count++;
    await this.state.storage.put('c', data);
    return Response.json({
      ok: true,
      remaining: limit - data.count,
      resetAt: data.resetAt
    });
  }
}

// ============================================================
//  Helpers
// ============================================================

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, x-license-key, x-device-id, stripe-signature'
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() }
  });
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function html(title, bodyHtml) {
  return new Response(
    `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:80px auto;padding:0 24px;color:#1a1a1a;line-height:1.6}
h1{font-size:22px;margin-bottom:8px}
code{display:block;background:#f5f3ff;border:2px solid #7c3aed;color:#5b21b6;
padding:14px;border-radius:8px;font-size:16px;word-break:break-all;margin:20px 0;user-select:all}
.hint{font-size:13px;color:#666}
</style></head><body><h1>${escapeHtml(title)}</h1>${bodyHtml}</body></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}
