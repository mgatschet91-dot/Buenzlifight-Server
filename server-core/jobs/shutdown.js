'use strict';

const { logInfo, logError } = require('../infra/logger.js');

let isShuttingDown = false;

async function flushAllAndShutdown(server, intervals) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logInfo('SHUTDOWN', 'Server fährt herunter...');

  // Clear all intervals
  for (const interval of intervals || []) {
    clearInterval(interval);
  }

  // Flush all room runtime entries
  try {
    const rooms = require('../game/rooms');
    await rooms.flushAllRoomRuntimeEntries('shutdown');
    logInfo('SHUTDOWN', 'Alle Room-Caches geflusht');
  } catch (err) {
    logError('SHUTDOWN', 'Flush fehlgeschlagen', { error: err?.message });
  }

  // Close HTTP server
  if (server) {
    server.close(() => {
      logInfo('SHUTDOWN', 'HTTP-Server geschlossen');
      process.exit(0);
    });
    // Force exit after 10s
    setTimeout(() => {
      logError('SHUTDOWN', 'Force exit nach Timeout');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
}

function registerShutdownHandlers(server, intervals) {
  const handler = () => flushAllAndShutdown(server, intervals);
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  logInfo('SHUTDOWN', 'Shutdown-Handler registriert (SIGINT/SIGTERM)');
}

module.exports = { flushAllAndShutdown, registerShutdownHandlers };
