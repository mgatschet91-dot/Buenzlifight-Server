'use strict';

const path = require('path');
const { loadConfig } = require('./loadConfig');

const CONFIG_PATH = path.join(__dirname, '..', 'config.cfg');
const config = loadConfig(CONFIG_PATH);

const HOST = config.HOST || '127.0.0.1';
const PORT = Number(config.PORT || 4100);
const JWT_SECRET = config.JWT_SECRET || 'change-me';
if (JWT_SECRET === 'change-me') {
  if ((config.NODE_ENV || process.env.NODE_ENV) === 'production') {
    console.error('\n[FATAL] JWT_SECRET ist auf dem Default-Wert! Setze JWT_SECRET in config.cfg oder als Umgebungsvariable.\n');
    process.exit(1);
  } else {
    console.warn('[WARN] JWT_SECRET ist auf dem Default-Wert "change-me". Bitte in config.cfg oder als Umgebungsvariable setzen.');
  }
}
const TOKEN_TTL_HOURS = Number(config.TOKEN_TTL_HOURS || 24);
const TOKEN_TTL_HOURS_REMEMBER = Number(config.TOKEN_TTL_HOURS_REMEMBER || 24 * 30);
const DB_HOST = config.DB_HOST || '127.0.0.1';
const DB_PORT = Number(config.DB_PORT || 3306);
const DB_NAME = config.DB_NAME || '';
const DB_USER = config.DB_USER || '';
const DB_PASSWORD = config.DB_PASSWORD || '';
const DB_CONNECTION_LIMIT = Number(config.DB_CONNECTION_LIMIT || 10);
const BULLDOZE_COST_PER_CLICK = 10;
const MUNICIPALITY_MEMBER_LIMIT = 25;
const STEAM_WEB_API_KEY = config.STEAM_WEB_API_KEY || '';
const STEAM_APP_ID = config.STEAM_APP_ID || '4563360';

const MUNICIPALITY_ROLE_OWNER = 'owner';
const MUNICIPALITY_ROLE_COUNCIL = 'council';
const MUNICIPALITY_ROLE_CITIZEN = 'citizen';
const MUNICIPALITY_ROLE_OBSERVER = 'observer';
const MUNICIPALITY_ROLE_HIERARCHY = [MUNICIPALITY_ROLE_OWNER, MUNICIPALITY_ROLE_COUNCIL, MUNICIPALITY_ROLE_CITIZEN, MUNICIPALITY_ROLE_OBSERVER];

const GLOBAL_ROLE_USER = 'user';
const GLOBAL_ROLE_MODERATOR = 'moderator';
const GLOBAL_ROLE_ADMINISTRATOR = 'administrator';

const DISCORD_BOT_WEBHOOK_URL = config.DISCORD_BOT_WEBHOOK_URL || '';

const GOOGLE_CLIENT_ID = config.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = config.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = config.GOOGLE_REDIRECT_URI || 'https://core.buenzlifight.ch/api/auth/google/callback';
const FRONTEND_URL = config.FRONTEND_URL || 'https://buenzlifight.ch';

