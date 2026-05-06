'use strict';

const registerPartnershipRoutes = require('./partnerships');
const registerMunicipalityChatRoutes = require('./municipalityChat');
const registerGlobalChatRoutes = require('./globalChat');
const registerXpAndLevelRoutes = require('./xpAndLevel');
const registerReporterRoutes = require('./reporter');
const registerProfileRoutes = require('./profile');

module.exports = function registerSocialRoutes(deps) {
  const subHandlers = [
    registerPartnershipRoutes(deps),
    registerMunicipalityChatRoutes(deps),
    registerGlobalChatRoutes(deps),
    registerXpAndLevelRoutes(deps),
    registerReporterRoutes(deps),
    registerProfileRoutes(deps),
  ];

  return async function handleSocial(req, res, pathname, requestUrl) {
    for (const handler of subHandlers) {
      await handler(req, res, pathname, requestUrl);
      if (res.headersSent) return;
    }
  };
};
