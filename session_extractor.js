// Pelt — Session Extractor (Content Script)
// Runs on steamcommunity.com pages to capture g_sessionID.
// The session ID is needed to create trade offers via POST.
// It is stored locally in extension storage — NEVER sent to our servers.

(function () {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;
  const EXPECTED_ORIGIN = "https://steamcommunity.com";

  // Inject a tiny page script to read g_sessionID from Steam's JS context
  const script = document.createElement("script");
  script.textContent = `
    (function() {
      var origin = "https://steamcommunity.com";
      if (typeof g_sessionID !== "undefined" && g_sessionID) {
        window.postMessage({ type: "PELT_SESSION", sessionID: g_sessionID }, origin);
      }
      var match = document.documentElement.innerHTML.match(/g_sessionID\\s*=\\s*"([0-9a-fA-F]+)"/);
      if (match && match[1]) {
        window.postMessage({ type: "PELT_SESSION", sessionID: match[1] }, origin);
      }
    })();
  `;
  document.head.appendChild(script);
  script.remove();

  // Listen for the session ID from the page script
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.origin !== EXPECTED_ORIGIN) return; // Reject cross-origin messages
    if (event.data?.type === "PELT_SESSION" && event.data.sessionID) {
      // Validate session ID format (hex string, 24 chars typical)
      if (!/^[0-9a-fA-F]{12,32}$/.test(event.data.sessionID)) return;
      api.storage.local.set({
        steamSessionID: event.data.sessionID,
        steamSessionUpdated: Date.now(),
      });
    }
  });
})();
