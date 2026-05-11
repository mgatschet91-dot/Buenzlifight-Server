'use strict';

const registerManagementRoutes = require('./management');
const registerContractRoutes = require('./contracts');
const registerWorkTaskRoutes = require('./workTasks');
const registerLoanRoutes = require('./loans');
const registerBusLineRoutes = require('./busLines');
const registerNpcBotRoutes = require('./npcBots');
const registerParkingKontrolleRoutes = require('./parkingKontrolle');

module.exports = function registerCompaniesRoutes(deps) {
  const handlers = [
    registerLoanRoutes(deps),
    registerBusLineRoutes(deps),
    registerManagementRoutes(deps),
    registerContractRoutes(deps),
    registerWorkTaskRoutes(deps),
    registerNpcBotRoutes(deps),
    registerParkingKontrolleRoutes(deps),
  ];

  return async function handleCompanies(req, res, pathname, requestUrl) {
    for (const handler of handlers) {
      await handler(req, res, pathname, requestUrl);
      if (res.headersSent) return;
    }
  };
};