const CORS_ALLOWED_ORIGINS = String(config.CORS_ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
  .split(',')
  .map((v) => String(v || '').trim())
  .filter(Boolean);
const CORS_ALLOWED_ORIGIN_SET = new Set(CORS_ALLOWED_ORIGINS);
const CORS_ALLOW_ALL = CORS_ALLOWED_ORIGIN_SET.has('*');

const CLIENT_TOOL_INFO_PATH = path.resolve(__dirname, '..', '..', 'mapGame', 'src', 'games', 'isocity', 'types', 'game.ts');
const CLIENT_ITEM_DETAILS_PATH = path.resolve(__dirname, '..', '..', 'mapGame', 'src', 'lib', 'itemDetails.ts');
const CLIENT_BUILDING_STATS_PATH = path.resolve(__dirname, '..', '..', 'mapGame', 'src', 'games', 'isocity', 'types', 'buildings.ts');
// Statische JSON-Datei die beim Serverstart geschrieben wird (Gebäudepreise für Client)
const ITEM_PRICES_OUTPUT_PATH = path.resolve(__dirname, '..', '..', 'mapGame', 'public', '_data', 'item-prices.json');
const HARD_CODED_BUILDING_STATS = new Map([
  // [tool, { maxPop, maxJobs, pollution, landValue }]
  // Kopiert von Client: mapGame/src/games/isocity/types/buildings.ts
  ['empty', { maxPop: 0, maxJobs: 0, pollution: 0, landValue: 0 }],
  ['grass', { maxPop: 0, maxJobs: 0, pollution: 0, landValue: 0 }],
  ['water', { maxPop: 0, maxJobs: 0, pollution: 0, landValue: 5 }],
  ['road', { maxPop: 0, maxJobs: 0, pollution: 2, landValue: 0 }],
  ['autobahn', { maxPop: 0, maxJobs: 0, pollution: 4, landValue: -5 }],
  ['bridge', { maxPop: 0, maxJobs: 0, pollution: 1, landValue: 5 }],
  ['rail', { maxPop: 0, maxJobs: 0, pollution: 1, landValue: -2 }],
  ['tree', { maxPop: 0, maxJobs: 0, pollution: -5, landValue: 2 }],
  ['tree_oak', { maxPop: 0, maxJobs: 0, pollution: -5, landValue: 3 }],
  ['tree_maple', { maxPop: 0, maxJobs: 0, pollution: -5, landValue: 3 }],
  ['tree_birch', { maxPop: 0, maxJobs: 0, pollution: -5, landValue: 3 }],
  ['tree_willow', { maxPop: 0, maxJobs: 0, pollution: -5, landValue: 4 }],
  ['tree_pine', { maxPop: 0, maxJobs: 0, pollution: -5, landValue: 3 }],
  ['tree_spruce', { maxPop: 0, maxJobs: 0, pollution: -5, landValue: 3 }],
  ['tree_fir', { maxPop: 0, maxJobs: 0, pollution: -5, landValue: 3 }],
  ['tree_cedar', { maxPop: 0, maxJobs: 0, pollution: -5, landValue: 3 }],
  ['tree_palm', { maxPop: 0, maxJobs: 0, pollution: -4, landValue: 4 }],
  ['tree_bamboo', { maxPop: 0, maxJobs: 0, pollution: -4, landValue: 4 }],
  ['tree_coconut', { maxPop: 0, maxJobs: 0, pollution: -4, landValue: 4 }],
  ['tree_cherry', { maxPop: 0, maxJobs: 0, pollution: -4, landValue: 5 }],
  ['tree_magnolia', { maxPop: 0, maxJobs: 0, pollution: -4, landValue: 5 }],
  ['tree_jacaranda', { maxPop: 0, maxJobs: 0, pollution: -4, landValue: 5 }],
  ['tree_wisteria', { maxPop: 0, maxJobs: 0, pollution: -4, landValue: 5 }],
  ['bush_hedge', { maxPop: 0, maxJobs: 0, pollution: -3, landValue: 4 }],
  ['bush_flowering', { maxPop: 0, maxJobs: 0, pollution: -3, landValue: 4 }],
  ['topiary_ball', { maxPop: 0, maxJobs: 0, pollution: -2, landValue: 6 }],
  ['topiary_spiral', { maxPop: 0, maxJobs: 0, pollution: -2, landValue: 6 }],
  ['flower_bed', { maxPop: 0, maxJobs: 0, pollution: -3, landValue: 5 }],
  ['flower_planter', { maxPop: 0, maxJobs: 0, pollution: -3, landValue: 5 }],
  // powerConsumptionBase = MW bei Level 1, wird mit level multipliziert in stats.js
  // Wohngebäude: Verbrauch per Formel (pop × Faktor × lvlFactor) – kein Base-Wert nötig
  ['house_small', { maxPop: 6, maxJobs: 0, pollution: 0, landValue: 10 }],
  ['house_medium', { maxPop: 14, maxJobs: 0, pollution: 0, landValue: 22 }],
  ['mansion', { maxPop: 8, maxJobs: 0, pollution: 0, landValue: 60 }],
  ['apartment_low', { maxPop: 120, maxJobs: 0, pollution: 2, landValue: 40 }],
  ['apartment_high', { maxPop: 260, maxJobs: 0, pollution: 3, landValue: 55 }],
  ['cabin_house', { maxPop: 4, maxJobs: 0, pollution: -3, landValue: 15 }],
  // Gewerbe/Industrie: Verbrauch per Formel (jobs × Faktor × lvlFactor)
  ['shop_small', { maxPop: 0, maxJobs: 10, pollution: 1, landValue: 16 }],
  ['shop_medium', { maxPop: 0, maxJobs: 28, pollution: 2, landValue: 26 }],
  ['office_low', { maxPop: 0, maxJobs: 90, pollution: 2, landValue: 40 }],
  ['office_high', { maxPop: 0, maxJobs: 210, pollution: 3, landValue: 55 }],
  ['office_building_small', { maxPop: 0, maxJobs: 25, pollution: 1, landValue: 22 }],
  ['mall', { maxPop: 0, maxJobs: 260, pollution: 6, landValue: 70 }],
  ['bank_house', { maxPop: 0, maxJobs: 30, pollution: 0, landValue: 35, powerConsumptionBase: 4 }],
  ['factory_small', { maxPop: 0, maxJobs: 40, pollution: 15, landValue: -5 }],
  ['factory_medium', { maxPop: 0, maxJobs: 90, pollution: 28, landValue: -10 }],
  ['factory_large', { maxPop: 0, maxJobs: 180, pollution: 55, landValue: -18 }],
  ['warehouse', { maxPop: 0, maxJobs: 100, pollution: 12, landValue: -5 }],
  // Öffentliche Dienste
  ['police_station', { maxPop: 0, maxJobs: 20, pollution: 0, landValue: 15, powerConsumptionBase: 3 }],
  ['fire_station', { maxPop: 0, maxJobs: 20, pollution: 0, landValue: 10, powerConsumptionBase: 3 }],
  ['hospital', { maxPop: 0, maxJobs: 80, pollution: 0, landValue: 25, powerConsumptionBase: 8 }],
  ['school', { maxPop: 0, maxJobs: 25, pollution: 0, landValue: 15, powerConsumptionBase: 2 }],
  ['university', { maxPop: 0, maxJobs: 100, pollution: 0, landValue: 35, powerConsumptionBase: 6 }],
  ['city_hall', { maxPop: 0, maxJobs: 60, pollution: 0, landValue: 50, powerConsumptionBase: 4 }],
  // Parks & Natur – kein Stromverbrauch
  ['park', { maxPop: 0, maxJobs: 2, pollution: -10, landValue: 20 }],
  ['park_large', { maxPop: 0, maxJobs: 6, pollution: -25, landValue: 50 }],
  ['tennis', { maxPop: 0, maxJobs: 1, pollution: -5, landValue: 15 }],
  ['basketball_courts', { maxPop: 0, maxJobs: 2, pollution: -3, landValue: 12 }],
  ['playground_small', { maxPop: 0, maxJobs: 1, pollution: -5, landValue: 15 }],
  ['playground_large', { maxPop: 0, maxJobs: 2, pollution: -8, landValue: 18 }],
  ['baseball_field_small', { maxPop: 0, maxJobs: 4, pollution: -10, landValue: 25 }],
  ['soccer_field_small', { maxPop: 0, maxJobs: 2, pollution: -5, landValue: 15 }],
  ['football_field', { maxPop: 0, maxJobs: 8, pollution: -8, landValue: 30 }],
  ['community_garden', { maxPop: 0, maxJobs: 2, pollution: -12, landValue: 18 }],
  ['pond_park', { maxPop: 0, maxJobs: 2, pollution: -15, landValue: 22 }],
  ['park_gate', { maxPop: 0, maxJobs: 1, pollution: -2, landValue: 8 }],
  ['greenhouse_garden', { maxPop: 0, maxJobs: 8, pollution: -15, landValue: 28 }],
  ['animal_pens_farm', { maxPop: 0, maxJobs: 4, pollution: 2, landValue: 10 }],
  ['campground', { maxPop: 0, maxJobs: 3, pollution: -8, landValue: 12 }],
  ['mountain_trailhead', { maxPop: 0, maxJobs: 2, pollution: -10, landValue: 15 }],
  // Strom-/Wasserinfrastruktur
  ['power_plant', { maxPop: 0, maxJobs: 30, pollution: 30, landValue: -20, powerConsumptionBase: 5 }],
  ['solar_panel', { maxPop: 0, maxJobs: 2, pollution: -5, landValue: 5, powerProduction: 60 }],
  ['wind_turbine', { maxPop: 0, maxJobs: 3, pollution: -3, landValue: -5, powerProduction: 80 }],
  ['water_tower', { maxPop: 0, maxJobs: 5, pollution: 0, landValue: 5, powerConsumptionBase: 2 }],
  ['water_reservoir', { maxPop: 0, maxJobs: 8, pollution: 0, landValue: 8, powerConsumptionBase: 5, waterCapacity: 2000 }],
  // Grosse Gebäude & Sehenswürdigkeiten
  ['stadium', { maxPop: 0, maxJobs: 50, pollution: 5, landValue: 40, powerConsumptionBase: 12 }],
  ['baseball_stadium', { maxPop: 0, maxJobs: 60, pollution: 5, landValue: 45, powerConsumptionBase: 8 }],
  ['museum', { maxPop: 0, maxJobs: 40, pollution: 0, landValue: 45, powerConsumptionBase: 4 }],
  ['airport', { maxPop: 0, maxJobs: 200, pollution: 20, landValue: 50, powerConsumptionBase: 20 }],
  ['space_program', { maxPop: 0, maxJobs: 150, pollution: 5, landValue: 80, powerConsumptionBase: 25 }],
  ['amusement_park', { maxPop: 0, maxJobs: 100, pollution: 8, landValue: 60, powerConsumptionBase: 10 }],
  ['roller_coaster_small', { maxPop: 0, maxJobs: 20, pollution: 3, landValue: 40, powerConsumptionBase: 5 }],
  ['community_center', { maxPop: 0, maxJobs: 10, pollution: 0, landValue: 20, powerConsumptionBase: 2 }],
  ['amphitheater', { maxPop: 0, maxJobs: 15, pollution: -5, landValue: 35, powerConsumptionBase: 2 }],
  ['swimming_pool', { maxPop: 0, maxJobs: 5, pollution: -5, landValue: 18, powerConsumptionBase: 3 }],
  ['go_kart_track', { maxPop: 0, maxJobs: 10, pollution: 5, landValue: 20, powerConsumptionBase: 3 }],
  ['skate_park', { maxPop: 0, maxJobs: 2, pollution: -3, landValue: 12 }],
  ['mini_golf_course', { maxPop: 0, maxJobs: 6, pollution: -8, landValue: 22, powerConsumptionBase: 1 }],
  ['bleachers_field', { maxPop: 0, maxJobs: 3, pollution: -5, landValue: 15 }],
  // Transport
  ['subway_station', { maxPop: 0, maxJobs: 15, pollution: 0, landValue: 25, powerConsumptionBase: 3 }],
  ['rail_station', { maxPop: 0, maxJobs: 25, pollution: 2, landValue: 20, powerConsumptionBase: 3 }],
  ['bus_station', { maxPop: 0, maxJobs: 25, pollution: 3, landValue: 30, powerConsumptionBase: 2 }],
  ['bus_stop', { maxPop: 0, maxJobs: 2, pollution: 0, landValue: 8 }],
  // Sonstiges
  ['woodcutter_house', { maxPop: 0, maxJobs: 4, pollution: -5, landValue: 12, powerConsumptionBase: 1 }],
  ['marina_docks_small', { maxPop: 0, maxJobs: 8, pollution: 2, landValue: 25, powerConsumptionBase: 2 }],
  ['pier_large', { maxPop: 0, maxJobs: 12, pollution: 1, landValue: 30, powerConsumptionBase: 2 }],
  ['mountain_lodge', { maxPop: 0, maxJobs: 15, pollution: -5, landValue: 35, powerConsumptionBase: 2 }],
  ['furni', { maxPop: 0, maxJobs: 0, pollution: 0, landValue: 0 }],
]);

const SERVICE_UPGRADE_TOOLS = new Set([
  'police_station',
  'fire_station',
  'hospital',
  'school',
  'university',
  'power_plant',
  'water_tower',
]);

const COAT_OF_ARMS_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'coat-of-arms');
const MINIMAP_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'minimaps');
const MAX_COAT_OF_ARMS_PNG_BYTES = 512 * 1024;
const MAX_MINIMAP_PNG_BYTES = 256 * 1024;

