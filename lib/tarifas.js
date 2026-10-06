'use strict';
// Tabelas de tarifa e estimativas de Uber e táxi para São Paulo (capital).
// Todos os valores ficam na tabela `config` e podem ser editados na tela de
// Configurações; os defaults abaixo são a referência de out/2026.

const DEFAULTS = {
  // Reembolso
  reembolso: {
    // 'km_fixo' = km × valor_km. 'uber_fora_pico' = estimativa UberX da rota
    // calculada com multiplicador 1,0 (sem preço dinâmico).
    modo: 'km_fixo',
    // Média UberX em SP fora de pico, centro expandido (área do rodízio):
    // 1,65/km + 0,35/min a ~25 km/h (2,4 min/km) + base e taxa de reserva
    // amortizadas numa corrida de ~10 km ≈ R$ 2,90/km.
    valor_km: 2.90,
  },
  // UberX São Paulo (referência 2026)
  uber: {
    tarifa_base: 2.50,
    por_km: 1.65,
    por_min: 0.35,
    taxa_reserva: 2.00,
    tarifa_minima: 8.00,
    // Faixas de horário (hora local). Dias: 0=dom … 6=sáb. Primeira faixa que casar vale.
    faixas: [
      { nome: 'Pico manhã', dias: [1, 2, 3, 4, 5], de: '07:00', ate: '10:00', mult: 1.30 },
      { nome: 'Pico tarde', dias: [1, 2, 3, 4, 5], de: '17:00', ate: '20:00', mult: 1.40 },
      { nome: 'Noite sex/sáb', dias: [5, 6], de: '20:00', ate: '24:00', mult: 1.25 },
      { nome: 'Noite', dias: [0, 1, 2, 3, 4], de: '20:00', ate: '24:00', mult: 1.10 },
      { nome: 'Madrugada', dias: [0, 1, 2, 3, 4, 5, 6], de: '00:00', ate: '06:00', mult: 1.20 },
    ],
    mult_padrao: 1.00, // fora de pico
  },
  // Táxi comum SP — Portaria SMT, vigente desde 11/08/2025
  taxi: {
    bandeirada: 6.55,
    km_bandeira1: 4.80,
    km_bandeira2: 6.24, // +30%
    hora_parada: 55.50,
    bandeira2_de: '20:00',
    bandeira2_ate: '06:00',
    // Para estimar o tempo parado (tarifa horária): o que passar da
    // velocidade de fluxo abaixo conta como parado/engarrafado.
    velocidade_fluxo_kmh: 30,
  },
};

function hhmmToMin(s) {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + (m || 0);
}

// Páscoa (Meeus/Jones/Butcher)
function pascoa(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(ano, mes - 1, dia);
}

function addDias(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Feriados em São Paulo capital (nacionais + estadual 09/07 + municipais 25/01 e 20/11)
function feriadosSP(ano) {
  const p = pascoa(ano);
  const fixos = ['01-01', '01-25', '04-21', '05-01', '07-09', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25']
    .map((md) => `${ano}-${md}`);
  const moveis = [addDias(p, -48), addDias(p, -47), addDias(p, -2), addDias(p, 60)].map(ymd);
  return new Set([...fixos, ...moveis]);
}

function isFeriado(date) {
  return feriadosSP(date.getFullYear()).has(ymd(date));
}

// Horário dentro de uma janela [de, ate) com suporte a virada de dia (20:00–06:00)
function dentroJanela(minDia, de, ate) {
  const a = hhmmToMin(de), b = hhmmToMin(ate);
  if (a < b) return minDia >= a && minDia < b;
  return minDia >= a || minDia < b;
}

function faixaUber(date, cfg) {
  const dia = date.getDay();
  const min = date.getHours() * 60 + date.getMinutes();
  for (const f of cfg.faixas || []) {
    if (!f.dias.includes(dia)) continue;
    if (dentroJanela(min, f.de, f.ate)) return { nome: f.nome, mult: Number(f.mult) };
  }
  return { nome: 'Fora de pico', mult: Number(cfg.mult_padrao ?? 1) };
}

function round2(x) { return Math.round(x * 100) / 100; }

// Estimativa UberX. `mult` força um multiplicador (1,0 = sem preço dinâmico).
function estimarUber({ km, minutos, date }, cfg, mult) {
  const faixa = mult == null ? faixaUber(date, cfg) : { nome: 'Fora de pico (fixo)', mult };
  const corrida = cfg.tarifa_base + km * cfg.por_km + minutos * cfg.por_min;
  const comDinamico = corrida * faixa.mult + cfg.taxa_reserva;
  const valor = Math.max(comDinamico, cfg.tarifa_minima);
  return { valor: round2(valor), faixa: faixa.nome, mult: faixa.mult };
}

function bandeiraTaxi(date, cfg) {
  const dia = date.getDay();
  if (dia === 0 || isFeriado(date)) return 2;
  const min = date.getHours() * 60 + date.getMinutes();
  return dentroJanela(min, cfg.bandeira2_de, cfg.bandeira2_ate) ? 2 : 1;
}

function estimarTaxi({ km, minutos, date }, cfg) {
  const bandeira = bandeiraTaxi(date, cfg);
  const porKm = bandeira === 2 ? cfg.km_bandeira2 : cfg.km_bandeira1;
  const minFluxo = (km / cfg.velocidade_fluxo_kmh) * 60;
  const minParado = Math.max(0, minutos - minFluxo);
  const valor = cfg.bandeirada + km * porKm + (minParado / 60) * cfg.hora_parada;
  return { valor: round2(valor), bandeira, min_parado: Math.round(minParado) };
}

function calcularReembolso({ km, minutos, date }, cfgReembolso, cfgUber) {
  if (cfgReembolso.modo === 'uber_fora_pico') {
    const u = estimarUber({ km, minutos, date }, cfgUber, 1.0);
    return { valor: u.valor, valor_km: round2(u.valor / Math.max(km, 0.01)), modo: 'uber_fora_pico' };
  }
  return { valor: round2(km * cfgReembolso.valor_km), valor_km: cfgReembolso.valor_km, modo: 'km_fixo' };
}

// Valor informado manualmente (o que o app do Uber está cobrando agora, só a ida).
// Se existir, substitui o cálculo por km; em ida e volta, vale o dobro.
function reembolsoUberManual(uberManual, idaVolta, km) {
  const v = Number(uberManual);
  if (!(v > 0)) return null;
  const valor = round2(v * (idaVolta ? 2 : 1));
  return { valor, valor_km: round2(valor / Math.max(km, 0.01)), modo: 'uber_manual', uber_manual: round2(v) };
}

module.exports = {
  DEFAULTS, estimarUber, estimarTaxi, calcularReembolso, reembolsoUberManual, faixaUber, bandeiraTaxi,
  isFeriado, feriadosSP, pascoa,
};
