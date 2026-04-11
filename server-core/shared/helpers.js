'use strict';

const crypto = require('crypto');

function validateEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function toJsonValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort((a, b) => a.localeCompare(b))
      .reduce((acc, key) => {
        acc[key] = canonicalizeJson(value[key]);
        return acc;
      }, {});
  }
  return value ?? null;
}

function jsonEquals(a, b) {
  return JSON.stringify(canonicalizeJson(a)) === JSON.stringify(canonicalizeJson(b));
}

function metaValue(meta, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(meta, key) && typeof meta[key] !== 'undefined') {
      return meta[key];
    }
  }
  return undefined;
}

function normalizeRoomCode(roomCode) {
  return String(roomCode || '').trim().toUpperCase().slice(0, 10);
}

function toDisplayNameFromTool(tool) {
  return String(tool || '')
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function normalizeDirection(direction) {
  const value = String(direction || '').toLowerCase();
  return ['north', 'south', 'east', 'west'].includes(value) ? value : null;
}

function oppositeDirection(direction) {
  const map = { north: 'south', south: 'north', east: 'west', west: 'east' };
  return map[String(direction || '').toLowerCase()] || null;
}

function normalizePartnershipStatus(status) {
  const value = String(status || '').toLowerCase();
  return ['discovered', 'connected'].includes(value) ? value : 'discovered';
}

function normalizePublicRoomSizeKey(value) {
  const { PUBLIC_ROOM_SIZE_PRESETS } = require('../config/constants');
  const v = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PUBLIC_ROOM_SIZE_PRESETS, v) ? v : 'small';
}

function normalizePublicRoomIndex(value) {
  const n = Math.round(Number(value || 1));
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(99, n));
}

function normalizePublicRoomGenerator(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'open') return 'open';
  if (v === 'small_walls') return 'small_walls';
  return 'small_walls';
}

function cloneJsonValue(value) {
  if (value === null || typeof value === 'undefined') return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function extractItemState(metadata) {
  const meta = toJsonValue(metadata) || {};
  const constructionProgress = Number(metaValue(meta, 'constructionProgress', 'construction_progress') ?? 0);
  const level = Number(metaValue(meta, 'level') ?? 0);
  const footprintWidth = Number(metaValue(meta, 'footprintWidth', 'footprint_width') ?? 1);
  const footprintHeight = Number(metaValue(meta, 'footprintHeight', 'footprint_height') ?? 1);
  const onFire = Boolean(metaValue(meta, 'onFire', 'on_fire') ?? false);
  const fireProgress = Number(metaValue(meta, 'fireProgress', 'fire_progress') ?? 0);
  const mapPersistent = Boolean(metaValue(meta, 'mapPersistent', 'map_persistent') ?? false);
  const plantedAt = Number(metaValue(meta, 'plantedAt', 'planted_at') ?? 0);
  return {
    construction_progress: Number.isFinite(constructionProgress) ? constructionProgress : 0,
    constructed: Boolean(meta.constructed ?? false),
    level: Number.isFinite(level) ? level : 0,
    abandoned: Boolean(meta.abandoned ?? false),
    on_fire: onFire,
    fire_progress: Number.isFinite(fireProgress) ? fireProgress : 0,
    footprint_width: Number.isFinite(footprintWidth) ? Math.max(1, footprintWidth) : 1,
    footprint_height: Number.isFinite(footprintHeight) ? Math.max(1, footprintHeight) : 1,
    map_persistent: mapPersistent,
    planted_at: Number.isFinite(plantedAt) && plantedAt > 0 ? plantedAt : 0,
  };
}

/** @deprecated Nicht mehr verwenden – treasury kommt aus municipality_stats.treasury */
function readMoneyFromStats(rawStats) {
  if (!rawStats || typeof rawStats !== 'object') return 0;
  if (Number.isFinite(Number(rawStats.money))) return Math.round(Number(rawStats.money));
  if (rawStats.finances && Number.isFinite(Number(rawStats.finances.money))) {
    return Math.round(Number(rawStats.finances.money));
  }
  return 0;
}

function parsePngDataUrl(input) {
  const raw = String(input || '').trim();
  const match = raw.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  try {
    const buffer = Buffer.from(match[1], 'base64');
    if (!buffer || buffer.length <= 0) return null;
    return buffer;
  } catch {
    return null;
  }
}

function seededHash(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function rand() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function pickRandomRows(rows, count) {
  const pool = Array.isArray(rows) ? [...rows] : [];
  const out = [];
  const max = Math.max(0, Math.min(pool.length, Math.round(Number(count || 0))));
  while (out.length < max && pool.length > 0) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return out;
}

function normalizeInventoryItemCode(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]/g, '')
    .slice(0, 64);
}

function normalizeInventoryQuantity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

module.exports = {
  validateEmail,
  sha256,
  toJsonValue,
  toFiniteNumber,
  canonicalizeJson,
  jsonEquals,
  metaValue,
  normalizeRoomCode,
  toDisplayNameFromTool,
  normalizeDirection,
  oppositeDirection,
  normalizePartnershipStatus,
  normalizePublicRoomSizeKey,
  normalizePublicRoomIndex,
  normalizePublicRoomGenerator,
  cloneJsonValue,
  extractItemState,
  readMoneyFromStats,
  parsePngDataUrl,
  seededHash,
  mulberry32,
  pickRandomRows,
  normalizeInventoryItemCode,
  normalizeInventoryQuantity,
  escapeLike,
  sanitizeText,
};

function escapeLike(str) {
  return String(str).replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Entfernt HTML-Tags und gefährliche Zeichen aus User-Input.
 * Schützt gegen XSS wenn der Text jemals im Browser gerendert wird.
 * SQL-Injection wird bereits durch Parameterized Queries verhindert,
 * aber wir entfernen trotzdem verdächtige Patterns als Defense-in-Depth.
 */
function sanitizeText(input, maxLength = 2000) {
  if (typeof input !== 'string') return '';
  let text = input
    .replace(/[<>]/g, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .replace(/data\s*:\s*text\/html/gi, '')
    .replace(/&#/g, '')
    .replace(/\x00/g, '');
  text = text.trim();
  if (maxLength > 0) text = text.slice(0, maxLength);
  return text;
}
