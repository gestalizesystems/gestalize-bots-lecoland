// Cria um template de mensagem no WhatsApp (Meta) usando o token do .env.
// Uso: node scripts/criar-template-meta.js [nome] ["corpo da mensagem"]
// Descobre o WABA ID pelo token (ou usa WHATSAPP_WABA_ID se definido no .env).

require("dotenv").config();

const TOKEN = process.env.WHATSAPP_TOKEN;
const VERSAO = process.env.WHATSAPP_API_VERSION || "v21.0";

async function descobrirWaba() {
  if (process.env.WHATSAPP_WABA_ID) return process.env.WHATSAPP_WABA_ID;
  const r = await fetch(`https://graph.facebook.com/${VERSAO}/debug_token?input_token=${TOKEN}&access_token=${TOKEN}`);
  const j = await r.json();
  const scopes = (j.data && j.data.granular_scopes) || [];
  for (const s of scopes) {
    if (/whatsapp_business_(messaging|management)/.test(s.scope || "") && Array.isArray(s.target_ids) && s.target_ids.length) {
      return s.target_ids[0];
    }
  }
  return null;
}

async function main() {
  if (!TOKEN) throw new Error("WHATSAPP_TOKEN ausente no .env");
  const waba = await descobrirWaba();
  if (!waba) throw new Error("Não achei o WABA ID. Defina WHATSAPP_WABA_ID no .env (Meta → WhatsApp → Configuração da API → 'ID da conta do WhatsApp Business').");

  const nome = process.argv[2] || "novidades_lecoland";
  const corpo = process.argv[3] ||
    "Olá! 🐾 Aqui é a Lecoland. Temos novidades e promoções esperando por você! Se quiser saber mais, é só responder esta mensagem. 🐶🐱";

  const body = {
    name: nome,
    category: "MARKETING",
    language: "pt_BR",
    allow_category_change: true,
    components: [
      { type: "BODY", text: corpo },
      { type: "FOOTER", text: "Responda SAIR para não receber mais mensagens." },
    ],
  };

  const r = await fetch(`https://graph.facebook.com/${VERSAO}/${waba}/message_templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  console.log("WABA ID:", waba);
  console.log("Status HTTP:", r.status);
  console.log("Resposta:", JSON.stringify(j, null, 2));
  if (j.id) console.log(`\n✅ Template "${nome}" criado e enviado para aprovação da Meta.`);
}

main().catch((e) => { console.error("ERRO:", e.message); process.exit(1); });
