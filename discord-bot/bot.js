/**
 * MeinOrt Discord Bot
 * Sendet Spielbenachrichtigungen an Discord-Channels.
 *
 * Funktionen:
 * - Überwacht die Datenbank auf neue Benachrichtigungen (Polling)
 * - Empfängt Push-Events vom Spielserver via interner HTTP-Webhook
 * - Slash-Commands für Status-Abfragen (/status, /gemeinde)
 */

require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const mysql = require('mysql2/promise');
const http = require('http');
const { formatEvent, EMBED_COLORS } = require('./events/formatter');

// ─── Konfiguration ───────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const CHANNEL_DISASTERS = process.env.DISCORD_CHANNEL_DISASTERS || DISCORD_CHANNEL_ID;
const CHANNEL_BUILDINGS = process.env.DISCORD_CHANNEL_BUILDINGS || DISCORD_CHANNEL_ID;
const CHANNEL_PARTNERSHIPS = process.env.DISCORD_CHANNEL_PARTNERSHIPS || DISCORD_CHANNEL_ID;
const CHANNEL_BUENZLI = process.env.DISCORD_CHANNEL_BUENZLI || DISCORD_CHANNEL_ID;
const WEBHOOK_PORT = Number(process.env.WEBHOOK_PORT || 4200);
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL || 5000);

const DB_CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME || 'buenzlifight',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  waitForConnections: true,
  connectionLimit: 3,
};

// ─── Validierung ─────────────────────────────────────────────
if (!DISCORD_TOKEN) {
  console.error('[FEHLER] DISCORD_TOKEN fehlt in .env');
  process.exit(1);
}
if (!DISCORD_CHANNEL_ID) {
  console.error('[FEHLER] DISCORD_CHANNEL_ID fehlt in .env');
  process.exit(1);
}

// ─── Discord Client ──────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

let dbPool = null;
let lastNotificationId = 0;
let isReady = false;

// ─── Channel-Mapping ─────────────────────────────────────────
const CHANNEL_MAP = {
  disaster: CHANNEL_DISASTERS,
  fire: CHANNEL_DISASTERS,
  meteor: CHANNEL_DISASTERS,
  earthquake: CHANNEL_DISASTERS,
  tornado: CHANNEL_DISASTERS,
  flood: CHANNEL_DISASTERS,
  building_complete: CHANNEL_BUILDINGS,
  building_upgrade: CHANNEL_BUILDINGS,
  building_abandoned: CHANNEL_BUILDINGS,
  partnership_discovered: CHANNEL_PARTNERSHIPS,
  partnership_discovered_by_other: CHANNEL_PARTNERSHIPS,
  partnership_connected: CHANNEL_PARTNERSHIPS,
  partnership_request_incoming: CHANNEL_PARTNERSHIPS,
  partnership_request_accepted: CHANNEL_PARTNERSHIPS,
  partnership_request_declined: CHANNEL_PARTNERSHIPS,
  buenzli_report: CHANNEL_BUENZLI,
  buenzli_resolve: CHANNEL_BUENZLI,
  inspection_complete: CHANNEL_BUENZLI,
  contract_created: CHANNEL_BUENZLI,
  contract_completed: CHANNEL_BUENZLI,
};

function getChannelForEvent(eventType) {
  return CHANNEL_MAP[eventType] || DISCORD_CHANNEL_ID;
}

// ─── Discord: Nachricht senden ───────────────────────────────
async function sendDiscordMessage(channelId, embed) {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      console.error(`[DISCORD] Channel ${channelId} nicht gefunden`);
      return;
    }
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error('[DISCORD] Fehler beim Senden:', err.message);
  }
}

async function sendGameEvent(eventType, data) {
  if (!isReady) return;
  const embed = formatEvent(eventType, data);
  if (!embed) return;
  const channelId = getChannelForEvent(eventType);
  await sendDiscordMessage(channelId, embed);
}

// ─── Datenbank: Polling für neue Benachrichtigungen ──────────
async function initDatabase() {
  try {
    dbPool = mysql.createPool(DB_CONFIG);
    const [rows] = await dbPool.query(
      'SELECT COALESCE(MAX(id), 0) AS max_id FROM user_notifications'
    );
    lastNotificationId = Number(rows[0]?.max_id || 0);
    console.log(`[DB] Verbunden. Starte Polling ab Notification-ID ${lastNotificationId}`);
    return true;
  } catch (err) {
    console.error('[DB] Verbindungsfehler:', err.message);
    console.warn('[DB] Bot läuft ohne Datenbank-Polling (nur Webhook-Events)');
    return false;
  }
}

