/* global XLSX */
const statusEl = document.getElementById('status');
const wordCountEl = document.getElementById('word-count');
const searchInput = document.getElementById('search-input');
const wordListEl = document.getElementById('word-list');
const settingsLink = document.getElementById('settings-link');
const savedCountEl = document.getElementById('saved-count');
const listView = document.getElementById('list-view');
const reviewView = document.getElementById('review-view');
const phraseView = document.getElementById('phrase-view');
const aiBadge = document.getElementById('ai-badge');
const exportBtn = document.getElementById('export-btn');

let allWords = [];
let translations = {};
let intermediateWords = new Set();
let advancedWords = new Set();
let toeflWords = new Set();
let wordDetails = {};
let wordContexts = {}; // { word: "sentence from page" }
let pageText = ''; // truncated page content for phrase lookups
let savedWords = {}; // { word: timestamp }
let aiProvider = 'claude';
let accessMode = 'pro';
let openWord = null;
let currentTab = 'all'; // 'all' | 'saved' | 'review'
let currentFilter = 'all'; // 'all' | 'basic' | 'intermediate' | 'advanced' | 'toefl'

// Review state
let reviewList = [];
let reviewIndex = 0;

// --- On panel open: extract words from current tab immediately ---
chrome.runtime.sendMessage({ type: 'PANEL_OPENED' });

// Retry if no words arrived (handles late panel open after page load)
setTimeout(() => {
  if (allWords.length === 0) {
    chrome.runtime.sendMessage({ type: 'PANEL_OPENED' });
  }
}, 1500);

// --- Settings ---
settingsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// --- Tabs ---
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    currentTab = btn.dataset.tab;
    document
      .querySelectorAll('.tab')
      .forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    openWord = null;

    listView.classList.add('hidden');
    reviewView.classList.add('hidden');
    phraseView.classList.add('hidden');

    if (currentTab === 'review') {
      reviewView.classList.remove('hidden');
      startReview();
    } else if (currentTab === 'phrase') {
      phraseView.classList.remove('hidden');
    } else {
      listView.classList.remove('hidden');
      render();
    }

    // Show export button only on Saved tab
    if (currentTab === 'saved') {
      exportBtn.classList.remove('hidden');
    } else {
      exportBtn.classList.add('hidden');
    }
  });
});

// --- Level Filters ---
document.querySelectorAll('.filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    currentFilter = btn.dataset.filter;
    document
      .querySelectorAll('.filter-btn')
      .forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    openWord = null;
    render();
  });
});

// --- Load data ---
chrome.storage.sync.get(['savedWords', 'aiProvider', 'accessMode'], (data) => {
  savedWords = data.savedWords || {};
  aiProvider = data.aiProvider || 'claude';
  accessMode = data.accessMode || 'pro';
  updateSavedCount();
  updateAiBadge();
});

// Load page-specific data from session
chrome.storage.session.get(
  [
    'allWords',
    'status',
    'intermediateWords',
    'advancedWords',
    'toeflWords',
    'wordContexts',
    'pageText'
  ],
  (data) => {
    if (data.allWords) allWords = data.allWords;
    if (data.status) statusEl.textContent = data.status;
    if (data.intermediateWords)
      intermediateWords = new Set(data.intermediateWords);
    if (data.advancedWords) advancedWords = new Set(data.advancedWords);
    if (data.toeflWords) toeflWords = new Set(data.toeflWords);
    if (data.wordContexts) wordContexts = data.wordContexts;
    if (data.pageText) pageText = data.pageText;
    render();
  }
);

// Load persistent cache from local
chrome.storage.local.get(['translations', 'wordDetails'], (data) => {
  if (data.translations) translations = data.translations;
  if (data.wordDetails) wordDetails = data.wordDetails;
  render();
});

