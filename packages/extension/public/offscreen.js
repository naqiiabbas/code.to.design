// navigator.clipboard needs a focused document, which an offscreen document
// never is. The textarea + execCommand route is the supported workaround.
const sink = document.getElementById('sink');

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen' || message.type !== 'copy') return undefined;
  let ok = false;
  try {
    sink.value = message.text;
    sink.select();
    sink.setSelectionRange(0, sink.value.length);
    ok = document.execCommand('copy');
  } catch (err) {
    console.error('offscreen copy failed', err);
  } finally {
    sink.value = '';
  }
  sendResponse({ ok });
  return false;
});
