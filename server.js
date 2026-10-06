'use strict';
const path = require('node:path');
const express = require('express');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { db, config, salvarConfig, DB_PATH, NOTAS_DIR } = require('./lib/db');
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
app.use(express.json({ limit: '8mb' })); // fotos de nota vêm em base64 (comprimidas no cliente)
// no-cache: o navegador revalida a cada carga, então a equipe recebe a versão nova logo após um deploy
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

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

function lerOdometro(body) {
  const vazio = (x) => x == null || String(x).trim() === '';
  if (vazio(body.km_saida) && vazio(body.km_chegada)) return null;
  if (vazio(body.km_saida) || vazio(body.km_chegada)) throw Object.assign(new Error('Odômetro: informe saída E chegada, ou deixe os dois vazios'), { status: 400 });
  const saida = Number(String(body.km_saida).replace(',', '.')), chegada = Number(String(body.km_chegada).replace(',', '.'));
  if (!Number.isFinite(saida) || !Number.isFinite(chegada) || saida < 0) throw Object.assign(new Error('Odômetro: valores inválidos'), { status: 400 });
  if (chegada <= saida) throw Object.assign(new Error('Odômetro: a chegada precisa ser maior que a saída'), { status: 400 });
  return { saida, chegada, km: Math.round((chegada - saida) * 100) / 100 };
}

// Calcula a rota (e a volta, se pedido) e devolve km, tempo e estimativas, sem gravar.
async function calcular(body) {
  const cfg = config();
  const date = parseLocal(body.data_hora) || new Date();
  const origem = { endereco: String(body.origem || '').trim(), place_id: body.origem_place_id || null };
  const destino = { endereco: String(body.destino || '').trim(), place_id: body.destino_place_id || null };
  if (!origem.endereco && !origem.place_id) throw Object.assign(new Error('Informe a origem'), { status: 400 });
  if (!destino.endereco && !destino.place_id) throw Object.assign(new Error('Informe o destino'), { status: 400 });

  const odo = lerOdometro(body); // valida antes de gastar consulta no Google
  const ida = await google.rota(origem, destino, date);
  let volta = null;
  if (body.ida_volta) volta = await google.rota(destino, origem, null);

  const kmGoogle = Math.round((ida.km + (volta?.km || 0)) * 100) / 100;
  const minutos = ida.minutos + (volta?.minutos || 0);
  // Odômetro do carro (opcional): se saída e chegada vierem, a distância real substitui a do Google no reembolso.
  const km = odo ? odo.km : kmGoogle;
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
    km_google: kmGoogle, km_saida: odo?.saida ?? null, km_chegada: odo?.chegada ?? null,
    aviso_odometro: odo && kmGoogle > 0 && (odo.km > kmGoogle * 2.5 || odo.km < kmGoogle / 2.5) ? `Odômetro (${odo.km} km) muito diferente da rota do Google (${kmGoogle} km). Confira os números.` : null,
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
     polyline, polyline_volta, modo_reembolso, valor_km, reembolso, uber_estimado, uber_faixa, taxi_estimado, taxi_bandeira, uber_manual, observacao,
     km_google, km_saida, km_chegada)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    colab.id, b.data_hora.slice(0, 16), String(b.origem).trim(), String(b.destino).trim(),
    b.origem_place_id || null, b.destino_place_id || null, r.ida_volta, r.km, r.minutos,
    r.polyline, r.polyline_volta, r.reembolso.modo, r.reembolso.valor_km, r.reembolso.valor,
    r.uber.valor, r.uber.faixa, r.taxi.valor, r.taxi.bandeira, r.uber_manual, b.observacao ? String(b.observacao).trim() : null,
    r.km_google, r.km_saida, r.km_chegada,
  );
  const v = db.prepare(`${SEL} WHERE v.id = ?`).get(info.lastInsertRowid);
  log(`viagem #${v.id} ${v.colaborador} ${v.data_hora} ${v.km} km${v.km_saida != null ? ` (odômetro ${v.km_saida}→${v.km_chegada}, Google ${v.km_google})` : ''} R$ ${v.reembolso} (${v.modo_reembolso}${v.uber_manual ? ` uber R$ ${v.uber_manual}` : ''})`);
  res.status(201).json(v);
}));

app.delete('/api/viagens/:id', (req, res) => {
  const r = db.prepare('DELETE FROM viagens WHERE id = ?').run(Number(req.params.id));
  log(`viagem #${req.params.id} excluída`);
  res.json({ ok: r.changes > 0 });
});

// ---------- despesas (outros custos) ----------
const TIPOS = { estacionamento: 'Estacionamento', combustivel: 'Combustível', alimentacao: 'Alimentação', transporte: 'Transporte', pedagio: 'Pedágio', outro: 'Outro' };
const SELD = `SELECT d.*, c.nome AS colaborador FROM despesas d JOIN colaboradores c ON c.id = d.colaborador_id`;

