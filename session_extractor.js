// Pelt — Session Extractor (Content Script)
// Runs on steamcommunity.com pages to capture g_sessionID.
// The session ID is needed to create trade offers via POST.
// It is stored locally in extension storage — NEVER sent to our servers.

(function () {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;

  // Extract g_sessionID directly from the page HTML.
  // Content scripts have DOM access, so we can regex-match from the source
  // without injecting an inline script (which Steam's CSP blocks).
  function extractSessionId() {
    var html = document.documentElement.innerHTML;
    var match = html.match(/g_sessionID\s*=\s*"([0-9a-fA-F]+)"/);
    if (match && match[1]) {
      var sessionID = match[1];
      // Validate session ID format (hex string, 12-32 chars typical)
      if (/^[0-9a-fA-F]{12,32}$/.test(sessionID)) {
        api.storage.local.set({
          steamSessionID: sessionID,
          steamSessionUpdated: Date.now(),
        });
      }
    }
  }

  // Run immediately and again after a short delay (some Steam pages
  // render g_sessionID after initial DOM load)
  extractSessionId();
  setTimeout(extractSessionId, 1500);
})();
