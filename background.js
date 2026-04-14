// Pelt Extension — Background Service Worker
// Creates trade offers, verifies trades via Steam Web API, and reports status to pelt.gg.
// Inspired by CSFloat's robust extension architecture.

const api = typeof browser !== "undefined" ? browser : chrome;
const PELT_ORIGINS = ["https://pelt.gg"];
const STEAM_API_BASE = "https://api.steampowered.com";
const POLL_INTERVAL_MIN = 2; // Poll every 2 minutes
const SESSION_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const STALE_OFFER_MS = 60 * 60 * 1000; // 1 hour — auto-cancel unconfirmed offers
const REFERER_RULE_ID = 1738196326;

var refererRuleReady = false;

async function configureRefererRule() {
  if (!api.declarativeNetRequest || !api.runtime?.getURL) return false;

  try {
    var extensionHost = new URL(api.runtime.getURL("")).hostname;
    await api.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [REFERER_RULE_ID],
      addRules: [
        {
          id: REFERER_RULE_ID,
          priority: 2,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              {
                header: "Referer",
                operation: "set",
                value: "https://steamcommunity.com/tradeoffer/new",
              },
            ],
          },
          condition: {
            urlFilter: "https://steamcommunity.com/tradeoffer/new/send",
            resourceTypes: ["xmlhttprequest"],
            initiatorDomains: [extensionHost],
          },
        },
      ],
    });
    refererRuleReady = true;
    return true;
  } catch (_e) {
    return false;
  }
}

async function ensureRefererRule() {
  if (refererRuleReady) return true;
  return configureRefererRule();
}

// ── Message Handling ────────────────────────────────────────────────────────

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
    // Content script requests session extraction via MAIN world injection
    if (chrome.scripting) {
      chrome.scripting.executeScript({
        target: { tabId: sender.tab.id },
        world: "MAIN",
        func: function () {
          var data = {};
          if (typeof g_sessionID !== "undefined" && g_sessionID) data.sessionID = g_sessionID;
          if (typeof g_steamID !== "undefined" && g_steamID) data.steamID = g_steamID;
          if (Object.keys(data).length > 0) {
            window.postMessage(
              { type: "__PELT_SESSION_RESULT__", ...data },
              window.location.origin
            );
          }
        },
      }).catch(function () {});
    }
    return false;
  }
  if (message.type === "PELT_GET_SESSION") {
    // Website requests non-sensitive session state
    getOrRefreshSession()
      .then((session) => sendResponse(toPublicSession(session)))
      .catch(() => sendResponse({ loggedIn: false }));
    return true;
  }
});

// External messages (from pelt.gg directly, browser-enforced via externally_connectable)
if (api.runtime.onMessageExternal) {
  api.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    // Browser enforces externally_connectable origins, but double-check
    var senderOrigin = sender.origin || (sender.url ? new URL(sender.url).origin : null);
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

// ── Alarms ──────────────────────────────────────────────────────────────────

if (chrome.alarms) {
  chrome.alarms.create("pelt-trade-poll", { periodInMinutes: POLL_INTERVAL_MIN });
  chrome.alarms.create("pelt-session-refresh", { periodInMinutes: 15 });
  chrome.alarms.create("pelt-stale-cancel", { periodInMinutes: 10 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "pelt-trade-poll") pollPendingTrades().catch(() => {});
    if (alarm.name === "pelt-session-refresh") getOrRefreshSession().catch(() => {});
    if (alarm.name === "pelt-stale-cancel") cancelStaleOffers().catch(() => {});
  });
}

// Poll on service worker wake-up
pollPendingTrades().catch(() => {});
configureRefererRule().catch(() => {});

// ── Session Management ──────────────────────────────────────────────────────
// Primary: fetch steamcommunity.com from background and parse g_sessionID + g_steamID + access token
// Fallback: content script MAIN world injection (for when user is browsing Steam)

