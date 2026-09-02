const claudeKeyInput = document.getElementById('claude-key-input');
const claudeModelSelect = document.getElementById('claude-model-select');
const signinLink = document.getElementById('signin-link');
const signoutLink = document.getElementById('signout-link');
const refreshLink = document.getElementById('refresh-link');
const upgradeHint = document.getElementById('upgrade-hint');
const planAccountEl = document.getElementById('plan-account');
const planUsageEl = document.getElementById('plan-usage');
const upgradeBtn = document.getElementById('upgrade-btn');
const planTierEl = document.getElementById('plan-tier');
const saveBtn = document.getElementById('save-btn');
const statusEl = document.getElementById('status');

// Load saved settings
chrome.storage.sync.get(['apiKey', 'claudeModel'], (data) => {
  if (data.apiKey) claudeKeyInput.value = data.apiKey;
  if (data.claudeModel) claudeModelSelect.value = data.claudeModel;
});

// Save
saveBtn.addEventListener('click', () => {
  const claudeKey = claudeKeyInput.value.trim();
  const claudeModel = claudeModelSelect.value;

  if (!claudeKey) {
    showStatus('Claude API 키를 입력하세요.', true);
    return;
  }

  chrome.storage.sync.set({ apiKey: claudeKey, claudeModel }, () => {
    const label =
      claudeModelSelect.selectedOptions[0]?.textContent.trim() || claudeModel;
    showStatus(`저장되었습니다. 단어 분석에 ${label}을(를) 사용합니다.`, false);
  });
});

function showStatus(msg, isError) {
  statusEl.style.color = isError ? '#dc2626' : '#16a34a';
  statusEl.textContent = msg;
}

// =====================
//  Plan & billing
// =====================

function applyMe(me) {
  const signedIn = !!me?.signedIn;
  const paid = !!me?.paid;

  planTierEl.textContent = paid ? 'Pro (영구)' : '무료';
  planAccountEl.textContent = signedIn
    ? me.email || '로그인됨'
    : '로그인되지 않음';
  planUsageEl.textContent = signedIn
    ? paid
      ? `저장한 단어 ${me.wordCount}개`
      : `저장한 단어 ${me.wordCount}/${me.limit}개`
    : '저장·복습·내보내기는 로그인이 필요합니다';

  upgradeBtn.classList.toggle('hidden', paid);

  // The hint only matters while the unlock button is still visible.
  upgradeHint.classList.toggle('hidden', paid);

  signinLink.classList.toggle('hidden', signedIn);
  signoutLink.classList.toggle('hidden', !signedIn);
}

function refreshPlan() {
  chrome.runtime.sendMessage({ type: 'GET_ME', refresh: true }, applyMe);
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

    // Fire-and-forget: pulls any legacy chrome.storage.sync word list up to
    // the server so signing in never looks like it dropped what the user
    // already saved.
    chrome.runtime.sendMessage({ type: 'SYNC_WORDS' }, (syncRes) => {
      if (syncRes?.error === 'MIGRATION_FAILED') {
        showStatus(
          '이전 단어 이관에 실패했습니다. 새로고침을 눌러 다시 시도하세요.',
          true
        );
      }
      refreshPlan();
    });
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

// Unlocking drives sign-in itself, so the user never has to think about the
// order — one button, one flow.
upgradeBtn.addEventListener('click', () => {
  upgradeBtn.disabled = true;
  upgradeBtn.textContent = '결제 페이지 여는 중...';
  chrome.runtime.sendMessage({ type: 'OPEN_CHECKOUT' }, (res) => {
    upgradeBtn.disabled = false;
    upgradeBtn.textContent = '$3로 영구 잠금 해제';
    if (res && res.url) {
      showStatus('새 탭에서 결제를 완료한 뒤 새로고침하세요.', false);
      return;
    }
    const messages = {
      ALREADY_PAID: '이미 구매하셨습니다. 새로고침을 눌러 상태를 갱신하세요.',
      SIGN_IN_REQUIRED:
        '로그인이 만료되었습니다. Google 로그인 후 다시 시도하세요.'
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
