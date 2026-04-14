// Pelt — Marketplace Bridge (Content Script)
// Injected on pelt.gg to relay messages between the webpage and the extension background script.

(function () {
  "use strict";

  var api = typeof browser !== "undefined" ? browser : chrome;
  var ALLOWED_ORIGIN = window.location.origin;

  // Announce extension presence immediately and repeatedly
  // (React components may mount after this script runs)
  function announce() {
    window.postMessage({ type: "PELT_PONG" }, ALLOWED_ORIGIN);
  }

  announce();
  setTimeout(announce, 500);
  setTimeout(announce, 1500);
  setTimeout(announce, 3000);

  // Listen for messages from the marketplace page
  window.addEventListener("message", async function (event) {
    if (event.source !== window) return;
    if (event.origin !== ALLOWED_ORIGIN) return;

    // Respond to ping
    if (event.data?.type === "PELT_PING") {
      announce();
      return;
    }

    // Handle trade offer creation request (single or multi-item)
    if (event.data?.type === "PELT_CREATE_TRADE") {
      try {
        var response = await api.runtime.sendMessage({
          type: "CREATE_TRADE_OFFER",
          ...event.data.payload,
        });

        window.postMessage({
          type: "PELT_TRADE_RESULT",
          ...response,
        }, ALLOWED_ORIGIN);
      } catch (err) {
        window.postMessage({
          type: "PELT_TRADE_RESULT",
          success: false,
          error: "Extension communication error: " + (err instanceof Error ? err.message : String(err)),
        }, ALLOWED_ORIGIN);
      }
      return;
    }

    // Handle session request (page wants to know if user is logged into Steam)
    if (event.data?.type === "PELT_GET_SESSION") {
      try {
        var session = await api.runtime.sendMessage({ type: "PELT_GET_SESSION" });
        window.postMessage({
          type: "PELT_SESSION_RESULT",
          ...session,
        }, ALLOWED_ORIGIN);
      } catch (err) {
        window.postMessage({
          type: "PELT_SESSION_RESULT",
          error: "Failed to get session",
        }, ALLOWED_ORIGIN);
      }
      return;
    }

    // Handle manual trade poll request
    if (event.data?.type === "PELT_POLL_TRADES") {
      try {
        var result = await api.runtime.sendMessage({ type: "PELT_POLL_TRADES" });
        window.postMessage({
          type: "PELT_POLL_RESULT",
          ...result,
        }, ALLOWED_ORIGIN);
      } catch (_e) {}
      return;
    }
  });
})();
