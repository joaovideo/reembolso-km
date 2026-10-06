'use strict';
const path = require('node:path');
const express = require('express');
const { db, config, salvarConfig, DB_PATH } = require('./lib/db');
const google = require('./lib/google');
const T = require('./lib/tarifas');

const app = express();
app.set('trust proxy', (process.env.TRUSTED_PROXIES || '').split(',').map((x) => x.trim()).filter(Boolean));

// Senha única de acesso (Basic Auth), ligada quando APP_USER e APP_PASS existem no .env.
// Sem as duas variáveis o app fica aberto (uso local).
const AUTH_USER = process.env.APP_USER || '';
const AUTH_PASS = process.env.APP_PASS || '';
if (AUTH_USER && AUTH_PASS) {
  const { timingSafeEqual } = require('node:crypto');
  const igual = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
  app.use((req, res, next) => {
    const h = req.headers.authorization || '';
    if (h.startsWith('Basic ')) {
      const [u, ...p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
      if (igual(u || '', AUTH_USER) && igual(p.join(':'), AUTH_PASS)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Reembolso KM", charset="UTF-8"');
    res.status(401).send('Acesso restrito');
  });
}
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const log = (...a) => console.log(new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }), ...a);

// 'YYYY-MM-DDTHH:MM' local → Date
function parseLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- status / colaboradores / config ----------
app.get('/api/status', (req, res) => {
  res.json({ ok: true, google_key: google.temChave(), db: DB_PATH, versao: require('./package.json').version });
});

app.get('/api/colaboradores', (req, res) => {
  res.json(db.prepare('SELECT id, nome, ativo FROM colaboradores ORDER BY nome').all());
});

app.post('/api/colaboradores', (req, res) => {
  const nome = String(req.body?.nome || '').trim();
  if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
  db.prepare('INSERT INTO colaboradores (nome) VALUES (?) ON CONFLICT(nome) DO UPDATE SET ativo = 1').run(nome);
  res.json(db.prepare('SELECT id, nome, ativo FROM colaboradores ORDER BY nome').all());
});

app.patch('/api/colaboradores/:id', (req, res) => {
  const ativo = req.body?.ativo ? 1 : 0;
  db.prepare('UPDATE colaboradores SET ativo = ? WHERE id = ?').run(ativo, Number(req.params.id));
  res.json(db.prepare('SELECT id, nome, ativo FROM colaboradores ORDER BY nome').all());
});

app.get('/api/config', (req, res) => res.json(config()));
app.put('/api/config', (req, res) => {
  const cfg = salvarConfig(req.body || {});
  log('config alterada', JSON.stringify(req.body));
  res.json(cfg);
});

// ---------- Google ----------
app.get('/api/places', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.json([]);
  res.json(await google.autocomplete(q, req.query.session ? String(req.query.session) : undefined));
}));

// Calcula a rota (e a volta, se pedido) e devolve km, tempo e estimativas, sem gravar.
async function calcular(body) {
  const cfg = config();
  const date = parseLocal(body.data_hora) || new Date();
  const origem = { endereco: String(body.origem || '').trim(), place_id: body.origem_place_id || null };
  const destino = { endereco: String(body.destino || '').trim(), place_id: body.destino_place_id || null };
  if (!origem.endereco && !origem.place_id) throw Object.assign(new Error('Informe a origem'), { status: 400 });
  if (!destino.endereco && !destino.place_id) throw Object.assign(new Error('Informe o destino'), { status: 400 });

  const ida = await google.rota(origem, destino, date);
  let volta = null;
  if (body.ida_volta) volta = await google.rota(destino, origem, null);

  const km = Math.round((ida.km + (volta?.km || 0)) * 100) / 100;
  const minutos = ida.minutos + (volta?.minutos || 0);
  const base = { km, minutos, date };

  const uber = T.estimarUber(base, cfg.uber);
  const taxi = T.estimarTaxi(base, cfg.taxi);
  let reembolso = T.calcularReembolso(base, cfg.reembolso, cfg.uber);
  if (body.uber_manual != null && String(body.uber_manual).trim() !== '') {
    const manual = T.reembolsoUberManual(String(body.uber_manual).replace(',', '.'), body.ida_volta, km);
    if (!manual) throw Object.assign(new Error('Valor do Uber inválido: informe um número maior que zero'), { status: 400 });
    reembolso = manual;
  }
  return {
    km, minutos, ida_volta: body.ida_volta ? 1 : 0,
    km_ida: ida.km, km_volta: volta?.km ?? null,
    polyline: ida.polyline, polyline_volta: volta?.polyline || null,
    descricao: ida.descricao,
    reembolso, uber, taxi,
    uber_manual: reembolso.uber_manual ?? null,
    // Uber "fora de pico" sempre, para comparação
    uber_fora_pico: T.estimarUber(base, cfg.uber, 1.0).valor,
  };
}

