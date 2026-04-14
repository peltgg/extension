// Pelt — Session Extractor (Content Script)
// Runs on steamcommunity.com pages to capture g_sessionID.
// The session ID is needed to create trade offers via POST.
// It is stored locally in extension storage — NEVER sent to our servers.

(function () {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;

  function saveSession(sessionID) {
    if (/^[0-9a-fA-F]{12,32}$/.test(sessionID)) {
      api.storage.local.set({
        steamSessionID: sessionID,
        steamSessionUpdated: Date.now(),
      });
    }
  }

  // Listen for results from the main-world script injection (via background.js)
  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    if (event.data?.type === "__PELT_SESSION_RESULT__" && event.data.sessionID) {
      saveSession(event.data.sessionID);
    }
  });

  // Method 1: Ask the background script to inject into the page's main world
  // via chrome.scripting.executeScript (bypasses CSP, accesses page JS globals)
  try {
    api.runtime.sendMessage({ type: "PELT_EXTRACT_SESSION" });
  } catch (_e) {
    // Extension context may not be available
  }

  // Method 2: Fallback — regex-match g_sessionID from page HTML
  // Content scripts have DOM access but not page JS variable access.
  function extractFromDom() {
    var html = document.documentElement.innerHTML;
    var match = html.match(/g_sessionID\s*=\s*"([0-9a-fA-F]+)"/);
    if (match && match[1]) {
      saveSession(match[1]);
    }
  }

  extractFromDom();
  setTimeout(extractFromDom, 1500);
})();