async function pollNotifications() {
  if (!dbPool) return;
  try {
    const [rows] = await dbPool.query(
      `SELECT n.*, u.nickname
       FROM user_notifications n
       LEFT JOIN users u ON u.id = n.user_id
       WHERE n.id > ?
       ORDER BY n.id ASC
       LIMIT 20`,
      [lastNotificationId]
    );
    for (const row of rows) {
      lastNotificationId = Math.max(lastNotificationId, Number(row.id));
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
      await sendGameEvent(row.notification_type, {
        title: row.title,
        message: row.message,
        username: row.nickname || 'Unbekannt',
        payload,
        createdAt: row.created_at,
      });
    }
  } catch (err) {
    console.error('[DB-POLL] Fehler:', err.message);
  }
}

// ─── Interner Webhook-Server ─────────────────────────────────
// Der Spielserver kann POST-Requests an diesen Endpoint senden
function startWebhookServer() {
  const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  const server = http.createServer(async (req, res) => {
    // CORS Preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url === '/event') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const eventType = data.type || data.eventType || 'unknown';
          console.log(`[WEBHOOK] Event empfangen: ${eventType}`);
          await sendGameEvent(eventType, data);
          res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          console.error('[WEBHOOK] Parse-Fehler:', err.message);
          res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Ungültiges JSON' }));
        }
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), isReady }));
      return;
    }

    res.writeHead(404, CORS_HEADERS);
    res.end('Not Found');
  });

  server.listen(WEBHOOK_PORT, '127.0.0.1', () => {
    console.log(`[WEBHOOK] Interner Webhook-Server läuft auf http://127.0.0.1:${WEBHOOK_PORT}`);
  });
}

// ─── Slash Commands ──────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Zeigt den aktuellen Bot-Status an'),
  new SlashCommandBuilder()
    .setName('gemeinde')
    .setDescription('Zeigt Info zu einer Gemeinde')
    .addStringOption(opt =>
      opt.setName('name').setDescription('Name oder Slug der Gemeinde').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('events')
    .setDescription('Zeigt die letzten Spielereignisse')
    .addIntegerOption(opt =>
      opt.setName('anzahl').setDescription('Anzahl der Events (1-10)').setMinValue(1).setMaxValue(10)
    ),
  new SlashCommandBuilder()
    .setName('inspect')
    .setDescription('Zeigt aktive Bünzli-Events einer Gemeinde')
    .addStringOption(opt =>
      opt.setName('gemeinde').setDescription('Name oder Slug der Gemeinde').setRequired(false)
    ),
];

async function registerCommands() {
  try {
    const rest = new REST().setToken(DISCORD_TOKEN);
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands.map(c => c.toJSON()) },
    );
    console.log('[COMMANDS] Slash-Commands registriert');
  } catch (err) {
    console.error('[COMMANDS] Registrierung fehlgeschlagen:', err.message);
  }
}

