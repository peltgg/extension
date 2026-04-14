// Pelt — Session Extractor (Content Script)
// Runs on steamcommunity.com pages to capture g_sessionID and g_steamID.
// The session ID is needed to create trade offers via POST.
// The Steam ID is used for account identity validation.
// All data stored locally in extension storage — NEVER sent to our servers.

(function () {
  "use strict";

  var api = typeof browser !== "undefined" ? browser : chrome;

  function saveSession(data) {
    var update = { steamSessionUpdated: Date.now() };
    if (data.sessionID && /^[0-9a-fA-F]{12,32}$/.test(data.sessionID)) {
      update.steamSessionID = data.sessionID;
    }
    if (data.steamID && /^\d{17}$/.test(data.steamID)) {
      update.steamSteamID = data.steamID;
    }
    if (Object.keys(update).length > 1) {
      api.storage.local.set(update);
    }
  }

  // Listen for results from the main-world script injection (via background.js)
  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    if (event.data?.type === "__PELT_SESSION_RESULT__") {
      saveSession(event.data);
    }
  });

  // Method 1: Ask background to inject into page's MAIN world
  // (bypasses CSP, accesses live g_sessionID and g_steamID variables)
  try {
    api.runtime.sendMessage({ type: "PELT_EXTRACT_SESSION" });
  } catch (_e) {}

  // Method 2: Fallback — regex-match from page HTML (DOM access)
  function extractFromDom() {
    var html = document.documentElement.innerHTML;
    var data = {};
    var sessionMatch = html.match(/g_sessionID\s*=\s*"([0-9a-fA-F]+)"/);
    if (sessionMatch && sessionMatch[1]) data.sessionID = sessionMatch[1];
    var steamIdMatch = html.match(/g_steamID\s*=\s*"(\d{17})"/);
    if (steamIdMatch && steamIdMatch[1]) data.steamID = steamIdMatch[1];
    if (data.sessionID || data.steamID) saveSession(data);
  }

  extractFromDom();
  setTimeout(extractFromDom, 1500);
})();