async function getOrRefreshSession() {
  var stored = await api.storage.local.get([
    "steamSessionID", "steamSteamID", "steamAccessToken",
    "steamSessionUpdated"
  ]);

  // Return cached if fresh
  if (stored.steamSessionID && stored.steamSessionUpdated) {
    var age = Date.now() - stored.steamSessionUpdated;
    if (age < SESSION_MAX_AGE_MS) {
      return {
        sessionID: stored.steamSessionID,
        steamID: stored.steamSteamID || null,
        accessToken: stored.steamAccessToken || null,
        fresh: false,
      };
    }
  }

  // Fetch fresh from Steam
  try {
    var resp = await fetch("https://steamcommunity.com/", {
      credentials: "include",
      headers: { "Accept": "text/html,application/xhtml+xml" },
    });
    if (!resp.ok) return null;

    var html = await resp.text();
    var sessionMatch = html.match(/g_sessionID\s*=\s*"([0-9a-fA-F]+)"/);
    var steamIdMatch = html.match(/g_steamID\s*=\s*"(\d{17})"/);
    var tokenMatch = html.match(/data-loyalty_webapi_token="&quot;([^&]+)&quot;"/);

    if (!sessionMatch) return null;

    var session = {
      sessionID: sessionMatch[1],
      steamID: steamIdMatch ? steamIdMatch[1] : null,
      accessToken: tokenMatch ? tokenMatch[1] : null,
      fresh: true,
    };

    await api.storage.local.set({
      steamSessionID: session.sessionID,
      steamSteamID: session.steamID,
      steamAccessToken: session.accessToken,
      steamSessionUpdated: Date.now(),
    });

    return session;
  } catch (_e) {
    return null;
  }
}

function toPublicSession(session) {
  if (!session || !session.steamID) {
    return { loggedIn: false };
  }

  return {
    loggedIn: true,
    steamID: session.steamID,
    fresh: !!session.fresh,
  };
}

// ── Trade Verification (Steam Web API primary, HTML scraping fallback) ──────