function filtroDespesas(q) {
  const where = []; const params = [];
  if (q.de) { where.push('d.data >= ?'); params.push(q.de); }
  if (q.ate) { where.push('d.data <= ?'); params.push(q.ate); }
  if (q.colaborador_id) { where.push('d.colaborador_id = ?'); params.push(Number(q.colaborador_id)); }
  return { sql: where.length ? ' WHERE ' + where.join(' AND ') : '', params };
}

app.get('/api/despesas/tipos', (req, res) => res.json(TIPOS));

app.get('/api/despesas', (req, res) => {
  const f = filtroDespesas(req.query);
  res.json(db.prepare(`${SELD}${f.sql} ORDER BY d.data DESC, d.id DESC`).all(...f.params));
});

// Foto da nota: data URL (image/jpeg ou image/png) já reduzida no cliente. Guardada em data/notas/.
function salvarNota(dataUrl) {
  if (!dataUrl) return null;
  const m = /^data:(image\/jpeg|image\/png);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m) throw Object.assign(new Error('Foto da nota: envie uma imagem JPEG ou PNG'), { status: 400 });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 5 * 1024 * 1024) throw Object.assign(new Error('Foto da nota: máximo 5 MB'), { status: 400 });
  const ok = (m[1] === 'image/jpeg' && buf[0] === 0xff && buf[1] === 0xd8) || (m[1] === 'image/png' && buf[0] === 0x89 && buf[1] === 0x50);
  if (!ok) throw Object.assign(new Error('Foto da nota: arquivo não é uma imagem válida'), { status: 400 });
  const nome = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${m[1] === 'image/png' ? 'png' : 'jpg'}`;
  fs.writeFileSync(path.join(NOTAS_DIR, nome), buf);
  return nome;
}

app.post('/api/despesas', (req, res) => {
  const b = req.body || {};
  const colab = db.prepare('SELECT id FROM colaboradores WHERE id = ? AND ativo = 1').get(Number(b.colaborador_id));
  if (!colab) return res.status(400).json({ erro: 'Selecione o colaborador' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.data || ''))) return res.status(400).json({ erro: 'Data inválida' });
  if (!TIPOS[b.tipo]) return res.status(400).json({ erro: 'Tipo de despesa inválido' });
  const descricao = String(b.descricao || '').trim();
  if (!descricao) return res.status(400).json({ erro: 'Descreva em que situação a despesa foi usada' });
  const valor = Number(String(b.valor ?? '').replace(',', '.'));
  if (!(valor > 0)) return res.status(400).json({ erro: 'Valor inválido' });
  const nota = salvarNota(b.nota);
  const info = db.prepare('INSERT INTO despesas (colaborador_id, data, tipo, descricao, valor, nota_arquivo) VALUES (?,?,?,?,?,?)')
    .run(colab.id, b.data, b.tipo, descricao, Math.round(valor * 100) / 100, nota);
  const d = db.prepare(`${SELD} WHERE d.id = ?`).get(info.lastInsertRowid);
  log(`despesa #${d.id} ${d.colaborador} ${d.data} ${TIPOS[d.tipo]} R$ ${d.valor}${nota ? ' com nota' : ''} — ${descricao}`);
  res.status(201).json(d);
});

app.get('/api/despesas/:id/nota', (req, res) => {
  const d = db.prepare('SELECT nota_arquivo FROM despesas WHERE id = ?').get(Number(req.params.id));
  if (!d?.nota_arquivo) return res.status(404).json({ erro: 'Sem nota' });
  res.sendFile(path.join(NOTAS_DIR, path.basename(d.nota_arquivo)));
});

app.delete('/api/despesas/:id', (req, res) => {
  const d = db.prepare('SELECT nota_arquivo FROM despesas WHERE id = ?').get(Number(req.params.id));
  const r = db.prepare('DELETE FROM despesas WHERE id = ?').run(Number(req.params.id));
  if (d?.nota_arquivo) fs.rm(path.join(NOTAS_DIR, path.basename(d.nota_arquivo)), { force: true }, () => {});
  log(`despesa #${req.params.id} excluída`);
  res.json({ ok: r.changes > 0 });
});

