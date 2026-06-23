// Cálculo de distância a partir de um endereço, usando o OpenRouteService (gratuito).
// 1) geocodifica o endereço (texto → coordenadas)
// 2) mede a distância de carro entre a loja e o endereço
// 3) devolve as taxas calculadas para essa distância (cálculo determinístico no config.js)

const config = require("./config");

const ORS_KEY = process.env.ORS_API_KEY;
const BASE = "https://api.openrouteservice.org";

let origemCache = null; // { lat, lon, endereco } — evita geocodificar a loja toda hora

function temChave() {
  return !!ORS_KEY;
}

// Texto → coordenadas. `focus` (coords da loja) ajuda a desambiguar bairros.
async function geocode(endereco, focus) {
  let url = `${BASE}/geocode/search?api_key=${ORS_KEY}&text=${encodeURIComponent(endereco)}&boundary.country=BR&size=1`;
  if (focus) url += `&focus.point.lon=${focus.lon}&focus.point.lat=${focus.lat}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("geocode HTTP " + r.status);
  const j = await r.json();
  const f = j.features && j.features[0];
  if (!f) return null;
  const [lon, lat] = f.geometry.coordinates;
  return { lat, lon, label: f.properties.label, confidence: f.properties.confidence };
}

// Coordenadas da loja (ponto de partida). Usa lat/lon do config se houver;
// senão geocodifica o endereço de partida e guarda em cache.
async function getOrigem() {
  const e = (config.get().entrega && config.get().entrega.origem) || {};
  if (e.lat != null && e.lon != null) return { lat: e.lat, lon: e.lon };
  if (origemCache && origemCache.endereco === e.endereco) return origemCache;
  const enderecoLoja = e.endereco || config.get().negocio.endereco;
  const g = await geocode(enderecoLoja);
  if (!g) throw new Error("não foi possível localizar o endereço da loja: " + enderecoLoja);
  origemCache = { lat: g.lat, lon: g.lon, endereco: e.endereco };
  return origemCache;
}

// Distância de carro (km) entre dois pontos.
async function distanciaKm(o, d) {
  const url = `${BASE}/v2/directions/driving-car?api_key=${ORS_KEY}&start=${o.lon},${o.lat}&end=${d.lon},${d.lat}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("directions HTTP " + r.status);
  const j = await r.json();
  const dist = j.features && j.features[0] && j.features[0].properties.summary.distance;
  if (dist == null) return null;
  return Math.round((dist / 1000) * 10) / 10; // km com 1 casa
}

// Função chamada pela IA (function calling): endereço → distância + taxas.
async function consultarTaxaPorEndereco(endereco) {
  if (!temChave()) return { erro: "geolocalizacao_indisponivel" };
  try {
    const origem = await getOrigem();
    const destino = await geocode(endereco, origem);
    if (!destino) return { encontrado: false };
    const km = await distanciaKm(origem, destino);
    if (km == null) return { encontrado: false };
    return {
      encontrado: true,
      endereco_reconhecido: destino.label,
      distancia_km: km,
      taxas: config.calcularTaxas(km),
      observacao:
        "Táxi Dog é ida e volta. Em 'taxas', valor null significa distância acima da área de cobertura daquele serviço — nesse caso oriente o cliente a confirmar com um atendente.",
    };
  } catch (e) {
    return { erro: "falha_geolocalizacao", detalhe: String((e && e.message) || e) };
  }
}

module.exports = { consultarTaxaPorEndereco, temChave };
