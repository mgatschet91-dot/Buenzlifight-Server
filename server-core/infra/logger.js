'use strict';

function nowStamp() {
  return new Date().toISOString();
}

function logInfo(scope, message, details = null) {
  if (details && typeof details === 'object') {
    console.log(`[${nowStamp()}] [${scope}] ${message}`, details);
    return;
  }
  console.log(`[${nowStamp()}] [${scope}] ${message}`);
}

function logWarn(scope, message, details = null) {
  if (details && typeof details === 'object') {
    console.warn(`[${nowStamp()}] [${scope}] ${message}`, details);
    return;
  }
  console.warn(`[${nowStamp()}] [${scope}] ${message}`);
}

function logError(scope, message, details = null) {
  if (details && typeof details === 'object') {
    console.error(`[${nowStamp()}] [${scope}] ${message}`, details);
    return;
  }
  console.error(`[${nowStamp()}] [${scope}] ${message}`);
}

async function runStartupTask(name, task) {
  const started = Date.now();
  logInfo('BOOT', `Start: ${name}`);
  try {
    await task();
    const elapsed = Date.now() - started;
    logInfo('BOOT', `OK: ${name} (${elapsed}ms)`);
    return { name, ok: true, elapsed };
  } catch (err) {
    const elapsed = Date.now() - started;
    logError('BOOT', `FEHLER: ${name} (${elapsed}ms)`, { error: err?.message || String(err) });
    return { name, ok: false, elapsed, error: err };
  }
}

module.exports = { nowStamp, logInfo, logWarn, logError, runStartupTask };
