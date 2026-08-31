/* global COMMON_WORDS, BASIC_WORDS, TOEFL_WORDS */
importScripts('common-words.js', 'toefl-words.js');

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error(err));

chrome.runtime.onInstalled.addListener(() => {
  // v1 stored an accessMode toggle; the proxy it selected no longer exists.
  chrome.storage.sync.remove('accessMode');
});

const PROXY_BASE = 'https://eng-ko-translator-proxy.mwmw77.workers.dev';

// --- Google sign-in ---------------------------------------

/**
 * Silent probe — returns a token only if one is already cached, so the common
 * path never shows UI. Failing here just means "not signed in yet", which is
 * why it stays quiet. Interactive sign-in lives in requestGoogleToken(), which
 * must be driven by a user gesture: Chrome rejects a prompt raised out of
 * nowhere.
 */
async function getCachedGoogleToken() {
  try {
    const res = await chrome.identity.getAuthToken({ interactive: false });
    return (typeof res === 'string' ? res : res?.token) || null;
  } catch {
    return null;
  }
}

/**
 * Interactive sign-in that keeps the underlying Chrome error. The reason
 * matters: a cancelled prompt and a browser that cannot sign in at all both
 * arrive here, and only the first is worth retrying.
 */
async function requestGoogleToken() {
  let res;
  try {
    res = await chrome.identity.getAuthToken({ interactive: true });
  } catch (err) {
    const detail = String(err?.message || err);
    console.error('[auth] sign-in failed:', detail);
    return { error: 'SIGN_IN_FAILED', detail };
  }

  const token = (typeof res === 'string' ? res : res?.token) || null;
  if (!token) {
    const detail = chrome.runtime.lastError?.message || 'no token returned';
    console.error('[auth] sign-in failed:', detail);
    return { error: 'SIGN_IN_FAILED', detail };
  }
  return { token };
}

/** Surfaces the underlying Chrome error instead of a generic failure. */
async function signIn() {
  const attempt = await requestGoogleToken();
  if (attempt.error) return attempt;
  const token = attempt.token;

  const me = await proxyPost('/v1/me', {}, token);
  if (!me.signedIn) {
    console.error('[auth] worker rejected the token', me);
    return { error: 'TOKEN_REJECTED', detail: JSON.stringify(me) };
  }
  await chrome.storage.local.remove('me');
  await notifyPlanChanged();
  return me;
}

/** Prints everything needed to diagnose an OAuth mismatch. */
function authDiagnostics() {
  const m = chrome.runtime.getManifest();
  const info = {
    extensionId: chrome.runtime.id,
    manifestClientId: m.oauth2?.client_id || '(없음)',
    scopes: m.oauth2?.scopes || [],
    hasKey: !!m.key,
    proxyBase: PROXY_BASE
  };
  console.log('[auth] diagnostics', info);
  return info;
}

/**
 * Revokes the cached token as well as clearing it. Without the revoke, the
 * next sign-in silently reuses the same account and "sign out" appears broken
 * to anyone switching accounts.
 */
