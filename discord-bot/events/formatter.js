/**
 * Event-Formatter: Wandelt Spielereignisse in Discord Embeds um.
 *
 * Jeder Event-Typ bekommt ein eigenes, formatiertes Embed mit
 * passendem Icon, Farbe und Feldern.
 */

const { EmbedBuilder } = require('discord.js');

// ─── Farben für verschiedene Event-Kategorien ────────────────
const EMBED_COLORS = {
  fire: 0xFF4500,         // Orange-Rot
  meteor: 0x8B4513,       // Braun
  earthquake: 0xDAA520,   // Dunkelgelb
  tornado: 0x708090,      // Schiefergrau
  flood: 0x4169E1,        // Königsblau
  disaster: 0xFF0000,     // Rot

  building_complete: 0x00FF00,  // Grün
  building_upgrade: 0x32CD32,   // Limettengrün
  building_abandoned: 0x808080, // Grau

  partnership: 0xFFD700,   // Gold
  partnership_discovered: 0xFFD700,
  partnership_discovered_by_other: 0xFFA500,
  partnership_connected: 0x00FF7F,
  partnership_request_incoming: 0xFFAA00,
  partnership_request_accepted: 0x00CC00,
  partnership_request_declined: 0xCC4444,

  trade: 0xFFD700,         // Gold
  info: 0x5865F2,          // Discord Blurple
  system: 0x99AAB5,        // Grau
  success: 0x57F287,       // Grün
  warning: 0xFEE75C,       // Gelb
  error: 0xED4245,         // Rot

  buenzli_report: 0xFFA500,  // Orange
  buenzli_resolve: 0x57F287, // Grün
  inspection_complete: 0x5865F2, // Blurple
  contract_created: 0xFFD700,  // Gold
  contract_completed: 0x57F287, // Grün
};

// ─── Icons für Event-Typen ───────────────────────────────────
const EVENT_ICONS = {
  fire: '🔥',
  meteor: '☄️',
  earthquake: '🌍',
  tornado: '🌪️',
  flood: '🌊',
  disaster: '⚠️',

  building_complete: '🏗️',
  building_upgrade: '⬆️',
  building_abandoned: '🏚️',
  building_destroyed: '💥',

  partnership_discovered: '🔍',
  partnership_discovered_by_other: '👀',
  partnership_connected: '🤝',
  partnership_request_incoming: '📨',
  partnership_request_accepted: '✅',
  partnership_request_declined: '❌',

  trade: '💰',
  stats_update: '📈',
  player_join: '👋',
  player_leave: '🚪',
  system: 'ℹ️',

  buenzli_report: '🔍',
  buenzli_resolve: '✅',
  inspection_complete: '🕵️',
  contract_created: '📋',
  contract_completed: '🏆',
};

// ─── Deutsche Gebäudenamen ───────────────────────────────────
const BUILDING_NAMES = {
  residential: 'Wohnhaus',
  commercial: 'Geschäft',
  industrial: 'Fabrik',
  office: 'Büro',
  road: 'Strasse',
  rail: 'Gleise',
  subway: 'U-Bahn',
  tree: 'Baum',
  tree_oak: 'Eiche',
  tree_maple: 'Ahorn',
  tree_birch: 'Birke',
  tree_willow: 'Weide',
  tree_pine: 'Kiefer',
  tree_spruce: 'Fichte',
  tree_fir: 'Tanne',
  tree_cedar: 'Zeder',
  tree_palm: 'Palme',
  tree_cherry: 'Kirschbaum',
  police_station: 'Polizeistation',
  fire_station: 'Feuerwache',
  hospital: 'Spital',
  school: 'Schule',
  university: 'Universität',
  park: 'Kleiner Park',
  park_large: 'Grosser Park',
  tennis: 'Tennisplatz',
  power_plant: 'Kraftwerk',
  water_tower: 'Wasserturm',
  subway_station: 'U-Bahn-Station',
  rail_station: 'Bahnhof',
  stadium: 'Stadion',
  museum: 'Museum',
  airport: 'Flughafen',
  space_program: 'Raumfahrtprogramm',
  city_hall: 'Rathaus',
  zone_residential: 'Wohnzone',
  zone_commercial: 'Gewerbezone',
  zone_industrial: 'Industriezone',
};