app.post('/api/calcular', wrap(async (req, res) => {
  const r = await calcular(req.body || {});
  log(`calcular ${r.km} km ${r.minutos} min "${req.body.origem}" → "${req.body.destino}"${req.body.ida_volta ? ' (ida e volta)' : ''}${r.uber_manual ? ` uber informado R$ ${r.uber_manual}` : ''} → reembolso R$ ${r.reembolso.valor} (${r.reembolso.modo})`);
  res.json(r);
}));

// ---------- viagens ----------
const SEL = `SELECT v.*, c.nome AS colaborador FROM viagens v JOIN colaboradores c ON c.id = v.colaborador_id`;

function filtro(q) {
  const where = []; const params = [];
  if (q.de) { where.push("v.data_hora >= ?"); params.push(`${q.de}T00:00`); }
  if (q.ate) { where.push("v.data_hora <= ?"); params.push(`${q.ate}T23:59`); }
  if (q.colaborador_id) { where.push('v.colaborador_id = ?'); params.push(Number(q.colaborador_id)); }
  return { sql: where.length ? ' WHERE ' + where.join(' AND ') : '', params };
}

app.get('/api/viagens', (req, res) => {
  const f = filtro(req.query);
  res.json(db.prepare(`${SEL}${f.sql} ORDER BY v.data_hora DESC, v.id DESC`).all(...f.params));
});

