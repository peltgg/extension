// Pelt — Marketplace Bridge (Content Script)
// Injected on localhost and pelt.gg to relay messages
// between the marketplace webpage and the extension background script.

(function () {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;
  const ALLOWED_ORIGIN = window.location.origin; // Only accept messages from same origin

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
  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    if (event.origin !== ALLOWED_ORIGIN) return; // Reject cross-origin messages

    // Respond to ping
    if (event.data?.type === "PELT_PING") {
      announce();
      return;
    }

    // Handle trade offer creation request
    if (event.data?.type === "PELT_CREATE_TRADE") {
      try {
        const response = await api.runtime.sendMessage({
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
    }
  });
})();