async function signOut() {
  const token = await getCachedGoogleToken();
  if (token) {
    await chrome.identity.removeCachedAuthToken({ token }).catch(() => {});
    await fetch(
      `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
      { method: 'POST' }
    ).catch(() => {});
  }
  // Clear this device's account-scoped mirror/queue too, not just `me` —
  // otherwise a later sign-in with a DIFFERENT Google account flushes the
  // previous account's still-queued ops into the new account's word list.
  // Routed through the same mutex as SAVE_WORD/DELETE_WORD/REVIEW_GRADE:
  // those handlers do their storage read-modify-write inside serialized()
  // too, so without this, a write already in flight when sign-out starts
  // could still land its savedWords/reviewMeta write AFTER this clear runs
  // — resurrecting the old account's mirror right after we wiped it. Going
  // through the mutex makes this clear run after every mutation already
  // queued ahead of it, closing that specific race (a SAVE_WORD queued
  // AFTER sign-out is a separate, narrower case: it re-checks me.signedIn,
  // and `me` was just cleared, so it refetches and sees signed-out before
  // writing). The scheduled flush is cancelled inside the same block so a
  // debounced flush armed by that same in-flight write can't fire
  // afterward and repost the old account's pendingWordOps.
  // Ops queued in the last <1.5s before sign-out are lost; that's the
  // accepted tradeoff against cross-account contamination.
  // wordDetails/translations are per-page caches, not account data, so
  // they're kept.
  await serialized(async () => {
    clearTimeout(flushTimer);
    await chrome.storage.local.remove([
      'savedWords',
      'reviewMeta',
      'pendingWordOps',
      'me'
    ]);
  });
  await notifyPlanChanged();
  return { ok: true };
}

/**
 * The side panel and the options page each cache the plan they last saw, and
 * neither observes the other. Signing out in one left a stale "Pro" quota in
 * the other until something unrelated forced a refresh. Stamp a key both
 * already watch through storage.onChanged rather than adding a second
 * messaging path alongside it.
 */
async function notifyPlanChanged() {
  await chrome.storage.local.set({ planChangedAt: Date.now() });
}

// --- Word-list sync ----------------------------------------
// The server owns the word list; storage.local holds a mirror so the panel
// renders instantly and works offline. Writes are optimistic: mirror first,
// queue the op, flush after a debounce (KV allows ~1 write/sec per key).
// A rejected save (limit) reverts the mirror and posts a limitNotice.

let flushTimer = null;
const FLUSH_DELAY_MS = 1500;

// Serializes storage.local read-modify-write sequences that would otherwise
// race across await gaps when handlers interleave (e.g. two SAVE_WORD calls
// both reading savedWords before either writes it back). Callers must not
// call serialized() again from inside a function already running as one —
// the chain would await its own completion and hang. Each handler below
// calls it once for its own mutation, then (after that resolves) once more,
// separately, for enqueueOp's queue write — sequential, not nested.
let mutex = Promise.resolve();
function serialized(fn) {
  const p = mutex.then(fn, fn);
  mutex = p.catch(() => {});
  return p;
}

async function localGet(keys) {
  return chrome.storage.local.get(keys);
}

async function getMeCached(refresh = false) {
  const { me } = await localGet('me');
  if (me && !refresh && Date.now() - (me.fetchedAt || 0) < 60_000) return me;
  try {
    const token = await getCachedGoogleToken();
    const fresh = await proxyPost('/v1/me', {}, token);
    if (fresh?.error || typeof fresh.signedIn !== 'boolean') {
      // A worker 500 / edge 502 body ({error:...}, or HTML coerced to
      // {error:'HTTP 502'} by proxyPost) is not a real answer — trust the
      // last known-good `me` instead of caching the error body over it,
      // which would otherwise lock a paying user out during an outage.
      if (me) return me;
      return {
        signedIn: false,
        email: null,
        paid: false,
        wordCount: 0,
        limit: 200
      };
    }
    const stamped = { ...fresh, fetchedAt: Date.now() };
    await chrome.storage.local.set({ me: stamped });
    return stamped;
  } catch (err) {
    // Server unreachable: trust the last known answer. A network blip must
    // never lock a paying user out of their own word list (spec: 오류 처리).
    if (me) return me;
    return {
      signedIn: false,
      email: null,
      paid: false,
      wordCount: 0,
      limit: 200
    };
  }
}

async function enqueueOp(op) {
  await serialized(async () => {
    const { pendingWordOps = [] } = await localGet('pendingWordOps');
    pendingWordOps.push(op);
    await chrome.storage.local.set({ pendingWordOps });
  });
  clearTimeout(flushTimer);
  flushTimer = setTimeout(
    () => flushOps().catch(console.error),
    FLUSH_DELAY_MS
  );
}

async function flushOps() {
  const token = await getCachedGoogleToken();
  if (!token) return; // stays queued until next sign-in/flush

  const { pendingWordOps = [] } = await localGet('pendingWordOps');
  if (!pendingWordOps.length) return;
  await chrome.storage.local.set({ pendingWordOps: [] });

  const saves = pendingWordOps.filter((o) => o.op === 'save');
  const dels = pendingWordOps
    .filter((o) => o.op === 'delete')
    .map((o) => o.word);
  // Coalesce queued review grades per word — last grade wins, first-seen
  // order preserved via Map — so a burst of grades on one word becomes a
  // single batched POST instead of one rewrite-the-whole-map write per
  // grade (KV allows ~1 write/sec/key).
  const gradeByWord = new Map();
  for (const o of pendingWordOps) {
    if (o.op === 'review') gradeByWord.set(o.word, o.grade);
  }
  const grades = [...gradeByWord.entries()].map(([word, grade]) => ({
    word,
    grade
  }));

  // Ops not yet confirmed successful. Trimmed as each step succeeds so a
  // later failure — network OR a non-2xx JSON error body, since proxyPost
  // only throws on network failure — only requeues what's still outstanding
  // (spec: save 실패 시 클라이언트 큐에 남겨 재시도). Any failure throws (instead
  // of returning) so syncWords' caller sees it too, rather than silently
  // proceeding to overwrite the local mirror with a server list that's
  // still missing these ops.
  let remaining = [...pendingWordOps];

  try {
    if (saves.length) {
      const res = await proxyPost(
        '/v1/words/save',
        {
          words: saves.map(({ word, ko, detail }) => ({ word, ko, detail }))
        },
        token
      );
      if (res.error) throw new Error(res.error);
      if (res.rejected?.length) {
        // A definitive answer (limit reached), not a retryable failure —
        // revert the optimistic mirror instead of requeuing it.
        const { savedWords = {}, reviewMeta = {} } = await localGet([
          'savedWords',
          'reviewMeta'
        ]);
        for (const w of res.rejected) {
          delete savedWords[w];
          delete reviewMeta[w];
        }
        await chrome.storage.local.set({
          savedWords,
          reviewMeta,
          limitNotice: { rejected: res.rejected, at: Date.now() }
        });
      }
      if (typeof res.wordCount === 'number') {
        const me = await getMeCached();
        if (typeof me.signedIn === 'boolean' && me.signedIn) {
          await chrome.storage.local.set({
            me: { ...me, wordCount: res.wordCount }
          });
        }
      }
      // The server slices a save batch at 100 words. Only drop ops the
      // server actually acknowledged (saved or definitively rejected) —
      // anything past the slice stays in `remaining` and gets requeued
      // below instead of silently vanishing from the mirror's future.
      const acked = new Set([...(res.saved || []), ...(res.rejected || [])]);
      remaining = remaining.filter(
        (o) => o.op !== 'save' || !acked.has(o.word)
      );
    }
    if (dels.length) {
      const res = await proxyPost('/v1/words/delete', { words: dels }, token);
      if (res?.error) throw new Error(res.error);
      const acked = new Set(res?.removed || []);
      remaining = remaining.filter(
        (o) => o.op !== 'delete' || !acked.has(o.word)
      );
    }
    if (grades.length) {
      const res = await proxyPost('/v1/words/review', { grades }, token);
      if (res?.error) throw new Error(res.error);
      // notSaved is only a definitive "word doesn't exist" answer if there
      // is no save op for that word still outstanding in `remaining` (e.g.
      // requeued past the save endpoint's 100-word slice). If the save
      // just hasn't landed yet, notSaved here is a race, not a fact — keep
      // the review op queued so it retries once the save actually lands.
      const pendingSaveWords = new Set(
        remaining.filter((o) => o.op === 'save').map((o) => o.word)
      );
      const acked = new Set([
        ...(res?.results || []).map((r) => r.word),
        ...(res?.notSaved || []).filter((w) => !pendingSaveWords.has(w))
      ]);
      remaining = remaining.filter(
        (o) => o.op !== 'review' || !acked.has(o.word)
      );
    }
  } catch (err) {
    // Network failure, or a non-2xx JSON error body thrown above: put
    // everything not-yet-succeeded back for the next flush.
    const { pendingWordOps: cur = [] } = await localGet('pendingWordOps');
    await chrome.storage.local.set({ pendingWordOps: [...remaining, ...cur] });
    throw err;
  }

  if (remaining.length > 0) {
    // Everything above that ran succeeded, but some ops were outside a
    // server-side slice (e.g. > 100 saves) and never got an ack either
    // way. Requeue without throwing — a throw here would mislabel a
    // partial success as a failure — and reschedule so the next slice
    // goes out on its own debounce.
    const { pendingWordOps: cur = [] } = await localGet('pendingWordOps');
    await chrome.storage.local.set({ pendingWordOps: [...remaining, ...cur] });
    clearTimeout(flushTimer);
    flushTimer = setTimeout(
      () => flushOps().catch(console.error),
      FLUSH_DELAY_MS
    );
  }
}

async function syncWords() {
  const token = await getCachedGoogleToken();
  if (!token) return { error: 'SIGN_IN_REQUIRED' };

  try {
    await migrateLegacySaved(token);
  } catch (err) {
    // Migration must never look like success: abort without touching the
    // legacy copy so a retry can pick up where this left off
    // (spec: 사용자가 모은 것을 버리지 않는다).
    return { error: 'MIGRATION_FAILED', detail: String(err?.message || err) };
  }
  await flushOps();

  // flushOps no longer throws on unacked overflow (e.g. a save batch over
  // the server's 100-word slice) — it requeues and reschedules itself
  // instead (FIX 2). That means ops can still be outstanding here even
  // though flushOps returned normally. Fetching the server list now would
  // overwrite the mirror with a snapshot that's still missing those words,
  // wiping them from the panel until the deferred flush lands. Defer the
  // mirror replacement instead — the queue will keep draining on its own
  // timer, and a later SYNC_WORDS call reconciles once it's empty.
  const { pendingWordOps: stillPending = [] } =
    await localGet('pendingWordOps');
  if (stillPending.length) return { ok: true, deferred: true };

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
// collection), then clears the old key so this can't run twice. A failed
// batch aborts immediately, before the legacy copy is touched or the
// migrated flag is set, so a retry starts from the full untouched list
// instead of silently losing whatever didn't make it up
// (spec: 사용자가 모은 것을 버리지 않는다).
async function migrateLegacySaved(token) {
  const { wordsMigrated } = await localGet('wordsMigrated');
  if (wordsMigrated) return;

  const { savedWords: legacy = {} } =
    await chrome.storage.sync.get('savedWords');
  const entries = Object.entries(legacy);
  if (entries.length) {
    const { wordDetails = {}, translations = {} } = await localGet([
      'wordDetails',
      'translations'
    ]);
    for (let i = 0; i < entries.length; i += 50) {
      const batch = entries.slice(i, i + 50).map(([word]) => ({
        word,
        ko: translations[word] || null,
        detail: wordDetails[word] || null
      }));
      const res = await proxyPost(
        '/v1/words/save',
        { words: batch, migrate: true },
        token
      );
      if (res.error || !Array.isArray(res.saved)) {
        throw new Error(
          res.error || 'legacy word migration failed: unexpected response'
        );
      }
    }
    await chrome.storage.sync.remove('savedWords');
  }
  await chrome.storage.local.set({ wordsMigrated: true });
}

const memoryCache = new Map();
const BATCH_SIZE = 50;

const WORD_PROMPT = (word, context) => {
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
};

const PHRASE_PROMPT = (phrase, pageText) => {
  const ctxPart = pageText
    ? `\nArticle excerpt:\n"${pageText.slice(0, 1500)}"\n`
    : '';

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
};

// --- Tab navigation triggers ---

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.status === 'complete' &&
    tab.url &&
    tab.url.startsWith('http')
  ) {
    extractWordsFromTab(tabId);
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (tab.url && tab.url.startsWith('http')) {
      extractWordsFromTab(tabId);
    }
  });
});

// Message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'WORDS_EXTRACTED') {
    handleWords(message.words, message.contexts || {}, message.pageText || '');
  }
  if (message.type === 'PANEL_OPENED') {
    extractFromActiveTab();
  }
  if (message.type === 'FETCH_WORD_DETAIL') {
    fetchWordDetail(message.word, message.context).then(sendResponse);
    return true;
  }
  if (message.type === 'FETCH_PHRASE_DETAIL') {
    fetchPhraseDetail(message.phrase, message.pageText).then(sendResponse);
    return true;
  }
  if (message.type === 'GET_ME') {
    getMeCached(message.refresh).then(sendResponse, (err) =>
      sendResponse({
        error: 'GET_ME_FAILED',
        detail: String(err?.message || err)
      })
    );
    return true;
  }
  if (message.type === 'SAVE_WORD') {
    (async () => {
      const word = String(message.word || '')
        .trim()
        .toLowerCase()
        .slice(0, 60);
      // Storage mutation is serialized by itself; enqueueOp below serializes
      // its own queue write separately, once this has already resolved —
      // nesting the two would await on its own completion and hang.
      const result = await serialized(async () => {
        const me = await getMeCached();
        if (!me.signedIn) return { error: 'SIGN_IN_REQUIRED' };
        const { savedWords = {} } = await localGet('savedWords');
        const alreadySaved = Object.prototype.hasOwnProperty.call(
          savedWords,
          word
        );
        if (!alreadySaved && Object.keys(savedWords).length >= me.limit) {
          return {
            error: 'LIMIT_REACHED',
            wordCount: Object.keys(savedWords).length,
            limit: me.limit
          };
        }
        const now = Date.now();
        savedWords[word] = now;
        const { reviewMeta = {} } = await localGet('reviewMeta');
        if (!Object.prototype.hasOwnProperty.call(reviewMeta, word)) {
          reviewMeta[word] = { box: 1, nextDue: now };
        }
        await chrome.storage.local.set({ savedWords, reviewMeta });
        return { ok: true };
      });
      if (result.ok) {
        await enqueueOp({
          op: 'save',
          word,
          ko: message.ko,
          detail: message.detail
        });
      }
      return result;
    })().then(sendResponse, (err) =>
      sendResponse({
        error: 'SAVE_FAILED',
        detail: String(err?.message || err)
      })
    );
    return true;
  }
  if (message.type === 'DELETE_WORD') {
    (async () => {
      const word = String(message.word || '')
        .trim()
        .toLowerCase()
        .slice(0, 60);
      const result = await serialized(async () => {
        const me = await getMeCached();
        if (!me.signedIn) return { error: 'SIGN_IN_REQUIRED' };
        const { savedWords = {}, reviewMeta = {} } = await localGet([
          'savedWords',
          'reviewMeta'
        ]);
        delete savedWords[word];
        delete reviewMeta[word];
        await chrome.storage.local.set({ savedWords, reviewMeta });
        return { ok: true };
      });
      if (result.ok) {
        await enqueueOp({ op: 'delete', word });
      }
      return result;
    })().then(sendResponse, (err) =>
      sendResponse({
        error: 'DELETE_FAILED',
        detail: String(err?.message || err)
      })
    );
    return true;
  }
  if (message.type === 'REVIEW_GRADE') {
    (async () => {
      const word = String(message.word || '')
        .trim()
        .toLowerCase()
        .slice(0, 60);
      const result = await serialized(async () => {
        const BOX_MS = { 1: 86400000, 2: 259200000, 3: 604800000 }; // lib.js와 동일 값
        const { reviewMeta = {} } = await localGet('reviewMeta');
        const cur = reviewMeta[word] || { box: 1 };
        const box =
          message.grade === 'good' ? Math.min((cur.box || 1) + 1, 3) : 1;
        const nextDue = Date.now() + BOX_MS[box];
        reviewMeta[word] = { box, nextDue };
        await chrome.storage.local.set({ reviewMeta });
        return { ok: true, box, nextDue };
      });
      if (result.ok) {
        await enqueueOp({ op: 'review', word, grade: message.grade });
      }
      return result;
    })().then(sendResponse, (err) =>
      sendResponse({
        error: 'REVIEW_FAILED',
        detail: String(err?.message || err)
      })
    );
    return true;
  }
  if (message.type === 'SYNC_WORDS') {
    syncWords().then(sendResponse, (err) =>
      sendResponse({
        error: 'SYNC_FAILED',
        detail: String(err?.message || err)
      })
    );
    return true;
  }
  if (message.type === 'SIGN_IN') {
    signIn().then(sendResponse, (err) =>
      sendResponse({
        error: 'SIGN_IN_FAILED',
        detail: String(err?.message || err)
      })
    );
    return true;
  }
  if (message.type === 'AUTH_DIAGNOSTICS') {
    sendResponse(authDiagnostics());
    return true;
  }
  if (message.type === 'SIGN_OUT') {
    signOut().then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  if (message.type === 'OPEN_CHECKOUT') {
    openCheckout().then(sendResponse, (err) =>
      sendResponse({
        error: 'CHECKOUT_FAILED',
        detail: String(err?.message || err)
      })
    );
    return true;
  }
});

async function extractFromActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && tab.url.startsWith('http')) {
    extractWordsFromTab(tab.id);
  }
}

async function extractWordsFromTab(tabId) {
  // Try executeScript first (works with activeTab permission)
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const text = document.body.innerText;
        const matches = text.match(/\b[a-zA-Z]{2,}\b/g);
        if (!matches) return { words: [], contexts: {} };

        const words = [...new Set(matches.map((w) => w.toLowerCase()))].sort();

        const sentences = text
          .split(/[.!?\n]+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 10 && s.length < 300);
        const contexts = {};
        for (const word of words) {
          const regex = new RegExp('\\b' + word + '\\b', 'i');
          const sentence = sentences.find((s) => regex.test(s));
          if (sentence) {
            contexts[word] = sentence.slice(0, 200);
          }
        }

        const pageText = text.slice(0, 3000);
        return { words, contexts, pageText };
      }
    });
    const data = results[0]?.result;
    if (data && data.words && data.words.length > 0) {
      handleWords(data.words, data.contexts || {}, data.pageText || '');
      return;
    }
  } catch {
    // executeScript failed — fall through to content script fallback
  }

  // Fallback: ask the already-injected content script to re-extract
  try {
    const data = await chrome.tabs.sendMessage(tabId, { type: 'RE_EXTRACT' });
    if (data && data.words && data.words.length > 0) {
      handleWords(data.words, data.contexts || {}, data.pageText || '');
    }
  } catch {
    // Content script not available either
  }
}

// --- Google Translate pipeline ---

async function handleWords(words, contexts = {}, pageText = '') {
  await chrome.storage.session.set({
    status: 'Checking cache...',
    allWords: words,
    wordContexts: contexts,
    pageText
  });

  // 3-tier classification: basic (no label), intermediate, advanced
  const intermediateList = words.filter(
    (w) => COMMON_WORDS.has(w) && !BASIC_WORDS.has(w)
  );
  const advancedList = words.filter((w) => !COMMON_WORDS.has(w));
  const toeflList = words.filter((w) => TOEFL_WORDS.has(w));
  await chrome.storage.session.set({
    intermediateWords: intermediateList,
    advancedWords: advancedList,
    toeflWords: toeflList
  });

  const uncached = [];
  const cached = {};

  for (const word of words) {
    if (memoryCache.has(word)) {
      cached[word] = memoryCache.get(word);
    }
  }

  const remaining = words.filter((w) => !memoryCache.has(w));
  if (remaining.length > 0) {
    const stored = await chrome.storage.local.get('translations');
    const existing = stored.translations || {};
    for (const word of remaining) {
      if (existing[word]) {
        cached[word] = existing[word];
        memoryCache.set(word, existing[word]);
      } else {
        uncached.push(word);
      }
    }
  }

  if (Object.keys(cached).length > 0) {
    const stored = await chrome.storage.local.get('translations');
    const merged = { ...(stored.translations || {}), ...cached };
    await chrome.storage.local.set({ translations: merged });
  }

  if (uncached.length > 0) {
    const batches = chunk(uncached, BATCH_SIZE);
    for (let i = 0; i < batches.length; i++) {
      await chrome.storage.session.set({
        status: `Translating batch ${i + 1} of ${batches.length}...`
      });
      try {
        const results = await googleTranslateBatch(batches[i]);
        for (const [w, t] of Object.entries(results)) {
          memoryCache.set(w, t);
        }
        const stored = await chrome.storage.local.get('translations');
        const merged = { ...(stored.translations || {}), ...results };
        await chrome.storage.local.set({ translations: merged });
      } catch (err) {
        await chrome.storage.session.set({
          status: `Translation error: ${err.message}`
        });
        return;
      }
    }
  }

  await chrome.storage.session.set({ status: 'Translation complete!' });
}

async function googleTranslateBatch(words) {
  const results = {};
  const promises = words.map(async (word) => {
    const url =
      'https://translate.googleapis.com/translate_a/single' +
      `?client=gtx&sl=en&tl=ko&dt=t&q=${encodeURIComponent(word)}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Google Translate ${response.status}`);
    const data = await response.json();
    results[word] = data[0][0][0];
  });
  await Promise.all(promises);
  return results;
}

// --- Shared settings load -----------------------------------

const SETTING_KEYS = [
  'apiKey',
  'geminiKey',
  'openaiKey',
  'aiProvider',
  'geminiModel',
  'claudeModel',
  'openaiModel'
];

/** Resolves which own-key backend to use for word/phrase lookups. */
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

// --- On-demand word detail ----------------------------------

async function fetchWordDetail(word, context) {
  const backend = await resolveBackend();
  if (backend.error) return backend;
  const { provider, settings } = backend;

  // Cache — re-fetch if the context changed (different page/sentence)
  const stored = await chrome.storage.local.get('wordDetails');
  const existing = stored.wordDetails || {};
  if (existing[word]) {
    const cached = existing[word];
    const cachedCtx = cached.contextSentence || '';
    if (!context || cachedCtx === context) {
      return { detail: cached, provider, cached: true };
    }
  }

  try {
    const detail = await callOwnKey(
      WORD_PROMPT(word, context),
      provider,
      settings
    );

    const s = await chrome.storage.local.get('wordDetails');
    const merged = { ...(s.wordDetails || {}), [word]: detail };
    await chrome.storage.local.set({ wordDetails: merged });

    // If this word is already saved, the server's copy may predate this
    // detail (or have none) — push it up so the server matches what's
    // shown locally (spec: 없는 단어는 재조회 뒤 업로드). Normalized the same
    // way as SAVE_WORD/DELETE_WORD/REVIEW_GRADE and the server's own
    // slice(0,60) — otherwise a >60-char word's enqueued op would never
    // match the server's truncated echo in flushOps' ack sets and would
    // requeue forever.
    const normalized = String(word || '')
      .trim()
      .toLowerCase()
      .slice(0, 60);
    const { savedWords: sw = {} } = await localGet('savedWords');
    if (Object.prototype.hasOwnProperty.call(sw, normalized)) {
      const { translations: tr = {} } = await localGet('translations');
      await enqueueOp({
        op: 'save',
        word: normalized,
        ko: tr[normalized] || null,
        detail
      });
    }

    return { detail, provider };
  } catch (err) {
    return { error: err.message, provider };
  }
}

// --- On-demand phrase detail --------------------------------

async function fetchPhraseDetail(phrase, pageText) {
  const backend = await resolveBackend();
  if (backend.error) return backend;
  const { provider, settings } = backend;

  try {
    const detail = await callOwnKey(
      PHRASE_PROMPT(phrase, pageText),
      provider,
      settings
    );

    return { detail, provider };
  } catch (err) {
    return { error: err.message, provider };
  }
}

// --- Worker API (license + word list) ------------------------

async function proxyPost(path, body, tokenOverride) {
  const token = tokenOverride ?? (await getCachedGoogleToken());
  const response = await fetch(`${PROXY_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
  return response.json().catch(() => ({ error: `HTTP ${response.status}` }));
}

async function openCheckout() {
  // Checkout needs an account to attach the subscription to, so escalate to an
  // interactive sign-in rather than failing with SIGN_IN_REQUIRED.
  let token = await getCachedGoogleToken();
  if (!token) {
    // Carries the reason through, so the options page can tell a cancelled
    // prompt apart from a browser that has no Google sign-in to offer.
    const attempt = await requestGoogleToken();
    if (attempt.error) return attempt;
    token = attempt.token;
  }

  const result = await proxyPost('/v1/checkout', {}, token);
  if (result.url) chrome.tabs.create({ url: result.url });
  return result;
}

// --- Own-key providers --------------------------------------

async function callOwnKey(prompt, provider, settings) {
  if (provider === 'gemini') {
    return callGemini(
      prompt,
      settings.geminiKey,
      settings.geminiModel || 'gemini-2.5-flash'
    );
  }
  if (provider === 'openai') {
    return callOpenAI(
      prompt,
      settings.openaiKey,
      settings.openaiModel || 'gpt-4.1-mini'
    );
  }
  return callClaude(
    prompt,
    settings.apiKey,
    settings.claudeModel || 'claude-haiku-4-5-20251001'
  );
}

// --- Claude API ---

async function callClaude(prompt, apiKey, model) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error(
        'Claude API 할당량 초과 — API 사용량 및 billing을 확인하세요.'
      );
    }
    if (response.status === 401) {
      throw new Error('Claude API 키가 유효하지 않습니다.');
    }
    const err = await response.text();
    throw new Error(`Claude ${response.status}: ${err}`);
  }

  const data = await response.json();
  const raw = data.content[0].text;
  return parseJSON(raw);
}

