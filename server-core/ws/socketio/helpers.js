'use strict';

const { normalizeRoomCode } = require('../../shared/helpers');

function wsRoomKey(municipalitySlug, roomCode) {
  return `${String(municipalitySlug || 'default').toLowerCase()}:${normalizeRoomCode(roomCode) || 'MAIN'}`;
}

function wsParseRoomKey(roomKey) {
  const raw = String(roomKey || '');
  const idx = raw.indexOf(':');
  if (idx <= 0) return { municipalitySlug: 'default', roomCode: 'MAIN' };
  return {
    municipalitySlug: raw.slice(0, idx).toLowerCase(),
    roomCode: normalizeRoomCode(raw.slice(idx + 1)) || 'MAIN',
  };
}

function wsClampTile(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return null;
  // Raum-Koordinaten sind Floats und können negativ sein (world space, zentriert bei 0)
  // Hauptkarten-Tiles sind positive Integer (0-300+) — beide passen in -2048..2048
  return Math.max(-2048, Math.min(2048, value));
}

function wsSanitizAvatarPath(path) {
  if (!Array.isArray(path)) return [];
  const out = [];
  for (const step of path) {
    const x = wsClampTile(step?.x);
    const y = wsClampTile(step?.y);
    if (x === null || y === null) continue;
    out.push({ x, y });
    if (out.length >= 2048) break;
  }
  return out;
}

function wsNormalizeAvatarColor(value, fallback) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const hex = raw.startsWith('#') ? raw : `#${raw}`;
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : fallback;
}

function wsSanitizeAvatarConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const normalizeAvatarFigure = (value, fallback) => {
    const rawFigure = String(value || '').trim();
    if (!rawFigure) return fallback;
    if (!/^[a-z]{2,3}-[0-9]+(?:-[0-9]+)*(?:\.[a-z]{2,3}-[0-9]+(?:-[0-9]+)*)*$/i.test(rawFigure)) {
      return fallback;
    }
    return rawFigure;
  };
  const headShape = src.headShape === 'square' ? 'square' : 'round';
  const eyeStyle = src.eyeStyle === 'line' || src.eyeStyle === 'big' ? src.eyeStyle : 'dot';
  const hatStyle =
    src.hatStyle === 'cap' || src.hatStyle === 'beanie' || src.hatStyle === 'crown'
      ? src.hatStyle
      : 'none';
  const hairStyle =
    src.hairStyle === 'none' || src.hairStyle === 'long' || src.hairStyle === 'mohawk'
      ? src.hairStyle
      : 'short';
  const motto = typeof src.motto === 'string' ? src.motto.slice(0, 100) : undefined;

  const result = {
    headShape,
    eyeStyle,
    hatStyle,
    hairStyle,
    figure: normalizeAvatarFigure(src.figure, 'hd-180-1.hr-828-61.ch-210-66.lg-270-82.sh-290-80'),
    skinColor: wsNormalizeAvatarColor(src.skinColor, '#f0c8a0'),
    shirtColor: wsNormalizeAvatarColor(src.shirtColor, '#7c3aed'),
    pantsColor: wsNormalizeAvatarColor(src.pantsColor, '#312e81'),
    hatColor: wsNormalizeAvatarColor(src.hatColor, '#7c3aed'),
    hairColor: wsNormalizeAvatarColor(src.hairColor, '#2d1b12'),
    eyeColor: wsNormalizeAvatarColor(src.eyeColor, '#1f2937'),
  };
  if (motto !== undefined) result.motto = motto;
  // avatar_code: pipe-separierter String für den Isometric Room Viewer (3D-Avatar)
  if (typeof src.avatar_code === 'string' && src.avatar_code.length > 0) {
    result.avatar_code = src.avatar_code.slice(0, 200);
  }
  return result;
}

function wsGetRoomPlayerList(roomKey, wsRoomPlayers) {
  const players = wsRoomPlayers.get(roomKey);
  if (!players) return [];
  return Array.from(players.values())
    .filter((p) => !p.isViewOnly)
    .map((p) => ({
      id: p.id,
      name: p.name,
      isLocal: false,
      isViewOnly: !!p.isViewOnly,
    }));
}

function wsGetRoomAvatars(roomKey, wsRoomAvatars) {
  const avatars = wsRoomAvatars.get(roomKey);
  if (!avatars) return [];
  return Array.from(avatars.values());
}