app.post('/api/viagens', wrap(async (req, res) => {
  const b = req.body || {};
  const colab = db.prepare('SELECT id FROM colaboradores WHERE id = ? AND ativo = 1').get(Number(b.colaborador_id));
  if (!colab) return res.status(400).json({ erro: 'Selecione o colaborador' });
  if (!parseLocal(b.data_hora)) return res.status(400).json({ erro: 'Data/hora inválida' });

  // Recalcula no servidor: o cliente nunca manda km/valores.
  const r = await calcular(b);
  const info = db.prepare(`INSERT INTO viagens
    (colaborador_id, data_hora, origem, destino, origem_place_id, destino_place_id, ida_volta, km, minutos,
     polyline, polyline_volta, modo_reembolso, valor_km, reembolso, uber_estimado, uber_faixa, taxi_estimado, taxi_bandeira, uber_manual, observacao)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    colab.id, b.data_hora.slice(0, 16), String(b.origem).trim(), String(b.destino).trim(),
    b.origem_place_id || null, b.destino_place_id || null, r.ida_volta, r.km, r.minutos,
    r.polyline, r.polyline_volta, r.reembolso.modo, r.reembolso.valor_km, r.reembolso.valor,
    r.uber.valor, r.uber.faixa, r.taxi.valor, r.taxi.bandeira, r.uber_manual, b.observacao ? String(b.observacao).trim() : null,
  );
  const v = db.prepare(`${SEL} WHERE v.id = ?`).get(info.lastInsertRowid);
  log(`viagem #${v.id} ${v.colaborador} ${v.data_hora} ${v.km} km R$ ${v.reembolso} (${v.modo_reembolso}${v.uber_manual ? ` uber R$ ${v.uber_manual}` : ''})`);
  res.status(201).json(v);
}));

app.delete('/api/viagens/:id', (req, res) => {
  const r = db.prepare('DELETE FROM viagens WHERE id = ?').run(Number(req.params.id));
  log(`viagem #${req.params.id} excluída`);
  res.json({ ok: r.changes > 0 });
});

// ---------- relatório ----------
function relatorio(q) {
  const f = filtro(q);
  const viagens = db.prepare(`${SEL}${f.sql} ORDER BY c.nome, v.data_hora`).all(...f.params);
  const porColab = db.prepare(`SELECT c.id, c.nome AS colaborador, COUNT(*) AS viagens, ROUND(SUM(v.km), 2) AS km,
      ROUND(SUM(v.reembolso), 2) AS reembolso, ROUND(SUM(v.uber_estimado), 2) AS uber, ROUND(SUM(v.taxi_estimado), 2) AS taxi
    FROM viagens v JOIN colaboradores c ON c.id = v.colaborador_id${f.sql} GROUP BY c.id ORDER BY c.nome`).all(...f.params);
  const total = porColab.reduce((a, r) => ({
    viagens: a.viagens + r.viagens, km: a.km + r.km, reembolso: a.reembolso + r.reembolso, uber: a.uber + r.uber, taxi: a.taxi + r.taxi,
  }), { viagens: 0, km: 0, reembolso: 0, uber: 0, taxi: 0 });
  for (const k of ['km', 'reembolso', 'uber', 'taxi']) total[k] = Math.round(total[k] * 100) / 100;
  return { periodo: { de: q.de || null, ate: q.ate || null }, colaboradores: porColab, total, viagens };
}

app.get('/api/relatorio', (req, res) => res.json(relatorio(req.query)));

const BASE = { km_fixo: 'R$/km fixo', uber_fora_pico: 'UberX fora de pico (estimado)', uber_manual: 'Uber informado' };

app.get('/api/relatorio.csv', (req, res) => {
  const r = relatorio(req.query);
  const num = (x) => (x == null ? '' : String(x).replace('.', ','));
  const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const linhas = [
    ['Colaborador', 'Data', 'Hora', 'Origem', 'Destino', 'Ida e volta', 'Km', 'Minutos', 'Base do reembolso', 'Uber informado (R$)', 'R$/km', 'Reembolso (R$)', 'Uber est. (R$)', 'Faixa Uber', 'Táxi est. (R$)', 'Bandeira', 'Observação'].join(';'),
    ...r.viagens.map((v) => [
      esc(v.colaborador), v.data_hora.slice(0, 10).split('-').reverse().join('/'), v.data_hora.slice(11, 16),
      esc(v.origem), esc(v.destino), v.ida_volta ? 'Sim' : 'Não', num(v.km), v.minutos, BASE[v.modo_reembolso] || v.modo_reembolso, num(v.uber_manual), num(v.valor_km), num(v.reembolso),
      num(v.uber_estimado), esc(v.uber_faixa), num(v.taxi_estimado), v.taxi_bandeira, esc(v.observacao),
    ].join(';')),
    '',
    ['TOTAL', '', '', '', '', '', num(r.total.km), '', '', '', '', num(r.total.reembolso), num(r.total.uber), '', num(r.total.taxi), '', ''].join(';'),
  ];
  const nome = `reembolso-km_${r.periodo.de || 'inicio'}_${r.periodo.ate || 'hoje'}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
  res.send('﻿' + linhas.join('\r\n'));
});

// ---------- erros ----------
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  log(`ERRO ${status} ${req.method} ${req.url}: ${err.message}`, err.detalhe ? JSON.stringify(err.detalhe) : '');
  res.status(status).json({ erro: err.message, codigo: err.code || null });
});

if (require.main === module) {
  const PORT = Number(process.env.PORT || 3080);
  app.listen(PORT, () => log(`Reembolso KM na porta ${PORT} — chave Google: ${google.temChave() ? 'OK' : 'FALTANDO (veja .env.example)'} — senha: ${AUTH_USER && AUTH_PASS ? 'ligada' : 'DESLIGADA (defina APP_USER/APP_PASS)'} — banco: ${DB_PATH}`));
}

module.exports = { app, calcular };