// --- Real-time updates ---
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.allWords) allWords = changes.allWords.newValue || [];
  if (changes.status) statusEl.textContent = changes.status.newValue || '';
  if (changes.intermediateWords)
    intermediateWords = new Set(changes.intermediateWords.newValue || []);
  if (changes.advancedWords)
    advancedWords = new Set(changes.advancedWords.newValue || []);
  if (changes.toeflWords)
    toeflWords = new Set(changes.toeflWords.newValue || []);
  if (changes.wordContexts) wordContexts = changes.wordContexts.newValue || {};
  if (changes.pageText) pageText = changes.pageText.newValue || '';
  if (currentTab !== 'review' && currentTab !== 'phrase') render();
});

chrome.storage.local.onChanged.addListener((changes) => {
  if (changes.translations) translations = changes.translations.newValue || {};
  if (changes.wordDetails) wordDetails = changes.wordDetails.newValue || {};
  if (currentTab !== 'review') render();
});

chrome.storage.sync.onChanged.addListener((changes) => {
  if (changes.savedWords) {
    savedWords = changes.savedWords.newValue || {};
    updateSavedCount();
    if (currentTab !== 'review') render();
  }
  if (changes.aiProvider) {
    aiProvider = changes.aiProvider.newValue || 'claude';
    updateAiBadge();
  }
  if (changes.accessMode) {
    accessMode = changes.accessMode.newValue || 'pro';
    updateAiBadge();
  }
});

// --- Search ---
searchInput.addEventListener('input', () => {
  openWord = null;
  render();
});

// --- Save / Unsave ---
function toggleSave(word) {
  if (savedWords[word]) {
    delete savedWords[word];
  } else {
    savedWords[word] = Date.now();
  }
  chrome.storage.sync.set({ savedWords });
  updateSavedCount();
  render();
}

function updateSavedCount() {
  savedCountEl.textContent = Object.keys(savedWords).length;
}

function updateAiBadge() {
  if (accessMode === 'pro') {
    aiBadge.textContent = 'Pro';
    aiBadge.className = 'ai-badge-pro';
  } else {
    const badgeNames = { claude: 'Claude', gemini: 'Gemini', openai: 'OpenAI' };
    aiBadge.textContent = badgeNames[aiProvider] || aiProvider;
    aiBadge.className = 'ai-badge-' + aiProvider;
  }
}

