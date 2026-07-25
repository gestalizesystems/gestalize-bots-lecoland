// Cliente da WhatsApp Cloud API (oficial da Meta).
// Envia mensagens via Graph API. As credenciais podem vir de duas fontes:
//   1) conexão pela COEXISTÊNCIA no painel (Embedded Signup) — preferida;
//   2) .env (WHATSAPP_TOKEN / WHATSAPP_PHONE_ID) — fallback.
// Assim, quando a loja conecta o número pelo painel, o bot passa a usá-lo sem redeploy.

const onboard = require("./waonboard");

const ENV_TOKEN = process.env.WHATSAPP_TOKEN;
const ENV_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const VERSAO = process.env.WHATSAPP_API_VERSION || "v21.0";

// Credenciais em uso agora: prefere as conectadas pelo painel; cai pro .env.
function cred() {
  const c = onboard.getCredenciais();
  if (c && c.token && c.phoneId) return { token: c.token, phoneId: c.phoneId };
  return { token: ENV_TOKEN, phoneId: ENV_PHONE_ID };
}

function configurado() {
  const { token, phoneId } = cred();
  return !!(token && phoneId);
}

async function enviar(payload) {
  const { token, phoneId } = cred();
  if (!token || !phoneId) throw new Error("WhatsApp Cloud API não configurado (conecte pelo painel ou defina WHATSAPP_TOKEN/WHATSAPP_PHONE_ID).");
  const url = `https://graph.facebook.com/${VERSAO}/${phoneId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...payload }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`WhatsApp API ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json();
}

// Corrige o "9º dígito" dos celulares brasileiros: o WhatsApp entrega o número do
// remetente sem o 9 (ex.: 55 85 8735-3914). Para responder, reinserimos o 9.
function normalizarNumero(numero) {
  const n = String(numero).replace(/\D/g, "");
  // 55 + DDD(2) + 8 dígitos de celular (sem o 9) → insere o 9 depois do DDD.
  if (n.length === 12 && n.startsWith("55") && /[6-9]/.test(n[4])) {
    return n.slice(0, 4) + "9" + n.slice(4);
  }
  return n;
}

async function enviarTexto(para, texto) {
  return enviar({ to: normalizarNumero(para), type: "text", text: { preview_url: true, body: String(texto).slice(0, 4096) } });
}

async function enviarImagem(para, link, legenda) {
  const image = { link };
  if (legenda) image.caption = String(legenda).slice(0, 1024);
  return enviar({ to: normalizarNumero(para), type: "image", image });
}

// Envia um TEMPLATE aprovado na Meta (chega a qualquer hora, fora da janela de 24h).
async function enviarTemplate(para, nome, idioma, componentes) {
  const template = { name: nome, language: { code: idioma || "pt_BR" } };
  if (Array.isArray(componentes) && componentes.length) template.components = componentes;
  return enviar({ to: normalizarNumero(para), type: "template", template });
}

// Baixa uma mídia recebida (áudio/imagem) pela Graph API. Retorna { buffer, mimeType }.
async function baixarMidia(mediaId) {
  const { token } = cred();
  if (!token) throw new Error("WhatsApp Cloud API não configurado.");
  const meta = await fetch(`https://graph.facebook.com/${VERSAO}/${mediaId}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!meta.ok) throw new Error("Falha ao obter mídia (" + meta.status + ")");
  const info = await meta.json();
  const bin = await fetch(info.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!bin.ok) throw new Error("Falha ao baixar mídia (" + bin.status + ")");
  const buffer = Buffer.from(await bin.arrayBuffer());
  return { buffer, mimeType: info.mime_type || "audio/ogg" };
}

module.exports = { configurado, enviarTexto, enviarImagem, enviarTemplate, baixarMidia };