function translateBuildingType(type) {
  if (!type) return 'Unbekannt';
  const key = String(type).trim().toLowerCase();
  return BUILDING_NAMES[key] || type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, ' ');
}

// ─── Katastrophen-Formatter ──────────────────────────────────
function formatDisaster(eventType, data) {
  const icon = EVENT_ICONS[eventType] || EVENT_ICONS.disaster;
  const color = EMBED_COLORS[eventType] || EMBED_COLORS.disaster;

  const disasterNames = {
    fire: 'Feuer',
    meteor: 'Meteoreinschlag',
    earthquake: 'Erdbeben',
    tornado: 'Tornado',
    flood: 'Überschwemmung',
  };

  const embed = new EmbedBuilder()
    .setTitle(`${icon} ${disasterNames[eventType] || 'Katastrophe'}!`)
    .setColor(color)
    .setTimestamp();

  if (data.municipalityName) {
    embed.addFields({ name: 'Gemeinde', value: data.municipalityName, inline: true });
  }
  if (data.roomCode) {
    embed.addFields({ name: 'Raum', value: data.roomCode, inline: true });
  }
  if (data.affectedCount !== undefined) {
    embed.addFields({ name: 'Betroffene Gebäude', value: `${data.affectedCount}`, inline: true });
  }
  if (data.destroyedCount !== undefined) {
    embed.addFields({ name: 'Zerstört', value: `${data.destroyedCount}`, inline: true });
  }
  if (data.intensity) {
    embed.addFields({ name: 'Stärke', value: `${data.intensity}`, inline: true });
  }

  const descriptions = {
    fire: 'Ein Feuer ist ausgebrochen! Gebäude brennen!',
    meteor: 'Ein Meteor ist eingeschlagen! Massive Zerstörung!',
    earthquake: 'Die Erde bebt! Gebäude sind beschädigt!',
    tornado: 'Ein Tornado fegt über die Gemeinde!',
    flood: 'Überflutung! Gebäude stehen unter Wasser!',
  };
  embed.setDescription(descriptions[eventType] || 'Eine Katastrophe hat zugeschlagen!');

  return embed;
}

// ─── Gebäude-Formatter ───────────────────────────────────────
function formatBuilding(eventType, data) {
  const icon = EVENT_ICONS[eventType] || '🏗️';
  const color = EMBED_COLORS[eventType] || EMBED_COLORS.building_complete;

  const titles = {
    building_complete: 'Gebäude fertiggestellt',
    building_upgrade: 'Gebäude aufgewertet',
    building_abandoned: 'Gebäude verlassen',
    building_destroyed: 'Gebäude zerstört',
  };

  const embed = new EmbedBuilder()
    .setTitle(`${icon} ${titles[eventType] || 'Gebäude-Update'}`)
    .setColor(color)
    .setTimestamp();

  if (data.municipalityName) {
    embed.addFields({ name: 'Gemeinde', value: data.municipalityName, inline: true });
  }
  if (data.buildingType) {
    embed.addFields({ name: 'Gebäudetyp', value: translateBuildingType(data.buildingType), inline: true });
  }
  if (data.level !== undefined) {
    embed.addFields({ name: 'Level', value: `${data.level}`, inline: true });
  }
  if (data.position) {
    embed.addFields({ name: 'Position', value: `(${data.position.x}, ${data.position.y})`, inline: true });
  }
  if (data.count) {
    embed.addFields({ name: 'Anzahl', value: `${data.count}`, inline: true });
  }

  return embed;
}

