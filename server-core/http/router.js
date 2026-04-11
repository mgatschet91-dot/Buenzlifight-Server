'use strict';

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const regex = typeof pattern === 'string'
      ? new RegExp(`^${pattern.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '(?<$1>[^/]+)')}$`)
      : pattern;
    this.routes.push({ method: method.toUpperCase(), regex, handler });
  }

  get(pattern, handler) { this.add('GET', pattern, handler); }
  post(pattern, handler) { this.add('POST', pattern, handler); }
  put(pattern, handler) { this.add('PUT', pattern, handler); }
  patch(pattern, handler) { this.add('PATCH', pattern, handler); }
  delete(pattern, handler) { this.add('DELETE', pattern, handler); }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      const m = pathname.match(route.regex);
      if (m) return { handler: route.handler, params: m.groups || {} };
    }
    return null;
  }
}

module.exports = { Router };
