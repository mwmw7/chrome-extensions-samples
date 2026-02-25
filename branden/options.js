const claudeKeyInput = document.getElementById('claude-key-input');
const claudeModelSelect = document.getElementById('claude-model-select');
const geminiKeyInput = document.getElementById('gemini-key-input');
const geminiModelSelect = document.getElementById('gemini-model-select');
const saveBtn = document.getElementById('save-btn');
const statusEl = document.getElementById('status');
const providerOptions = document.querySelectorAll('.provider-option');
const claudeSection = document.getElementById('claude-section');
const geminiSection = document.getElementById('gemini-section');

// Load saved settings
chrome.storage.sync.get(
  ['apiKey', 'geminiKey', 'aiProvider', 'geminiModel', 'claudeModel'],
  (data) => {
    if (data.apiKey) claudeKeyInput.value = data.apiKey;
    if (data.geminiKey) geminiKeyInput.value = data.geminiKey;
    if (data.aiProvider) selectProvider(data.aiProvider);
    if (data.claudeModel) claudeModelSelect.value = data.claudeModel;
    if (data.geminiModel) geminiModelSelect.value = data.geminiModel;
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

  if (provider === 'claude' && !claudeKey) {
    showStatus('Please enter a Claude API key.', true);
    return;
  }
  if (provider === 'gemini' && !geminiKey) {
    showStatus('Please enter a Gemini API key.', true);
    return;
  }

  chrome.storage.sync.set(
    {
      apiKey: claudeKey,
      claudeModel,
      geminiKey,
      aiProvider: provider,
      geminiModel
    },
    () => {
      const name =
        provider === 'claude'
          ? `Claude (${claudeModel.split('-')[1]})`
          : `Gemini (${geminiModel})`;
      showStatus(`Saved! Using ${name} for word details.`, false);
    }
  );
});

function showStatus(msg, isError) {
  statusEl.style.color = isError ? '#dc2626' : '#16a34a';
  statusEl.textContent = msg;
}
