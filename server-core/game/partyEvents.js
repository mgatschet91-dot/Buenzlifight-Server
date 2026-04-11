'use strict';

const { dbPool, ensureDbEnabled } = require('../infra/db');
const { debitUserBankAccount } = require('./userBanking');
const { logInfo, logError } = require('../infra/logger');

// Polizei-Intervall in Minuten basierend auf Tageszeit (echte Serverzeit)
function getPoliceIntervalMinutes() {
  const hour = new Date().getHours();
  if (hour >= 8 && hour < 18) return 20;  // Tag: alle 20 Min
  if (hour >= 18 && hour < 22) return 10; // Abend: alle 10 Min
  return 5;                               // Nacht (22-8): alle 5 Min (Ruhestörung!)
}

// Bussenhöhe skaliert mit Anzahl Polizeibesuche
function getFineAmount(policeVisits) {
  const fines = [150, 300, 600, 1200];
  return fines[Math.min(policeVisits, fines.length - 1)];
}

async function startParty(userId, municipalityId, tileX, tileY, roomCode) {
  ensureDbEnabled();
  const [existing] = await dbPool.query(
    `SELECT id FROM mansion_parties
     WHERE owner_id = ? AND room_code = ? AND status NOT IN ('shutdown','ended')
     LIMIT 1`,
    [userId, roomCode]
  );
  if (existing.length > 0) {
    throw new Error('Du hast bereits eine aktive Party');
  }
  await dbPool.query(
    `INSERT INTO mansion_parties
       (municipality_id, owner_id, tile_x, tile_y, room_code, started_at, last_warning_at)
     VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
    [municipalityId, userId, tileX, tileY, roomCode]
  );
  logInfo('PARTY', `Party gestartet: user=${userId} tile=${tileX},${tileY} room=${roomCode}`);
}

async function stopParty(partyId, userId) {
  ensureDbEnabled();
  const [result] = await dbPool.query(
    `UPDATE mansion_parties SET status = 'ended'
     WHERE id = ? AND owner_id = ? AND status NOT IN ('shutdown','ended')`,
    [partyId, userId]
  );
  if (result.affectedRows === 0) {
    throw new Error('Party nicht gefunden oder bereits beendet');
  }
  logInfo('PARTY', `Party manuell beendet: id=${partyId} user=${userId}`);
}

async function getActivePartiesForRoom(roomCode) {
  ensureDbEnabled();
  const [rows] = await dbPool.query(
    `SELECT id, tile_x, tile_y, status, police_visits, started_at, owner_id
     FROM mansion_parties
     WHERE room_code = ? AND status NOT IN ('shutdown','ended')`,
    [roomCode]
  );
  return rows.map(p => ({
    id: p.id,
    tileX: p.tile_x,
    tileY: p.tile_y,
    status: p.status,
    policeVisits: p.police_visits,
    durationMinutes: (Date.now() - new Date(p.started_at).getTime()) / 60000,
    ownerUserId: p.owner_id,
  }));
}

// roomKey  = voller Socket.IO Key ("slug:MAIN") für io.to()
// roomCode = roher DB-Wert ("MAIN") für SQL-Abfragen
async function runPartyTick(roomKey, io, roomCode) {
  ensureDbEnabled();

  // Falls kein separater roomCode übergeben: aus roomKey extrahieren (nach dem ersten ':')
  const dbRoomCode = roomCode || (roomKey.includes(':') ? roomKey.split(':').slice(1).join(':') : roomKey);

  // Alle aktiven Parties in diesem Room laden
  const [parties] = await dbPool.query(
    `SELECT * FROM mansion_parties
     WHERE room_code = ? AND status NOT IN ('shutdown','ended')`,
    [dbRoomCode]
  );

  if (parties.length === 0) return;

  const intervalMin = getPoliceIntervalMinutes();

  for (const party of parties) {
    const minSinceLastWarning =
      (Date.now() - new Date(party.last_warning_at).getTime()) / 60000;

    if (minSinceLastWarning < intervalMin) continue;

    const newVisits  = party.police_visits + 1;
    const fineAmount = getFineAmount(party.police_visits);
    let isShutdown   = newVisits >= 4;
    let fineDebited  = false;
    let shutdownReason = null;   // 'visits' | 'no_money' | null

    try {
      await debitUserBankAccount(party.owner_id, {
        amount: fineAmount,
        type: 'party_fine',
        description: `Party-Lärmbusse (${newVisits}. Polizeibesuch)`,
      });
      fineDebited = true;
    } catch (err) {
      if (err?.code === 'INSUFFICIENT_BALANCE') {
        // Kein Geld → Party sofort schliessen
        isShutdown     = true;
        shutdownReason = 'no_money';
        logInfo('PARTY', `Party ${party.id} geschlossen: zu wenig Geld (user=${party.owner_id}, nötig=${fineAmount}, vorhanden=${err.currentBalance ?? '?'})`);
      } else {
        logError('PARTY', `Busse konnte nicht abgezogen werden: user=${party.owner_id}`, { error: err?.message });
      }
    }

    const newStatus = isShutdown ? 'shutdown' : `warning_${Math.min(newVisits, 3)}`;
    const fineForDb = fineDebited ? fineAmount : 0;   // nur wirklich abgebuchten Betrag in total_fines

    await dbPool.query(
      `UPDATE mansion_parties
       SET police_visits = ?, status = ?, total_fines = total_fines + ?,
           last_warning_at = NOW()
       WHERE id = ?`,
      [newVisits, newStatus, fineForDb, party.id]
    );

    logInfo('PARTY', `Polizeiwarnung ${newVisits} für party=${party.id}, Busse=${fineAmount} CHF (abgebucht=${fineDebited}), Status=${newStatus}`);

    io.to(roomKey).emit('party-police-warning', {
      partyId: party.id,
      tileX: party.tile_x,
      tileY: party.tile_y,
      warningNumber: newVisits,
      fineAmount: fineDebited ? fineAmount : 0,
      isShutdown,
      shutdownReason,   // 'no_money' → Client zeigt passende Meldung
      ownerUserId: party.owner_id,
    });
  }

  // Aktuellen State broadcasten (DB-Abfrage mit rawCode, Broadcast mit roomKey)
  const parties2 = await getActivePartiesForRoom(dbRoomCode);
  io.to(roomKey).emit('party-authoritative', {
    parties: parties2,
    serverTimestamp: Date.now(),
  });
}

module.exports = { startParty, stopParty, getActivePartiesForRoom, runPartyTick };
