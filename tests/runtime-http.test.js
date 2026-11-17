const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../runtime/server.cjs');

test('HTTP adapter preserves handlers and exposes only approved static files', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-runtime-'));
  fs.mkdirSync(path.join(root, 'api/qr'), { recursive: true });
  fs.mkdirSync(path.join(root, 'api/_lib'));
  fs.mkdirSync(path.join(root, 'runtime'));
  fs.writeFileSync(path.join(root, 'runtime/static.json'), JSON.stringify(['index.html']));
  fs.writeFileSync(path.join(root, 'index.html'), 'public home');
  fs.writeFileSync(path.join(root, 'private.json'), '{"secret":true}');
  fs.writeFileSync(path.join(root, 'api/_lib/secret.js'), 'module.exports = () => { throw Error("must not execute"); };');
  fs.writeFileSync(path.join(root, 'api/echo.js'), 'module.exports = (req,res) => {res.setHeader("Set-Cookie", ["nf_token=a; HttpOnly; Path=/", "nf_refresh=b; Path=/api/auth"]); return res.status(201).json({query:req.query,body:req.body});};');
  fs.writeFileSync(path.join(root, 'api/qr/[token].js'), 'module.exports = (req,res) => res.redirect(302,"/destination/"+req.query.token);');
  fs.writeFileSync(path.join(root, 'api/raw.js'), 'module.exports = async (req,res) => {let n=0;for await(const c of req)n+=c.length;res.json({size:n});};');
  const server = http.createServer(createApp(root));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  for (const route of ['/', '/app-v2', '/app-v2.html', '/app-v2-v3']) {
    const r = await fetch(base + route); assert.equal(r.status, 200); assert.equal(await r.text(), 'public home');
  }
  for (const route of ['/private.json', '/runtime/static.json', '/api/_lib/secret', '/.env', '/api/unknown', '/%2eenv']) {
    const r = await fetch(base + route); assert.equal(r.status, 404, route); assert.match(r.headers.get('cache-control'), /no-store/);
  }
  const r = await fetch(base + '/api/echo?a=1&a=2&b=3', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"value":42}' });
  assert.equal(r.status, 201); assert.deepEqual(await r.json(), { query: { a: ['1','2'], b: '3' }, body: { value: 42 } });
  assert.equal(r.headers.getSetCookie().length, 2);
  assert.equal((await fetch(base + '/api/echo', {method:'POST',headers:{'Content-Type':'application/json'},body:'{'})).status, 400);
  assert.equal((await fetch(base + '/api/echo', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify('x'.repeat(1024*1024))})).status, 413);
  const redirect = await fetch(base + '/api/qr/example?token=wrong', {redirect:'manual'});
  assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), '/destination/example');
  const raw = await fetch(base + '/api/raw', {method:'POST',headers:{'Content-Type':'multipart/form-data; boundary=test'},body:'raw-body'});
  assert.deepEqual(await raw.json(), {size:8});
  const head = await fetch(base + '/', {method:'HEAD'}); assert.equal(await head.text(), ''); assert.equal(head.headers.get('content-length'), '11');
  assert.equal((await fetch(base + '/', {method:'POST'})).status, 405);
});
