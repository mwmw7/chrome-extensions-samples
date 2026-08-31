// License + word-list server for the English→Korean Translator extension.
//
// INVARIANT: this Worker never calls an AI provider. Lookups run in the
// extension on the user's own key (BYOK); a $3 one-time payment unlocks
// software features only. Storing word text below is a KV write, not an
// AI call. If you find yourself adding a provider fetch here, the pricing
// model's premises (no lookup caps, no server cache, one-time charge)
// stop holding — see the spec before doing that.

import Stripe from 'stripe';
import { wordLimit, applySaves, applyDeletes, applyReview } from './lib.js';

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
  if (request.method !== 'POST')
    return { resp: json({ error: 'METHOD' }, 405) };
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
    return json({
      signedIn: false,
      email: null,
      paid: false,
      wordCount: 0,
      limit: wordLimit(false)
    });
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
    sub: user.sub,
    email: user.email,
    paid: false,
    wordCount: 0
  };
  const words = await loadWords(env, user.sub);
  const result = applySaves(words, incoming, {
    paid: !!rec.paid,
    migrate: !!body.migrate,
    now: Date.now()
  });
  const wordCount = Object.keys(result.words).length;
  await env.LICENSES.put(`words:${user.sub}`, JSON.stringify(result.words));

  // Re-read immediately before the put: a checkout webhook can flip
  // paid:true in the gap between the read above and this write, and writing
  // back the stale `rec` would clobber that back to paid:false — a paying
  // user permanently locked out with no charge to resend. Take everything
  // from the fresh read except the fields this handler owns.
  const freshRec = (await loadRec(env, user.sub)) || {
    sub: user.sub,
    paid: false
  };
  freshRec.email = user.email || freshRec.email || null;
  freshRec.wordCount = wordCount;
  await env.LICENSES.put(`user:${user.sub}`, JSON.stringify(freshRec));

  return json({
    saved: result.saved,
    rejected: result.rejected,
    wordCount,
    limit: wordLimit(!!rec.paid)
  });
}

async function handleWordsDelete(request, env) {
  const { user, resp } = await requireUser(request, env);
  if (resp) return resp;

  const body = await request.json().catch(() => ({}));
  const list = Array.isArray(body.words) ? body.words.slice(0, 100) : [];
  if (!list.length) return json({ error: 'BAD_REQUEST' }, 400);

  const words = await loadWords(env, user.sub);
  const result = applyDeletes(words, list);
  const wordCount = Object.keys(result.words).length;
  await env.LICENSES.put(`words:${user.sub}`, JSON.stringify(result.words));

  // Same re-read-before-put as handleWordsSave — see comment there.
  const freshRec = (await loadRec(env, user.sub)) || {
    sub: user.sub,
    paid: false
  };
  freshRec.email = user.email || freshRec.email || null;
  freshRec.wordCount = wordCount;
  await env.LICENSES.put(`user:${user.sub}`, JSON.stringify(freshRec));

  return json({ removed: result.removed, wordCount });
}

// Accepts either the legacy single-word shape ({word, grade}) or a batch
// ({grades: [{word, grade}]}) — batching lets the client coalesce a burst of
// grades into one KV write instead of one rewrite-the-whole-map POST per
// card (KV allows ~1 write/sec/key; unbatched bursts can drop mutations).
async function handleWordsReview(request, env) {
  const { user, resp } = await requireUser(request, env);
  if (resp) return resp;

  const body = await request.json().catch(() => ({}));
  const isBatch = Array.isArray(body.grades);

  const items = isBatch
    ? body.grades.map((g) => ({
        word: String(g?.word || '')
          .trim()
          .toLowerCase(),
        grade: g?.grade === 'again' ? 'again' : 'good'
      }))
    : [
        {
          word: String(body.word || '')
            .trim()
            .toLowerCase(),
          grade: body.grade === 'again' ? 'again' : 'good'
        }
      ];

  const words = await loadWords(env, user.sub);
  const now = Date.now();
  const results = [];
  const notSaved = [];

  for (const { word, grade } of items) {
    if (!word || !Object.prototype.hasOwnProperty.call(words, word)) {
      notSaved.push(word);
      continue;
    }
    const next = applyReview(words[word], grade, now);
    words[word] = { ...words[word], ...next };
    results.push({ word, ...next });
  }

  if (!isBatch) {
    if (!results.length) return json({ error: 'NOT_SAVED' }, 404);
    await env.LICENSES.put(`words:${user.sub}`, JSON.stringify(words));
    return json({
      word: results[0].word,
      box: results[0].box,
      nextDue: results[0].nextDue
    });
  }

  if (results.length) {
    await env.LICENSES.put(`words:${user.sub}`, JSON.stringify(words));
  }
  return json({ results, notSaved });
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
      if (cs.mode !== 'payment') break;
      // Delayed-notification payment methods (e.g. bank debits) can
      // complete a Checkout Session before the payment itself settles —
      // don't unlock until Stripe confirms the money actually arrived.
      if (cs.payment_status !== 'paid') break;
      if (!cs.client_reference_id) {
        // Without it we cannot tell whose account this payment belongs to —
        // record the orphan loudly rather than silently dropping a paid unlock.
        console.error('checkout completed with no client_reference_id', cs.id);
        break;
      }
      const sub = cs.client_reference_id;
      const pi =
        typeof cs.payment_intent === 'string'
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