// ---------- relatório ----------
function relatorio(q) {
  const f = filtro(q);
  const viagens = db.prepare(`${SEL}${f.sql} ORDER BY c.nome, v.data_hora`).all(...f.params);
  const porColab = db.prepare(`SELECT c.id, c.nome AS colaborador, COUNT(*) AS viagens, ROUND(SUM(v.km), 2) AS km,
      ROUND(SUM(v.reembolso), 2) AS reembolso, ROUND(SUM(v.uber_estimado), 2) AS uber, ROUND(SUM(v.taxi_estimado), 2) AS taxi
    FROM viagens v JOIN colaboradores c ON c.id = v.colaborador_id${f.sql} GROUP BY c.id ORDER BY c.nome`).all(...f.params);
  const fd = filtroDespesas(q);
  const despesas = db.prepare(`${SELD}${fd.sql} ORDER BY c.nome, d.data, d.id`).all(...fd.params).map((d) => ({ ...d, tipo_nome: TIPOS[d.tipo] || d.tipo, tem_nota: !!d.nota_arquivo, nota_arquivo: undefined }));
  const despPorColab = db.prepare(`SELECT c.id, c.nome AS colaborador, COUNT(*) AS n, ROUND(SUM(d.valor), 2) AS valor
    FROM despesas d JOIN colaboradores c ON c.id = d.colaborador_id${fd.sql} GROUP BY c.id`).all(...fd.params);
  // junta viagens e despesas por colaborador
  const mapa = new Map();
  for (const r of porColab) mapa.set(r.id, { ...r, despesas_n: 0, despesas: 0 });
  for (const d of despPorColab) {
    const r = mapa.get(d.id) || { id: d.id, colaborador: d.colaborador, viagens: 0, km: 0, reembolso: 0, uber: 0, taxi: 0 };
    r.despesas_n = d.n; r.despesas = d.valor; mapa.set(d.id, r);
  }
  const colabs = [...mapa.values()].map((r) => ({ ...r, total: Math.round((r.reembolso + (r.despesas || 0)) * 100) / 100 })).sort((a, b) => a.colaborador.localeCompare(b.colaborador));
  const total = colabs.reduce((a, r) => ({
    viagens: a.viagens + r.viagens, km: a.km + r.km, reembolso: a.reembolso + r.reembolso, uber: a.uber + r.uber, taxi: a.taxi + r.taxi,
    despesas_n: a.despesas_n + (r.despesas_n || 0), despesas: a.despesas + (r.despesas || 0),
  }), { viagens: 0, km: 0, reembolso: 0, uber: 0, taxi: 0, despesas_n: 0, despesas: 0 });
  for (const k of ['km', 'reembolso', 'uber', 'taxi', 'despesas']) total[k] = Math.round(total[k] * 100) / 100;
  total.geral = Math.round((total.reembolso + total.despesas) * 100) / 100;
  return { periodo: { de: q.de || null, ate: q.ate || null }, colaboradores: colabs, total, viagens, despesas };
}

app.get('/api/relatorio', (req, res) => res.json(relatorio(req.query)));

const BASE = { km_fixo: 'R$/km fixo', uber_fora_pico: 'UberX fora de pico (estimado)', uber_manual: 'Uber informado' };

app.get('/api/relatorio.csv', (req, res) => {
  const r = relatorio(req.query);
  const num = (x) => (x == null ? '' : String(x).replace('.', ','));
  const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const linhas = [
    ['Colaborador', 'Data', 'Hora', 'Origem', 'Destino', 'Ida e volta', 'Km', 'Km Google', 'Odômetro saída', 'Odômetro chegada', 'Minutos', 'Base do reembolso', 'Uber informado (R$)', 'R$/km', 'Reembolso (R$)', 'Uber est. (R$)', 'Faixa Uber', 'Táxi est. (R$)', 'Bandeira', 'Observação'].join(';'),
    ...r.viagens.map((v) => [
      esc(v.colaborador), v.data_hora.slice(0, 10).split('-').reverse().join('/'), v.data_hora.slice(11, 16),
      esc(v.origem), esc(v.destino), v.ida_volta ? 'Sim' : 'Não', num(v.km), num(v.km_google ?? v.km), num(v.km_saida), num(v.km_chegada), v.minutos, BASE[v.modo_reembolso] || v.modo_reembolso, num(v.uber_manual), num(v.valor_km), num(v.reembolso),
      num(v.uber_estimado), esc(v.uber_faixa), num(v.taxi_estimado), v.taxi_bandeira, esc(v.observacao),
    ].join(';')),
    '',
    ['TOTAL VIAGENS', '', '', '', '', '', num(r.total.km), '', '', '', '', '', '', '', num(r.total.reembolso), num(r.total.uber), '', num(r.total.taxi), '', ''].join(';'),
    '',
    'OUTRAS DESPESAS',
    ['Colaborador', 'Data', 'Tipo', 'Situação', 'Valor (R$)', 'Nota fiscal'].join(';'),
    ...r.despesas.map((d) => [esc(d.colaborador), d.data.split('-').reverse().join('/'), esc(d.tipo_nome), esc(d.descricao), num(d.valor), d.tem_nota ? 'Sim' : 'Não'].join(';')),
    ['TOTAL DESPESAS', '', '', '', num(r.total.despesas), ''].join(';'),
    '',
    ['TOTAL GERAL A REEMBOLSAR', '', '', '', num(r.total.geral), ''].join(';'),
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
