'use strict';

const fs = require('fs');

function loadConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const cfg = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    cfg[key] = value;
  }
  return cfg;
}

module.exports = { loadConfig };
