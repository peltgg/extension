// Pelt Extension — Background Service Worker / Script
// Creates trade offers in the background without opening the Steam trade page.
// The user must still confirm via Steam Mobile Authenticator.
// Also polls for trade status changes and reports them back to pelt.gg.

const api = typeof browser !== "undefined" ? browser : chrome;
const PELT_ORIGINS = ["https://pelt.gg"];

// ── Listen for messages from the marketplace website ──────────────────────────

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CREATE_TRADE_OFFER") {
    handleCreateTradeOffer(message)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.type === "PELT_POLL_TRADES") {
    pollPendingTrades()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.type === "PELT_EXTRACT_SESSION" && sender.tab?.id) {
    // Use chrome.scripting to execute in the page's MAIN world (bypasses CSP)
    // This can access page JS globals like g_sessionID directly
    if (chrome.scripting) {
      chrome.scripting.executeScript({
        target: { tabId: sender.tab.id },
        world: "MAIN",
        func: function () {
          if (typeof g_sessionID !== "undefined" && g_sessionID) {
            window.postMessage(
              { type: "__PELT_SESSION_RESULT__", sessionID: g_sessionID },
              window.location.origin
            );
          }
        },
      }).catch(function () {});
    }
    return false;
  }
});

if (api.runtime.onMessageExternal) {
  api.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    // Validate origin — only accept messages from trusted Pelt origins
    const senderOrigin = sender.origin || (sender.url ? new URL(sender.url).origin : null);
    if (!senderOrigin || !PELT_ORIGINS.includes(senderOrigin)) {
      sendResponse({ success: false, error: "Untrusted origin" });
      return true;
    }

    if (message.type === "CREATE_TRADE_OFFER") {
      handleCreateTradeOffer(message)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true;
    }
  });
}

// ── Trade status polling via Chrome alarms ───────────────────────────────────

if (chrome.alarms) {
  chrome.alarms.create("pelt-trade-poll", { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "pelt-trade-poll") {
      pollPendingTrades().catch(() => {});
    }
  });
}

// Also poll on service worker wake-up
pollPendingTrades().catch(() => {});

/**
 * Poll Steam for status of pending trade offers and report back to Pelt.
 * Checks trades stored in extension storage that are awaiting confirmation.
 */
async function pollPendingTrades() {
  const stored = await api.storage.local.get(["pendingTrades", "steamSessionID"]);
  const pending = stored.pendingTrades || [];
  if (pending.length === 0) return { checked: 0 };

  const sessionID = stored.steamSessionID;
  if (!sessionID) return { checked: 0 };

  for (const trade of pending) {
    try {
      const res = await fetch(
        "https://steamcommunity.com/tradeoffer/" + trade.tradeOfferId + "/",
        { credentials: "include" }
      );
      if (!res.ok) continue;

      const html = await res.text();

      let newState = null;
      if (html.includes("Trade Accepted") || html.includes("Items have been exchanged")) {
        newState = "accepted";
      } else if (html.includes("Trade Declined") || html.includes("has been declined")) {
        newState = "declined";
      } else if (html.includes("Trade Canceled") || html.includes("Cancelled") || html.includes("CanceledBySecondFactor")) {
        newState = "cancelled";
      }

      if (newState && newState !== trade.lastState) {
        // Report to Pelt server
        for (const origin of PELT_ORIGINS) {
          try {
            await fetch(origin + "/api/extension/trade-status", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({
                transactionId: trade.transactionId,
                tradeOfferId: trade.tradeOfferId,
                state: newState,
              }),
            });
            break;
          } catch (_e) {
            continue;
          }
        }
        trade.lastState = newState;
        if (["accepted", "declined", "cancelled"].includes(newState)) {
          trade.done = true;
        }
      }

      // Clean up old trades (> 48h)
      if (Date.now() - trade.createdAt > 48 * 60 * 60 * 1000) {
        trade.done = true;
      }
    } catch (_e) {
      // Skip individual failures
    }
  }

  const remaining = pending.filter(function(t) { return !t.done; });
  await api.storage.local.set({ pendingTrades: remaining });
  return { checked: pending.length, remaining: remaining.length };
}

// ── Create trade offer via Steam's endpoint ──────────────────────────────────

async function handleCreateTradeOffer(params) {
  const partnerSteamId = params.partnerSteamId;
  const tradeToken = params.tradeToken;
  const appId = params.appId;
  const assetId = params.assetId;
  const message = params.message;
  const transactionId = params.transactionId;

  if (!partnerSteamId || !tradeToken || !assetId) {
    return { success: false, error: "Missing required trade parameters" };
  }

  var stored = await api.storage.local.get(["steamSessionID", "steamSessionUpdated"]);
  var sessionID = stored.steamSessionID;

  if (!sessionID) {
    return {
      success: false,
      error: "No Steam session found. Visit steamcommunity.com first to log in.",
      needsLogin: true,
    };
  }

  // Refresh session if stale (> 1 hour)
  var age = Date.now() - (stored.steamSessionUpdated || 0);
  if (age > 3600000) {
    try {
      var refreshResp = await fetch("https://steamcommunity.com/", { credentials: "include" });
      var html = await refreshResp.text();
      var match = html.match(/g_sessionID\s*=\s*"([0-9a-fA-F]+)"/);
      if (match && match[1]) {
        await api.storage.local.set({ steamSessionID: match[1], steamSessionUpdated: Date.now() });
      }
    } catch (_e) {
      // Continue with existing session
    }
  }

  var freshStored = await api.storage.local.get(["steamSessionID"]);
  var freshSessionID = freshStored.steamSessionID || sessionID;

  var tradeOffer = {
    newversion: true,
    version: 2,
    me: {
      assets: [{ appid: appId, contextid: "2", assetid: String(assetId), amount: 1 }],
      currency: [],
      ready: false,
    },
    them: { assets: [], currency: [], ready: false },
  };

  var formData = new URLSearchParams();
  formData.set("sessionid", freshSessionID);
  formData.set("serverid", "1");
  formData.set("partner", partnerSteamId);
  formData.set("tradeoffermessage", message || "");
  formData.set("json_tradeoffer", JSON.stringify(tradeOffer));
  formData.set("captcha", "");
  formData.set("trade_offer_create_params", JSON.stringify({ trade_offer_access_token: tradeToken }));

  try {
    var response = await fetch("https://steamcommunity.com/tradeoffer/new/send", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      credentials: "include",
      body: formData.toString(),
    });

    var data = await response.json();

    if (data.tradeofferid) {
      // Store in pending trades for polling
      var pendingStored = await api.storage.local.get(["pendingTrades"]);
      var pendingList = pendingStored.pendingTrades || [];
      pendingList.push({
        tradeOfferId: data.tradeofferid,
        transactionId: transactionId,
        createdAt: Date.now(),
        lastState: "active",
        done: false,
      });
      await api.storage.local.set({ pendingTrades: pendingList });

      return {
        success: true,
        tradeOfferId: data.tradeofferid,
        transactionId: transactionId,
        needsMobileConfirmation: data.needs_mobile_confirmation || false,
      };
    } else {
      return { success: false, error: data.strError || "Steam rejected the trade offer" };
    }
  } catch (err) {
    return { success: false, error: "Failed to reach Steam: " + err.message };
  }
}
