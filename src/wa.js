// Cliente da WhatsApp Cloud API (oficial da Meta).
// Envia mensagens via Graph API. Precisa de WHATSAPP_TOKEN e WHATSAPP_PHONE_ID no .env.

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const VERSAO = process.env.WHATSAPP_API_VERSION || "v21.0";

function configurado() {
  return !!(TOKEN && PHONE_ID);
}

async function enviar(payload) {
  if (!configurado()) throw new Error("WhatsApp Cloud API não configurado (WHATSAPP_TOKEN/WHATSAPP_PHONE_ID).");
  const url = `https://graph.facebook.com/${VERSAO}/${PHONE_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
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
  if (!configurado()) throw new Error("WhatsApp Cloud API não configurado.");
  const meta = await fetch(`https://graph.facebook.com/${VERSAO}/${mediaId}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!meta.ok) throw new Error("Falha ao obter mídia (" + meta.status + ")");
  const info = await meta.json();
  const bin = await fetch(info.url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!bin.ok) throw new Error("Falha ao baixar mídia (" + bin.status + ")");
  const buffer = Buffer.from(await bin.arrayBuffer());
  return { buffer, mimeType: info.mime_type || "audio/ogg" };
}

module.exports = { configurado, enviarTexto, enviarImagem, enviarTemplate, baixarMidia };
