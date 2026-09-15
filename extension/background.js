const REVIEW_URL = chrome.runtime.getURL('review.html');

async function openReviewPage() {
  const existing = await chrome.tabs.query({ url: `${REVIEW_URL}*` });
  if (existing[0]?.id) {
    await chrome.tabs.update(existing[0].id, { active: true });
    if (existing[0].windowId) await chrome.windows.update(existing[0].windowId, { focused: true });
    chrome.runtime.sendMessage({ type: 'capture-ready' }).catch(() => {});
    return;
  }
  await chrome.tabs.create({ url: REVIEW_URL });
}

async function captureVisibleOrderPage(tab) {
  try {
    if (!tab?.windowId || !/^https?:/i.test(tab.url || '')) {
      throw new Error('Open a retailer or Amazon webpage before capturing.');
    }
    const imageData = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 88 });
    await chrome.storage.local.set({
      bbb_pending_capture: {
        imageData,
        pageUrl: tab.url,
        pageTitle: tab.title || '',
        capturedAt: new Date().toISOString()
      }
    });
    await openReviewPage();
  } catch (error) {
    await chrome.storage.local.set({ bbb_capture_error: String(error.message || error) });
    await openReviewPage();
  }
}

chrome.action.onClicked.addListener((tab) => {
  captureVisibleOrderPage(tab);
});
