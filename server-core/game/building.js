'use strict';

const fs = require('fs');
const { dbPool, ensureDbEnabled } = require('../infra/db.js');
const {
  CLIENT_TOOL_INFO_PATH,
  CLIENT_ITEM_DETAILS_PATH,
  CLIENT_BUILDING_STATS_PATH,
  HARD_CODED_BUILDING_STATS,
  SERVICE_UPGRADE_TOOLS,
} = require('../config/constants.js');
const { toDisplayNameFromTool, toFiniteNumber, toJsonValue, extractItemState } = require('../shared/helpers.js');

let hardcodedCatalogCache = null;

function parseToolInfoFromClientSource(source) {
  const items = new Map();
  const lines = String(source || '').split(/\r?\n/);
  const entryRegex = /^\s*([a-z0-9_]+)\s*:\s*\{(.+)\}\s*,?\s*$/i;
  for (const line of lines) {
    const match = line.match(entryRegex);
    if (!match) continue;
    const tool = String(match[1] || '').trim().toLowerCase();
    const body = match[2] || '';
    if (!tool) continue;
    const costMatch = body.match(/\bcost:\s*([0-9]+)/i);
    if (!costMatch) continue;
    const sizeMatch = body.match(/\bsize:\s*([0-9]+)/i);
    const nameMatch = body.match(/name:\s*msg\('((?:\\'|[^'])*)'\)/i);
    const displayName = nameMatch ? nameMatch[1].replace(/\\'/g, "'") : toDisplayNameFromTool(tool);
    const cost = Math.max(0, Math.round(Number(costMatch[1] || 0)));
    const size = sizeMatch ? Math.max(1, Math.round(Number(sizeMatch[1] || 1))) : 1;
    items.set(tool, { tool, display_name: displayName, build_cost: cost, size });
  }
  return items;
}

function parseItemFootprintsFromClientSource(source) {
  const items = new Map();
  const lines = String(source || '').split(/\r?\n/);
  const footprintRegex = /^\s*([a-z0-9_]+)\s*:\s*\{\s*footprintWidth:\s*([0-9]+)\s*,\s*footprintHeight:\s*([0-9]+)\s*\}\s*,?\s*$/i;
  for (const line of lines) {
    const match = line.match(footprintRegex);
    if (!match) continue;
    const tool = String(match[1] || '').trim().toLowerCase();
    if (!tool) continue;
    items.set(tool, {
      width: Math.max(1, Math.round(Number(match[2] || 1))),
      height: Math.max(1, Math.round(Number(match[3] || 1))),
    });
  }
  return items;
}

function parseBuildingStatsFromClientSource(source) {
  const items = new Map();
  const lines = String(source || '').split(/\r?\n/);
  const statsRegex = /^\s*([a-z0-9_]+)\s*:\s*\{\s*maxPop:\s*(-?[0-9]+)\s*,\s*maxJobs:\s*(-?[0-9]+)\s*,\s*pollution:\s*(-?[0-9]+)\s*,\s*landValue:\s*(-?[0-9]+)\s*\}\s*,?\s*$/i;
  for (const line of lines) {
    const match = line.match(statsRegex);
    if (!match) continue;
    const tool = String(match[1] || '').trim().toLowerCase();
    if (!tool) continue;
    items.set(tool, {
      maxPop: Math.max(0, Math.round(Number(match[2] || 0))),
      maxJobs: Math.max(0, Math.round(Number(match[3] || 0))),
      pollution: Math.round(Number(match[4] || 0)),
      landValue: Math.round(Number(match[5] || 0)),
    });
  }
  return items;
}

function deriveBuildTimeSecondsByFootprint(width, height, tool) {
  const area = Math.max(1, Math.round(Number(width || 1)) * Math.max(1, Math.round(Number(height || 1))));
  if (String(tool || '').toLowerCase() === 'water_tower') return 60;
  if (area >= 16) return 60;
  if (area >= 9) return 45;
  if (area >= 4) return 30;
  return 20;
}

function inferCategoryFromTool(tool, fallbackCategory = 'general') {
  const t = String(tool || '').toLowerCase();
  const fromDb = String(fallbackCategory || '').toLowerCase();
  if (fromDb && fromDb !== 'general') return fromDb;
  if (t === 'woodcutter_house' || t === 'bank_house' || t === 'bus_stop') return 'infrastructure';
  // Industrial zuerst prüfen – vor residential/commercial, da 'warehouse' sonst 'house' matcht und 'factory_small' 'mall' matcht
  if (t.includes('factory') || t.includes('warehouse') || t.includes('industrial') || t.includes('power_plant')) return 'industrial';
  if (t.includes('house') || t.includes('apartment') || t.includes('residential') || t.includes('cabin') || t.includes('lodge')
      || t.includes('skyscraper') || t.includes('tower') || t.includes('highrise') || t.includes('condo')
      || t.includes('villa') || t.includes('loft') || t.includes('penthouse') || t.includes('duplex')
      || t.includes('bungalow') || t.includes('flat')) return 'residential';
  if (t.includes('shop') || t.includes('office') || t.includes('mall') || t.includes('commercial') || t.includes('market')) return 'commercial';
  if (t.includes('station') || t.includes('school') || t.includes('hospital') || t.includes('police') || t.includes('fire_') || t.includes('city_hall') || t.includes('airport') || t.includes('museum') || t.includes('university')) return 'infrastructure';
  if (t.includes('park') || t.includes('garden') || t.includes('playground') || t.includes('field') || t.includes('stadium') || t.includes('pool')) return 'decoration';
  return 'infrastructure';
}

function isNonEconomicTool(tool) {
  const t = String(tool || '').trim().toLowerCase();
  if (!t) return true;
  if (['grass', 'water', 'road', 'autobahn', 'rail', 'bridge', 'tree', 'empty'].includes(t)) return true;
  if (t.startsWith('tree_') || t.startsWith('bush_') || t.startsWith('flower_') || t.startsWith('topiary_')) return true;
  if (t.startsWith('paint_') || t.startsWith('terrain_') || t.startsWith('zone_')) return true;
  return false;
}

function estimateBuildingBaseStats({ category, footprintArea }) {
  const area = Math.max(1, Math.round(Number(footprintArea || 1)));
  const cat = String(category || 'infrastructure').toLowerCase();
  if (cat === 'residential') return { pop: Math.max(2, area * 2), jobs: 0 };
  if (cat === 'commercial') return { pop: 0, jobs: Math.max(3, area * 4) };
  if (cat === 'industrial') return { pop: 0, jobs: Math.max(4, area * 5) };
  if (cat === 'decoration') return { pop: 0, jobs: Math.max(1, area * 1) };
  return { pop: 0, jobs: Math.max(3, area * 3) };
}

function estimateDefaultBuildCost(tool, metadata = null, footprintWidth = 1, footprintHeight = 1, categoryHint = 'general') {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  const fromMeta = Number(meta.buildCost ?? meta.build_cost ?? meta.price ?? meta.cost);
  if (Number.isFinite(fromMeta) && fromMeta >= 0) return Math.round(fromMeta);
  const normalizedTool = String(tool || '').trim().toLowerCase();
  if (normalizedTool === 'terrain_lower2') return 90;
  if (isNonEconomicTool(tool)) return 0;
  const area = Math.max(1, Math.round(Number(footprintWidth || 1)) * Math.max(1, Math.round(Number(footprintHeight || 1))));
  const category = inferCategoryFromTool(tool, categoryHint);
  if (category === 'residential') return Math.max(400, area * 700);
  if (category === 'commercial') return Math.max(600, area * 950);
  if (category === 'industrial') return Math.max(800, area * 1200);
  if (category === 'decoration') return Math.max(100, area * 220);
  return Math.max(300, area * 500);
}

async function loadHardcodedCatalogFromClientFiles(force = false) {
  if (hardcodedCatalogCache && !force) return hardcodedCatalogCache;
  const missing = [];
  if (!fs.existsSync(CLIENT_TOOL_INFO_PATH)) missing.push(CLIENT_TOOL_INFO_PATH);
  if (!fs.existsSync(CLIENT_ITEM_DETAILS_PATH)) missing.push(CLIENT_ITEM_DETAILS_PATH);
  if (!fs.existsSync(CLIENT_BUILDING_STATS_PATH)) missing.push(CLIENT_BUILDING_STATS_PATH);
  if (missing.length > 0) {
    if (!hardcodedCatalogCache) {
      hardcodedCatalogCache = { tools: [], statsByTool: new Map(), missing };
    }
    return hardcodedCatalogCache;
  }

  const toolInfoRaw = fs.readFileSync(CLIENT_TOOL_INFO_PATH, 'utf8');
  const itemDetailsRaw = fs.readFileSync(CLIENT_ITEM_DETAILS_PATH, 'utf8');
  const buildingStatsRaw = fs.readFileSync(CLIENT_BUILDING_STATS_PATH, 'utf8');

  const tools = parseToolInfoFromClientSource(toolInfoRaw);
  const footprints = parseItemFootprintsFromClientSource(itemDetailsRaw);
  const statsByTool = parseBuildingStatsFromClientSource(buildingStatsRaw);

  const catalogTools = [];
  for (const [tool, raw] of tools.entries()) {
    const fp = footprints.get(tool) || { width: raw.size || 1, height: raw.size || 1 };
    const category = inferCategoryFromTool(tool, 'general');
    const buildCost = Math.max(0, Math.round(Number(raw.build_cost || 0)));
    const bStats = statsByTool.get(tool);
    const pollutionVal = bStats ? Math.round(Number(bStats.pollution || 0)) : 0;
    catalogTools.push({
      tool,
      display_name: raw.display_name || toDisplayNameFromTool(tool),
      category,
      footprint_width: Math.max(1, Math.round(Number(fp.width || 1))),
      footprint_height: Math.max(1, Math.round(Number(fp.height || 1))),
      build_cost: buildCost,
      pollution: pollutionVal,
      build_time_seconds: deriveBuildTimeSecondsByFootprint(fp.width, fp.height, tool),
      requires_power: 0,
      requires_water: 0,
      is_active: 1,
    });
  }

  hardcodedCatalogCache = { tools: catalogTools, statsByTool, missing: [] };
  return hardcodedCatalogCache;
}

async function seedGameItemDetailsFromClientHardcodedData() {
  ensureDbEnabled();
  const catalog = await loadHardcodedCatalogFromClientFiles();
  const rows = Array.isArray(catalog.tools) ? catalog.tools : [];
  if (!rows.length) return { seeded: 0, missing: catalog.missing || [] };

  let seeded = 0;
  let hasPollutionColumn = true;
  try {
    await dbPool.query(`SELECT pollution FROM game_item_details LIMIT 1`);
  } catch (_e) {
    hasPollutionColumn = false;
  }

  for (const row of rows) {
    if (hasPollutionColumn) {
      await dbPool.query(
        `INSERT INTO game_item_details
         (tool, display_name, category, footprint_width, footprint_height, build_cost, pollution, build_time_seconds, requires_power, requires_water, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
          display_name = VALUES(display_name),
          category = VALUES(category),
          footprint_width = VALUES(footprint_width),
          footprint_height = VALUES(footprint_height),
          build_cost = VALUES(build_cost),
          pollution = VALUES(pollution),
          build_time_seconds = VALUES(build_time_seconds),
          requires_power = VALUES(requires_power),
          requires_water = VALUES(requires_water),
          is_active = VALUES(is_active),
          updated_at = CURRENT_TIMESTAMP`,
        [
          row.tool,
          row.display_name,
          row.category,
          row.footprint_width,
          row.footprint_height,
          row.build_cost,
          row.pollution || 0,
          row.build_time_seconds,
          row.requires_power,
          row.requires_water,
          row.is_active,
        ]
      );
    } else {
      await dbPool.query(
        `INSERT INTO game_item_details
         (tool, display_name, category, footprint_width, footprint_height, build_cost, build_time_seconds, requires_power, requires_water, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
          display_name = VALUES(display_name),
          category = VALUES(category),
          footprint_width = VALUES(footprint_width),
          footprint_height = VALUES(footprint_height),
          build_cost = VALUES(build_cost),
          build_time_seconds = VALUES(build_time_seconds),
          requires_power = VALUES(requires_power),
          requires_water = VALUES(requires_water),
          is_active = VALUES(is_active),
          updated_at = CURRENT_TIMESTAMP`,
        [
          row.tool,
          row.display_name,
          row.category,
          row.footprint_width,
          row.footprint_height,
          row.build_cost,
          row.build_time_seconds,
          row.requires_power,
          row.requires_water,
          row.is_active,
        ]
      );
    }
    seeded += 1;
  }

  HARD_CODED_BUILDING_STATS.clear();
  if (catalog.statsByTool instanceof Map) {
    for (const [tool, stats] of catalog.statsByTool.entries()) {
      HARD_CODED_BUILDING_STATS.set(String(tool || '').toLowerCase(), stats);
    }
  }
  return { seeded, missing: [] };
}

async function seedBuildingStatsToDb() {
  ensureDbEnabled();
  // Prüfe ob neue Spalten vorhanden sind (nach Migration 069)
  try {
    await dbPool.query(`SELECT max_pop FROM game_item_details LIMIT 1`);
  } catch (_e) {
    return { seeded: 0, skipped: true, reason: 'Spalten nicht vorhanden (Migration 069 noch nicht gelaufen)' };
  }
  let seeded = 0;
  for (const [tool, stats] of HARD_CODED_BUILDING_STATS.entries()) {
    if (!tool) continue;
    const [result] = await dbPool.query(
      `UPDATE game_item_details
       SET max_pop = ?, max_jobs = ?, power_production = ?, power_consumption_base = ?, land_value = ?, pollution = ?
       WHERE tool = ?`,
      [
        Math.max(0, Math.round(Number(stats.maxPop || 0))),
        Math.max(0, Math.round(Number(stats.maxJobs || 0))),
        Math.max(0, Math.round(Number(stats.powerProduction || 0))),
        Math.max(0, Math.round(Number(stats.powerConsumptionBase || 0))),
        Math.round(Number(stats.landValue || 0)),
        Math.round(Number(stats.pollution || 0)),
        tool,
      ]
    );
    if (result?.affectedRows > 0) seeded += 1;
  }
  return { seeded };
}

async function fetchItemDetails(tool) {
  ensureDbEnabled();
  const fallbackItemDetails = {
    water_tower: {
      tool: 'water_tower',
      display_name: 'Water Tower',
      category: 'infrastructure',
      footprint_width: 1,
      footprint_height: 1,
      build_cost: 1000,
      price: 1000,
      build_time_seconds: 60,
      requires_power: 0,
      requires_water: 0,
      is_active: 1,
      updated_at: new Date().toISOString(),
    },
  };

  const colsFull = 'tool, display_name, category, furni_classname, furni_logic, catalog_page_id, footprint_width, footprint_height, build_cost, daily_income, pollution, max_pop, max_jobs, power_production, power_consumption_base, land_value, build_cost AS price, build_time_seconds, upgrade_build_time_seconds, requires_power, requires_water, is_active, updated_at';
  const colsSafe = 'tool, display_name, category, furni_classname, furni_logic, catalog_page_id, footprint_width, footprint_height, build_cost, daily_income, build_cost AS price, build_time_seconds, requires_power, requires_water, is_active, updated_at';

  if (tool) {
    let rows;
    try {
      [rows] = await dbPool.query(
        `SELECT ${colsFull} FROM game_item_details WHERE tool = ? LIMIT 1`,
        [tool]
      );
    } catch (e) {
      [rows] = await dbPool.query(
        `SELECT ${colsSafe} FROM game_item_details WHERE tool = ? LIMIT 1`,
        [tool]
      );
    }
    const row = rows[0] || null;
    if (row) return row;
    return fallbackItemDetails[tool] || null;
  }
  let rows;
  try {
    [rows] = await dbPool.query(
      `SELECT ${colsFull} FROM game_item_details WHERE is_active = 1 ORDER BY category ASC, tool ASC`
    );
  } catch (e) {
    [rows] = await dbPool.query(
      `SELECT ${colsSafe} FROM game_item_details WHERE is_active = 1 ORDER BY category ASC, tool ASC`
    );
  }
  const list = Array.isArray(rows) ? rows.slice() : [];
  const existingTools = new Set(list.map((r) => String(r.tool)));
  for (const fallback of Object.values(fallbackItemDetails)) {
    if (!existingTools.has(fallback.tool)) {
      list.push(fallback);
    }
  }
  return list;
}

async function ensureItemDetailExists(tool, metadata = null) {
  ensureDbEnabled();
  const normalizedTool = String(tool || '').trim();
  if (!normalizedTool) return null;

  let detail = await fetchItemDetails(normalizedTool);
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  const footprintWidth = Math.max(1, Math.round(Number(meta.footprintWidth ?? 1)));
  const footprintHeight = Math.max(1, Math.round(Number(meta.footprintHeight ?? 1)));
  const inferredCategory = inferCategoryFromTool(normalizedTool, String(meta.category || 'general'));
  const estimatedCost = estimateDefaultBuildCost(normalizedTool, meta, footprintWidth, footprintHeight, inferredCategory);

  if (detail) {
    const currentCost = Math.max(0, Math.round(toFiniteNumber(detail.build_cost, 0)));
    if (currentCost <= 0 && estimatedCost > 0) {
      await dbPool.query(
        `UPDATE game_item_details
         SET build_cost = ?, category = COALESCE(NULLIF(category, ''), ?), updated_at = CURRENT_TIMESTAMP
         WHERE tool = ?`,
        [estimatedCost, inferredCategory, normalizedTool]
      );
      detail = await fetchItemDetails(normalizedTool);
    }
    return detail;
  }

  const hardcodedPollution = HARD_CODED_BUILDING_STATS.get(normalizedTool);
  const pollutionVal = hardcodedPollution ? Math.round(Number(hardcodedPollution.pollution || 0)) : 0;

  try {
    await dbPool.query(
      `INSERT INTO game_item_details (
        tool, display_name, category, footprint_width, footprint_height, build_cost, pollution, is_active
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
        display_name = VALUES(display_name),
        category = VALUES(category),
        footprint_width = VALUES(footprint_width),
        footprint_height = VALUES(footprint_height),
        build_cost = CASE
          WHEN COALESCE(build_cost, 0) <= 0 THEN VALUES(build_cost)
          ELSE build_cost
        END,
        pollution = VALUES(pollution),
        is_active = 1,
        updated_at = CURRENT_TIMESTAMP`,
      [normalizedTool, toDisplayNameFromTool(normalizedTool), inferredCategory, footprintWidth, footprintHeight, estimatedCost, pollutionVal]
    );
  } catch (_e) {
    await dbPool.query(
      `INSERT INTO game_item_details (
        tool, display_name, category, footprint_width, footprint_height, build_cost, is_active
       ) VALUES (?, ?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
        display_name = VALUES(display_name),
        category = VALUES(category),
        footprint_width = VALUES(footprint_width),
        footprint_height = VALUES(footprint_height),
        build_cost = CASE
          WHEN COALESCE(build_cost, 0) <= 0 THEN VALUES(build_cost)
          ELSE build_cost
        END,
        is_active = 1,
        updated_at = CURRENT_TIMESTAMP`,
      [normalizedTool, toDisplayNameFromTool(normalizedTool), inferredCategory, footprintWidth, footprintHeight, estimatedCost]
    );
  }

  detail = await fetchItemDetails(normalizedTool);
  return detail;
}

async function fetchItemCatalogVersion() {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT UNIX_TIMESTAMP(MAX(updated_at)) AS catalog_version
     FROM game_item_details
     WHERE is_active = 1`
  );
  return Number(rows[0]?.catalog_version || 0);
}

async function fetchCatalogPages() {
  ensureDbEnabled();
  try {
    const [rows] = await dbPool.query(
      `SELECT id, parent_id, caption, slug, icon_image, sort_order
       FROM catalog_pages
       WHERE visible = 1
       ORDER BY sort_order ASC, caption ASC`
    );
    return Array.isArray(rows) ? rows : [];
  } catch (_e) {
    return [];
  }
}

function formatGameItemRow(row) {
  const metadata = toJsonValue(row.metadata);
  const state = extractItemState(metadata);
  return {
    id: row.id,
    action_type: row.action_type,
    tool: row.tool,
    zone_type: row.zone_type,
    x: row.x,
    y: row.y,
    player_id: row.player_id,
    user_id: row.user_id,
    version: row.version,
    metadata,
    ...state,
  };
}

module.exports = {
  parseToolInfoFromClientSource,
  parseItemFootprintsFromClientSource,
  parseBuildingStatsFromClientSource,
  deriveBuildTimeSecondsByFootprint,
  inferCategoryFromTool,
  isNonEconomicTool,
  estimateBuildingBaseStats,
  estimateDefaultBuildCost,
  loadHardcodedCatalogFromClientFiles,
  seedGameItemDetailsFromClientHardcodedData,
  seedBuildingStatsToDb,
  fetchItemDetails,
  ensureItemDetailExists,
  fetchItemCatalogVersion,
  fetchCatalogPages,
  formatGameItemRow,
};
