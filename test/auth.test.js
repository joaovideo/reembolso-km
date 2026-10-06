'use strict';
process.env.DB_PATH = ':memory:';
process.env.APP_USER = 'equipe';
process.env.APP_PASS = 'segredo:com:dois-pontos';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');

let srv, base;
before(async () => { await new Promise((r) => { srv = app.listen(0, () => { base = `http://127.0.0.1:${srv.address().port}`; r(); }); }); });
after(() => srv.close());
const auth = (u, p) => ({ Authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') });

test('sem senha → 401 com WWW-Authenticate', async () => {
  const r = await fetch(base + '/api/status');
  assert.equal(r.status, 401); assert.match(r.headers.get('www-authenticate'), /Basic/);
  assert.equal((await fetch(base + '/')).status, 401);
});
test('senha errada → 401', async () => {
  assert.equal((await fetch(base + '/api/status', { headers: auth('equipe', 'errada') })).status, 401);
  assert.equal((await fetch(base + '/api/status', { headers: auth('outro', 'segredo:com:dois-pontos') })).status, 401);
});
test('senha certa (com dois-pontos) → 200', async () => {
  const r = await fetch(base + '/api/status', { headers: auth('equipe', 'segredo:com:dois-pontos') });
  assert.equal(r.status, 200); assert.equal((await r.json()).ok, true);
});