const ROOM_CACHE_UNLOAD_IDLE_MS = Number(config.ROOM_CACHE_UNLOAD_IDLE_MS || 180000);
const ROOM_CACHE_FLUSH_INTERVAL_MS = Number(config.ROOM_CACHE_FLUSH_INTERVAL_MS || 10000);

const XP_LEVEL_CAP = 25;
const XP_DAILY_LOGIN = 50;

const BUENZLI_EVENTS_ENABLED = (config.BUENZLI_EVENTS_ENABLED || 'true').toLowerCase() === 'true';
const BUENZLI_EVENTS_PER_DAY_MIN = 4;
const BUENZLI_EVENTS_PER_DAY_MAX = 10;
const BUENZLI_EVENT_CHECK_INTERVAL_MS = 60000;
const INSPECTION_DURATION_MS = 10 * 60 * 1000;
const INSPECTION_RADIUS = 5;

const FOREIGN_REPORT_COIN_MULTIPLIER = 3;
const FOREIGN_REPORT_XP_MULTIPLIER = 2;
const FOREIGN_REPORT_PENALTY_MULTIPLIER = 2;

const PUBLIC_ROOM_SIZE_PRESETS = {
  very_small: { size: 6, label: 'Sehr klein', tiles: 36 },
  small: { size: 8, label: 'Klein', tiles: 64 },
  medium: { size: 10, label: 'Mittel', tiles: 100 },
  large: { size: 12, label: 'Gross', tiles: 144 },
};

