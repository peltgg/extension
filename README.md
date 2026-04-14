# Pelt Browser Extension

The official browser extension for [Pelt](https://pelt.gg) — a peer-to-peer marketplace for S&box skins.

## What It Does

- **Auto-creates Steam trade offers** when you sell an item on Pelt, without leaving the site
- **Polls trade status** and reports acceptance/decline/cancellation back to Pelt for near-instant settlement
- **Extracts Steam session ID** from steamcommunity.com for authentication (stored locally, never sent to our servers)

## What It Does NOT Do

- Does not access your Steam password or credentials
- Does not read your inventory (that's done server-side via Steam API)
- Does not send any data to third parties
- Does not modify any Steam pages
- Does not run any code outside of pelt.gg and steamcommunity.com

## Files

| File | Purpose |
|------|---------|
| `background.js` | Service worker — creates trade offers via Steam's endpoint, polls trade status |
| `marketplace_bridge.js` | Content script on pelt.gg — relays messages between the page and the extension |
| `session_extractor.js` | Content script on steamcommunity.com — reads g_sessionID for trade authentication |
| `manifest.json` | Extension configuration and permissions |
| `rules.json` | Sets Referer header for Steam trade API calls |

## Permissions Explained

| Permission | Why |
|-----------|-----|
| `storage` | Store Steam session ID and pending trade status locally |
| `scripting` | Inject content scripts on pelt.gg and Steam |
| `alarms` | Periodic trade status polling (every 30 seconds) |
| `declarativeNetRequestWithHostAccess` | Set correct Referer header for Steam API |
| `host_permissions: steamcommunity.com` | Read session ID + create trade offers |
| `host_permissions: pelt.gg` | Communicate with the marketplace |

## Installation

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select this folder
5. The Pelt icon should appear in your browser toolbar
6. Visit [steamcommunity.com](https://steamcommunity.com) once to initialize your session
7. Go to [pelt.gg](https://pelt.gg) and start trading

## Yes, This Is The Entire Extension

5 files. No build step. No dependencies. No bundler. Fully auditable in under 5 minutes. We keep it minimal on purpose — less code means fewer places for bugs or vulnerabilities to hide.

## Security

This extension is fully open-source so you can audit every line of code. We believe in transparency — especially for software that interacts with your Steam account.

If you find a security issue, please report it to **support@pelt.gg**.

## License

MIT
