'use strict';

// Rückwärts-kompatibler Re-Export für require('./municipality')

const core      = require('./core.js');
const elections = require('./elections.js');
const petitions = require('./petitions.js');
const uploads   = require('./uploads.js');
const chat      = require('./chat.js');

module.exports = {
  ...core,
  ...elections,
  ...petitions,
  ...uploads,
  ...chat,
};