const DEFAULT_ACHIEVEMENTS = [
  { code: 'first_steps', title: 'Erste Schritte', description: 'Baue mindestens 10 Gebäude in deiner Gemeinde.', goal_type: 'building_count', goal_value: 10, reward_xp: 50, reward_money: 1000, sort_order: 10 },
  { code: 'city_hall_built', title: 'Rathaus steht', description: 'Errichte ein City Hall Gebäude.', goal_type: 'city_hall_count', goal_value: 1, reward_xp: 80, reward_money: 2500, sort_order: 20 },
  { code: 'population_100', title: 'Dorfleben', description: 'Erreiche 100 Einwohner.', goal_type: 'population', goal_value: 100, reward_xp: 100, reward_money: 3000, sort_order: 30 },
  { code: 'population_500', title: 'Kleinstadt', description: 'Erreiche 500 Einwohner.', goal_type: 'population', goal_value: 500, reward_xp: 220, reward_money: 7000, sort_order: 40 },
  { code: 'jobs_200', title: 'Wirtschaft läuft', description: 'Erreiche 200 Arbeitsplätze.', goal_type: 'jobs', goal_value: 200, reward_xp: 120, reward_money: 3500, sort_order: 50 },
  { code: 'money_100k', title: 'Gefüllte Kasse', description: 'Halte mindestens 100000 Geld in der Stadtkasse.', goal_type: 'money', goal_value: 100000, reward_xp: 180, reward_money: 5000, sort_order: 60 },
  { code: 'money_250k', title: 'Finanzmeister', description: 'Halte mindestens 250000 Geld in der Stadtkasse.', goal_type: 'money', goal_value: 250000, reward_xp: 300, reward_money: 12000, sort_order: 70 },
  { code: 'trade_connected', title: 'Vernetzte Region', description: 'Verbinde mindestens eine Handelsroute.', goal_type: 'connected_partnerships', goal_value: 1, reward_xp: 160, reward_money: 4500, sort_order: 80 },
];