// =====================
//  LIST RENDER (All / Saved)
// =====================
function render() {
  const query = searchInput.value.toLowerCase().trim();
  let sourceWords =
    currentTab === 'saved' ? Object.keys(savedWords).sort() : allWords;

  // Apply level filter
  let levelFiltered = sourceWords;
  if (currentFilter === 'basic') {
    levelFiltered = sourceWords.filter(
      (w) => !intermediateWords.has(w) && !advancedWords.has(w)
    );
  } else if (currentFilter === 'intermediate') {
    levelFiltered = sourceWords.filter((w) => intermediateWords.has(w));
  } else if (currentFilter === 'advanced') {
    levelFiltered = sourceWords.filter((w) => advancedWords.has(w));
  } else if (currentFilter === 'toefl') {
    levelFiltered = sourceWords.filter((w) => toeflWords.has(w));
  }

  const filtered = levelFiltered.filter(
    (w) =>
      w.includes(query) || (translations[w] && translations[w].includes(query))
  );

  const translatedCount = filtered.filter((w) => translations[w]).length;
  if (currentTab === 'saved') {
    wordCountEl.textContent = `${filtered.length} saved words`;
  } else {
    const filterLabel =
      {
        all: '',
        basic: ' (Basic)',
        intermediate: ' (INT)',
        advanced: ' (ADV)',
        toefl: ' (TOEFL)'
      }[currentFilter] || '';
    const intCount = filtered.filter((w) => intermediateWords.has(w)).length;
    const advCount = filtered.filter((w) => advancedWords.has(w)).length;
    wordCountEl.textContent = `${translatedCount}/${filtered.length} translated${filterLabel} · ${intCount} INT · ${advCount} ADV`;
  }

  wordListEl.innerHTML = '';
  for (const word of filtered) {
    const isInt = intermediateWords.has(word);
    const isAdv = advancedWords.has(word);
    const isToefl = toeflWords.has(word);
    const isSaved = !!savedWords[word];
    const isOpen = openWord === word;

    const row = document.createElement('div');
    row.className =
      'word-row' + (isAdv ? ' advanced' : isInt ? ' intermediate' : '');

    // Main line
    const mainLine = document.createElement('div');
    mainLine.className = 'word-main';

    const en = document.createElement('span');
    en.className = 'word-en';
    en.textContent = word;

    const ko = document.createElement('span');
    ko.className = 'word-ko';
    ko.textContent = translations[word] || '...';

    // Save button
    const saveBtn = document.createElement('button');
    saveBtn.className = 'save-btn' + (isSaved ? ' saved' : '');
    saveBtn.textContent = isSaved ? '\u2605' : '\u2606'; // ★ or ☆
    saveBtn.title = isSaved ? 'Remove from saved' : 'Save word';
    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSave(word);
    });

    // Speak button
    const speakBtn = document.createElement('button');
    speakBtn.className = 'speak-btn';
    speakBtn.innerHTML = '\u{1F508}';
    speakBtn.title = 'Listen to pronunciation';
    speakBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      speakWord(word, speakBtn);
    });

    mainLine.appendChild(en);
    if (isToefl) {
      const tBadge = document.createElement('span');
      tBadge.className = 'badge badge-toefl';
      tBadge.textContent = 'TOEFL';
      mainLine.appendChild(tBadge);
    }
    if (isAdv) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-adv';
      badge.textContent = 'ADV';
      mainLine.appendChild(badge);
    } else if (isInt) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-int';
      badge.textContent = 'INT';
      mainLine.appendChild(badge);
    }
    mainLine.appendChild(speakBtn);
    mainLine.appendChild(saveBtn);
    mainLine.appendChild(ko);
    mainLine.style.cursor = 'pointer';
    row.appendChild(mainLine);

    // Detail panel
    const detailEl = document.createElement('div');
    detailEl.className = 'word-detail' + (isOpen ? '' : ' hidden');
    row.appendChild(detailEl);

    if (isOpen) {
      const detail = wordDetails[word];
      if (detail) {
        renderDetail(detailEl, detail);
      } else {
        detailEl.innerHTML = '<div class="detail-loading">Loading...</div>';
      }
    }

    // Click to expand
    mainLine.addEventListener('click', () => {
      if (openWord === word) {
        openWord = null;
        render();
        return;
      }
      openWord = word;
      render();

      const ctx = wordContexts[word] || '';
      const cached = wordDetails[word];
      const needsFetch = !cached || (ctx && cached.contextSentence !== ctx);
      if (needsFetch) {
        chrome.runtime.sendMessage(
          { type: 'FETCH_WORD_DETAIL', word, context: ctx },
          (resp) => {
            if (resp && resp.error === 'NO_ACCESS_CODE') {
              const el = document.querySelector('.word-detail:not(.hidden)');
              if (el)
                el.innerHTML =
                  '<div class="detail-error">Settings에서 액세스 코드를 입력하세요.</div>';
              return;
            }
            if (resp && resp.error === 'INVALID_ACCESS_CODE') {
              const el = document.querySelector('.word-detail:not(.hidden)');
              if (el)
                el.innerHTML =
                  '<div class="detail-error">유효하지 않은 액세스 코드입니다. Settings에서 확인하세요.</div>';
              return;
            }
            if (resp && resp.error === 'RATE_LIMITED') {
              const el = document.querySelector('.word-detail:not(.hidden)');
              if (el)
                el.innerHTML =
                  '<div class="detail-error">요청 한도 초과 — 잠시 후 다시 시도하세요. (시간당 30회)</div>';
              return;
            }
            if (resp && resp.error === 'NO_API_KEY') {
              const providerNames = {
                claude: 'Claude',
                gemini: 'Gemini',
                openai: 'OpenAI'
              };
              const name = providerNames[resp.provider] || resp.provider;
              const el = document.querySelector('.word-detail:not(.hidden)');
              if (el)
                el.innerHTML = `<div class="detail-error">Set your ${name} API key in Settings to see details.</div>`;
              return;
            }
            if (resp && resp.error) {
              const el = document.querySelector('.word-detail:not(.hidden)');
              if (el)
                el.innerHTML = `<div class="detail-error">Error: ${escapeHtml(resp.error)}</div>`;
              return;
            }
            if (resp && resp.detail) {
              wordDetails[word] = resp.detail;
              if (openWord === word) render();
            }
          }
        );
      }
    });

    wordListEl.appendChild(row);
  }
}

