'use strict';

const {
  MUNICIPALITY_ROLE_OWNER,
  MUNICIPALITY_ROLE_COUNCIL,
  MUNICIPALITY_ROLE_CITIZEN,
  MUNICIPALITY_ROLE_OBSERVER,
  MUNICIPALITY_ROLE_HIERARCHY,
  GLOBAL_ROLE_USER,
  GLOBAL_ROLE_MODERATOR,
  GLOBAL_ROLE_ADMINISTRATOR,
} = require('../config/constants');

function municipalityRoleRank(role) {
  const idx = MUNICIPALITY_ROLE_HIERARCHY.indexOf(role);
  return idx >= 0 ? idx : 999;
}

function canBuildInMunicipality(role) {
  return role === MUNICIPALITY_ROLE_OWNER || role === MUNICIPALITY_ROLE_COUNCIL || role === MUNICIPALITY_ROLE_CITIZEN;
}

function canManageMunicipality(role) {
  return role === MUNICIPALITY_ROLE_OWNER || role === MUNICIPALITY_ROLE_COUNCIL;
}

function canInviteToMunicipality(role) {
  return role === MUNICIPALITY_ROLE_OWNER || role === MUNICIPALITY_ROLE_COUNCIL;
}

function canManageBauzones(role) {
  return role === MUNICIPALITY_ROLE_OWNER || role === MUNICIPALITY_ROLE_COUNCIL;
}

/**
 * Returns true if the given role must follow bauzone restrictions under the given mode.
 * @param {string} role  - municipality role (owner, council, citizen, observer)
 * @param {string} mode  - 'disabled' | 'members' | 'all'
 */
function shouldEnforceBauzone(role, mode) {
  if (!mode || mode === 'disabled') return false;
  if (mode === 'members') return role === MUNICIPALITY_ROLE_CITIZEN;
  if (mode === 'all') return role !== MUNICIPALITY_ROLE_OWNER;
  return false;
}

function normalizeMunicipalityRole(role) {
  const value = String(role || '').trim().toLowerCase();
  if (value === MUNICIPALITY_ROLE_OWNER) return MUNICIPALITY_ROLE_OWNER;
  if (value === MUNICIPALITY_ROLE_COUNCIL || value === 'admin') return MUNICIPALITY_ROLE_COUNCIL;
  if (value === MUNICIPALITY_ROLE_OBSERVER) return MUNICIPALITY_ROLE_OBSERVER;
  return MUNICIPALITY_ROLE_CITIZEN;
}

function normalizeGlobalRole(role) {
  const value = String(role || '').trim().toLowerCase();
  if (value === GLOBAL_ROLE_ADMINISTRATOR) return GLOBAL_ROLE_ADMINISTRATOR;
  if (value === GLOBAL_ROLE_MODERATOR) return GLOBAL_ROLE_MODERATOR;
  return GLOBAL_ROLE_USER;
}

function globalRoleFromUserRank(rankValue) {
  const rank = Math.max(0, Math.round(Number(rankValue || 0)));
  if (rank >= 7) return GLOBAL_ROLE_ADMINISTRATOR;
  if (rank >= 6) return GLOBAL_ROLE_MODERATOR;
  return GLOBAL_ROLE_USER;
}

module.exports = {
  municipalityRoleRank,
  canBuildInMunicipality,
  canManageMunicipality,
  canManageBauzones,
  shouldEnforceBauzone,
  canInviteToMunicipality,
  normalizeMunicipalityRole,
  normalizeGlobalRole,
  globalRoleFromUserRank,
};