// ─── Service Building Level-Effekte (L1-L5) ───────────────────────
const SERVICE_LEVEL_CONFIG = {
  // Kapazitäts-Skalierung: capacity = base × (BASE + level × PER_LEVEL)
  // L1=1.0x, L2=1.5x, L3=2.0x, L4=2.5x, L5=3.0x
  capacityScaleBase: 0.5,
  capacityScalePerLevel: 0.5,

  // Budget-Kosten-Skalierung: cost = baseCost × (BASE + level × PER_LEVEL)
  // L1=1.0x, L2=1.4x, L3=1.8x, L4=2.2x, L5=2.6x
  budgetCostScaleBase: 0.6,
  budgetCostScalePerLevel: 0.4,

  // Coverage-Stärke: intensity = 1 + (level-1) × FACTOR
  // L1=1.0x, L2=1.15x, L3=1.3x, L4=1.45x, L5=1.6x
  coverageStrengthPerLevel: 0.15,

  // Polizei-Level-Effekte
  policeChaseRadiusBase: 20,        // L1: 20 Tiles
  policeChaseRadiusPerLevel: 4,     // +4/Level → L5: 36 Tiles
  policeNoticeDelayBase: 4,         // L1: 4 Ticks (12s)
  policeNoticeDelayReduction: 0.5,  // -0.5/Level → L5: 2 Ticks (6s)
  policeNoticeDelayMin: 2,          // Minimum 2 Ticks
  policeCatchBonusPerLevel: 0.06,   // +6%/Level → L5: 89%/74%
  policeCatchMax: 0.95,             // Maximum 95%

  // Schulkapazität
  schoolCapacityBase: 120,          // Schüler pro Schule (L1)
  uniCapacityBase: 200,             // Studenten pro Uni (L1)

  // Gesundheits-Kapazität
  healthCapacityBase: 300,          // Patienten pro Hospital (L1)
  healthSeniorWeight: 3,            // Senioren belasten 3x mehr
  healthScoreWeightCoverage: 0.6,   // 60% Coverage
  healthScoreWeightPollution: 0.15, // 15% Umwelt
  healthScoreWeightAdequacy: 0.25,  // 25% Kapazitäts-Deckung
  healthPenaltyThreshold: 0.8,      // Unter 80% Deckung → Happiness-Penalty
  healthPenaltyMax: 10,             // Max -10 Happiness

  // Bildungs-Score
  educationScoreWeightCoverage: 0.7, // 70% Coverage
  educationScoreWeightCapacity: 0.3, // 30% Kapazitäts-Deckung

  // Natürliche Arbeitslosigkeit (Friktionelle + Strukturelle)
  // Auch bei Vollbeschäftigung gibt es immer Jobwechsler, Skill-Mismatch etc.
  naturalUnemploymentRate: 3.5,      // 3.5% Minimum (real: ~4-5%)
};

