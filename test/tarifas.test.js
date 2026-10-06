'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/tarifas');

const cfg = T.DEFAULTS;

test('feriados SP 2026 (Páscoa 05/04/2026)', () => {
  const f = T.feriadosSP(2026);
  for (const d of ['2026-01-25', '2026-02-16', '2026-02-17', '2026-04-03', '2026-06-04', '2026-07-09', '2026-11-20']) assert.ok(f.has(d), d);
  assert.equal(f.has('2026-10-06'), false);
});

test('bandeira do táxi', () => {
  assert.equal(T.bandeiraTaxi(new Date(2026, 9, 6, 14, 0), cfg.taxi), 1); // terça 14h
  assert.equal(T.bandeiraTaxi(new Date(2026, 9, 6, 21, 0), cfg.taxi), 2); // terça 21h
  assert.equal(T.bandeiraTaxi(new Date(2026, 9, 6, 5, 59), cfg.taxi), 2); // madrugada
  assert.equal(T.bandeiraTaxi(new Date(2026, 9, 11, 10, 0), cfg.taxi), 2); // domingo
  assert.equal(T.bandeiraTaxi(new Date(2026, 10, 20, 10, 0), cfg.taxi), 2); // feriado
});

test('táxi 10 km bandeira 1 ≈ tabela da prefeitura (R$ 67 com tempo parado típico)', () => {
  const r = T.estimarTaxi({ km: 10, minutos: 20, date: new Date(2026, 9, 6, 14, 0) }, cfg.taxi);
  assert.equal(r.bandeira, 1);
  assert.equal(r.valor, 6.55 + 48); // 20 min a 30 km/h = sem tempo parado
  const r2 = T.estimarTaxi({ km: 10, minutos: 35, date: new Date(2026, 9, 6, 14, 0) }, cfg.taxi);
  assert.ok(r2.valor > 60 && r2.valor < 75, String(r2.valor));
});

test('uber fora de pico e com pico', () => {
  const base = { km: 10, minutos: 24 };
  const fora = T.estimarUber({ ...base, date: new Date(2026, 9, 6, 14, 0) }, cfg.uber);
  assert.equal(fora.faixa, 'Fora de pico');
  assert.equal(fora.valor, 29.4); // 2.5 + 16.5 + 8.4 + 2
  const pico = T.estimarUber({ ...base, date: new Date(2026, 9, 6, 18, 0) }, cfg.uber);
  assert.equal(pico.faixa, 'Pico tarde');
  assert.ok(pico.valor > fora.valor);
  const fixo = T.estimarUber({ ...base, date: new Date(2026, 9, 6, 18, 0) }, cfg.uber, 1.0);
  assert.equal(fixo.valor, fora.valor);
});

test('tarifa mínima', () => {
  const r = T.estimarUber({ km: 0.5, minutos: 2, date: new Date(2026, 9, 6, 14, 0) }, cfg.uber);
  assert.equal(r.valor, cfg.uber.tarifa_minima);
});

test('reembolso por km fixo e por uber fora de pico', () => {
  const b = { km: 10, minutos: 24, date: new Date(2026, 9, 6, 18, 0) };
  assert.deepEqual(T.calcularReembolso(b, cfg.reembolso, cfg.uber), { valor: 29, valor_km: 2.9, modo: 'km_fixo' });
  const u = T.calcularReembolso(b, { modo: 'uber_fora_pico' }, cfg.uber);
  assert.equal(u.valor, 29.4);
});

test('uber informado manualmente substitui o cálculo e dobra em ida e volta', () => {
  assert.deepEqual(T.reembolsoUberManual('31.50', false, 10), { valor: 31.5, valor_km: 3.15, modo: 'uber_manual', uber_manual: 31.5 });
  assert.deepEqual(T.reembolsoUberManual(31.5, true, 20), { valor: 63, valor_km: 3.15, modo: 'uber_manual', uber_manual: 31.5 });
  assert.equal(T.reembolsoUberManual('', true, 10), null);
  assert.equal(T.reembolsoUberManual('abc', true, 10), null);
  assert.equal(T.reembolsoUberManual(0, true, 10), null);
  assert.equal(T.reembolsoUberManual(-5, true, 10), null);
});
