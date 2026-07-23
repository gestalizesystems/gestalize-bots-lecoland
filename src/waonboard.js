// Onboarding do WhatsApp via Embedded Signup da Meta (com COEXISTÊNCIA).
// Guarda as credenciais obtidas (token + phone_number_id + waba_id) num arquivo
// persistente (Volume do Railway), pra o bot passar a usar o número da loja
// SEM precisar de redeploy. Os IDs do App e a config do Embedded Signup vêm do .env:
//   META_APP_ID, META_APP_SECRET, META_ES_CONFIG_ID

const fs = require("fs");
const path = require("path");

const DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const CAMINHO = path.join(DIR, "wa-credenciais.json");
const GRAPH = "https://graph.facebook.com";

const APP_ID = process.env.META_APP_ID || "";
const APP_SECRET = process.env.META_APP_SECRET || "";
const ES_CONFIG_ID = process.env.META_ES_CONFIG_ID || "";
const VERSAO = process.env.WHATSAPP_API_VERSION || "v21.0";

let cache;

function carregar() {
  if (cache !== undefined) return cache;
  try { cache = JSON.parse(fs.readFileSync(CAMINHO, "utf8")); }
  catch (_) { cache = null; }
  return cache;
}

// Credenciais conectadas pelo painel (ou null se ainda não conectou pela coexistência).
function getCredenciais() { return carregar(); }

function salvarCredenciais(creds) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(CAMINHO, JSON.stringify(creds, null, 2), "utf8");
  cache = creds;
  return creds;
}

function limparCredenciais() {
  try { fs.unlinkSync(CAMINHO); } catch (_) {}
  cache = null;
}

// O Embedded Signup está pronto pra usar? (precisa do App ID + config no .env)
function embeddedPronto() { return !!(APP_ID && ES_CONFIG_ID); }

// Dados públicos que o front precisa pra iniciar o SDK (NUNCA inclui o App Secret).
function configPublica() {
  return { appId: APP_ID, configId: ES_CONFIG_ID, graphVersion: VERSAO, pronto: embeddedPronto() };
}

// Troca o "code" do Embedded Signup por um token de acesso do negócio (server-side).
async function trocarCodePorToken(code) {
  if (!APP_ID || !APP_SECRET) throw new Error("META_APP_ID / META_APP_SECRET não configurados no .env.");
  const url = `${GRAPH}/${VERSAO}/oauth/access_token`
    + `?client_id=${encodeURIComponent(APP_ID)}`
    + `&client_secret=${encodeURIComponent(APP_SECRET)}`
    + `&code=${encodeURIComponent(code)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error("Falha ao trocar código por token: " + ((data.error && data.error.message) || res.status));
  }
  return data.access_token;
}

// Inscreve o NOSSO app nos webhooks da WABA (pra receber as mensagens desse número).
async function inscreverApp(wabaId, token) {
  const res = await fetch(`${GRAPH}/${VERSAO}/${wabaId}/subscribed_apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Falha ao inscrever app na WABA: " + ((data.error && data.error.message) || res.status));
  return data;
}

// Consulta o número (display + nome verificado) só pra confirmar/exibir no painel.
async function infoNumero(phoneId, token) {
  try {
    const res = await fetch(`${GRAPH}/${VERSAO}/${phoneId}?fields=display_phone_number,verified_name,quality_rating`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return await res.json();
  } catch (_) { return {}; }
}

// Lista os números de uma WABA. Na COEXISTÊNCIA o Embedded Signup costuma devolver só o
// waba_id — então buscamos aqui o phone_number_id do número que a loja acabou de autorizar.
async function listarNumeros(wabaId, token) {
  const res = await fetch(`${GRAPH}/${VERSAO}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Falha ao listar números da WABA: " + ((data.error && data.error.message) || res.status));
  return Array.isArray(data.data) ? data.data : [];
}

// Para o featureType whatsapp_business_app_onboarding (coexistência), o postMessage da Meta
// não inclui waba_id. Descobrimos a WABA listando os negócios acessíveis pelo token.
async function descobrirWabaDoToken(token) {
  const res = await fetch(
    `${GRAPH}/${VERSAO}/me/businesses?fields=whatsapp_business_accounts.limit(3){id,phone_numbers.limit(5){id,display_phone_number,verified_name}}&limit=5`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json().catch(() => ({}));
  if (data.data && data.data.length) {
    for (const biz of data.data) {
      const wabas = (biz.whatsapp_business_accounts && biz.whatsapp_business_accounts.data) || [];
      for (const waba of wabas) {
        if (waba.id) {
          const phones = (waba.phone_numbers && waba.phone_numbers.data) || [];
          return { wabaId: waba.id, phoneId: (phones[0] && phones[0].id) || null };
        }
      }
    }
  }
  throw new Error("Não foi possível descobrir a conta do WhatsApp pelo token. Tente novamente.");
}

// Fluxo completo do "Conectar WhatsApp": recebe o code (+ ids) do Embedded Signup, obtém o
// token, inscreve nos webhooks, descobre o número (se não veio) e guarda as credenciais.
async function conectar({ code, wabaId, phoneId }) {
  if (!code) throw new Error("Faltou o 'code' do Embedded Signup.");
  const token = await trocarCodePorToken(code);

  if (!wabaId) {
    // Coexistência: featureType whatsapp_business_app_onboarding não retorna waba_id no postMessage.
    const desc = await descobrirWabaDoToken(token);
    wabaId = desc.wabaId;
    if (!phoneId && desc.phoneId) phoneId = desc.phoneId;
  }

  await inscreverApp(wabaId, token);

  let numero = "", nomeVerificado = "";
  if (!phoneId) {
    // Coexistência: o front só recebeu o waba_id → busca o número na conta.
    const nums = await listarNumeros(wabaId, token);
    if (!nums.length) throw new Error("Nenhum número encontrado na conta. Confirme a autorização no app do WhatsApp Business (versão 2.24.17+).");
    phoneId = nums[0].id; numero = nums[0].display_phone_number || ""; nomeVerificado = nums[0].verified_name || "";
  } else {
    const info = await infoNumero(phoneId, token);
    numero = info.display_phone_number || ""; nomeVerificado = info.verified_name || "";
  }

  return salvarCredenciais({
    token, phoneId, wabaId, numero, nomeVerificado,
    conectadoEm: new Date().toISOString(), coexistencia: true,
  });
}

module.exports = {
  getCredenciais, salvarCredenciais, limparCredenciais,
  embeddedPronto, configPublica, conectar, infoNumero, VERSAO,
};