// =====================
//  DETAIL RENDER
// =====================
function renderDetail(container, d) {
  let html = '';

  // --- Contextual meaning (top priority, shown first) ---
  if (d.contextSentence) {
    html += `<div class="detail-context">
      <div class="detail-label">문맥 속 의미</div>
      <div class="context-sentence">"${escapeHtml(d.contextSentence)}"</div>
      <div class="context-korean">${escapeHtml(d.contextKorean || '')}</div>`;
    if (d.contextExplanation) {
      html += `<div class="context-explanation">${escapeHtml(d.contextExplanation)}</div>`;
    }
    html += '</div>';
  }

  // --- Dictionary definitions ---
  if (d.definitions && d.definitions.length > 0) {
    html +=
      '<div class="detail-section"><div class="detail-label">사전 정의</div>';
    for (const def of d.definitions) {
      html += `<div class="detail-def">
        <span class="def-pos">${escapeHtml(def.pos)}</span>
        <span class="def-meaning">${escapeHtml(def.meaning)}</span>`;
      if (def.example) {
        html += `<span class="def-example">${escapeHtml(def.example)}</span>`;
      }
      html += '</div>';
    }
    html += '</div>';
  }

  if (d.grammar) {
    html += `<div class="detail-section">
      <div class="detail-label">Grammar</div>
      <div class="detail-text">${escapeHtml(d.grammar)}</div>
    </div>`;
  }

  if (d.nativeUsage) {
    html += `<div class="detail-section">
      <div class="detail-label">Native Usage</div>
      <div class="detail-text">${escapeHtml(d.nativeUsage)}</div>
    </div>`;
  }

  if (d.idioms && d.idioms.length > 0) {
    html +=
      '<div class="detail-section"><div class="detail-label">Idioms</div>';
    for (const idiom of d.idioms) {
      html += `<div class="detail-idiom">
        <span class="idiom-expr">${escapeHtml(idiom.expression)}</span>
        <span class="idiom-meaning">${escapeHtml(idiom.meaning)}</span>
      </div>`;
    }
    html += '</div>';
  }

  if (d.examples && d.examples.length > 0) {
    html +=
      '<div class="detail-section"><div class="detail-label">Examples</div>';
    for (const ex of d.examples) {
      html += `<div class="detail-example">
        <span class="ex-en">${escapeHtml(ex.en)}</span>
        <span class="ex-ko">${escapeHtml(ex.ko)}</span>
      </div>`;
    }
    html += '</div>';
  }

  if (
    (d.synonyms && d.synonyms.length > 0) ||
    (d.antonyms && d.antonyms.length > 0)
  ) {
    html += '<div class="detail-section detail-syn-ant">';
    if (d.synonyms && d.synonyms.length > 0) {
      html += `<div><span class="detail-label">\uB3D9\uC758\uC5B4</span> <span class="syn-list">${d.synonyms.map(escapeHtml).join(', ')}</span></div>`;
    }
    if (d.antonyms && d.antonyms.length > 0) {
      html += `<div><span class="detail-label">\uBC18\uC758\uC5B4</span> <span class="ant-list">${d.antonyms.map(escapeHtml).join(', ')}</span></div>`;
    }
    html += '</div>';
  }

  container.innerHTML = html;
}

// =====================
//  REVIEW MODE
// =====================
const reviewCard = document.getElementById('review-card');
const reviewEmpty = document.getElementById('review-empty');
const reviewWordEl = document.getElementById('review-word');
const reviewKoreanEl = document.getElementById('review-korean');
const reviewDetailEl = document.getElementById('review-detail');
const reviewAnswer = document.getElementById('review-answer');
const reviewShowBtn = document.getElementById('review-show');
const reviewNextBtn = document.getElementById('review-next');
const reviewProgressEl = document.getElementById('review-progress');
const reviewSpeakBtn = document.getElementById('review-speak');