function wsRegisterUserSocket(userId, socketId, wsUserSockets) {
  if (!userId || !socketId) return;
  if (!wsUserSockets.has(userId)) wsUserSockets.set(userId, new Set());
  wsUserSockets.get(userId).add(socketId);
}

function wsUnregisterUserSocket(userId, socketId, wsUserSockets) {
  if (!userId || !socketId) return;
  const sockets = wsUserSockets.get(userId);
  if (!sockets) return;
  sockets.delete(socketId);
  if (sockets.size === 0) wsUserSockets.delete(userId);
}

function wsEmitToUser(ioInstance, userId, event, data, wsUserSockets) {
  const sockets = wsUserSockets.get(userId);
  if (!sockets || sockets.size === 0) return false;
  for (const sid of sockets) {
    const s = ioInstance.sockets?.sockets?.get(sid);
    if (s) s.emit(event, data);
  }
  return true;
}

function wsMapStatsToRealtimePayload(rawStats) {
  const { toStatsApiShape } = require('../../game/rooms');
  const shaped = toStatsApiShape(rawStats || {});
  return {
    money: Number(shaped.finances?.money || 0),
    population: Number(shaped.population?.current || 0),
    income: Number(shaped.finances?.income || 0),
    expenses: Number(shaped.finances?.expenses || 0),
    tax_income: Number(rawStats?.tax_income || 0),
    tax_income_population: Number(rawStats?.tax_income_population || 0),
    tax_income_business: Number(rawStats?.tax_income_business || 0),
    tax_income_property: Number(rawStats?.tax_income_property || 0),
    building_income: Number(rawStats?.building_income || 0),
    company_tax_income: Number(rawStats?.company_tax_income || 0),
    budget_expenses: Number(rawStats?.budget_expenses || 0),
    budget_cost_police: Number(rawStats?.budget_cost_police || 0),
    budget_cost_fire: Number(rawStats?.budget_cost_fire || 0),
    budget_cost_health: Number(rawStats?.budget_cost_health || 0),
    budget_cost_education: Number(rawStats?.budget_cost_education || 0),
    budget_cost_transportation: Number(rawStats?.budget_cost_transportation || 0),
    budget_cost_parks: Number(rawStats?.budget_cost_parks || 0),
    budget_cost_power: Number(rawStats?.budget_cost_power || 0),
    budget_cost_water: Number(rawStats?.budget_cost_water || 0),
    maintenance_expenses: Number(rawStats?.maintenance_expenses || 0),
    administration_base_expenses: Number(rawStats?.administration_base_expenses || 0),
    civic_overhead_expenses: Number(rawStats?.civic_overhead_expenses || 0),
    utility_overhead_expenses: Number(rawStats?.utility_overhead_expenses || 0),
    jobs: Number(shaped.employment?.jobs || 0),
    happiness: Number(shaped.happiness?.overall || 50),
    safety: Number(rawStats?.happiness_safety ?? 50),
    health: Number(rawStats?.happiness_health ?? 50),
    education: Number(rawStats?.happiness_education ?? 50),
    environment: Number(rawStats?.happiness_environment ?? 75),
    happinessTaxComponent: Number(rawStats?.happiness_tax_component ?? 0),
    happinessWeatherPenalty: Number(rawStats?.happiness_weather_penalty ?? 0),
    happinessCrimePenalty: Number(rawStats?.happiness_crime_penalty ?? 0),
    happinessUnemploymentPenalty: Number(rawStats?.happiness_unemployment_penalty ?? 0),
    tick: Number(shaped.time?.tick || 0),
    taxRate: Number(shaped.finances?.tax_rate || 10),
    gameSpeed: Number(shaped.time?.speed || 1),
    year: Number(rawStats?.year || 2026),
    month: Number(rawStats?.month || 1),
    weatherType: String(rawStats?.weather_type || 'clear'),
    weatherIntensity: Number(rawStats?.weather_intensity || 0),
    weatherTemperature: rawStats?.weather_temperature != null ? Number(rawStats.weather_temperature) : null,
    season: String(rawStats?.season || 'spring'),
    seasonHappinessBonus: Number(rawStats?.season_happiness_bonus || 0),
    winterHeatingSurcharge: Number(rawStats?.winter_heating_surcharge || 0),
    gameMapData: shaped.game_map_data || null,
    debt: Number(rawStats?.debt || 0),
    creditLimit: Number(rawStats?.credit_limit || rawStats?.creditLimit || 50000),
    interestRate: Number(rawStats?.interest_rate || rawStats?.interestRate || 0.0005),
    homeless: Number(rawStats?.homeless || 0),
    trafficCongestion: Number(rawStats?.traffic_congestion || 0),
    employed: Number(rawStats?.employed || 0),
    unemployed: Number(rawStats?.unemployed || 0),
    unemploymentRate: Number(rawStats?.unemployment_rate || 0),
    workforce: Number(rawStats?.workforce || 0),
    workforceRate: Number(rawStats?.workforce_rate || 0),
    children: Number(rawStats?.children || 0),
    seniors: Number(rawStats?.seniors || 0),
    students: Number(rawStats?.students || 0),
    socialFund: Number(rawStats?.social_fund || 0),
    socialContributionRate: Number(rawStats?.social_contribution_rate || 5),
    welfarePerUnemployed: Number(rawStats?.welfare_per_unemployed || 8),
    socialFundIncome: Number(rawStats?.social_fund_income || 0),
    socialFundExpenses: Number(rawStats?.social_fund_expenses || 0),
    socialExpenses: Number(rawStats?.social_expenses || 0),
    welfareCoverage: Number(rawStats?.welfare_coverage || 100),
    schoolCapacity: Number(rawStats?.school_capacity || 0),
    uniCapacity: Number(rawStats?.uni_capacity || 0),
    educationOvercrowding: Number(rawStats?.education_overcrowding || 0),
    healthCapacity: Number(rawStats?.health_capacity || 0),
    healthDemand: Number(rawStats?.health_demand || 0),
    healthAdequacy: Number(rawStats?.health_adequacy || 0),
    // Strom
    power_production: Number(rawStats?.power_production || 0),
    power_consumption: Number(rawStats?.power_consumption || 0),
    power_production_effective: Number(rawStats?.power_production_effective || rawStats?.power_production || 0),
    power_balance_effective: Number(rawStats?.power_balance_effective || 0),
    power_surplus_pct: Number(rawStats?.power_surplus_pct || 0),
    power_available_to_sell: Number(rawStats?.power_available_to_sell || 0),
    power_buffer_mw: Number(rawStats?.power_buffer_mw || 0),
    power_buffer_pct: Number(rawStats?.power_buffer_pct || 10),
    power_sold_mw: Number(rawStats?.power_sold_mw || 0),
    power_bought_mw: Number(rawStats?.power_bought_mw || 0),
    power_import_units: Number(rawStats?.power_import_units || 0),
    power_import_cost: Number(rawStats?.power_import_cost || 0),
    power_import_price_per_unit: Number(rawStats?.power_import_price_per_unit || 2),
    power_season_multiplier: Number(rawStats?.power_season_multiplier || 1),
    // Wasser
    water_production: Number(rawStats?.water_production || 0),
    water_consumption: Number(rawStats?.water_consumption || 0),
    water_balance: Number(rawStats?.water_balance || 0),
    water_net_deficit: Number(rawStats?.water_net_deficit || 0),
    water_storage_level: Number(rawStats?.water_storage_level || 0),
    water_storage_capacity: Number(rawStats?.water_storage_capacity || 0),
    // Zone demand & building counts (for growth debug panel)
    demand_residential: Number(rawStats?.demand_residential ?? 0),
    demand_commercial: Number(rawStats?.demand_commercial ?? 0),
    demand_industrial: Number(rawStats?.demand_industrial ?? 0),
    zones_residential: Number(rawStats?.zones_residential ?? 0),
    zones_commercial: Number(rawStats?.zones_commercial ?? 0),
    zones_industrial: Number(rawStats?.zones_industrial ?? 0),
    buildings_residential: Number(rawStats?.buildings_residential ?? 0),
    buildings_commercial: Number(rawStats?.buildings_commercial ?? 0),
    buildings_industrial: Number(rawStats?.buildings_industrial ?? 0),
  };
}

module.exports = {
  wsRoomKey,
  wsParseRoomKey,
  wsClampTile,
  wsSanitizAvatarPath,
  wsNormalizeAvatarColor,
  wsSanitizeAvatarConfig,
  wsGetRoomPlayerList,
  wsGetRoomAvatars,
  wsRegisterUserSocket,
  wsUnregisterUserSocket,
  wsEmitToUser,
  wsMapStatsToRealtimePayload,
};
