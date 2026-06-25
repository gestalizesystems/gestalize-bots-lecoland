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
const config = require("./config");
const estado = require("./estado");

const ADMIN_PORT = process.env.PORT || process.env.ADMIN_PORT || 4500;

if (!process.env.GEMINI_API_KEY) {
  console.error("❌ Falta a variável GEMINI_API_KEY. Copie .env.example para .env e preencha a chave gratuita do Google (https://aistudio.google.com/apikey).");
  process.exit(1);
}

// Contatos pausados (atendimento humano em andamento) → o bot fica em silêncio.
// Em memória mesmo (some ao reiniciar o processo).
const pausados = new Map(); // contactId -> { timer, ultimaMsg }
const aguardandoFecho = new Map(); // contactId -> { timer } (após o "posso ajudar em algo mais?")
const menuContexto = new Map(); // contactId -> opções do menu atual (p/ resolver o número escolhido)

const PAUSA_SILENCIO_MS = 60 * 60 * 1000; // handoff → "posso ajudar?" após 1h de silêncio do cliente
const SEM_RESPOSTA_MS = 2 * 60 * 60 * 1000; // sem resposta ao "posso ajudar?" em 2h → finaliza
const LIMITE_REENGAJAR_MS = 24 * 60 * 60 * 1000; // não reengaja conversas paradas há +24h

// Frases curtas que indicam que o cliente encerrou ("não, obrigado", etc.).
const FECHO_PALAVRAS = ["nao", "no", "obrigado", "obrigada", "obg", "vlw", "valeu", "era so isso", "so isso", "so isso mesmo", "era isso", "isso mesmo", "tudo certo", "ok", "blz", "beleza", "nada mais", "agradecido", "grato", "grata", "por enquanto so"];

function normaliza(t) {
  return (t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}
function ehFecho(t) {
  const n = normaliza(t);
  if (!n || n.length > 28) return false;
  return FECHO_PALAVRAS.some((p) => n === p || n.includes(p));
}

// Inicia/reinicia a pausa: o bot some por 1h de silêncio do cliente.
function pausar(contactId) {
  const atual = pausados.get(contactId);
  if (atual && atual.timer) clearTimeout(atual.timer);
  const timer = setTimeout(() => aoSilenciar(contactId), PAUSA_SILENCIO_MS);
  pausados.set(contactId, { timer, ultimaMsg: Date.now() });
}

// Após 1h sem mensagens do cliente: reengaja uma única vez (se dentro de 24h).
async function aoSilenciar(contactId) {
  const p = pausados.get(contactId);
  pausados.delete(contactId);
  if (!p || Date.now() - p.ultimaMsg > LIMITE_REENGAJAR_MS) return;
  try {
    await client.sendMessage(contactId, "Posso te ajudar em mais alguma coisa? 😊");
    // Sem resposta em 2h → finaliza sozinho e não volta mais.
    const timer = setTimeout(() => finalizar(contactId, true), SEM_RESPOSTA_MS);
    aguardandoFecho.set(contactId, { timer });
  } catch (e) {
    console.error("Falha ao reengajar:", e.message);
  }
}

// Encerra o atendimento: limpa estado e histórico (próximo contato = atendimento novo).
async function finalizar(contactId, enviarDespedida) {
  const f = aguardandoFecho.get(contactId);
  if (f && f.timer) clearTimeout(f.timer);
  aguardandoFecho.delete(contactId);
  menuContexto.delete(contactId);
  limparHistorico(contactId);
  if (enviarDespedida) {
    try {
      await client.sendMessage(contactId, "Atendimento finalizado, qualquer coisa é só chamar! 🐾");
    } catch (e) {
      console.error("Falha ao finalizar:", e.message);
    }
  }
}

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
client.on("ready", () => { estado.whatsappConectado = true; console.log("✅ Bot da Lecoland conectado e pronto!"); });
client.on("auth_failure", (msg) => { estado.whatsappConectado = false; console.error("❌ Falha de autenticação:", msg); });
client.on("disconnected", (reason) => { estado.whatsappConectado = false; console.warn("⚠️  Desconectado:", reason); });

client.on("message", async (msg) => {
  try {
    // Ignora grupos, status e mensagens sem texto (áudio/imagem/etc.).
    if (msg.from.endsWith("@g.us") || msg.isStatus) return;
    if (msg.type !== "chat" || !msg.body) return;

    // Bot desligado no painel → não responde nada (continua conectado, só em silêncio).
    if (!config.get().botAtivo) return;

    const contactId = msg.from;

    // Atendimento humano em andamento: o bot fica quieto e só reinicia o cronômetro
    // de silêncio a cada mensagem do cliente (não interrompe a conversa).
    if (pausados.has(contactId)) {
      pausar(contactId);
      return;
    }

    // Resposta ao "Posso te ajudar em mais alguma coisa?".
    if (aguardandoFecho.has(contactId)) {
      if (ehFecho(msg.body)) {
        await finalizar(contactId, false);
        await msg.reply("Atendimento finalizado, qualquer coisa é só chamar! 🐾");
        console.log(`[finalizado] ${contactId} → cliente encerrou`);
        return;
      }
      // Cliente trouxe algo novo → encerra esse ciclo e começa um atendimento novo.
      await finalizar(contactId, false);
    }

    const ctx = menuContexto.get(contactId) || null;
    const resultado = triar(msg.body, ctx);
    if ("novoContexto" in resultado) {
      if (resultado.novoContexto && resultado.novoContexto.length) menuContexto.set(contactId, resultado.novoContexto);
      else menuContexto.delete(contactId);
    }

    if (resultado.tipo === "atendente") {
      await msg.reply(resultado.resposta);
      pausar(contactId);
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
    const r = await responder(contactId, msg.body);
    await msg.reply(r.texto);

    // A IA decidiu que precisa de um atendente humano → pausa o bot de verdade.
    // (Não limpamos o histórico aqui: a conversa fica preservada para o atendente.)
    if (r.encaminhar) {
      pausar(contactId);
      console.log(`[ia→atendente] ${contactId}: ${r.motivo || "(sem motivo)"}`);
    } else {
      console.log(`[ia] ${contactId}: "${msg.body.slice(0, 60)}"`);
    }
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