const POPULATION_MILESTONES = [
  { code: 'POP_100', threshold: 100, bonus: 5000 },
  { code: 'POP_500', threshold: 500, bonus: 15000 },
  { code: 'POP_1000', threshold: 1000, bonus: 50000 },
  { code: 'POP_2000', threshold: 2000, bonus: 100000 },
  { code: 'POP_3000', threshold: 3000, bonus: 200000 },
];

module.exports = {
  config,
  CONFIG_PATH,
  HOST,
  PORT,
  JWT_SECRET,
  TOKEN_TTL_HOURS,
  TOKEN_TTL_HOURS_REMEMBER,
  DB_HOST,
  DB_PORT,
  DB_NAME,
  DB_USER,
  DB_PASSWORD,
  DB_CONNECTION_LIMIT,
  BULLDOZE_COST_PER_CLICK,
  MUNICIPALITY_MEMBER_LIMIT,
  MUNICIPALITY_ROLE_OWNER,
  MUNICIPALITY_ROLE_COUNCIL,
  MUNICIPALITY_ROLE_CITIZEN,
  MUNICIPALITY_ROLE_OBSERVER,
  MUNICIPALITY_ROLE_HIERARCHY,
  GLOBAL_ROLE_USER,
  GLOBAL_ROLE_MODERATOR,
  GLOBAL_ROLE_ADMINISTRATOR,
  DISCORD_BOT_WEBHOOK_URL,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  FRONTEND_URL,
  CORS_ALLOWED_ORIGINS,
  CORS_ALLOWED_ORIGIN_SET,
  CORS_ALLOW_ALL,
  CLIENT_TOOL_INFO_PATH,
  CLIENT_ITEM_DETAILS_PATH,
  CLIENT_BUILDING_STATS_PATH,
  ITEM_PRICES_OUTPUT_PATH,
  HARD_CODED_BUILDING_STATS,
  SERVICE_UPGRADE_TOOLS,
  COAT_OF_ARMS_UPLOAD_DIR,
  MINIMAP_UPLOAD_DIR,
  MAX_COAT_OF_ARMS_PNG_BYTES,
  MAX_MINIMAP_PNG_BYTES,
  ROOM_CACHE_UNLOAD_IDLE_MS,
  ROOM_CACHE_FLUSH_INTERVAL_MS,
  XP_LEVEL_CAP,
  XP_DAILY_LOGIN,
  BUENZLI_EVENTS_ENABLED,
  BUENZLI_EVENTS_PER_DAY_MIN,
  BUENZLI_EVENTS_PER_DAY_MAX,
  BUENZLI_EVENT_CHECK_INTERVAL_MS,
  INSPECTION_DURATION_MS,
  INSPECTION_RADIUS,
  FOREIGN_REPORT_COIN_MULTIPLIER,
  FOREIGN_REPORT_XP_MULTIPLIER,
  FOREIGN_REPORT_PENALTY_MULTIPLIER,
  PUBLIC_ROOM_SIZE_PRESETS,
  DEFAULT_ACHIEVEMENTS,
  POPULATION_MILESTONES,
  SERVICE_LEVEL_CONFIG,
  STEAM_WEB_API_KEY,
  STEAM_APP_ID,
};
