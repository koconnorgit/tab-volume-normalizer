"use strict";

// Tabs with normalization turned on. Lives for the browser session.
const enabledTabs = new Set();

// tabId -> Set of frameIds that currently have audio going through the
// compressor. Drives the marker in the tab's title.
const activeFrames = new Map();

function setFrameActive(tabId, frameId, active) {
  let frames = activeFrames.get(tabId);
  if (active) {
    if (!frames) activeFrames.set(tabId, (frames = new Set()));
    frames.add(frameId);
  } else if (frames) {
    frames.delete(frameId);
    if (frames.size === 0) activeFrames.delete(tabId);
  }
}

function updateMark(tabId) {
  const on = enabledTabs.has(tabId) && activeFrames.has(tabId);
  browser.tabs
    .sendMessage(tabId, { type: "mark", on }, { frameId: 0 })
    .catch(() => {});
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image failed to load"));
    img.src = src;
  });
}

const ICON_SIZE = 64;
const BADGE_SIZE = 40;
const badgeImage = loadImage(browser.runtime.getURL("icons/on.svg"));
const composedIcons = new Map(); // favicon URL -> badged data: URL

// Draws the site's favicon with the toolbar "on" image badged into its
// bottom-right corner. Done here rather than in the page because the
// background script can read any site's favicon without tainting the canvas.
// Falls back to the plain "on" image if the favicon cannot be loaded.
async function composeIcon(url) {
  if (composedIcons.has(url)) return composedIcons.get(url);

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = ICON_SIZE;
  const ctx = canvas.getContext("2d");

  let drewSite = false;
  if (url) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error("HTTP " + response.status);
      const objectUrl = URL.createObjectURL(await response.blob());
      try {
        ctx.drawImage(await loadImage(objectUrl), 0, 0, ICON_SIZE, ICON_SIZE);
        drewSite = true;
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } catch (e) {
      // No usable favicon; fall through to the plain badge.
    }
  }

  const badge = await badgeImage;
  if (drewSite) {
    const pos = ICON_SIZE - BADGE_SIZE;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.roundRect(pos, pos, BADGE_SIZE, BADGE_SIZE, 8);
    ctx.fill();
    ctx.drawImage(badge, pos + 3, pos + 3, BADGE_SIZE - 6, BADGE_SIZE - 6);
  } else {
    ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE);
    ctx.drawImage(badge, 0, 0, ICON_SIZE, ICON_SIZE);
  }

  const dataUrl = canvas.toDataURL("image/png");
  if (composedIcons.size >= 100) composedIcons.clear();
  composedIcons.set(url, dataUrl);
  return dataUrl;
}

function updateButton(tabId) {
  const on = enabledTabs.has(tabId);
  // Tab-specific button state is reset by Firefox on navigation, so this is
  // re-applied from tabs.onUpdated as well.
  browser.browserAction.setIcon({
    tabId,
    path: on ? "icons/on.svg" : "icons/off.svg",
  }).catch(() => {});
  browser.browserAction.setTitle({
    tabId,
    title: on
      ? "Volume normalization: on (click to turn off)"
      : "Volume normalization: off (click to turn on)",
  }).catch(() => {});
}

browser.browserAction.onClicked.addListener((tab) => {
  const enabled = !enabledTabs.has(tab.id);
  if (enabled) {
    enabledTabs.add(tab.id);
  } else {
    enabledTabs.delete(tab.id);
  }
  updateButton(tab.id);
  // Reaches the content script in every frame of the tab. Fails harmlessly
  // on pages where content scripts cannot run (about:, addons.mozilla.org).
  browser.tabs.sendMessage(tab.id, { type: "set", enabled }).catch(() => {});
});

// Each frame asks for its tab's state when it loads, so the setting survives
// navigation and applies to iframes added later.
browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || !sender.tab) return undefined;
  const tabId = sender.tab.id;

  if (message.type === "query") {
    // A new top-level document replaces every frame in the tab; any other
    // (re)loaded frame only replaces itself.
    if (sender.frameId === 0 && message.fresh) {
      activeFrames.delete(tabId);
    } else {
      setFrameActive(tabId, sender.frameId, false);
    }
    updateMark(tabId);
    return Promise.resolve({ enabled: enabledTabs.has(tabId) });
  }

  if (message.type === "compose") {
    return composeIcon(String(message.url || ""));
  }

  if (message.type === "active") {
    setFrameActive(tabId, sender.frameId, message.active);
    updateMark(tabId);
  }
  return undefined;
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status && enabledTabs.has(tabId)) {
    updateButton(tabId);
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  enabledTabs.delete(tabId);
  activeFrames.delete(tabId);
});