// ─── Slash Command Handler ───────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'status') {
    const uptimeSeconds = Math.round(process.uptime());
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const embed = new EmbedBuilder()
      .setTitle('🏙️ MeinOrt Bot Status')
      .setColor(EMBED_COLORS.info)
      .addFields(
        { name: 'Status', value: '🟢 Online', inline: true },
        { name: 'Uptime', value: `${hours}h ${minutes}m`, inline: true },
        { name: 'Datenbank', value: dbPool ? '🟢 Verbunden' : '🔴 Getrennt', inline: true },
        { name: 'Letzte Notification-ID', value: `${lastNotificationId}`, inline: true },
      )
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  }

  if (interaction.commandName === 'gemeinde') {
    const name = interaction.options.getString('name');
    if (!dbPool) {
      await interaction.reply({ content: '❌ Keine Datenbankverbindung.', ephemeral: true });
      return;
    }
    try {
      const [rows] = await dbPool.query(
        `SELECT m.*, u.nickname AS owner_name
         FROM municipalities m
         LEFT JOIN municipality_members mm ON mm.municipality_id = m.id AND mm.role = 'owner'
         LEFT JOIN users u ON u.id = mm.user_id
         WHERE m.name LIKE ? OR m.slug LIKE ?
         LIMIT 1`,
        [`%${name}%`, `%${name}%`]
      );
      if (!rows.length) {
        await interaction.reply({ content: `❌ Gemeinde "${name}" nicht gefunden.`, ephemeral: true });
        return;
      }
      const m = rows[0];
      const embed = new EmbedBuilder()
        .setTitle(`🏘️ ${m.name}`)
        .setColor(EMBED_COLORS.info)
        .addFields(
          { name: 'Slug', value: m.slug || '-', inline: true },
          { name: 'Besitzer', value: m.owner_name || 'Kein Besitzer', inline: true },
          { name: 'Erstellt', value: m.created_at ? new Date(m.created_at).toLocaleDateString('de-CH') : '-', inline: true },
        )
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      await interaction.reply({ content: `❌ Fehler: ${err.message}`, ephemeral: true });
    }
  }

  if (interaction.commandName === 'inspect') {
    if (!dbPool) {
      await interaction.reply({ content: '❌ Keine Datenbankverbindung.', ephemeral: true });
      return;
    }
    try {
      const gemeindeName = interaction.options.getString('gemeinde');
      let whereClause = '';
      let params = [];
      if (gemeindeName) {
        whereClause = 'AND (m.name LIKE ? OR m.slug LIKE ?)';
        params = [`%${gemeindeName}%`, `%${gemeindeName}%`];
      }
      const [rows] = await dbPool.query(
        `SELECT me.id, me.severity, me.status, me.spawned_at, me.location_x, me.location_y,
                et.name, et.emoji, et.category, m.name AS municipality_name
         FROM municipality_events me
         JOIN event_types et ON et.id = me.event_type_id
         JOIN municipalities m ON m.id = me.municipality_id
         WHERE me.status IN ('detected','reported','assigned') ${whereClause}
         ORDER BY me.severity DESC
         LIMIT 15`,
        params
      );
      if (!rows.length) {
        await interaction.reply({ content: '✅ Keine aktiven Bünzli-Events gefunden.', ephemeral: true });
        return;
      }
      const lines = rows.map(r => {
        const severity = '⭐'.repeat(r.severity);
        const status = r.status === 'detected' ? '🔴' : r.status === 'reported' ? '🟡' : '🔵';
        return `${status} ${r.emoji} **${r.name}** ${severity}\n　↳ ${r.municipality_name} · (${r.location_x || '?'}, ${r.location_y || '?'})`;
      });
      const embed = new EmbedBuilder()
        .setTitle(`🕵️ Bünzli-Übersicht (${rows.length} Events)`)
        .setColor(EMBED_COLORS.buenzli_report || 0xFFA500)
        .setDescription(lines.join('\n'))
        .setFooter({ text: '🔴 Aktiv · 🟡 Gemeldet · 🔵 In Bearbeitung' })
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      await interaction.reply({ content: `❌ Fehler: ${err.message}`, ephemeral: true });
    }
  }

  if (interaction.commandName === 'events') {
    const count = interaction.options.getInteger('anzahl') || 5;
    if (!dbPool) {
      await interaction.reply({ content: '❌ Keine Datenbankverbindung.', ephemeral: true });
      return;
    }
    try {
      const [rows] = await dbPool.query(
        `SELECT n.*, u.nickname
         FROM user_notifications n
         LEFT JOIN users u ON u.id = n.user_id
         ORDER BY n.id DESC
         LIMIT ?`,
        [count]
      );
      if (!rows.length) {
        await interaction.reply({ content: 'Keine Events gefunden.', ephemeral: true });
        return;
      }
      const lines = rows.map(r => {
        const time = r.created_at ? new Date(r.created_at).toLocaleString('de-CH') : '?';
        return `**${r.title}** — ${r.message} _(${time})_`;
      });
      const embed = new EmbedBuilder()
        .setTitle(`📋 Letzte ${rows.length} Events`)
        .setColor(EMBED_COLORS.info)
        .setDescription(lines.join('\n\n'))
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      await interaction.reply({ content: `❌ Fehler: ${err.message}`, ephemeral: true });
    }
  }
});

// ─── Bot Start ───────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`[DISCORD] Bot eingeloggt als ${client.user.tag}`);
  isReady = true;
  await registerCommands();
  await initDatabase();

  // Starte Polling-Schleife
  setInterval(pollNotifications, POLL_INTERVAL);

  console.log('[BOT] MeinOrt Discord Bot ist bereit!');
  console.log(`[BOT] Benachrichtigungen gehen an Channel: ${DISCORD_CHANNEL_ID}`);
});

// Fehlerbehandlung
client.on('error', (err) => {
  console.error('[DISCORD] Client-Fehler:', err.message);
});

process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED]', err);
});

// Starte alles
startWebhookServer();
client.login(DISCORD_TOKEN);
