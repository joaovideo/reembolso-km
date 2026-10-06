'use strict';
// Cliente das APIs do Google Maps Platform usadas pelo app.
// A chave fica só no servidor (variável GOOGLE_MAPS_API_KEY).

const KEY = process.env.GOOGLE_MAPS_API_KEY || '';

// Centro expandido de São Paulo — viés para o autocomplete.
const SP_CENTER = { latitude: -23.5505, longitude: -46.6333 };

function exigirChave() {
  if (!KEY || KEY === 'COLE_AQUI_A_CHAVE') {
    const e = new Error('GOOGLE_MAPS_API_KEY não configurada. Veja README → "Chave do Google Maps".');
    e.status = 503; e.code = 'SEM_CHAVE';
    throw e;
  }
}

async function post(url, body, fieldMask) {
  exigirChave();
  const headers = { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY };
  if (fieldMask) headers['X-Goog-FieldMask'] = fieldMask;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json?.error?.message || text.slice(0, 300);
    const e = new Error(`Google ${res.status}: ${msg}`);
    e.status = 502; e.code = 'GOOGLE'; e.detalhe = json?.error;
    throw e;
  }
  return json;
}

// Places API (New) — Autocomplete
async function autocomplete(input, sessionToken) {
  const body = {
    input,
    languageCode: 'pt-BR',
    regionCode: 'BR',
    includedRegionCodes: ['br'],
    locationBias: { circle: { center: SP_CENTER, radius: 50000 } },
  };
  if (sessionToken) body.sessionToken = sessionToken;
  const json = await post('https://places.googleapis.com/v1/places:autocomplete', body);
  return (json.suggestions || [])
    .map((s) => s.placePrediction)
    .filter(Boolean)
    .map((p) => ({
      place_id: p.placeId,
      descricao: p.text?.text || '',
      principal: p.structuredFormat?.mainText?.text || p.text?.text || '',
      secundario: p.structuredFormat?.secondaryText?.text || '',
    }));
}

function waypoint(w) {
  if (w.place_id) return { placeId: w.place_id };
  return { address: w.endereco };
}

// Routes API v2 — computeRoutes
// `departure` (Date) só é enviado se estiver no futuro; o Google rejeita horários passados.
async function rota(origem, destino, departure) {
  const body = {
    origin: waypoint(origem),
    destination: waypoint(destino),
    travelMode: 'DRIVE',
    languageCode: 'pt-BR',
    regionCode: 'BR',
    units: 'METRIC',
    polylineQuality: 'OVERVIEW',
  };
  if (departure && departure.getTime() > Date.now() + 60_000) {
    body.routingPreference = 'TRAFFIC_AWARE';
    body.departureTime = departure.toISOString();
  } else {
    body.routingPreference = 'TRAFFIC_UNAWARE';
  }
  const mask = 'routes.distanceMeters,routes.duration,routes.staticDuration,routes.polyline.encodedPolyline,routes.description,routes.legs.startLocation,routes.legs.endLocation';
  const json = await post('https://routes.googleapis.com/directions/v2:computeRoutes', body, mask);
  const r = json.routes?.[0];
  if (!r) {
    const e = new Error('O Google não encontrou rota entre os dois endereços.');
    e.status = 422; e.code = 'SEM_ROTA';
    throw e;
  }
  const seg = (s) => Number(String(s || '0s').replace('s', ''));
  return {
    metros: r.distanceMeters,
    km: Math.round(r.distanceMeters / 10) / 100,
    segundos: seg(r.duration) || seg(r.staticDuration),
    minutos: Math.round((seg(r.duration) || seg(r.staticDuration)) / 60),
    polyline: r.polyline?.encodedPolyline || '',
    descricao: r.description || '',
    inicio: r.legs?.[0]?.startLocation?.latLng || null,
    fim: r.legs?.[r.legs.length - 1]?.endLocation?.latLng || null,
  };
}

module.exports = { autocomplete, rota, temChave: () => !!KEY && KEY !== 'COLE_AQUI_A_CHAVE' };
