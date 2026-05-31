'use strict';

const fs   = require('fs');
const path = require('path');
const { dbPool, ensureDbEnabled } = require('../../infra/db');
const {
  COAT_OF_ARMS_UPLOAD_DIR,
  MINIMAP_UPLOAD_DIR,
  MAX_COAT_OF_ARMS_PNG_BYTES,
  MAX_MINIMAP_PNG_BYTES,
} = require('../../config/constants');

function ensureCoatOfArmsUploadDir() {
  if (!fs.existsSync(COAT_OF_ARMS_UPLOAD_DIR)) fs.mkdirSync(COAT_OF_ARMS_UPLOAD_DIR, { recursive: true });
}

function ensureMinimapUploadDir() {
  if (!fs.existsSync(MINIMAP_UPLOAD_DIR)) fs.mkdirSync(MINIMAP_UPLOAD_DIR, { recursive: true });
}

async function saveMinimapPng(municipality, pngBuffer) {
  ensureMinimapUploadDir();
  if (!pngBuffer || pngBuffer.length < 8) throw new Error('PNG-Daten fehlen');
  if (pngBuffer.length > MAX_MINIMAP_PNG_BYTES) throw new Error('Minimap-PNG ist zu gross (max 256KB)');
  if (pngBuffer.readUInt32BE(0) !== 0x89504e47 || pngBuffer.readUInt32BE(4) !== 0x0d0a1a0a) throw new Error('Nur gültige PNG-Dateien sind erlaubt');
  const slug = String(municipality.slug || municipality.id).toLowerCase();
  const fileName = `${slug}-minimap.png`;
  fs.writeFileSync(path.join(MINIMAP_UPLOAD_DIR, fileName), pngBuffer);
  return { fileName, byteSize: pngBuffer.length };
}

async function ensureMunicipalityCoatOfArmsTable() {}

function buildCoatOfArmsImageUrl(municipalitySlug, updatedAt, requestUrl) {
  const safeSlug = String(municipalitySlug || '').toLowerCase();
  if (!safeSlug) return null;
  const stamp = updatedAt ? new Date(updatedAt).getTime() : Date.now();
  const relative = `/api/game/municipality/${safeSlug}/coat-of-arms/image?v=${Number.isFinite(stamp) ? stamp : Date.now()}`;
  if (requestUrl && requestUrl.origin) return `${requestUrl.origin}${relative}`;
  return relative;
}

async function getMunicipalityCoatOfArmsRecord(municipalityId) {
  ensureDbEnabled();
  await ensureMunicipalityCoatOfArmsTable();
  const [rows] = await dbPool.query(`SELECT municipality_id, image_filename, byte_size, created_at, updated_at FROM municipality_coat_of_arms WHERE municipality_id = ? LIMIT 1`, [municipalityId]);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function deleteMunicipalityCoatOfArms(municipalityId) {
  ensureDbEnabled();
  await ensureMunicipalityCoatOfArmsTable();
  ensureCoatOfArmsUploadDir();
  const existing = await getMunicipalityCoatOfArmsRecord(municipalityId);
  if (existing?.image_filename) {
    const oldPath = path.join(COAT_OF_ARMS_UPLOAD_DIR, String(existing.image_filename));
    if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch {} }
  }
  await dbPool.query(`DELETE FROM municipality_coat_of_arms WHERE municipality_id = ?`, [municipalityId]);
}

async function saveMunicipalityCoatOfArmsPng(municipality, pngBuffer) {
  ensureDbEnabled();
  await ensureMunicipalityCoatOfArmsTable();
  ensureCoatOfArmsUploadDir();
  const municipalityId = Number(municipality?.id || 0);
  if (!Number.isInteger(municipalityId) || municipalityId <= 0) throw new Error('Ungültige municipality_id für Wappen');
  if (!Buffer.isBuffer(pngBuffer) || pngBuffer.length <= 0) throw new Error('PNG-Daten fehlen');
  if (pngBuffer.length > MAX_COAT_OF_ARMS_PNG_BYTES) throw new Error('PNG-Datei ist zu gross (max 512KB)');
  if (pngBuffer.length < 8 || pngBuffer.readUInt32BE(0) !== 0x89504e47 || pngBuffer.readUInt32BE(4) !== 0x0d0a1a0a) throw new Error('Nur gültige PNG-Dateien sind erlaubt');

  const existing = await getMunicipalityCoatOfArmsRecord(municipalityId);
  const fileName = `${String(municipality.slug || municipalityId).toLowerCase()}-${Date.now()}.png`;
  fs.writeFileSync(path.join(COAT_OF_ARMS_UPLOAD_DIR, fileName), pngBuffer);

  await dbPool.query(
    `INSERT INTO municipality_coat_of_arms (municipality_id, image_filename, byte_size) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE image_filename = VALUES(image_filename), byte_size = VALUES(byte_size), updated_at = CURRENT_TIMESTAMP`,
    [municipalityId, fileName, pngBuffer.length]
  );

  if (existing?.image_filename && String(existing.image_filename) !== fileName) {
    const oldPath = path.join(COAT_OF_ARMS_UPLOAD_DIR, String(existing.image_filename));
    if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch {} }
  }

  return getMunicipalityCoatOfArmsRecord(municipalityId);
}

async function resolveMunicipalityCoatOfArmsDto(municipality, requestUrl) {
  const record = await getMunicipalityCoatOfArmsRecord(municipality.id);
  if (!record?.image_filename) return { svg: null, image_url: null };
  return { svg: null, image_url: buildCoatOfArmsImageUrl(municipality.slug, record.updated_at, requestUrl) };
}

module.exports = {
  ensureCoatOfArmsUploadDir, ensureMinimapUploadDir, saveMinimapPng,
  ensureMunicipalityCoatOfArmsTable, buildCoatOfArmsImageUrl,
  getMunicipalityCoatOfArmsRecord, deleteMunicipalityCoatOfArms,
  saveMunicipalityCoatOfArmsPng, resolveMunicipalityCoatOfArmsDto,
};
