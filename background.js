import { MSG } from './shared/protocol.js';

const DEFAULT_TITLE = '截取页面';

function ping(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: MSG.PING }, (resp) => {
      // Without injection sendMessage sets lastError; reading it suppresses the console warning.
      resolve(!chrome.runtime.lastError && !!resp && resp.ok === true);
    });
  });
}

async function markUnsupported(tabId) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#d93025' });
  await chrome.action.setBadgeText({ tabId, text: '!' });
  await chrome.action.setTitle({ tabId, title: '此页面不支持截图' });
}

chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab.id;
  await chrome.action.setBadgeText({ tabId, text: '' });
  await chrome.action.setTitle({ tabId, title: DEFAULT_TITLE });
  try {
    if (!(await ping(tabId))) {
      // executeScript awaits the returned import promise, so main.js's message
      // listener is registered before START is sent below (no race); module
      // evaluate-once semantics make a repeated bootstrap harmless.
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => import(chrome.runtime.getURL('content/main.js')),
      });
    }
    await chrome.tabs.sendMessage(tabId, { type: MSG.START });
  } catch (e) {
    await markUnsupported(tabId);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return false;

  if (msg.type === MSG.CAPTURE) {
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ dataUrl });
      }
    });
    return true; // async sendResponse
  }
  if (msg.type === MSG.PROGRESS) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#1a73e8' });
    chrome.action.setBadgeText({ tabId, text: String(msg.text || '') });
    return false;
  }
  if (msg.type === MSG.DONE) {
    chrome.action.setBadgeText({ tabId, text: '' });
    return false;
  }
  return false;
});
