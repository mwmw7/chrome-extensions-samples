const claudeKeyInput = document.getElementById('claude-key-input');
const claudeModelSelect = document.getElementById('claude-model-select');
const geminiKeyInput = document.getElementById('gemini-key-input');
const geminiModelSelect = document.getElementById('gemini-model-select');
const openaiKeyInput = document.getElementById('openai-key-input');
const openaiModelSelect = document.getElementById('openai-model-select');
const accessCodeInput = document.getElementById('access-code-input');
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
    'accessMode',
    'accessCode'
  ],
  (data) => {
    if (data.apiKey) claudeKeyInput.value = data.apiKey;
    if (data.geminiKey) geminiKeyInput.value = data.geminiKey;
    if (data.openaiKey) openaiKeyInput.value = data.openaiKey;
    if (data.aiProvider) selectProvider(data.aiProvider);
    if (data.claudeModel) claudeModelSelect.value = data.claudeModel;
    if (data.geminiModel) geminiModelSelect.value = data.geminiModel;
    if (data.openaiModel) openaiModelSelect.value = data.openaiModel;
    if (data.accessCode) accessCodeInput.value = data.accessCode;
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
  const accessCode = accessCodeInput.value.trim();

  if (accessMode === 'pro') {
    if (!accessCode) {
      showStatus('Please enter your access code.', true);
      return;
    }
    chrome.storage.sync.set({ accessMode, accessCode }, () => {
      showStatus('Saved! Using Pro mode with access code.', false);
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
      accessCode,
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
