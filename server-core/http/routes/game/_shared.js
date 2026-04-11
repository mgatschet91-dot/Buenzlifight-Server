'use strict';

const { GLOBAL_ROLE_ADMINISTRATOR } = require('../../../config/constants');

function isGlobalAdmin(authUser) {
  return String(authUser?.global_role || '').toLowerCase() === GLOBAL_ROLE_ADMINISTRATOR;
}

module.exports = { isGlobalAdmin };