// --- Gemini API ---

async function callGemini(prompt, apiKey, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048 }
    })
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        'Gemini API 키 인증 실패 — aistudio.google.com/apikey 에서 키를 생성했는지 확인하세요.'
      );
    }
    if (response.status === 429) {
      throw new Error(
        'Gemini API 할당량 초과 — billing을 활성화하거나 할당량을 확인하세요.'
      );
    }
    if (response.status === 403) {
      throw new Error('Gemini API 키가 유효하지 않거나 권한이 없습니다.');
    }
    const err = await response.text();
    throw new Error(`Gemini ${response.status}: ${err}`);
  }

  const data = await response.json();
  const raw = data.candidates[0].content.parts[0].text;
  return parseJSON(raw);
}

// --- OpenAI API ---

async function callOpenAI(prompt, apiKey, model) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      temperature: 0.3,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error(
        'OpenAI API 할당량 초과 — API 사용량 및 billing을 확인하세요.'
      );
    }
    if (response.status === 401) {
      throw new Error('OpenAI API 키가 유효하지 않습니다.');
    }
    const err = await response.text();
    throw new Error(`OpenAI ${response.status}: ${err}`);
  }

  const data = await response.json();
  const raw = data.choices[0].message.content;
  return parseJSON(raw);
}

// --- Shared JSON parser (strips markdown fences) ---

function parseJSON(raw) {
  const text = raw.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  return JSON.parse(text);
}

// --- Utility ---

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
