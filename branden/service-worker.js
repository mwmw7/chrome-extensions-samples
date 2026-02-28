/* global COMMON_WORDS, BASIC_WORDS, TOEFL_WORDS */
importScripts('common-words.js', 'toefl-words.js');

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// TODO: Replace with your actual Worker URL after `npx wrangler deploy`
const PROXY_URL = 'https://eng-ko-translator-proxy.mwmw77.workers.dev';

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

// --- On-demand word detail (Claude or Gemini) ---

async function fetchWordDetail(word, context) {
  const settings = await chrome.storage.sync.get([
    'apiKey',
    'geminiKey',
    'openaiKey',
    'aiProvider',
    'geminiModel',
    'claudeModel',
    'openaiModel',
    'accessMode',
    'accessCode'
  ]);
  const accessMode = settings.accessMode || 'pro';
  const provider =
    accessMode === 'pro' ? 'pro' : settings.aiProvider || 'claude';

  // Validate credentials
  if (accessMode === 'pro') {
    if (!settings.accessCode) {
      return { error: 'NO_ACCESS_CODE', provider: 'pro' };
    }
  } else {
    const apiKeyMap = {
      claude: settings.apiKey,
      gemini: settings.geminiKey,
      openai: settings.openaiKey
    };
    if (!apiKeyMap[provider]) {
      return { error: 'NO_API_KEY', provider };
    }
  }

  // Check cache — re-fetch if context changed (different page/sentence)
  const stored = await chrome.storage.local.get('wordDetails');
  const existing = stored.wordDetails || {};
  if (existing[word]) {
    const cached = existing[word];
    const cachedCtx = cached.contextSentence || '';
    const newCtx = context || '';
    if (!newCtx || cachedCtx === newCtx) {
      return { detail: cached, provider };
    }
  }

  try {
    const prompt = WORD_PROMPT(word, context);
    let detail;
    if (accessMode === 'pro') {
      detail = await callProxy(prompt, settings.accessCode);
    } else if (provider === 'gemini') {
      const model = settings.geminiModel || 'gemini-2.5-flash';
      detail = await callGemini(prompt, settings.geminiKey, model);
    } else if (provider === 'openai') {
      const model = settings.openaiModel || 'gpt-4.1-mini';
      detail = await callOpenAI(prompt, settings.openaiKey, model);
    } else {
      const claudeModel = settings.claudeModel || 'claude-haiku-4-5-20251001';
      detail = await callClaude(prompt, settings.apiKey, claudeModel);
    }

    // Cache (persistent)
    const s = await chrome.storage.local.get('wordDetails');
    const merged = { ...(s.wordDetails || {}), [word]: detail };
    await chrome.storage.local.set({ wordDetails: merged });

    return { detail, provider };
  } catch (err) {
    return { error: err.message, provider };
  }
}

// --- On-demand phrase detail ---

async function fetchPhraseDetail(phrase, pageText) {
  const settings = await chrome.storage.sync.get([
    'apiKey',
    'geminiKey',
    'openaiKey',
    'aiProvider',
    'geminiModel',
    'claudeModel',
    'openaiModel',
    'accessMode',
    'accessCode'
  ]);
  const accessMode = settings.accessMode || 'pro';
  const provider =
    accessMode === 'pro' ? 'pro' : settings.aiProvider || 'claude';

  // Validate credentials
  if (accessMode === 'pro') {
    if (!settings.accessCode) {
      return { error: 'NO_ACCESS_CODE', provider: 'pro' };
    }
  } else {
    const apiKeyMap = {
      claude: settings.apiKey,
      gemini: settings.geminiKey,
      openai: settings.openaiKey
    };
    if (!apiKeyMap[provider]) {
      return { error: 'NO_API_KEY', provider };
    }
  }

  try {
    const prompt = PHRASE_PROMPT(phrase, pageText);
    let detail;
    if (accessMode === 'pro') {
      detail = await callProxy(prompt, settings.accessCode);
    } else if (provider === 'gemini') {
      const model = settings.geminiModel || 'gemini-2.5-flash';
      detail = await callGemini(prompt, settings.geminiKey, model);
    } else if (provider === 'openai') {
      const model = settings.openaiModel || 'gpt-4.1-mini';
      detail = await callOpenAI(prompt, settings.openaiKey, model);
    } else {
      const claudeModel = settings.claudeModel || 'claude-haiku-4-5-20251001';
      detail = await callClaude(prompt, settings.apiKey, claudeModel);
    }
    return { detail, provider };
  } catch (err) {
    return { error: err.message, provider };
  }
}

// --- Proxy (Pro mode) ---

async function callProxy(prompt, accessCode) {
  const response = await fetch(PROXY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-access-code': accessCode
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const code = data.error || `HTTP ${response.status}`;
    if (code === 'NO_ACCESS_CODE' || code === 'INVALID_ACCESS_CODE') {
      throw new Error(code);
    }
    if (code === 'RATE_LIMITED') {
      throw new Error('RATE_LIMITED');
    }
    throw new Error(`Proxy error: ${code}`);
  }

  const data = await response.json();
  const raw = data.content[0].text;
  return parseJSON(raw);
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