// ─── Partnerschaft-Formatter ─────────────────────────────────
function formatPartnership(eventType, data) {
  const icon = EVENT_ICONS[eventType] || '🤝';
  const color = EMBED_COLORS[eventType] || EMBED_COLORS.partnership;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTimestamp();

  switch (eventType) {
    case 'partnership_discovered':
      embed.setTitle(`${icon} Neuer Handelspartner entdeckt`);
      embed.setDescription(data.message || 'Ein neuer Handelspartner wurde entdeckt!');
      break;
    case 'partnership_discovered_by_other':
      embed.setTitle(`${icon} Du wurdest entdeckt!`);
      embed.setDescription(data.message || 'Eine andere Gemeinde hat dich als Handelspartner entdeckt.');
      break;
    case 'partnership_connected':
      embed.setTitle(`${icon} Handelsroute aktiv!`);
      embed.setDescription(data.message || 'Eine neue Handelsroute ist jetzt aktiv!');
      break;
    case 'partnership_request_incoming':
      embed.setTitle(`${icon} Partnerschaftsanfrage`);
      embed.setDescription(data.message || 'Neue Partnerschaftsanfrage erhalten!');
      break;
    case 'partnership_request_accepted':
      embed.setTitle(`${icon} Anfrage angenommen!`);
      embed.setDescription(data.message || 'Deine Partnerschaftsanfrage wurde angenommen!');
      break;
    case 'partnership_request_declined':
      embed.setTitle(`${icon} Anfrage abgelehnt`);
      embed.setDescription(data.message || 'Deine Partnerschaftsanfrage wurde abgelehnt.');
      break;
    default:
      embed.setTitle(`${icon} Partnerschaft-Event`);
      embed.setDescription(data.message || 'Partnerschaft-Update');
  }

  if (data.username) {
    embed.addFields({ name: 'Spieler', value: data.username, inline: true });
  }

  const payload = data.payload || {};
  if (payload.municipality_slug) {
    embed.addFields({ name: 'Gemeinde', value: payload.municipality_slug, inline: true });
  }
  if (payload.partner_slug) {
    embed.addFields({ name: 'Partner', value: payload.partner_slug, inline: true });
  }
  if (payload.monthly_income !== undefined) {
    embed.addFields({ name: 'Monatliches Einkommen', value: `${payload.monthly_income} 💰`, inline: true });
  }

  return embed;
}

