'use strict';
// A small HTTP adapter for the existing Vercel Node handlers. Business logic
// and the authoritative storage remain unchanged during the application move.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { pipeline } = require('node:stream');

function createApp(root, options = {}) {
  root = fs.realpathSync(root);
  const files = new Set(JSON.parse(fs.readFileSync(path.join(root, 'runtime/static.json'))));
  const routes = [];
  function scan(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(full, prefix + '/' + entry.name);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        const route = prefix + '/' + entry.name.slice(0, -3);
        const keys = [];
        const expression = route.split('/').map(part => {
          if (/^\[\w+\]$/.test(part)) { keys.push(part.slice(1, -1)); return '([^/]+)'; }
          return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }).join('/');
        routes.push({ full, keys, match: new RegExp('^' + expression + '$') });
      }
    }
  }
  scan(path.join(root, 'api'), '/api');
  routes.sort((a, b) => a.keys.length - b.keys.length);
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
  return async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Cache-Control', 'private, no-store');
    res.status = code => { res.statusCode = code; return res; };
    res.json = value => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)); return res; };
    res.send = value => typeof value === 'object' ? res.json(value) : (res.end(String(value)), res);
    res.redirect = (status, target) => {
      if (typeof status === 'string') { target = status; status = 307; }
      res.statusCode = status; res.setHeader('Location', target); res.end(); return res;
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(p => p.startsWith('.'))) return res.status(404).end('Not Found');
      if (pathname === '/_runtime/health') return res.json({ status: 'ok', release: options.release || 'local', videoGeneration: process.env.VIDEO_GENERATION_ENABLED === 'false' ? 'disabled' : 'configured' });
      if (pathname.startsWith('/api/')) {
        const route = routes.find(r => r.match.test(pathname));
        if (!route) return res.status(404).end('Not Found');
        req.query = Object.create(null);
        for (const key of new Set(url.searchParams.keys())) {
          const values = url.searchParams.getAll(key); req.query[key] = values.length === 1 ? values[0] : values;
        }
        const matched = pathname.match(route.match);
        route.keys.forEach((key, index) => { req.query[key] = matched[index + 1]; });
        const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (contentType === 'application/json' || contentType === 'application/x-www-form-urlencoded') {
          let size = 0; const chunks = [];
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 1024 * 1024) return res.status(413).json({ error: 'Request too large' });
            chunks.push(chunk);
          }
          const body = Buffer.concat(chunks).toString('utf8');
          try { req.body = contentType === 'application/json' ? (body ? JSON.parse(body) : {}) : Object.fromEntries(new URLSearchParams(body)); }
          catch { return res.status(400).json({ error: 'Invalid JSON' }); }
        }
        const handler = require(route.full);
        await handler(req, res);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end('Method not allowed');
      let file = pathname.slice(1);
      if (['', 'app-v2', 'app-v2.html', 'app-v2-v3', 'app-v2-v3.html'].includes(file)) file = 'index.html';
      if (!files.has(file) && !path.extname(file) && files.has(file + '.html')) file += '.html';
      if (!files.has(file)) return res.status(404).end('Not Found');
      const full = fs.realpathSync(path.join(root, file));
      if (!full.startsWith(root + path.sep)) return res.status(404).end('Not Found');
      const stat = fs.statSync(full);
      res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      if (req.method === 'HEAD') return res.end();
      pipeline(fs.createReadStream(full), res, () => {});
    } catch (error) {
      // Never log request bodies, cookies, query strings, tokens or upstream URLs.
      console.error(JSON.stringify({ event: 'request_error', type: error.name, code: error.code || null }));
      if (!res.headersSent) res.status(error instanceof URIError ? 400 : 500).json({ error: 'Request failed' });
      else res.destroy();
    }
  };
}

if (require.main === module) {
  if (process.env.RUNTIME_ENV_FILE) {
    const env = JSON.parse(fs.readFileSync(process.env.RUNTIME_ENV_FILE));
    for (const [key, value] of Object.entries(env)) process.env[key] = String(value);
  }
  // Preserve Vercel production identity behavior until it is migrated separately.
  process.env.NODE_ENV = 'production'; process.env.VERCEL_ENV = 'production';
  process.env.VIDEO_GENERATION_ENABLED = 'false';
  const root = path.resolve(__dirname, '..');
  const buildFile = path.join(__dirname, 'build.json');
  const release = fs.existsSync(buildFile) ? JSON.parse(fs.readFileSync(buildFile)).release : process.env.RELEASE_SHA;
  const server = http.createServer(createApp(root, { release }));
  server.requestTimeout = 65000; server.headersTimeout = 15000;
  server.listen(Number(process.env.PORT || 4180), '127.0.0.1', () => console.log('NovelFlow runtime ready'));
  process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
}
module.exports = { createApp };
