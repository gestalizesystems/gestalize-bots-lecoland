// Bot de triagem do WhatsApp para a Lecoland.
// 1) Conecta via QR code (whatsapp-web.js)
// 2) Triagem por palavra-chave (banho, veterinário, horário, etc.)
// 3) Perguntas livres caem na IA gratuita do Google Gemini, ancorada nos dados do negócio.

require("dotenv").config();

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");

const { triar } = require("./triage");
const { responder, limparHistorico } = require("./ai");
const { iniciarAdmin } = require("./admin");

const ADMIN_PORT = process.env.ADMIN_PORT || 3000;

if (!process.env.GEMINI_API_KEY) {
  console.error("❌ Falta a variável GEMINI_API_KEY. Copie .env.example para .env e preencha a chave gratuita do Google (https://aistudio.google.com/apikey).");
  process.exit(1);
}

// Contatos com atendimento humano ativo → o bot fica em silêncio.
// Em produção, troque por um banco/redis; aqui é em memória mesmo.
const emAtendimentoHumano = new Set();

// Quanto tempo o bot fica pausado depois de pedir atendente (ms). Padrão: 1h.
const PAUSA_HUMANO_MS = 60 * 60 * 1000;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: ".wwebjs_auth" }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

client.on("qr", (qr) => {
  console.log("\n📲 Escaneie o QR code abaixo no WhatsApp (Aparelhos conectados → Conectar aparelho):\n");
  qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => console.log("🔐 Autenticado."));
client.on("ready", () => console.log("✅ Bot da Lecoland conectado e pronto!"));
client.on("auth_failure", (msg) => console.error("❌ Falha de autenticação:", msg));
client.on("disconnected", (reason) => console.warn("⚠️  Desconectado:", reason));

client.on("message", async (msg) => {
  try {
    // Ignora grupos, status e mensagens sem texto (áudio/imagem/etc.).
    if (msg.from.endsWith("@g.us") || msg.isStatus) return;
    if (msg.type !== "chat" || !msg.body) return;

    const contactId = msg.from;

    // Se está em atendimento humano, o bot não responde.
    if (emAtendimentoHumano.has(contactId)) return;

    const resultado = triar(msg.body);

    if (resultado.tipo === "atendente") {
      emAtendimentoHumano.add(contactId);
      limparHistorico(contactId);
      setTimeout(() => emAtendimentoHumano.delete(contactId), PAUSA_HUMANO_MS);
      await msg.reply(resultado.resposta);
      console.log(`[atendente] ${contactId} → repassado para humano`);
      return;
    }

    if (resultado.resposta) {
      await msg.reply(resultado.resposta);
      console.log(`[${resultado.tipo}${resultado.chave ? ":" + resultado.chave : ""}] ${contactId}`);
      return;
    }

    // tipo === "ia": pergunta livre.
    const chat = await msg.getChat();
    await chat.sendStateTyping();
    const texto = await responder(contactId, msg.body);
    await msg.reply(texto);
    console.log(`[ia] ${contactId}: "${msg.body.slice(0, 60)}"`);
  } catch (err) {
    console.error("Erro ao processar mensagem:", err);
    try {
      await msg.reply("Ops, tive um probleminha aqui 😣. Pode tentar de novo? Ou digite *atendente* para falar com uma pessoa.");
    } catch (_) {
      /* ignora falha no envio do fallback */
    }
  }
});

// Sobe o painel de administração (web) e, em seguida, conecta o WhatsApp.
iniciarAdmin(ADMIN_PORT)
  .then(() => client.initialize())
  .catch((err) => {
    console.error("Erro ao iniciar o painel:", err);
    client.initialize();
  });

process.on("SIGINT", async () => {
  console.log("\n👋 Encerrando o bot...");
  await client.destroy();
  process.exit(0);
});
