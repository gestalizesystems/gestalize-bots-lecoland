// Bot de atendimento — WhatsApp Cloud API (oficial da Meta).
// 1) Sobe o servidor (painel + webhook) — a Meta envia as mensagens pro /webhook.
// 2) Triagem por palavra-chave / menus; perguntas livres caem na IA (Gemini).

require("dotenv").config();

const { iniciarAdmin } = require("./admin");
const conversa = require("./conversa");
const wa = require("./wa");
const estado = require("./estado");
const config = require("./config");

const PORTA = process.env.PORT || process.env.ADMIN_PORT || 4500;

if (!process.env.GEMINI_API_KEY) {
  console.error("❌ Falta a variável GEMINI_API_KEY (chave do Google Gemini).");
}

// As respostas saem pela Cloud API.
conversa.configurar(
  (para, texto) => wa.enviarTexto(para, texto),
  (para, link, legenda) => wa.enviarImagem(para, link, legenda)
);
estado.whatsappConectado = wa.configurado();

iniciarAdmin(PORTA).then(() => {
  console.log("✅ Servidor no ar — painel + webhook do WhatsApp Cloud API.");
  console.log(`   Webhook: <sua-URL-pública>/webhook`);
  console.log(`   Bot no painel: ${config.get().botAtivo ? "LIGADO 🟢" : "DESLIGADO ⚪"}`);
  if (!wa.configurado()) {
    console.warn("⚠️  WhatsApp Cloud API ainda não configurado.");
    console.warn("    Defina WHATSAPP_TOKEN, WHATSAPP_PHONE_ID e WHATSAPP_VERIFY_TOKEN no .env (veja MIGRACAO.md).");
  }
});

process.on("SIGINT", () => {
  console.log("\n👋 Encerrando...");
  process.exit(0);
});
