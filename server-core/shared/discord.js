'use strict';

const http = require('http');
const { DISCORD_BOT_WEBHOOK_URL } = require('../config/constants');

function pushDiscordEvent(eventType, data) {
  if (!DISCORD_BOT_WEBHOOK_URL) return;
  try {
    const payload = JSON.stringify({ type: eventType, ...data, serverTimestamp: Date.now() });
    const url = new URL(DISCORD_BOT_WEBHOOK_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 3000,
    };
    const req = http.request(options, () => {});
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch (_) { /* fire-and-forget */ }
}

module.exports = { pushDiscordEvent };
