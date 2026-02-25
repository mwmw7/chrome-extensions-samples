function extractWords() {
  const text = document.body.innerText;
  const matches = text.match(/\b[a-zA-Z]{2,}\b/g);
  if (!matches) return null;

  const words = [...new Set(matches.map((w) => w.toLowerCase()))].sort();

  // Extract sentence contexts for each word
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

  // Capture page text for phrase lookups (truncated)
  const pageText = text.slice(0, 3000);

  return { words, contexts, pageText };
}

// Extract on page load
const data = extractWords();
if (data) {
  chrome.runtime
    .sendMessage({
      type: 'WORDS_EXTRACTED',
      words: data.words,
      contexts: data.contexts,
      pageText: data.pageText
    })
    .catch(() => {
      // Service worker may not be active yet; ignore
    });
}

// Listen for re-extraction requests (when panel opens after page load)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'RE_EXTRACT') {
    const result = extractWords();
    sendResponse(result || { words: [], contexts: {} });
  }
});