async function pollPendingTrades() {
  var stored = await api.storage.local.get(["pendingTrades"]);
  var pending = stored.pendingTrades || [];
  if (pending.length === 0) return { checked: 0 };

  // Try Steam Web API first (via access token)
  var session = await getOrRefreshSession();
  var apiResults = null;

  if (session && session.accessToken) {
    apiResults = await fetchTradeOffersViaAPI(session.accessToken);
  }

  for (var trade of pending) {
    try {
      var newState = null;

      // Primary: Steam Web API
      if (apiResults) {
        newState = getTradeStateFromAPI(apiResults, trade.tradeOfferId);
      }

      // Fallback: HTML scraping (if API didn't return a result for this trade)
      if (!newState) {
        newState = await getTradeStateFromHTML(trade.tradeOfferId);
      }

      if (newState && newState !== trade.lastState) {
        // Report to Pelt server
        await reportTradeStatus(trade.transactionId, trade.tradeOfferId, newState);
        trade.lastState = newState;
        if (["accepted", "declined", "cancelled", "escrow"].includes(newState)) {
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

  var remaining = pending.filter(function(t) { return !t.done; });
  await api.storage.local.set({ pendingTrades: remaining });
  return { checked: pending.length, remaining: remaining.length };
}

/**
 * Fetch sent trade offers via Steam Web API using the access token.
 * Returns a map of tradeOfferId -> state string.
 */
async function fetchTradeOffersViaAPI(accessToken) {
  try {
    var url = STEAM_API_BASE + "/IEconService/GetTradeOffers/v1/?" +
      "access_token=" + encodeURIComponent(accessToken) +
      "&get_sent_offers=true&get_received_offers=false&active_only=false" +
      "&time_historical_cutoff=" + Math.floor((Date.now() / 1000) - 7 * 86400);

    var ctrl = new AbortController();
    var timer = setTimeout(function() { ctrl.abort(); }, 15000);
    var resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);

    if (!resp.ok) return null;

    var data = await resp.json();
    var offers = data.response?.trade_offers_sent || [];
    var results = {};

    for (var offer of offers) {
      var id = String(offer.tradeofferid);
      var state = offer.trade_offer_state;
      // Map Steam states to our state strings
      // 2=Active, 3=Accepted, 4=Countered, 5=Expired, 6=Canceled,
      // 7=Declined, 9=NeedsConfirmation, 10=CanceledBySecondFactor, 11=InEscrow
      if (state === 3) results[id] = "accepted";
      else if (state === 7) results[id] = "declined";
      else if (state === 5 || state === 6 || state === 4 || state === 8 || state === 10) results[id] = "cancelled";
      else if (state === 11) results[id] = "escrow";
      else if (state === 2 || state === 9) results[id] = "active";
    }

    return results;
  } catch (_e) {
    return null;
  }
}

/**
 * Get trade state from API results map.
 */
function getTradeStateFromAPI(apiResults, tradeOfferId) {
  var state = apiResults[String(tradeOfferId)];
  return state && state !== "active" ? state : null;
}

/**
 * Fallback: fetch individual trade offer page and parse HTML for status.
 */
async function getTradeStateFromHTML(tradeOfferId) {
  try {
    var resp = await fetch(
      "https://steamcommunity.com/tradeoffer/" + tradeOfferId + "/",
      { credentials: "include" }
    );
    if (!resp.ok) return null;

    var html = await resp.text();

    if (html.includes("Trade Accepted") || html.includes("Items have been exchanged")) {
      return "accepted";
    } else if (html.toLowerCase().includes("escrow")) {
      return "escrow";
    } else if (html.includes("Trade Declined") || html.includes("has been declined")) {
      return "declined";
    } else if (
      html.includes("Trade Canceled") || html.includes("Cancelled") ||
      html.includes("CanceledBySecondFactor") || html.includes("Counter offer made")
    ) {
      return "cancelled";
    }

    return null;
  } catch (_e) {
    return null;
  }
}

/**
 * Report trade status to Pelt server.
 */
async function reportTradeStatus(transactionId, tradeOfferId, state) {
  var lastError = null;
  for (var origin of PELT_ORIGINS) {
    try {
      var resp = await fetch(origin + "/api/extension/trade-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ transactionId: transactionId, tradeOfferId: tradeOfferId, state: state }),
      });
      if (resp.ok) return;
      lastError = new Error("Trade status report failed with HTTP " + resp.status);
    } catch (e) {
      lastError = e;
      continue;
    }
  }
  throw lastError || new Error("Failed to report trade status");
}

// ── Auto-Cancel Stale Unconfirmed Offers ────────────────────────────────────

async function cancelStaleOffers() {
  var stored = await api.storage.local.get(["pendingTrades", "steamSessionID"]);
  var pending = stored.pendingTrades || [];
  var sessionID = stored.steamSessionID;
  if (!sessionID || pending.length === 0) return;

  for (var trade of pending) {
    if (trade.done) continue;
    var age = Date.now() - trade.createdAt;
    if (age < STALE_OFFER_MS) continue;
    if (trade.lastState !== "active") continue;

    // Cancel the stale offer on Steam
    try {
      var formData = new URLSearchParams();
      formData.set("sessionid", sessionID);
      var cancelResp = await fetch(
        "https://steamcommunity.com/tradeoffer/" + trade.tradeOfferId + "/cancel",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
          credentials: "include",
          body: formData.toString(),
        }
      );
      if (!cancelResp.ok) continue;
      trade.lastState = "cancelled";
      trade.done = true;

      // Report cancellation to Pelt
      await reportTradeStatus(trade.transactionId, trade.tradeOfferId, "cancelled");
    } catch (_e) {
      // Skip — will retry next cycle
    }
  }

  var remaining = pending.filter(function(t) { return !t.done; });
  await api.storage.local.set({ pendingTrades: remaining });
}

// ── Create Trade Offer (multi-item support) ─────────────────────────────────

async function handleCreateTradeOffer(params) {
  var partnerSteamId = params.partnerSteamId;
  var tradeToken = params.tradeToken;
  var transactionId = params.transactionId;

  // Support both single-item (legacy) and multi-item formats
  var itemsToGive = params.itemsToGive || [];
  var itemsToReceive = params.itemsToReceive || [];

  // Legacy single-item format
  if (itemsToGive.length === 0 && params.assetId) {
    itemsToGive = [{ appId: params.appId, assetId: params.assetId }];
  }

  if (!partnerSteamId || !tradeToken || itemsToGive.length === 0) {
    return { success: false, error: "Missing required trade parameters" };
  }

  // Get fresh session with account identity validation
  var session = await getOrRefreshSession();

  if (!session || !session.sessionID) {
    return {
      success: false,
      error: "No Steam session found. Visit steamcommunity.com first to log in.",
      needsLogin: true,
    };
  }

  await ensureRefererRule();

  // Account identity validation: if we know the expected seller SteamID, verify it matches
  if (params.expectedSteamId && session.steamID && session.steamID !== params.expectedSteamId) {
    return {
      success: false,
      error: "Steam account mismatch. You are logged in as " + session.steamID +
        " but the listing belongs to " + params.expectedSteamId +
        ". Log in to the correct Steam account.",
      wrongAccount: true,
    };
  }

  // Build trade offer JSON
  var meAssets = itemsToGive.map(function(item) {
    return { appid: item.appId, contextid: "2", assetid: String(item.assetId), amount: 1 };
  });
  var themAssets = itemsToReceive.map(function(item) {
    return { appid: item.appId, contextid: "2", assetid: String(item.assetId), amount: 1 };
  });

  var tradeOffer = {
    newversion: true,
    version: meAssets.length + themAssets.length + 1,
    me: { assets: meAssets, currency: [], ready: false },
    them: { assets: themAssets, currency: [], ready: false },
  };

  var formData = new URLSearchParams();
  formData.set("sessionid", session.sessionID);
  formData.set("serverid", "1");
  formData.set("partner", partnerSteamId);
  formData.set("tradeoffermessage", params.message || "");
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