// ─── Bünzli Event-Formatter ─────────────────────────────────
function formatBuenzli(eventType, data) {
  const icon = EVENT_ICONS[eventType] || '🔍';
  const color = EMBED_COLORS[eventType] || EMBED_COLORS.buenzli_report;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTimestamp();

  switch (eventType) {
    case 'buenzli_report':
      embed.setTitle(`${icon} Bünzli-Meldung eingegangen`);
      embed.setDescription(data.message || 'Ein Vergehen wurde gemeldet!');
      if (data.username) embed.addFields({ name: 'Gemeldet von', value: data.username, inline: true });
      if (data.payload?.event_name) embed.addFields({ name: 'Vergehen', value: `${data.payload.event_emoji || ''} ${data.payload.event_name}`, inline: true });
      if (data.payload?.severity) embed.addFields({ name: 'Schwere', value: `${'⭐'.repeat(data.payload.severity)}`, inline: true });
      if (data.payload?.municipality_name) embed.addFields({ name: 'Gemeinde', value: data.payload.municipality_name, inline: true });
      if (data.payload?.xp) embed.addFields({ name: 'XP erhalten', value: `+${data.payload.xp}`, inline: true });
      break;
    case 'buenzli_resolve':
      embed.setTitle(`${icon} Vergehen behoben!`);
      embed.setDescription(data.message || 'Ein gemeldetes Vergehen wurde erfolgreich behoben.');
      if (data.username) embed.addFields({ name: 'Behoben von', value: data.username, inline: true });
      if (data.payload?.event_name) embed.addFields({ name: 'Vergehen', value: `${data.payload.event_emoji || ''} ${data.payload.event_name}`, inline: true });
      if (data.payload?.cost) embed.addFields({ name: 'Kosten', value: `${data.payload.cost} 💰`, inline: true });
      break;
    case 'inspection_complete':
      embed.setTitle(`${icon} Inspektion abgeschlossen`);
      embed.setDescription(data.message || 'Eine Bünzli-Inspektion wurde abgeschlossen.');
      if (data.username) embed.addFields({ name: 'Inspektor', value: data.username, inline: true });
      if (data.payload?.events_found !== undefined) embed.addFields({ name: 'Vergehen gefunden', value: `${data.payload.events_found}`, inline: true });
      if (data.payload?.tile) embed.addFields({ name: 'Position', value: `(${data.payload.tile.x}, ${data.payload.tile.y})`, inline: true });
      break;
    case 'contract_created':
      embed.setTitle(`${icon} Neuer Firmenauftrag`);
      embed.setDescription(data.message || 'Ein neuer Auftrag wurde erstellt.');
      if (data.payload?.company_name) embed.addFields({ name: 'Firma', value: data.payload.company_name, inline: true });
      if (data.payload?.payment) embed.addFields({ name: 'Vergütung', value: `${data.payload.payment} 💰`, inline: true });
      break;
    case 'contract_completed':
      embed.setTitle(`${icon} Auftrag abgeschlossen!`);
      embed.setDescription(data.message || 'Ein Firmenauftrag wurde erfolgreich abgeschlossen.');
      if (data.payload?.company_name) embed.addFields({ name: 'Firma', value: data.payload.company_name, inline: true });
      if (data.payload?.payment) embed.addFields({ name: 'Verdient', value: `${data.payload.payment} 💰`, inline: true });
      if (data.username) embed.addFields({ name: 'Mitarbeiter', value: data.username, inline: true });
      break;
    default:
      embed.setTitle(`${icon} Bünzli-Event`);
      embed.setDescription(data.message || 'Bünzli-Event');
  }

  return embed;
}

// ─── Generischer Formatter (Fallback) ────────────────────────
function formatGeneric(eventType, data) {
  const icon = EVENT_ICONS[eventType] || EVENT_ICONS.system;
  const color = EMBED_COLORS[eventType] || EMBED_COLORS.info;

  const embed = new EmbedBuilder()
    .setTitle(`${icon} ${data.title || eventType}`)
    .setColor(color)
    .setTimestamp();

  if (data.message) {
    embed.setDescription(data.message);
  }
  if (data.username) {
    embed.addFields({ name: 'Spieler', value: data.username, inline: true });
  }

  return embed;
}

// ─── Haupt-Dispatcher ────────────────────────────────────────
function formatEvent(eventType, data) {
  const type = String(eventType || '').toLowerCase();

  // Katastrophen
  if (['fire', 'meteor', 'earthquake', 'tornado', 'flood', 'disaster'].includes(type)) {
    return formatDisaster(type, data);
  }

  // Gebäude
  if (type.startsWith('building_')) {
    return formatBuilding(type, data);
  }

  // Partnerschaften
  if (type.startsWith('partnership_')) {
    return formatPartnership(type, data);
  }

  // Bünzli Events
  if (['buenzli_report', 'buenzli_resolve', 'inspection_complete', 'contract_created', 'contract_completed'].includes(type)) {
    return formatBuenzli(type, data);
  }

  // Alles andere
  return formatGeneric(type, data);
}

module.exports = {
  formatEvent,
  formatDisaster,
  formatBuilding,
  formatPartnership,
  formatBuenzli,
  formatGeneric,
  translateBuildingType,
  EMBED_COLORS,
  EVENT_ICONS,
  BUILDING_NAMES,
};