reviewSpeakBtn.addEventListener('click', () => {
  const word = reviewList[reviewIndex];
  if (word) speakWord(word, reviewSpeakBtn);
});

function startReview() {
  reviewList = shuffle(Object.keys(savedWords));
  reviewIndex = 0;

  if (reviewList.length === 0) {
    reviewEmpty.classList.remove('hidden');
    reviewCard.classList.add('hidden');
    return;
  }

  reviewEmpty.classList.add('hidden');
  reviewCard.classList.remove('hidden');
  showReviewCard();
}

function showReviewCard() {
  const word = reviewList[reviewIndex];
  reviewProgressEl.textContent = `${reviewIndex + 1} / ${reviewList.length}`;
  reviewWordEl.textContent = word;
  reviewKoreanEl.textContent = translations[word] || '...';
  reviewAnswer.classList.add('hidden');
  reviewShowBtn.classList.remove('hidden');
  reviewNextBtn.classList.add('hidden');

  // Prepare detail
  const d = wordDetails[word];
  if (d) {
    renderReviewDetail(d);
  } else {
    reviewDetailEl.innerHTML = '';
    // Fetch in background
    chrome.runtime.sendMessage({ type: 'FETCH_WORD_DETAIL', word }, (resp) => {
      if (resp && resp.detail) {
        wordDetails[word] = resp.detail;
        if (
          reviewList[reviewIndex] === word &&
          !reviewAnswer.classList.contains('hidden')
        ) {
          renderReviewDetail(resp.detail);
        }
      }
    });
  }
}

function renderReviewDetail(d) {
  let html = '';
  if (d.contextSentence) {
    html += `<div class="review-info review-context">
      <strong>문맥:</strong> "${escapeHtml(d.contextSentence)}"
      <div class="review-context-korean">${escapeHtml(d.contextKorean || '')}</div>`;
    if (d.contextExplanation) {
      html += `<div class="review-context-explain">${escapeHtml(d.contextExplanation)}</div>`;
    }
    html += '</div>';
  }
  if (d.definitions && d.definitions.length > 0) {
    html += '<div class="review-info"><strong>사전 정의:</strong>';
    for (const def of d.definitions) {
      html += `<div class="review-def"><span class="def-pos">${escapeHtml(def.pos)}</span> ${escapeHtml(def.meaning)}</div>`;
    }
    html += '</div>';
  }
  if (d.grammar) {
    html += `<div class="review-info"><strong>Grammar:</strong> ${escapeHtml(d.grammar)}</div>`;
  }
  if (d.examples && d.examples.length > 0) {
    html += '<div class="review-info"><strong>Examples:</strong>';
    for (const ex of d.examples) {
      html += `<div class="review-ex">${escapeHtml(ex.en)}<br/><span class="ex-ko">${escapeHtml(ex.ko)}</span></div>`;
    }
    html += '</div>';
  }
  if (d.synonyms && d.synonyms.length > 0) {
    html += `<div class="review-info"><strong>\uB3D9\uC758\uC5B4:</strong> ${d.synonyms.map(escapeHtml).join(', ')}</div>`;
  }
  if (d.antonyms && d.antonyms.length > 0) {
    html += `<div class="review-info"><strong>\uBC18\uC758\uC5B4:</strong> ${d.antonyms.map(escapeHtml).join(', ')}</div>`;
  }
  reviewDetailEl.innerHTML = html;
}

reviewShowBtn.addEventListener('click', () => {
  reviewAnswer.classList.remove('hidden');
  reviewShowBtn.classList.add('hidden');
  reviewNextBtn.classList.remove('hidden');

  // Re-render detail in case it loaded while hidden
  const word = reviewList[reviewIndex];
  const d = wordDetails[word];
  if (d) renderReviewDetail(d);
});

reviewNextBtn.addEventListener('click', () => {
  reviewIndex++;
  if (reviewIndex >= reviewList.length) {
    reviewIndex = 0;
    reviewList = shuffle(Object.keys(savedWords));
    if (reviewList.length === 0) {
      reviewEmpty.classList.remove('hidden');
      reviewCard.classList.add('hidden');
      return;
    }
  }
  showReviewCard();
});

