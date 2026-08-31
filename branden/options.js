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
const planTierEl = document.getElementById('plan-tier');
const saveBtn = document.getElementById('save-btn');
const statusEl = document.getElementById('status');
const providerOptions = document.querySelectorAll('.provider-option');
const claudeSection = document.getElementById('claude-section');
const geminiSection = document.getElementById('gemini-section');
const openaiSection = document.getElementById('openai-section');

// Load saved settings
chrome.storage.sync.get(
  [
    'apiKey',
    'geminiKey',
    'openaiKey',
    'aiProvider',
    'geminiModel',
    'claudeModel',
    'openaiModel'
  ],
  (data) => {
    if (data.apiKey) claudeKeyInput.value = data.apiKey;
    if (data.geminiKey) geminiKeyInput.value = data.geminiKey;
    if (data.openaiKey) openaiKeyInput.value = data.openaiKey;
    selectProvider(data.aiProvider || 'gemini');
    if (data.claudeModel) claudeModelSelect.value = data.claudeModel;
    if (data.geminiModel) geminiModelSelect.value = data.geminiModel;
    if (data.openaiModel) openaiModelSelect.value = data.openaiModel;
  }
);

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

  upgradeBtn.classList.toggle('hidden', isPro);

  // The hint only matters while signing in is still part of the flow.
  upgradeHint.classList.toggle('hidden', isPro || signedIn);

  signinLink.classList.toggle('hidden', signedIn);
  signoutLink.classList.toggle('hidden', !signedIn);
}

function refreshPlan() {
  chrome.runtime.sendMessage({ type: 'GET_ME' }, applyMe);
}

// The side panel can sign in too, and this page would otherwise keep showing
// "로그인되지 않음" until reopened. Same stamp the panel watches.
chrome.storage.local.onChanged.addListener((changes) => {
  if (changes.planChangedAt) refreshPlan();
});

const NO_BROWSER_SIGNIN =
  'Chrome 브라우저 로그인이 꺼져 있어 Google 로그인을 할 수 없습니다. ' +
  '정품 Chrome에서 chrome://settings/syncSetup 의 "Chrome에 로그인 허용"을 켜주세요. ' +
  'Chromium·Brave 등에서는 이 기능이 제공되지 않습니다.';

/**
 * Chrome reports a browser with no Google sign-in — plain Chromium, Brave, a
 * profile under BrowserSignin policy — as "the user turned off browser
 * signin". That reads like a switch the user flipped, but on those builds
 * there is no switch, so the raw string sends people looking for a setting
 * that does not exist. Everything else really is a cancelled prompt.
 */
function signInErrorMessage(res) {
  if (/browser signin/i.test(res?.detail || '')) return NO_BROWSER_SIGNIN;
  // Google issued a token but the Worker refused it — an OAuth client mismatch,
  // not anything the user did. Saying "cancelled" here would send them retrying
  // a sign-in that cannot succeed.
  if (res?.error === 'TOKEN_REJECTED') {
    return '로그인은 되었지만 서버가 인증을 거부했습니다. OAuth 설정을 확인하세요.';
  }
  // The service worker already logged the raw detail for debugging; showing it
  // here only puts untranslated Chrome internals in front of the user.
  return '로그인이 취소되었습니다.';
}

signinLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.sendMessage({ type: 'SIGN_IN' }, (res) => {
    if (!res || res.error) {
      showStatus(signInErrorMessage(res), true);
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
      SIGN_IN_REQUIRED: '로그인이 필요합니다.',
      ALREADY_SUBSCRIBED: '이미 구독 중입니다.'
    };
    showStatus(
      res && res.error === 'SIGN_IN_FAILED'
        ? signInErrorMessage(res)
        : messages[res && res.error] || '결제 페이지를 열지 못했습니다.',
      true
    );
    refreshPlan();
  });
});

refreshPlan();
