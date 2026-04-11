'use strict';

// Per-socket rate limiting for WebSocket events
// Returns a function that checks if an event should be rate-limited

const RATE_LIMITS = {
  // expensive DB operations
  'stats-update': { max: 5, windowMs: 10_000 },
  'budget-update': { max: 5, windowMs: 10_000 },
  'upgrade-building': { max: 10, windowMs: 60_000 },
  'items-constructed-sync': { max: 10, windowMs: 10_000 },
  'delta': { max: 60, windowMs: 10_000 },
  'deltas': { max: 10, windowMs: 10_000 },
  'stats-request': { max: 5, windowMs: 10_000 },
  // chat / messaging
  'room-chat': { max: 10, windowMs: 10_000 },
  'messenger-send': { max: 10, windowMs: 10_000 },
  'messenger-friend-request': { max: 5, windowMs: 60_000 },
  // movement (higher limits)
  'cursor': { max: 30, windowMs: 5_000 },
  'avatar-move-request': { max: 200, windowMs: 5_000 },  // Roller/WASD: ~12.5/s → braucht 200/5s
};

function createSocketRateLimiter() {
  const counters = new Map(); // eventName -> { count, resetAt }

  return function isRateLimited(eventName) {
    const limit = RATE_LIMITS[eventName];
    if (!limit) return false;

    const now = Date.now();
    const key = eventName;
    const entry = counters.get(key);

    if (!entry || now >= entry.resetAt) {
      counters.set(key, { count: 1, resetAt: now + limit.windowMs });
      return false;
    }

    entry.count++;
    if (entry.count > limit.max) return true;
    return false;
  };
}

module.exports = { createSocketRateLimiter, RATE_LIMITS };