// =====================
//  PHRASE MODE
// =====================
const phraseInput = document.getElementById('phrase-input');
const phraseAskBtn = document.getElementById('phrase-ask-btn');
const phraseHistory = document.getElementById('phrase-history');

phraseAskBtn.addEventListener('click', submitPhrase);
phraseInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitPhrase();
});

function submitPhrase() {
  const phrase = phraseInput.value.trim();
  if (!phrase) return;

  phraseAskBtn.disabled = true;
  phraseAskBtn.textContent = '...';

  // Add loading card at top
  const card = document.createElement('div');
  card.className = 'phrase-card';
  card.innerHTML = `<div class="phrase-card-query">"${escapeHtml(phrase)}"</div><div class="phrase-card-loading">Analyzing...</div>`;
  phraseHistory.prepend(card);

  chrome.runtime.sendMessage(
    { type: 'FETCH_PHRASE_DETAIL', phrase, pageText },
    (resp) => {
      phraseAskBtn.disabled = false;
      phraseAskBtn.textContent = 'Ask AI';

      if (resp && resp.error === 'NO_ACCESS_CODE') {
        card.innerHTML = `<div class="phrase-card-query">"${escapeHtml(phrase)}"</div>
          <div class="detail-error">Settings에서 액세스 코드를 입력하세요.</div>`;
        return;
      }
      if (resp && resp.error === 'INVALID_ACCESS_CODE') {
        card.innerHTML = `<div class="phrase-card-query">"${escapeHtml(phrase)}"</div>
          <div class="detail-error">유효하지 않은 액세스 코드입니다.</div>`;
        return;
      }
      if (resp && resp.error === 'RATE_LIMITED') {
        card.innerHTML = `<div class="phrase-card-query">"${escapeHtml(phrase)}"</div>
          <div class="detail-error">요청 한도 초과 — 잠시 후 다시 시도하세요. (시간당 30회)</div>`;
        return;
      }
      if (resp && resp.error === 'NO_API_KEY') {
        const providerNames = {
          claude: 'Claude',
          gemini: 'Gemini',
          openai: 'OpenAI'
        };
        const name = providerNames[resp.provider] || resp.provider;
        card.innerHTML = `<div class="phrase-card-query">"${escapeHtml(phrase)}"</div>
          <div class="detail-error">Set your ${name} API key in Settings.</div>`;
        return;
      }
      if (resp && resp.error) {
        card.innerHTML = `<div class="phrase-card-query">"${escapeHtml(phrase)}"</div>
          <div class="detail-error">Error: ${escapeHtml(resp.error)}</div>`;
        return;
      }
      if (resp && resp.detail) {
        renderPhraseCard(card, phrase, resp.detail);
      }
    }
  );

  phraseInput.value = '';
}

function renderPhraseCard(card, phrase, d) {
  let html = `<div class="phrase-card-query">"${escapeHtml(d.phrase || phrase)}"</div>`;

  // Korean translation
  if (d.korean) {
    html += `<div class="phrase-korean">${escapeHtml(d.korean)}</div>`;
  }

  // Overall meaning
  if (d.meaning) {
    html += `<div class="phrase-section">
      <div class="detail-label">표현 의미</div>
      <div class="detail-text">${escapeHtml(d.meaning)}</div>
    </div>`;
  }

  // Why this meaning (literal breakdown)
  if (d.literal) {
    html += `<div class="phrase-section">
      <div class="detail-label">단어별 분석</div>
      <div class="detail-text">${escapeHtml(d.literal)}</div>
    </div>`;
  }

  // Context meaning
  if (d.contextMeaning) {
    html += `<div class="phrase-section phrase-context-box">
      <div class="detail-label">이 글에서의 의미</div>
      <div class="detail-text">${escapeHtml(d.contextMeaning)}</div>
    </div>`;
  }

  // Usage
  if (d.usage) {
    html += `<div class="phrase-section">
      <div class="detail-label">Usage</div>
      <div class="detail-text">${escapeHtml(d.usage)}</div>
    </div>`;
  }

  // Examples
  if (d.examples && d.examples.length > 0) {
    html +=
      '<div class="phrase-section"><div class="detail-label">Examples</div>';
    for (const ex of d.examples) {
      html += `<div class="detail-example">
        <span class="ex-en">${escapeHtml(ex.en)}</span>
        <span class="ex-ko">${escapeHtml(ex.ko)}</span>
      </div>`;
    }
    html += '</div>';
  }

  // Similar expressions
  if (d.similar && d.similar.length > 0) {
    html += `<div class="phrase-section">
      <div class="detail-label">비슷한 표현</div>
      <div class="syn-list">${d.similar.map(escapeHtml).join(' · ')}</div>
    </div>`;
  }

  card.innerHTML = html;
}

