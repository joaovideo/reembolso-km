'use strict';
const $ = (s) => document.querySelector(s);
const brl = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const kmf = (v) => `${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;
const dataBR = (s) => s.slice(0, 10).split('-').reverse().join('/');
const hoje = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

async function api(url, opt = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opt, body: opt.body ? JSON.stringify(opt.body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.erro || `Erro ${res.status}`);
  return json;
}

let colabs = [];
let colabSel = Number(localStorage.getItem('colab') || 0);
let calculo = null;

// ---------- abas ----------
document.querySelectorAll('.abas button').forEach((b) => b.addEventListener('click', () => mostrarAba(b.dataset.aba)));
function mostrarAba(nome) {
  document.querySelectorAll('.abas button').forEach((b) => b.classList.toggle('ativa', b.dataset.aba === nome));
  document.querySelectorAll('.aba').forEach((s) => s.classList.toggle('oculto', s.id !== `aba-${nome}`));
  if (nome === 'viagens') carregarViagens();
  if (nome === 'despesas') carregarDespesas();
  if (nome === 'config') carregarConfig();
  location.hash = nome;
}

// ---------- colaboradores ----------
async function carregarColabs() {
  colabs = await api('/api/colaboradores');
  const ativos = colabs.filter((c) => c.ativo);
  if (!ativos.some((c) => c.id === colabSel)) colabSel = 0;
  $('#colabs').innerHTML = ativos.map((c) => `<button type="button" data-id="${c.id}" class="${c.id === colabSel ? 'sel' : ''}">${c.nome}</button>`).join('');
  $('#colabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    colabSel = Number(b.dataset.id); localStorage.setItem('colab', colabSel); carregarColabs();
  }));
  $('#quem').textContent = ativos.find((c) => c.id === colabSel)?.nome || 'Quem é você?';
  $('#d-colabs').innerHTML = ativos.map((c) => `<button type="button" data-id="${c.id}" class="${c.id === colabSel ? 'sel' : ''}">${c.nome}</button>`).join('');
  $('#d-colabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    colabSel = Number(b.dataset.id); localStorage.setItem('colab', colabSel); carregarColabs();
  }));
  for (const sel of ['#v-colab', '#r-colab', '#d-colab-f']) {
    const el = $(sel); const atual = el.value;
    el.innerHTML = '<option value="">Todos</option>' + colabs.map((c) => `<option value="${c.id}">${c.nome}</option>`).join('');
    el.value = atual;
  }
}

// ---------- autocomplete ----------
const sessao = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
let sessaoAtual = sessao();
function ligarAutocomplete(inputId, hiddenId, listaId) {
  const input = $(inputId), hidden = $(hiddenId), lista = $(listaId);
  let timer, itens = [], foco = -1;
  const fechar = () => { lista.innerHTML = ''; itens = []; foco = -1; };
  const escolher = (i) => { const s = itens[i]; if (!s) return; input.value = s.descricao; hidden.value = s.place_id; fechar(); sessaoAtual = sessao(); invalidar(); };
  input.addEventListener('input', () => {
    hidden.value = ''; invalidar();
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) return fechar();
    timer = setTimeout(async () => {
      try {
        itens = await api(`/api/places?q=${encodeURIComponent(q)}&session=${sessaoAtual}`);
        lista.innerHTML = itens.map((s, i) => `<li data-i="${i}">${s.principal}<small>${s.secundario}</small></li>`).join('');
        lista.querySelectorAll('li').forEach((li) => li.addEventListener('mousedown', (e) => { e.preventDefault(); escolher(Number(li.dataset.i)); }));
      } catch (e) { mostrarErro(e.message); fechar(); }
    }, 300);
  });
  input.addEventListener('keydown', (e) => {
    if (!itens.length) return;
    if (e.key === 'ArrowDown') { foco = Math.min(foco + 1, itens.length - 1); }
    else if (e.key === 'ArrowUp') { foco = Math.max(foco - 1, 0); }
    else if (e.key === 'Enter') { if (foco >= 0) { e.preventDefault(); escolher(foco); } return; }
    else if (e.key === 'Escape') { fechar(); return; }
    else return;
    e.preventDefault();
    lista.querySelectorAll('li').forEach((li, i) => li.classList.toggle('foco', i === foco));
  });
  input.addEventListener('blur', () => setTimeout(fechar, 150));
}
ligarAutocomplete('#origem', '#origem_place_id', '#sug-origem');
ligarAutocomplete('#destino', '#destino_place_id', '#sug-destino');

$('#inverter').addEventListener('click', () => {
  const o = $('#origem').value, op = $('#origem_place_id').value;
  $('#origem').value = $('#destino').value; $('#origem_place_id').value = $('#destino_place_id').value;
  $('#destino').value = o; $('#destino_place_id').value = op; invalidar();
});
['#data', '#hora', '#ida_volta', '#km_saida', '#km_chegada'].forEach((s) => $(s).addEventListener('change', invalidar));

function invalidar() { calculo = null; $('#salvar').disabled = true; }

function mostrarReembolso(r) {
  $('#r-reembolso').textContent = brl(r.valor);
  $('#r-modo').textContent = r.modo === 'uber_manual'
    ? `Uber informado ${brl(r.uber_manual)}${calculo?.ida_volta ? ' × 2 (ida e volta)' : ''}`
    : r.modo === 'km_fixo' ? `${brl(r.valor_km)}/km` : 'UberX fora de pico';
}

// Digitar o valor do Uber depois de calcular atualiza o reembolso na hora, sem nova consulta ao Google.
// O servidor recalcula de novo ao salvar, com a mesma regra.
$('#uber_manual').addEventListener('input', async () => {
  if (!calculo) return;
  const v = Number($('#uber_manual').value.replace(',', '.'));
  if (v > 0) {
    const valor = Math.round(v * (calculo.ida_volta ? 2 : 1) * 100) / 100;
    mostrarReembolso({ valor, valor_km: valor / Math.max(calculo.km, 0.01), modo: 'uber_manual', uber_manual: v });
  } else {
    // voltou a vazio: recalcula pela regra padrão sem o Google
    mostrarReembolso(calculo.reembolso.modo === 'uber_manual' ? { valor: calculo.km * (await cfgValorKm()), valor_km: await cfgValorKm(), modo: 'km_fixo' } : calculo.reembolso);
  }
});
let _cfg;
async function cfgValorKm() { _cfg = _cfg || await api('/api/config'); return _cfg.reembolso.valor_km; }
function toast(msg) {
  let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('on'); clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove('on'), 4000);
}
function mostrarErro(msg) { const e = $('#erro'); e.textContent = msg; e.classList.toggle('oculto', !msg); }

function corpo() {
  return {
    colaborador_id: colabSel,
    data_hora: `${$('#data').value}T${$('#hora').value}`,
    origem: $('#origem').value.trim(), origem_place_id: $('#origem_place_id').value || null,
    destino: $('#destino').value.trim(), destino_place_id: $('#destino_place_id').value || null,
    ida_volta: $('#ida_volta').checked, observacao: $('#obs').value.trim(),
    uber_manual: $('#uber_manual').value.trim() || null,
    km_saida: $('#km_saida').value.trim() || null, km_chegada: $('#km_chegada').value.trim() || null,
  };
}

// ---------- mapa ----------
let mapa, camada;
function decodePolyline(str) {
  let index = 0, lat = 0, lng = 0; const pts = [];
  while (index < str.length) {
    for (const k of [0, 1]) {
      let b, shift = 0, result = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (k === 0) lat += d; else lng += d;
    }
    pts.push([lat / 1e5, lng / 1e5]);
  }
  return pts;
}
function desenharRota(r) {
  if (!mapa) {
    mapa = L.map('mapa', { zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(mapa);
  }
  if (camada) camada.remove();
  camada = L.layerGroup().addTo(mapa);
  const ida = decodePolyline(r.polyline || '');
  if (ida.length) {
    L.polyline(ida, { color: '#E8500A', weight: 5 }).addTo(camada);
    L.circleMarker(ida[0], { radius: 7, color: '#fff', fillColor: '#3cb371', fillOpacity: 1 }).addTo(camada).bindTooltip('Origem');
    L.circleMarker(ida[ida.length - 1], { radius: 7, color: '#fff', fillColor: '#e0504a', fillOpacity: 1 }).addTo(camada).bindTooltip('Destino');
  }
  if (r.polyline_volta) L.polyline(decodePolyline(r.polyline_volta), { color: '#F0956A', weight: 3, dashArray: '6 6' }).addTo(camada);
  const todos = [...ida, ...(r.polyline_volta ? decodePolyline(r.polyline_volta) : [])];
  if (todos.length) mapa.fitBounds(L.latLngBounds(todos), { padding: [24, 24] });
}

// ---------- calcular / salvar ----------
$('#calcular').addEventListener('click', async () => {
  mostrarErro('');
  const b = corpo();
  if (!b.origem || !b.destino) return mostrarErro('Preencha origem e destino.');
  if (!$('#data').value || !$('#hora').value) return mostrarErro('Preencha data e hora.');
  $('#calcular').disabled = true; $('#calcular').textContent = 'Calculando…';
  try {
    calculo = await api('/api/calcular', { method: 'POST', body: b });
    mostrarReembolso(calculo.reembolso);
    $('#r-km').textContent = kmf(calculo.km);
    $('#r-tempo').textContent = calculo.km_saida != null
      ? `odômetro ${calculo.km_saida} → ${calculo.km_chegada} · Google ${kmf(calculo.km_google)} · ${calculo.minutos} min`
      : `${calculo.minutos} min${calculo.ida_volta ? ` · ida ${kmf(calculo.km_ida)} + volta ${kmf(calculo.km_volta)}` : ''}`;
    if (calculo.aviso_odometro) mostrarErro(calculo.aviso_odometro);
    $('#r-uber').textContent = brl(calculo.uber.valor);
    $('#r-uber-faixa').textContent = `${calculo.uber.faixa} ×${calculo.uber.mult.toFixed(2)}${calculo.uber.mult !== 1 ? ` · fora de pico ${brl(calculo.uber_fora_pico)}` : ''}`;
    $('#r-taxi').textContent = brl(calculo.taxi.valor);
    $('#r-taxi-band').textContent = `Bandeira ${calculo.taxi.bandeira}`;
    $('#resultado').classList.remove('oculto');
    desenharRota(calculo);
    $('#salvar').disabled = !colabSel;
    if (!colabSel) mostrarErro('Selecione o colaborador para salvar.');
  } catch (e) { mostrarErro(e.message); }
  finally { $('#calcular').disabled = false; $('#calcular').textContent = 'Calcular rota'; }
});

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault(); mostrarErro('');
  if (!colabSel) return mostrarErro('Selecione o colaborador.');
  if (!calculo) return mostrarErro('Calcule a rota antes de salvar.');
  $('#salvar').disabled = true; $('#salvar').textContent = 'Salvando…';
  try {
    const v = await api('/api/viagens', { method: 'POST', body: corpo() });
    $('#origem').value = ''; $('#origem_place_id').value = ''; $('#destino').value = ''; $('#destino_place_id').value = ''; $('#obs').value = '';
    $('#ida_volta').checked = false; $('#uber_manual').value = ''; $('#km_saida').value = ''; $('#km_chegada').value = ''; invalidar(); $('#resultado').classList.add('oculto');
    mostrarAba('viagens');
    toast(`Viagem salva: ${v.colaborador}, ${kmf(v.km)}, ${brl(v.reembolso)}`);
  } catch (err) { mostrarErro(err.message); $('#salvar').disabled = false; }
  finally { $('#salvar').textContent = 'Salvar viagem'; }
});

// ---------- viagens ----------
function query(de, ate, colab) {
  const p = new URLSearchParams();
  if (de) p.set('de', de); if (ate) p.set('ate', ate); if (colab) p.set('colaborador_id', colab);
  return p.toString();
}
async function carregarViagens() {
  const vs = await api(`/api/viagens?${query($('#v-de').value, $('#v-ate').value, $('#v-colab').value)}`);
  $('#v-tabela tbody').innerHTML = vs.map((v) => `<tr>
    <td>${dataBR(v.data_hora)}<br><small>${v.data_hora.slice(11, 16)}</small></td>
    <td>${v.colaborador}</td>
    <td class="traj">${v.origem} → ${v.destino}${v.ida_volta ? ' <small>(ida e volta)</small>' : ''}${v.km_saida != null ? `<small>odômetro ${v.km_saida} → ${v.km_chegada} (Google ${kmf(v.km_google)})</small>` : ''}${v.observacao ? `<small>${v.observacao}</small>` : ''}</td>
    <td class="num">${kmf(v.km)}</td><td class="num"><b>${brl(v.reembolso)}</b>${v.modo_reembolso === 'uber_manual' ? `<br><small>Uber informado ${brl(v.uber_manual)}${v.ida_volta ? ' ×2' : ''}</small>` : ''}</td>
    <td class="num">${brl(v.uber_estimado)}</td><td class="num">${brl(v.taxi_estimado)}</td>
    <td><button class="excluir" data-id="${v.id}" title="Excluir">✕</button></td></tr>`).join('');
  $('#v-vazio').classList.toggle('oculto', vs.length > 0);
  $('#v-tabela tbody').querySelectorAll('.excluir').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Excluir esta viagem?')) return;
    await api(`/api/viagens/${b.dataset.id}`, { method: 'DELETE' }); carregarViagens();
  }));
}
$('#v-buscar').addEventListener('click', carregarViagens);

// ---------- relatório ----------
function mesAtual(offset = 0) {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + offset);
  const ini = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  const fim = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return [ini, `${fim.getFullYear()}-${String(fim.getMonth() + 1).padStart(2, '0')}-${String(fim.getDate()).padStart(2, '0')}`];
}
$('#r-mes').addEventListener('click', () => { [$('#r-de').value, $('#r-ate').value] = mesAtual(0); gerarRelatorio(); });
$('#r-mes-ant').addEventListener('click', () => { [$('#r-de').value, $('#r-ate').value] = mesAtual(-1); gerarRelatorio(); });
$('#r-gerar').addEventListener('click', gerarRelatorio);
$('#r-csv').addEventListener('click', () => { location.href = `/api/relatorio.csv?${query($('#r-de').value, $('#r-ate').value, $('#r-colab').value)}`; });
$('#r-pdf').addEventListener('click', async () => { await gerarRelatorio(); window.print(); });

function baseReembolso(v) {
  if (v.modo_reembolso === 'uber_manual') return `Uber informado ${brl(v.uber_manual)}${v.ida_volta ? ' × 2' : ''}`;
  if (v.modo_reembolso === 'uber_fora_pico') return 'UberX fora de pico (est.)';
  return `${brl(v.valor_km)}/km`;
}
async function gerarRelatorio() {
  const r = await api(`/api/relatorio?${query($('#r-de').value, $('#r-ate').value, $('#r-colab').value)}`);
  const per = r.periodo.de || r.periodo.ate ? `${r.periodo.de ? dataBR(r.periodo.de) : 'início'} a ${r.periodo.ate ? dataBR(r.periodo.ate) : 'hoje'}` : 'Todo o período';
  const colabNome = $('#r-colab').selectedOptions[0]?.textContent;
  $('#rel-periodo').textContent = `${per}${$('#r-colab').value ? ` · ${colabNome}` : ''}`;
  $('#rel-total').textContent = brl(r.total.geral);
  $('#rel-total-sub').textContent = `km ${brl(r.total.reembolso)} + despesas ${brl(r.total.despesas)}`;
  $('#rel-resumo tbody').innerHTML = r.colaboradores.map((c) => `<tr><td>${c.colaborador}</td><td class="num">${c.viagens}</td><td class="num">${kmf(c.km)}</td><td class="num">${brl(c.reembolso)}</td><td class="num">${brl(c.despesas || 0)}</td><td class="num"><b>${brl(c.total)}</b></td><td class="num">${brl(c.uber)}</td><td class="num">${brl(c.taxi)}</td></tr>`).join('')
    + `<tr><td><b>Total</b></td><td class="num"><b>${r.total.viagens}</b></td><td class="num"><b>${kmf(r.total.km)}</b></td><td class="num"><b>${brl(r.total.reembolso)}</b></td><td class="num"><b>${brl(r.total.despesas)}</b></td><td class="num"><b>${brl(r.total.geral)}</b></td><td class="num">${brl(r.total.uber)}</td><td class="num">${brl(r.total.taxi)}</td></tr>`;
  $('#rel-desp tbody').innerHTML = r.despesas.length ? r.despesas.map((d) => `<tr><td>${dataBR(d.data)}</td><td>${d.colaborador}</td><td>${d.tipo_nome}</td><td>${esc(d.descricao)}</td><td class="num">${brl(d.valor)}</td><td>${d.tem_nota ? `<img class="thumb" src="/api/despesas/${d.id}/nota" alt="nota" data-full="/api/despesas/${d.id}/nota">` : '—'}</td></tr>`).join('') : '<tr><td colspan="6" class="nota">Nenhuma despesa no período.</td></tr>';
  $('#rel-det tbody').innerHTML = r.viagens.map((v) => `<tr><td>${dataBR(v.data_hora)} ${v.data_hora.slice(11, 16)}</td><td>${v.colaborador}</td><td>${v.origem} → ${v.destino}${v.ida_volta ? ' (ida e volta)' : ''}</td><td class="num">${kmf(v.km)}${v.km_saida != null ? `<br><small>odômetro</small>` : ''}</td><td>${baseReembolso(v)}</td><td class="num">${brl(v.reembolso)}</td><td>${esc(v.observacao || '')}</td></tr>`).join('');
  $('#rel-gerado').textContent = new Date().toLocaleString('pt-BR');
  $('#rel').classList.remove('oculto');
}

// ---------- despesas ----------
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let TIPOS = {};
let fotoDataUrl = null;

// Reduz a foto no próprio celular (máx. 1600 px, JPEG 80%) para não subir 5 MB por nota.
function comprimirImagem(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1600; const esc_ = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * esc_); c.height = Math.round(img.height * esc_);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Não consegui ler a imagem')); };
    img.src = url;
  });
}
$('#d-foto').addEventListener('change', async () => {
  const f = $('#d-foto').files[0]; if (!f) return;
  try {
    fotoDataUrl = await comprimirImagem(f);
    $('#d-preview img').src = fotoDataUrl; $('#d-preview').classList.remove('oculto');
  } catch (e) { mostrarErroD(e.message); }
});
$('#d-foto-limpar').addEventListener('click', () => { fotoDataUrl = null; $('#d-foto').value = ''; $('#d-preview').classList.add('oculto'); });
function mostrarErroD(msg) { const e = $('#d-erro'); e.textContent = msg; e.classList.toggle('oculto', !msg); }

async function carregarTipos() {
  if (Object.keys(TIPOS).length) return;
  TIPOS = await api('/api/despesas/tipos');
  $('#d-tipo').innerHTML = Object.entries(TIPOS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
}

$('#d-form').addEventListener('submit', async (e) => {
  e.preventDefault(); mostrarErroD('');
  if (!colabSel) return mostrarErroD('Selecione o colaborador.');
  $('#d-salvar').disabled = true; $('#d-salvar').textContent = 'Salvando…';
  try {
    const d = await api('/api/despesas', { method: 'POST', body: {
      colaborador_id: colabSel, data: $('#d-data').value, tipo: $('#d-tipo').value,
      valor: $('#d-valor').value, descricao: $('#d-desc').value.trim(), nota: fotoDataUrl,
    } });
    $('#d-valor').value = ''; $('#d-desc').value = ''; $('#d-foto-limpar').click();
    toast(`Despesa salva: ${d.colaborador}, ${TIPOS[d.tipo]}, ${brl(d.valor)}`);
    carregarDespesas();
  } catch (err) { mostrarErroD(err.message); }
  finally { $('#d-salvar').disabled = false; $('#d-salvar').textContent = 'Salvar despesa'; }
});

async function carregarDespesas() {
  await carregarTipos();
  const ds = await api(`/api/despesas?${query($('#d-de').value, $('#d-ate').value, $('#d-colab-f').value)}`);
  $('#d-tabela tbody').innerHTML = ds.map((d) => `<tr>
    <td>${dataBR(d.data)}</td><td>${d.colaborador}</td><td>${TIPOS[d.tipo] || d.tipo}</td><td>${esc(d.descricao)}</td>
    <td class="num"><b>${brl(d.valor)}</b></td>
    <td>${d.nota_arquivo ? `<img class="thumb" src="/api/despesas/${d.id}/nota" alt="nota" data-full="/api/despesas/${d.id}/nota">` : '—'}</td>
    <td><button class="excluir" data-id="${d.id}" title="Excluir">✕</button></td></tr>`).join('');
  $('#d-vazio').classList.toggle('oculto', ds.length > 0);
  $('#d-tabela tbody').querySelectorAll('.excluir').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Excluir esta despesa?')) return;
    await api(`/api/despesas/${b.dataset.id}`, { method: 'DELETE' }); carregarDespesas();
  }));
}
$('#d-buscar').addEventListener('click', carregarDespesas);

// clique na miniatura abre a nota em tamanho grande
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.classList?.contains('thumb')) {
    const box = document.createElement('div'); box.id = 'lightbox';
    const img = document.createElement('img'); img.src = t.dataset.full; box.appendChild(img);
    box.addEventListener('click', () => box.remove()); document.body.appendChild(box);
  }
});

// ---------- config ----------
async function carregarConfig() {
  const c = await api('/api/config');
  $('#cfg-modo').value = c.reembolso.modo; $('#cfg-valor_km').value = c.reembolso.valor_km;
  for (const k of ['tarifa_base', 'por_km', 'por_min', 'taxa_reserva', 'tarifa_minima', 'mult_padrao']) $(`#u-${k}`).value = c.uber[k];
  $('#u-faixas').value = JSON.stringify(c.uber.faixas, null, 1).replace(/\n\s*(?=[^\[\]{}]*[,\]}])/g, ' ');
  for (const k of ['bandeirada', 'km_bandeira1', 'km_bandeira2', 'hora_parada', 'bandeira2_de', 'bandeira2_ate', 'velocidade_fluxo_kmh']) $(`#t-${k}`).value = c.taxi[k];
  $('#cfg-colabs').innerHTML = colabs.map((co) => `<label class="${co.ativo ? '' : 'inativo'}"><input type="checkbox" data-id="${co.id}" ${co.ativo ? 'checked' : ''}> ${co.nome}</label>`).join('');
  $('#cfg-colabs').querySelectorAll('input').forEach((i) => i.addEventListener('change', async () => {
    await api(`/api/colaboradores/${i.dataset.id}`, { method: 'PATCH', body: { ativo: i.checked } }); await carregarColabs(); carregarConfig();
  }));
}
$('#cfg-add-colab').addEventListener('click', async () => {
  const nome = $('#cfg-novo-colab').value.trim(); if (!nome) return;
  await api('/api/colaboradores', { method: 'POST', body: { nome } }); $('#cfg-novo-colab').value = '';
  await carregarColabs(); carregarConfig();
});
$('#cfg-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  let faixas; try { faixas = JSON.parse($('#u-faixas').value); if (!Array.isArray(faixas)) throw 0; } catch { return alert('Faixas: JSON inválido (precisa ser uma lista).'); }
  const num = (s) => Number($(s).value);
  await api('/api/config', { method: 'PUT', body: {
    reembolso: { modo: $('#cfg-modo').value, valor_km: num('#cfg-valor_km') },
    uber: { tarifa_base: num('#u-tarifa_base'), por_km: num('#u-por_km'), por_min: num('#u-por_min'), taxa_reserva: num('#u-taxa_reserva'), tarifa_minima: num('#u-tarifa_minima'), mult_padrao: num('#u-mult_padrao'), faixas },
    taxi: { bandeirada: num('#t-bandeirada'), km_bandeira1: num('#t-km_bandeira1'), km_bandeira2: num('#t-km_bandeira2'), hora_parada: num('#t-hora_parada'), bandeira2_de: $('#t-bandeira2_de').value, bandeira2_ate: $('#t-bandeira2_ate').value, velocidade_fluxo_kmh: num('#t-velocidade_fluxo_kmh') },
  } });
  $('#cfg-ok').classList.remove('oculto'); setTimeout(() => $('#cfg-ok').classList.add('oculto'), 2000);
});

// ---------- init ----------
(async () => {
  $('#data').value = hoje();
  const d = new Date(); $('#hora').value = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  [$('#v-de').value, $('#v-ate').value] = mesAtual(0);
  [$('#d-de').value, $('#d-ate').value] = mesAtual(0);
  $('#d-data').value = hoje();
  [$('#r-de').value, $('#r-ate').value] = mesAtual(0);
  const st = await api('/api/status').catch(() => ({}));
  $('#aviso-chave').classList.toggle('oculto', !!st.google_key);
  await carregarColabs();
  const aba = location.hash.replace('#', '');
  if (['viagens', 'despesas', 'relatorio', 'config'].includes(aba)) mostrarAba(aba);
})();
