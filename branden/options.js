const claudeKeyInput = document.getElementById('claude-key-input');
const claudeModelSelect = document.getElementById('claude-model-select');
const geminiKeyInput = document.getElementById('gemini-key-input');
const geminiModelSelect = document.getElementById('gemini-model-select');
const openaiKeyInput = document.getElementById('openai-key-input');
const openaiModelSelect = document.getElementById('openai-model-select');
const signinLink = document.getElementById('signin-link');
const signoutLink = document.getElementById('signout-link');
const refreshLink = document.getElementById('refresh-link');
const upgradeHint = document.getElementById('upgrade-hint');
const planAccountEl = document.getElementById('plan-account');
const upgradeBtn = document.getElementById('upgrade-btn');
const portalBtn = document.getElementById('portal-btn');
const planTierEl = document.getElementById('plan-tier');
const planUsageEl = document.getElementById('plan-usage');
const saveBtn = document.getElementById('save-btn');
const statusEl = document.getElementById('status');
const providerOptions = document.querySelectorAll('.provider-option');
const claudeSection = document.getElementById('claude-section');
const geminiSection = document.getElementById('gemini-section');
const openaiSection = document.getElementById('openai-section');
const modeOptions = document.querySelectorAll('.mode-option');
const proSection = document.getElementById('pro-section');
const ownKeySections = document.getElementById('own-key-sections');

// Load saved settings
chrome.storage.sync.get(
  [
    'apiKey',
    'geminiKey',
    'openaiKey',
    'aiProvider',
    'geminiModel',
    'claudeModel',
    'openaiModel',
    'accessMode'
  ],
  (data) => {
    if (data.apiKey) claudeKeyInput.value = data.apiKey;
    if (data.geminiKey) geminiKeyInput.value = data.geminiKey;
    if (data.openaiKey) openaiKeyInput.value = data.openaiKey;
    if (data.aiProvider) selectProvider(data.aiProvider);
    if (data.claudeModel) claudeModelSelect.value = data.claudeModel;
    if (data.geminiModel) geminiModelSelect.value = data.geminiModel;
    if (data.openaiModel) openaiModelSelect.value = data.openaiModel;
    selectMode(data.accessMode || 'pro');
  }
);

// Mode toggle
modeOptions.forEach((opt) => {
  opt.addEventListener('click', () => {
    selectMode(opt.dataset.mode);
  });
});

function selectMode(mode) {
  modeOptions.forEach((o) => {
    const isSelected = o.dataset.mode === mode;
    o.classList.toggle('selected', isSelected);
    o.querySelector('input').checked = isSelected;
  });
  if (mode === 'pro') {
    proSection.classList.remove('hidden');
    ownKeySections.classList.add('hidden');
  } else {
    proSection.classList.add('hidden');
    ownKeySections.classList.remove('hidden');
  }
}

// Provider toggle
providerOptions.forEach((opt) => {
  opt.addEventListener('click', () => {
    selectProvider(opt.dataset.provider);
  });
});

function selectProvider(provider) {
  providerOptions.forEach((o) => {
    const isSelected = o.dataset.provider === provider;
    o.classList.toggle('selected', isSelected);
    o.querySelector('input').checked = isSelected;
  });
  claudeSection.classList.toggle('visible', provider === 'claude');
  geminiSection.classList.toggle('visible', provider === 'gemini');
  openaiSection.classList.toggle('visible', provider === 'openai');
}

// Save
saveBtn.addEventListener('click', () => {
  const accessMode = document.querySelector(
    'input[name="accessMode"]:checked'
  ).value;
  if (accessMode === 'pro') {
    chrome.storage.sync.set({ accessMode }, () => {
      showStatus('저장되었습니다.', false);
      refreshPlan();
    });
    return;
  }

  // Own key mode
  const provider = document.querySelector(
    'input[name="provider"]:checked'
  ).value;
  const claudeKey = claudeKeyInput.value.trim();
  const claudeModel = claudeModelSelect.value;
  const geminiKey = geminiKeyInput.value.trim();
  const geminiModel = geminiModelSelect.value;
  const openaiKey = openaiKeyInput.value.trim();
  const openaiModel = openaiModelSelect.value;

  if (provider === 'claude' && !claudeKey) {
    showStatus('Please enter a Claude API key.', true);
    return;
  }
  if (provider === 'gemini' && !geminiKey) {
    showStatus('Please enter a Gemini API key.', true);
    return;
  }
  if (provider === 'openai' && !openaiKey) {
    showStatus('Please enter an OpenAI API key.', true);
    return;
  }

  chrome.storage.sync.set(
    {
      accessMode,
      apiKey: claudeKey,
      claudeModel,
      geminiKey,
      aiProvider: provider,
      geminiModel,
      openaiKey,
      openaiModel
    },
    () => {
      const names = {
        claude: `Claude (${claudeModel.split('-')[1]})`,
        gemini: `Gemini (${geminiModel})`,
        openai: `OpenAI (${openaiModel})`
      };
      showStatus(`Saved! Using ${names[provider]} for word details.`, false);
    }
  );
});

