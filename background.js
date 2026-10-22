import { MSG } from './shared/protocol.js';

const DEFAULT_TITLE = '截取页面';

// MessageRouter maps message types to handlers, centralizing the no-tab guard
// and Chrome's async-sendResponse channel rules: a handler returning a
// Promise keeps the channel open and its resolution is the response.
class MessageRouter {
  #handlers = new Map();

  on(type, handler) {
    this.#handlers.set(type, handler);
    return this;
  }

  listen() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      const tab = sender.tab;
      const handler = this.#handlers.get(msg.type);
      if (!tab || tab.id == null || !handler) return false;
      const result = handler(msg, tab);
      if (result instanceof Promise) {
        result.then(sendResponse);
        return true; // keep the channel open for the async response
      }
      return false;
    });
  }
}

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
  } catch {
    await markUnsupported(tabId);
  }
});

new MessageRouter()
  .on(MSG.CAPTURE, (msg, tab) => new Promise((resolve) => {
    chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, (dataUrl) => {
      resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : { dataUrl });
    });
  }))
  .on(MSG.PROGRESS, (msg, tab) => {
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#1a73e8' });
    chrome.action.setBadgeText({ tabId: tab.id, text: String(msg.text || '') });
  })
  .on(MSG.DONE, (msg, tab) => {
    chrome.action.setBadgeText({ tabId: tab.id, text: '' });
  })
  .listen();
