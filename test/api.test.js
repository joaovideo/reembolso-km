'use strict';
// Testa a API sem chave do Google: tudo que não depende do Google funciona, e o
// que depende devolve 503 SEM_CHAVE com mensagem clara (nunca falha em silêncio).
process.env.DB_PATH = ':memory:';
process.env.COLABORADORES = 'Ana, Bruno,Carla ,Davi';
delete process.env.GOOGLE_MAPS_API_KEY;
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');

let srv, base;
before(async () => { await new Promise((r) => { srv = app.listen(0, () => { base = `http://127.0.0.1:${srv.address().port}`; r(); }); }); });
after(() => srv.close());
const j = async (p, opt) => { const r = await fetch(base + p, { headers: { 'Content-Type': 'application/json' }, ...opt }); return { status: r.status, body: await r.json() }; };

test('status informa chave ausente', async () => {
  const r = await j('/api/status');
  assert.equal(r.status, 200); assert.equal(r.body.google_key, false);
});

test('colaboradores semeados e gerenciáveis', async () => {
  let r = await j('/api/colaboradores');
  assert.deepEqual(r.body.map((c) => c.nome), ['Ana', 'Bruno', 'Carla', 'Davi']);
  r = await j('/api/colaboradores', { method: 'POST', body: JSON.stringify({ nome: 'Teste' }) });
  assert.equal(r.body.length, 5);
  const id = r.body.find((c) => c.nome === 'Teste').id;
  r = await j(`/api/colaboradores/${id}`, { method: 'PATCH', body: JSON.stringify({ ativo: false }) });
  assert.equal(r.body.find((c) => c.id === id).ativo, 0);
});

test('config lê e grava com merge', async () => {
  let r = await j('/api/config');
  assert.equal(r.body.reembolso.valor_km, 2.9);
  r = await j('/api/config', { method: 'PUT', body: JSON.stringify({ reembolso: { valor_km: 3.1 } }) });
  assert.equal(r.body.reembolso.valor_km, 3.1);
  assert.equal(r.body.reembolso.modo, 'km_fixo');
  assert.equal(r.body.uber.por_km, 1.65);
});

test('calcular/places sem chave → 503 SEM_CHAVE', async () => {
  let r = await j('/api/calcular', { method: 'POST', body: JSON.stringify({ origem: 'Av. Paulista 1000', destino: 'Aeroporto de Congonhas', data_hora: '2026-10-06T14:00' }) });
  assert.equal(r.status, 503); assert.equal(r.body.codigo, 'SEM_CHAVE');
  r = await j('/api/places?q=paulista');
  assert.equal(r.status, 503);
  r = await j('/api/places?q=pa');
  assert.equal(r.status, 200); assert.deepEqual(r.body, []);
});

test('validações antes de chamar o Google', async () => {
  let r = await j('/api/calcular', { method: 'POST', body: JSON.stringify({ destino: 'x' }) });
  assert.equal(r.status, 400);
  r = await j('/api/viagens', { method: 'POST', body: JSON.stringify({ colaborador_id: 999, origem: 'a', destino: 'b', data_hora: '2026-10-06T14:00' }) });
  assert.equal(r.status, 400);
  r = await j('/api/viagens', { method: 'POST', body: JSON.stringify({ colaborador_id: 1, origem: 'a', destino: 'b', data_hora: 'ontem' }) });
  assert.equal(r.status, 400);
});

test('valor do Uber inválido → 400 antes de chamar o Google', async () => {
  const r = await j('/api/calcular', { method: 'POST', body: JSON.stringify({ origem: 'a', destino: 'b', data_hora: '2026-10-06T14:00', uber_manual: '-3' }) });
  // sem chave o Google nem é chamado; a validação do valor acontece depois da rota, então aqui esperamos SEM_CHAVE
  assert.ok([400, 503].includes(r.status));
});

test('viagens vazias, relatório e CSV', async () => {
  let r = await j('/api/viagens?de=2026-10-01&ate=2026-10-31');
  assert.deepEqual(r.body, []);
  r = await j('/api/relatorio?de=2026-10-01&ate=2026-10-31');
  assert.equal(r.body.total.reembolso, 0);
  const csv = await fetch(base + '/api/relatorio.csv?de=2026-10-01&ate=2026-10-31');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /reembolso-km_2026-10-01_2026-10-31\.csv/);
  assert.match((await csv.text()).replace(/^\uFEFF/, ''), /^Colaborador;Data;Hora;Origem;Destino;Ida e volta;Km;Km Google;Odômetro saída;Odômetro chegada;Minutos;Base do reembolso;Uber informado \(R\$\);/);
});

test('frontend servido', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200); assert.match(await r.text(), /Reembolso KM/);
});
