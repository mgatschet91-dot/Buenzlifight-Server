'use strict';

const createUsersHandler  = require('./users');
const createEventsHandler = require('./events');
const createContentHandler = require('./content');
const createSystemHandler = require('./system');

module.exports = function registerAdminRoutes(deps) {
  const handleUsers   = createUsersHandler(deps);
  const handleEvents  = createEventsHandler(deps);
  const handleContent = createContentHandler(deps);
  const handleSystem  = createSystemHandler(deps);

  return async function handleAdmin(req, res, pathname, requestUrl) {
    await handleUsers(req, res, pathname, requestUrl);
    if (res.headersSent) return;
    await handleEvents(req, res, pathname, requestUrl);
    if (res.headersSent) return;
    await handleContent(req, res, pathname, requestUrl);
    if (res.headersSent) return;
    await handleSystem(req, res, pathname, requestUrl);
  };
};
