'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { DEFAULTS } = require('./tarifas');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'reembolso.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS colaboradores (
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL UNIQUE,
  ativo INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS config (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS viagens (
  id INTEGER PRIMARY KEY,
  colaborador_id INTEGER NOT NULL REFERENCES colaboradores(id),
  data_hora TEXT NOT NULL,            -- 'YYYY-MM-DDTHH:MM' hora local (GMT-3)
  origem TEXT NOT NULL,
  destino TEXT NOT NULL,
  origem_place_id TEXT,
  destino_place_id TEXT,
  ida_volta INTEGER NOT NULL DEFAULT 0,
  km REAL NOT NULL,
  minutos INTEGER NOT NULL,
  polyline TEXT,
  polyline_volta TEXT,
  modo_reembolso TEXT NOT NULL,
  valor_km REAL NOT NULL,
  reembolso REAL NOT NULL,
  uber_estimado REAL,
  uber_faixa TEXT,
  taxi_estimado REAL,
  taxi_bandeira INTEGER,
  uber_manual REAL,
  observacao TEXT,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_viagens_data ON viagens(data_hora);
CREATE INDEX IF NOT EXISTS idx_viagens_colab ON viagens(colaborador_id);
CREATE TABLE IF NOT EXISTS despesas (
  id INTEGER PRIMARY KEY,
  colaborador_id INTEGER NOT NULL REFERENCES colaboradores(id),
  data TEXT NOT NULL,                 -- 'YYYY-MM-DD'
  tipo TEXT NOT NULL,                 -- estacionamento | combustivel | alimentacao | transporte | pedagio | outro
  descricao TEXT NOT NULL,            -- situação em que foi usada (cliente, motivo)
  valor REAL NOT NULL,
  nota_arquivo TEXT,                  -- nome do arquivo da foto em data/notas/
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S', 'now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_despesas_data ON despesas(data);
`);

// Migrações: colunas adicionadas depois da primeira versão
const colunas = db.prepare('PRAGMA table_info(viagens)').all().map((c) => c.name);
if (!colunas.includes('uber_manual')) db.exec('ALTER TABLE viagens ADD COLUMN uber_manual REAL');
for (const c of ['km_google', 'km_saida', 'km_chegada']) {
  if (!colunas.includes(c)) db.exec(`ALTER TABLE viagens ADD COLUMN ${c} REAL`);
}
const NOTAS_DIR = path.join(path.dirname(DB_PATH === ':memory:' ? path.join(__dirname, '..', 'data', 'x') : DB_PATH), 'notas');
fs.mkdirSync(NOTAS_DIR, { recursive: true });

// Seed de colaboradores e configuração
const insColab = db.prepare('INSERT OR IGNORE INTO colaboradores (nome) VALUES (?)');
// Colaboradores iniciais: COLABORADORES="Ana,Bruno" no .env. Depois, gerencie em Configurações.
for (const n of String(process.env.COLABORADORES || '').split(',').map((x) => x.trim()).filter(Boolean)) insColab.run(n);

const getCfg = db.prepare('SELECT valor FROM config WHERE chave = ?');
const setCfg = db.prepare('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor');
for (const [k, v] of Object.entries(DEFAULTS)) {
  if (!getCfg.get(k)) setCfg.run(k, JSON.stringify(v));
}

function config() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    const row = getCfg.get(k);
    // merge com defaults para campos novos adicionados depois
    out[k] = { ...DEFAULTS[k], ...(row ? JSON.parse(row.valor) : {}) };
  }
  return out;
}

function salvarConfig(novo) {
  const atual = config();
  const tx = db.prepare('BEGIN'); tx.run();
  try {
    for (const k of Object.keys(DEFAULTS)) {
      if (novo[k]) setCfg.run(k, JSON.stringify({ ...atual[k], ...novo[k] }));
    }
    db.prepare('COMMIT').run();
  } catch (e) { db.prepare('ROLLBACK').run(); throw e; }
  return config();
}

module.exports = { db, config, salvarConfig, DB_PATH, NOTAS_DIR };