// --- Pronunciation ---
function speakWord(word, btn) {
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = 'en-US';
  utterance.rate = 0.9;
  if (btn) {
    btn.classList.add('speaking');
    utterance.onend = () => btn.classList.remove('speaking');
    utterance.onerror = () => btn.classList.remove('speaking');
  }
  speechSynthesis.speak(utterance);
}

// --- Utility ---
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// =====================
//  EXCEL EXPORT
// =====================
exportBtn.addEventListener('click', exportToExcel);

function exportToExcel() {
  const words = Object.keys(savedWords).sort();
  if (words.length === 0) return;

  const wb = XLSX.utils.book_new();

  // Sheet 1: Saved Words (summary)
  const summaryRows = words.map((w) => {
    const d = wordDetails[w] || {};
    return {
      Word: w,
      Korean: translations[w] || '',
      Definitions: (d.definitions || [])
        .map((def) => `[${def.pos}] ${def.meaning}`)
        .join('; '),
      Context: d.contextSentence || '',
      'Context Korean': d.contextKorean || '',
      Grammar: d.grammar || '',
      Idioms: (d.idioms || []).map((i) => i.expression).join(', '),
      Examples: (d.examples || []).map((e) => e.en).join('; '),
      Synonyms: (d.synonyms || []).join(', '),
      Antonyms: (d.antonyms || []).join(', '),
      'Saved Date': new Date(savedWords[w]).toLocaleDateString()
    };
  });
  const ws1 = XLSX.utils.json_to_sheet(summaryRows);
  XLSX.utils.book_append_sheet(wb, ws1, 'Saved Words');

  // Sheet 2: Definitions
  const defRows = [];
  for (const w of words) {
    const d = wordDetails[w];
    if (d && d.definitions) {
      for (const def of d.definitions) {
        defRows.push({
          Word: w,
          POS: def.pos || '',
          Meaning: def.meaning || '',
          Example: def.example || ''
        });
      }
    }
  }
  if (defRows.length > 0) {
    const ws2 = XLSX.utils.json_to_sheet(defRows);
    XLSX.utils.book_append_sheet(wb, ws2, 'Definitions');
  }

  // Sheet 3: Idioms
  const idiomRows = [];
  for (const w of words) {
    const d = wordDetails[w];
    if (d && d.idioms) {
      for (const idiom of d.idioms) {
        idiomRows.push({
          Word: w,
          Expression: idiom.expression || '',
          Meaning: idiom.meaning || ''
        });
      }
    }
  }
  if (idiomRows.length > 0) {
    const ws3 = XLSX.utils.json_to_sheet(idiomRows);
    XLSX.utils.book_append_sheet(wb, ws3, 'Idioms');
  }

  // Sheet 4: Examples
  const exRows = [];
  for (const w of words) {
    const d = wordDetails[w];
    if (d && d.examples) {
      for (const ex of d.examples) {
        exRows.push({
          Word: w,
          English: ex.en || '',
          Korean: ex.ko || ''
        });
      }
    }
  }
  if (exRows.length > 0) {
    const ws4 = XLSX.utils.json_to_sheet(exRows);
    XLSX.utils.book_append_sheet(wb, ws4, 'Examples');
  }

  // Generate and download
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([wbout], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `saved-words-${new Date().toISOString().slice(0, 10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
