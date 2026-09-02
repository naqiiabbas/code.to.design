/**
 * Service workers have no DOM, so the clipboard write happens in an offscreen
 * document. That also means it survives the popup closing, which it must for
 * "Capture Selection" (the popup dismisses the moment you click the page).
 */

const OFFSCREEN_PATH = 'offscreen.html';

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  if (existing.length > 0) return;

  if (creating) {
    await creating;
    return;
  }
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['CLIPBOARD' as chrome.offscreen.Reason],
    justification: 'Copy the captured design to the clipboard so it can be pasted into Figma.',
  });
  try {
    await creating;
  } finally {
    creating = null;
  }
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await ensureOffscreen();
    const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'copy', text });
    return Boolean(response?.ok);
  } catch (err) {
    console.warn('Clipboard write failed:', err);
    return false;
  }
}
