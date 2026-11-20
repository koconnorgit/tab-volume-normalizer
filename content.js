"use strict";

(() => {
  // Compressor tuning. A low threshold with a high ratio squashes loud parts,
  // and the node's built-in makeup gain lifts quiet parts, which evens out
  // the overall level.
  const COMPRESSOR = {
    threshold: -40, // dB
    knee: 30, // dB
    ratio: 12,
    attack: 0.005, // seconds
    release: 0.25, // seconds
  };

  let enabled = false;
  let ctx = null;
  let compressor = null;
  let observer = null;
  let reportedActive = false;

  // While audio in the tab is actually being normalized, the tab's favicon is
  // replaced by a copy of itself with the toolbar button's "on" image badged
  // onto it (drawn by the background script). Only the top frame does this.
  const HIDDEN_REL = "x-normalizer-hidden-icon";
  const isTopFrame = window.top === window;
  let marked = false;
  let iconLink = null;
  let headObserver = null;
  let sourceUrl; // the page's favicon URL the badge was drawn on; undefined = not looked up yet
  let composedUrl = null; // the badged favicon, as a data: URL
  let composeSeq = 0;
  // The page's own icon <link>s -> their original rel, so they can be restored.
  const hiddenIcons = new Map();

  // element -> MediaElementAudioSourceNode. An element can only ever be given
  // one source node, so entries are kept and re-routed rather than removed.
  const sources = new Map();

  function ensureContext() {
    if (ctx) return;
    ctx = new AudioContext();
    compressor = ctx.createDynamicsCompressor();
    for (const [name, value] of Object.entries(COMPRESSOR)) {
      compressor[name].value = value;
    }
    compressor.connect(ctx.destination);
  }

  function resumeContext() {
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
  }

  // Routing cross-origin media that was loaded without CORS through Web Audio
  // produces silence, so those elements must be left alone.
  function wouldBeSilenced(el) {
    if (el.srcObject) return false;
    const src = el.currentSrc || el.src;
    if (!src) return true; // source not known yet; wait for a later event
    let url;
    try {
      url = new URL(src, location.href);
    } catch (e) {
      return true;
    }
    if (url.protocol === "blob:" || url.protocol === "data:") return false;
    if (url.origin === location.origin) return false;
    return el.crossOrigin === null;
  }

  // True while this frame has at least one media element going through the
  // compressor. The background script combines this across frames.
  function reportActive(force) {
    const active = enabled && sources.size > 0;
    if (!force && active === reportedActive) return;
    reportedActive = active;
    browser.runtime.sendMessage({ type: "active", active }).catch(() => {});
  }

  // The page's current favicon URL, going by its (not yet hidden) icon links.
  function pageIconUrl() {
    let url = null;
    for (const link of document.querySelectorAll('link[rel~="icon" i]')) {
      if (link !== iconLink && link.href) url = link.href;
    }
    return url;
  }

  // Works out which favicon to badge and asks the background script to draw
  // it. Runs when the mark turns on and whenever the page changes its icons.
  function refreshMark() {
    if (!marked || !document.head) return;

    let wanted = pageIconUrl();
    if (wanted === null) {
      if (sourceUrl !== undefined) {
        applyMark();
        return;
      }
      // No icon declared: browsers fall back to /favicon.ico.
      wanted = /^https?:$/.test(location.protocol) ? location.origin + "/favicon.ico" : "";
    }

    if (wanted !== sourceUrl) {
      sourceUrl = wanted;
      const seq = ++composeSeq;
      browser.runtime
        .sendMessage({ type: "compose", url: wanted })
        .then((dataUrl) => {
          if (seq !== composeSeq || !marked || !dataUrl) return;
          composedUrl = dataUrl;
          applyMark();
        })
        .catch(() => {});
    }
    applyMark();
  }

  function applyMark() {
    if (!marked || !document.head) return;
    headObserver.disconnect();

    if (composedUrl) {
      // Take the page's own icons out of the running so ours is the only one.
      for (const link of document.querySelectorAll('link[rel~="icon" i]')) {
        if (link === iconLink) continue;
        hiddenIcons.set(link, link.getAttribute("rel"));
        link.setAttribute("rel", HIDDEN_REL);
      }

      if (!iconLink) {
        iconLink = document.createElement("link");
        iconLink.rel = "icon";
        iconLink.type = "image/png";
      }
      if (iconLink.getAttribute("href") !== composedUrl) iconLink.href = composedUrl;
      if (iconLink.parentNode !== document.head || iconLink.nextElementSibling) {
        document.head.appendChild(iconLink);
      }
    }

    // Pages add icon links later (e.g. for notification badges); re-badge.
    headObserver.observe(document.head, { childList: true });
  }

  function setMarked(value) {
    if (!isTopFrame) return;
    value = Boolean(value);
    if (value === marked) return;
    marked = value;

    if (marked) {
      if (!headObserver) headObserver = new MutationObserver(refreshMark);
      refreshMark();
      return;
    }

    if (headObserver) headObserver.disconnect();
    composeSeq++;
    sourceUrl = undefined;
    composedUrl = null;
    if (iconLink) {
      iconLink.remove();
      iconLink = null;
    }

    // Firefox only re-reads a tab's favicon when an icon link is inserted
    // into the document (or its href changes). Changing rel back, or removing
    // our link, is not enough, so each restored link is re-inserted in place.
    let restored = false;
    for (const [link, rel] of hiddenIcons) {
      if (link.getAttribute("rel") === HIDDEN_REL) link.setAttribute("rel", rel);
      if (link.isConnected && link.parentNode) {
        link.parentNode.insertBefore(link, link.nextSibling);
        restored = true;
      }
    }
    hiddenIcons.clear();

    if (!restored && document.head && /^https?:$/.test(location.protocol)) {
      // The page relied on the default /favicon.ico; point back at it.
      const fallback = document.createElement("link");
      fallback.rel = "icon";
      fallback.href = location.origin + "/favicon.ico";
      document.head.appendChild(fallback);
    }
  }

  function route(source) {
    source.disconnect();
    source.connect(enabled ? compressor : ctx.destination);
  }

  function hook(el) {
    if (!enabled || sources.has(el) || wouldBeSilenced(el)) return;
    ensureContext();
    let source;
    try {
      source = ctx.createMediaElementSource(el);
    } catch (e) {
      return; // already captured by the page, or otherwise unavailable
    }
    sources.set(el, source);
    route(source);
    resumeContext();
    reportActive();
  }

  function scan(root) {
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    if (root instanceof HTMLMediaElement) hook(root);
    for (const el of root.querySelectorAll("audio, video")) hook(el);
  }

  function onMediaEvent(event) {
    if (event.target instanceof HTMLMediaElement) {
      hook(event.target);
      resumeContext();
    }
  }

  function setEnabled(value) {
    value = Boolean(value);
    if (value === enabled) return;
    enabled = value;

    if (enabled) {
      scan(document);
      if (!observer) {
        observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) scan(node);
          }
        });
      }
      observer.observe(document, { childList: true, subtree: true });
    } else if (observer) {
      observer.disconnect();
    }

    for (const source of sources.values()) route(source);
    resumeContext();
    reportActive();
  }

  // Fetch this tab's setting and tell the background script where this frame
  // stands. `fresh` is true for a new document, false for one restored from
  // the back/forward cache (which missed any messages sent while it was away).
  function sync(fresh) {
    browser.runtime
      .sendMessage({ type: "query", fresh })
      .then((reply) => {
        if (!reply) return;
        setEnabled(reply.enabled);
        reportActive(true);
      })
      .catch(() => {});
  }

  // Media events do not bubble, but they can be caught in the capture phase.
  // These catch elements whose source only becomes known after they are added.
  for (const type of ["loadedmetadata", "play", "playing"]) {
    window.addEventListener(type, onMediaEvent, true);
  }
  // An AudioContext may start suspended until the user interacts with the page.
  for (const type of ["pointerdown", "keydown"]) {
    window.addEventListener(type, resumeContext, true);
  }

  browser.runtime.onMessage.addListener((message) => {
    if (!message) return;
    if (message.type === "set") setEnabled(message.enabled);
    if (message.type === "mark") setMarked(message.on);
  });

  window.addEventListener("DOMContentLoaded", refreshMark);
  window.addEventListener("pagehide", () => {
    if (reportedActive) {
      reportedActive = false;
      browser.runtime.sendMessage({ type: "active", active: false }).catch(() => {});
    }
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) sync(false);
  });

  sync(true);
})();
