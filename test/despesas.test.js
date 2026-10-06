'use strict';
process.env.DB_PATH = ':memory:';
process.env.COLABORADORES = 'Ana,Bruno';
delete process.env.GOOGLE_MAPS_API_KEY;
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('../server');
const { NOTAS_DIR } = require('../lib/db');

let srv, base;
before(async () => { await new Promise((r) => { srv = app.listen(0, () => { base = `http://127.0.0.1:${srv.address().port}`; r(); }); }); });
after(() => srv.close());
const j = async (p, opt) => { const r = await fetch(base + p, { headers: { 'Content-Type': 'application/json' }, ...opt }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
// PNG 1x1 válido
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('tipos de despesa', async () => {
  const r = await j('/api/despesas/tipos');
  assert.equal(r.body.estacionamento, 'Estacionamento'); assert.ok(r.body.transporte);
});

test('validações da despesa', async () => {
  let r = await j('/api/despesas', { method: 'POST', body: JSON.stringify({ colaborador_id: 1, data: '2026-10-06', tipo: 'xyz', descricao: 'x', valor: 10 }) });
  assert.equal(r.status, 400);
  r = await j('/api/despesas', { method: 'POST', body: JSON.stringify({ colaborador_id: 1, data: '2026-10-06', tipo: 'outro', descricao: '', valor: 10 }) });
  assert.equal(r.status, 400);
  r = await j('/api/despesas', { method: 'POST', body: JSON.stringify({ colaborador_id: 1, data: '2026-10-06', tipo: 'outro', descricao: 'x', valor: '0' }) });
  assert.equal(r.status, 400);
  r = await j('/api/despesas', { method: 'POST', body: JSON.stringify({ colaborador_id: 1, data: '06/10/2026', tipo: 'outro', descricao: 'x', valor: 10 }) });
  assert.equal(r.status, 400);
  r = await j('/api/despesas', { method: 'POST', body: JSON.stringify({ colaborador_id: 1, data: '2026-10-06', tipo: 'outro', descricao: 'x', valor: 10, nota: 'data:image/png;base64,AAAA' }) });
  assert.equal(r.status, 400); assert.match(r.body.erro, /imagem/);
});

test('cria despesa com foto, lista, serve a nota, aparece no relatório e no CSV, exclui', async () => {
  let r = await j('/api/despesas', { method: 'POST', body: JSON.stringify({ colaborador_id: 1, data: '2026-10-06', tipo: 'estacionamento', descricao: 'Visita cliente X', valor: '12,50', nota: PNG }) });
  assert.equal(r.status, 201); assert.equal(r.body.valor, 12.5); assert.equal(r.body.colaborador, 'Ana'); assert.ok(r.body.nota_arquivo);
  const id = r.body.id;
  assert.ok(fs.existsSync(path.join(NOTAS_DIR, r.body.nota_arquivo)));
  r = await j('/api/despesas', { method: 'POST', body: JSON.stringify({ colaborador_id: 2, data: '2026-10-05', tipo: 'alimentacao', descricao: 'Almoço em campo', valor: 40 }) });
  assert.equal(r.status, 201); assert.equal(r.body.nota_arquivo, null);

  r = await j('/api/despesas?de=2026-10-01&ate=2026-10-31');
  assert.equal(r.body.length, 2); assert.equal(r.body[0].id, id); // mais recente primeiro
  r = await j('/api/despesas?colaborador_id=2'); assert.equal(r.body.length, 1);

  const nota = await fetch(`${base}/api/despesas/${id}/nota`);
  assert.equal(nota.status, 200); assert.match(nota.headers.get('content-type'), /image\/png/);
  assert.equal((await fetch(`${base}/api/despesas/${id + 1}/nota`)).status, 404);

  r = await j('/api/relatorio?de=2026-10-01&ate=2026-10-31');
  assert.equal(r.body.total.despesas, 52.5); assert.equal(r.body.total.geral, 52.5); assert.equal(r.body.total.reembolso, 0);
  const ana = r.body.colaboradores.find((c) => c.colaborador === 'Ana');
  assert.equal(ana.despesas, 12.5); assert.equal(ana.total, 12.5); assert.equal(ana.viagens, 0);
  assert.equal(r.body.despesas[0].tem_nota, true); assert.equal(r.body.despesas[0].nota_arquivo, undefined);

  const csv = await (await fetch(`${base}/api/relatorio.csv?de=2026-10-01&ate=2026-10-31`)).text();
  assert.match(csv, /OUTRAS DESPESAS/); assert.match(csv, /"Ana";06\/10\/2026;"Estacionamento";"Visita cliente X";12,5;Sim/);
  assert.match(csv, /TOTAL GERAL A REEMBOLSAR;;;;52,5/);

  r = await j(`/api/despesas/${id}`, { method: 'DELETE' }); assert.equal(r.body.ok, true);
  await new Promise((res) => setTimeout(res, 100));
  r = await j('/api/despesas'); assert.equal(r.body.length, 1);
});

test('odômetro: validações antes do Google', async () => {
  const b = { origem: 'a', destino: 'b', data_hora: '2026-10-06T14:00' };
  let r = await j('/api/calcular', { method: 'POST', body: JSON.stringify({ ...b, km_saida: '100' }) });
  assert.equal(r.status, 400); assert.match(r.body.erro, /saída E chegada/);
  r = await j('/api/calcular', { method: 'POST', body: JSON.stringify({ ...b, km_saida: '100', km_chegada: '90' }) });
  assert.equal(r.status, 400); assert.match(r.body.erro, /maior/);
  r = await j('/api/calcular', { method: 'POST', body: JSON.stringify({ ...b, km_saida: 'abc', km_chegada: '90' }) });
  assert.equal(r.status, 400);
  r = await j('/api/calcular', { method: 'POST', body: JSON.stringify({ ...b, km_saida: '100', km_chegada: '130' }) });
  assert.equal(r.status, 503); // válido → segue para o Google, que não tem chave aqui
});
