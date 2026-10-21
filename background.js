'use strict';

// Injection order matters: stitch.js defines window.FpsStitch used by the rest.
const CONTENT_FILES = ['content/stitch.js', 'content/select.js', 'content/capture.js', 'content/preview.js', 'content/main.js'];
const DEFAULT_TITLE = '截取页面';

function ping(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'fps:ping' }, (resp) => {
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
      await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
    }
    await chrome.tabs.sendMessage(tabId, { type: 'fps:start' });
  } catch (e) {
    await markUnsupported(tabId);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return false;

  if (msg.type === 'fps:capture') {
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ dataUrl });
      }
    });
    return true; // async sendResponse
  }
  if (msg.type === 'fps:progress') {
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#1a73e8' });
    chrome.action.setBadgeText({ tabId, text: String(msg.text || '') });
    return false;
  }
  if (msg.type === 'fps:done') {
    chrome.action.setBadgeText({ tabId, text: '' });
    return false;
  }
  return false;
});
