'use strict';

const { sendJson } = require('../../../infra/http');
const { BUENZLI_EVENTS_ENABLED } = require('../../../config/constants');

const registerHealthRoutes = require('./health');
const registerBuildingTypesRoutes = require('./buildingTypes');
const registerPublicMapsRoutes = require('./publicMaps');
const registerUserDataRoutes = require('./userData');
const registerDeltasRoutes = require('./deltas');
const registerStatsRoutes = require('./stats');
const registerDisastersRoutes = require('./disasters');
const registerAchievementsRoutes = require('./achievements');
const registerInspectionsRoutes = require('./inspections');
const registerEventsRoutes = require('./events');
const registerItemsRoutes = require('./items');
const registerMapDataRoutes = require('./mapData');
const registerResidencesRoutes = require('./residences');
const registerMansionPartyRoutes = require('./mansionParty');
const registerRoomModelsRoutes = require('./roomModels');
const registerShopFurnitureRoutes = require('./shopFurniture');
const registerRoomFurnitureRoutes = require('./roomFurniture');
const registerAvatarCodeRoutes = require('./avatarCode');
const registerRoomLayoutRoutes = require('./roomLayout');
const registerRoomNpcRoutes = require('./roomNpcs');
const registerRoomModerationRoutes = require('./roomModeration');
const registerNavigatorHousesRoute = require('./navigatorHouses');

module.exports = function registerGameRoutes(deps) {
  const subHandlers = [
    registerHealthRoutes(deps),
    registerBuildingTypesRoutes(deps),
    registerPublicMapsRoutes(deps),
    registerUserDataRoutes(deps),
    registerDeltasRoutes(deps),
    registerStatsRoutes(deps),
    registerDisastersRoutes(deps),
    registerAchievementsRoutes(deps),
    registerResidencesRoutes(deps),
    registerMansionPartyRoutes(deps),
    registerRoomModelsRoutes(deps),
    registerShopFurnitureRoutes(deps),
    registerRoomFurnitureRoutes(deps),
    registerAvatarCodeRoutes(deps),
    registerRoomLayoutRoutes(deps),
    registerRoomNpcRoutes(deps),
    registerRoomModerationRoutes(deps),
    registerNavigatorHousesRoute(deps),
  ];

  const handleInspections = registerInspectionsRoutes(deps);
  const handleEvents = registerEventsRoutes(deps);
  const handleItems = registerItemsRoutes(deps);
  const handleMapData = registerMapDataRoutes(deps);

  return async function handleGame(req, res, pathname, requestUrl) {
    // Standard sub-handlers
    for (const handler of subHandlers) {
      await handler(req, res, pathname, requestUrl);
      if (res.headersSent) return;
    }

    // Buenzli feature-flag
    if (!BUENZLI_EVENTS_ENABLED && (pathname.startsWith('/api/events') || pathname.startsWith('/api/inspections'))) {
      return sendJson(res, 503, { ok: false, error: 'Bünzli Event-System ist deaktiviert' });
    }

    await handleInspections(req, res, pathname, requestUrl);
    if (res.headersSent) return;

    await handleEvents(req, res, pathname, requestUrl);
    if (res.headersSent) return;

    await handleItems(req, res, pathname, requestUrl);
    if (res.headersSent) return;

    await handleMapData(req, res, pathname, requestUrl);
  };
};
