// Cálculo de distância a partir de um endereço, usando o Google Maps Platform.
// 1) geocodifica o endereço (texto → coordenadas)
// 2) mede a distância de carro entre a loja e o endereço
// 3) devolve as taxas calculadas para essa distância (cálculo determinístico no config.js)

const config = require("./config");

const GMAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
const MAX_RAIO_KM = 50; // só aceita endereços dentro desse raio da loja (evita matches errados em outra cidade)

let origemCache = null; // { lat, lon, endereco } — evita geocodificar a loja toda hora

function temChave() {
  return !!GMAPS_KEY;
}

// Texto → coordenadas. `focus` (coords da loja) ajuda a desambiguar bairros/ruas de mesmo nome
// em outra cidade — usado como viés de região (bounds), não como filtro rígido (o Geocoding API
// do Google não tem um "raio estrito" como o ORS; a distância real é validada depois, em km).
async function geocode(endereco, focus) {
  let url = `https://maps.googleapis.com/maps/api/geocode/json?key=${GMAPS_KEY}&address=${encodeURIComponent(endereco)}&region=br&components=country:BR`;
  if (focus) {
    // ~0.5 grau (±55km) de viés ao redor da loja — ajuda o Google a preferir o resultado certo
    // quando existe rua/bairro de mesmo nome em outra cidade.
    const d = 0.5;
    url += `&bounds=${focus.lat - d},${focus.lon - d}|${focus.lat + d},${focus.lon + d}`;
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error("geocode HTTP " + r.status);
  const j = await r.json();
  if (j.status !== "OK" && j.status !== "ZERO_RESULTS") throw new Error("geocode status " + j.status + (j.error_message ? ": " + j.error_message : ""));
  const f = j.results && j.results[0];
  if (!f) return null;
  return {
    lat: f.geometry.location.lat,
    lon: f.geometry.location.lng,
    label: f.formatted_address,
    locationType: f.geometry.location_type, // ROOFTOP | RANGE_INTERPOLATED | GEOMETRIC_CENTER | APPROXIMATE
    types: f.types || [],
  };
}

// location_type ROOFTOP/RANGE_INTERPOLATED/GEOMETRIC_CENTER = casou com endereço/rua/local
// específico. APPROXIMATE geralmente é só bairro/cidade (área grande demais) — usar essa
// coordenada como se fosse o endereço exato dá uma distância/taxa sem garantia nenhuma de
// precisão (ex.: rua sem cobertura no mapa vira silenciosamente "o bairro vizinho errado").
function ehPreciso(g) {
  return !!g && g.locationType !== "APPROXIMATE";
}

// Remove acentos/pontuação e deixa minúsculo — pra comparar bairro sem depender de grafia exata.
function normTxt(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Extrai o bairro que o cliente informou — assume o formato "rua, número, bairro"
// (é o formato que o prompt pede pra IA confirmar/enviar). Sem vírgula não dá pra
// isolar o bairro com segurança, então não valida nesse caso.
function extrairBairroInformado(endereco) {
  const partes = String(endereco || "").split(",").map((p) => p.trim()).filter(Boolean);
  if (partes.length < 2) return null;
  return partes[partes.length - 1];
}

const _BAIRRO_STOPWORDS = new Set(["parque", "jardim", "conjunto", "residencial", "cidade", "vila", "loteamento"]);

// O geocodificador às vezes casa a rua só pelo texto e devolve um bairro diferente
// do que o cliente informou (ruas de mesmo nome em bairros vizinhos) — mesmo com
// location_type preciso. Se o bairro devolvido não bate nem por aproximação com o que o
// cliente disse, não dá pra confiar na coordenada pra calcular a taxa.
function bairroConfere(bairroInformado, label) {
  if (!bairroInformado) return true; // não isolamos um bairro no texto → não valida
  const alvo = normTxt(bairroInformado);
  if (!alvo) return true;
  const labelNorm = normTxt(label);
  if (labelNorm.includes(alvo)) return true;
  const palavras = alvo.split(" ").filter((w) => w.length > 3 && !_BAIRRO_STOPWORDS.has(w));
  return palavras.length > 0 && palavras.some((w) => labelNorm.includes(w));
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
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?key=${GMAPS_KEY}&units=metric&mode=driving&origins=${o.lat},${o.lon}&destinations=${d.lat},${d.lon}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("distancematrix HTTP " + r.status);
  const j = await r.json();
  if (j.status !== "OK") throw new Error("distancematrix status " + j.status + (j.error_message ? ": " + j.error_message : ""));
  const el = j.rows && j.rows[0] && j.rows[0].elements && j.rows[0].elements[0];
  if (!el || el.status !== "OK" || el.distance == null) return null;
  return Math.round((el.distance.value / 1000) * 10) / 10; // km com 1 casa
}

// Função chamada pela IA (function calling): endereço → distância + taxas.
async function consultarTaxaPorEndereco(endereco) {
  if (!temChave()) return { erro: "geolocalizacao_indisponivel" };
  try {
    const origem = await getOrigem();
    const destino = await geocode(endereco, origem);
    if (!destino) return { encontrado: false };
    // Achou alguma coisa, mas só em nível de bairro/cidade (rua não mapeada) — não dá pra
    // calcular uma taxa confiável a partir disso. Não inventa: pede confirmação humana.
    if (!ehPreciso(destino)) {
      return { encontrado: false, baixaPrecisao: true, areaAproximada: destino.label };
    }
    // Rua encontrada com precisão alta, mas em bairro diferente do que o cliente
    // informou (colisão de nome de rua entre bairros vizinhos) — mesmo risco de taxa
    // errada que a baixa precisão acima, então trata igual: não inventa, pede confirmação.
    if (!bairroConfere(extrairBairroInformado(endereco), destino.label)) {
      return { encontrado: false, baixaPrecisao: true, areaAproximada: destino.label };
    }
    const km = await distanciaKm(origem, destino);
    if (km == null || km > MAX_RAIO_KM) return { encontrado: false }; // fora da área / endereço suspeito
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