function showStatus(msg, isError) {
  statusEl.style.color = isError ? '#dc2626' : '#16a34a';
  statusEl.textContent = msg;
}


// =====================
//  Plan & billing
// =====================

function applyMe(res) {
  const signedIn = !!(res && res.signedIn);
  const isPro = !!(res && res.tier === 'pro');

  planTierEl.textContent = isPro ? 'Pro' : 'Free';
  planAccountEl.textContent = signedIn
    ? res.email || '로그인됨'
    : '로그인되지 않음';

  if (res && typeof res.remaining === 'number') {
    planUsageEl.textContent = isPro
      ? `이번 결제 주기 ${res.remaining}/${res.limit}회 남음`
      : `오늘 ${res.remaining}/${res.limit}회 남음`;
  } else {
    planUsageEl.textContent = '사용량을 불러오지 못했습니다.';
  }

  if (isPro && res.cancelAtPeriodEnd && res.periodEnd) {
    const d = new Date(res.periodEnd).toLocaleDateString('ko-KR');
    planUsageEl.textContent += ` · ${d} 해지 예정`;
  }
  if (res && res.status === 'past_due') {
    planUsageEl.textContent += ' · 결제 실패 — 결제수단을 확인하세요';
  }

  // One primary action at a time: subscribe, or manage an existing sub.
  upgradeBtn.classList.toggle('hidden', isPro);
  portalBtn.classList.toggle('hidden', !isPro);

  // The hint only matters while signing in is still part of the flow.
  upgradeHint.classList.toggle('hidden', isPro || signedIn);

  signinLink.classList.toggle('hidden', signedIn);
  signoutLink.classList.toggle('hidden', !signedIn);
}

function refreshPlan() {
  chrome.runtime.sendMessage({ type: 'GET_ME' }, applyMe);
}

signinLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.sendMessage({ type: 'SIGN_IN' }, (res) => {
    if (!res || res.error) {
      showStatus(`로그인 실패: ${res?.detail || res?.error || '오류'}`, true);
      return;
    }
    applyMe(res);
    showStatus('로그인되었습니다.', false);
  });
});

signoutLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.sendMessage({ type: 'SIGN_OUT' }, () => {
    showStatus('로그아웃되었습니다.', false);
    refreshPlan();
  });
});

refreshLink.addEventListener('click', (e) => {
  e.preventDefault();
  refreshPlan();
});

// Subscribing drives sign-in itself, so the user never has to think about
// the order — one button, one flow.
upgradeBtn.addEventListener('click', () => {
  upgradeBtn.disabled = true;
  upgradeBtn.textContent = '결제 페이지 여는 중...';
  chrome.runtime.sendMessage({ type: 'OPEN_CHECKOUT' }, (res) => {
    upgradeBtn.disabled = false;
    upgradeBtn.textContent = 'Pro 구독하기';
    if (res && res.url) {
      showStatus('새 탭에서 결제를 완료한 뒤 새로고침하세요.', false);
      return;
    }
    const messages = {
      SIGN_IN_FAILED: '로그인이 취소되었습니다.',
      SIGN_IN_REQUIRED: '로그인이 필요합니다.',
      ALREADY_SUBSCRIBED: '이미 구독 중입니다.'
    };
    showStatus(
      messages[res && res.error] || '결제 페이지를 열지 못했습니다.',
      true
    );
    refreshPlan();
  });
});

portalBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_PORTAL' }, (res) => {
    if (!res || !res.url) showStatus('관리 페이지를 열지 못했습니다.', true);
  });
});

refreshPlan();
