// Painel de administração: servidor web (só na sua máquina) com tela de login.
// Serve a página, lê/grava o data/config.json, recebe a logo e gerencia a conta.

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const config = require("./config");
const conta = require("./conta");
const estado = require("./estado");
const conversa = require("./conversa");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
// Em produção (Railway) as imagens vão para o Volume persistente; local usa public/uploads.
const UPLOAD_DIR = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "uploads") : path.join(PUBLIC_DIR, "uploads");

// Na 1ª vez no Volume, copia as imagens versionadas (ex.: logo.png) para o destino persistente.
function semearUploads() {
  if (!process.env.DATA_DIR) return; // local já usa public/uploads diretamente
  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const origem = path.join(PUBLIC_DIR, "uploads");
    if (!fs.existsSync(origem)) return;
    for (const f of fs.readdirSync(origem)) {
      const dest = path.join(UPLOAD_DIR, f);
      if (!fs.existsSync(dest)) fs.copyFileSync(path.join(origem, f), dest);
    }
  } catch (e) {
    console.error("Falha ao semear uploads:", e.message);
  }
}

// Sessões em memória: token -> instante de expiração (ms). Some ao reiniciar.
const sessoes = new Map();
const SESSAO_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

// Proteção contra força-bruta no login: tentativas por IP.
const tentativas = new Map(); // ip -> { fails, lockUntil }
const MAX_TENTATIVAS = 5;
const BLOQUEIO_MS = 15 * 60 * 1000; // bloqueia por 15 min após exceder
function ipDe(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || (req.socket && req.socket.remoteAddress) || "?";
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function estaLogado(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return false;
  const exp = sessoes.get(sid);
  if (!exp || exp < Date.now()) {
    if (sid) sessoes.delete(sid);
    return false;
  }
  return true;
}

// Validação leve da configuração antes de gravar.
function validar(c) {
  if (!c || typeof c !== "object") throw new Error("Configuração inválida.");
  const obrig = ["negocio", "mensagens", "servicos", "faqRapido", "entrega", "gatilhosAtendente", "gatilhosSaudacao"];
  for (const k of obrig) {
    if (!(k in c)) throw new Error(`Faltou a seção "${k}".`);
  }
  if (typeof c.negocio !== "object") throw new Error('"negocio" deve ser um objeto.');
  if (!Array.isArray(c.mensagensExtras)) c.mensagensExtras = [];
  if (!Array.isArray(c.menus)) c.menus = [];
  if (typeof c.infoIA !== "string") c.infoIA = "";
  if (typeof c.botAtivo !== "boolean") c.botAtivo = config.get().botAtivo === true; // preserva o liga/desliga
  if (!c.expediente || typeof c.expediente !== "object") c.expediente = config.get().expediente || { ativo: false }; // horário/ausência
  // Preserva o catálogo quando o "Salvar tudo" não o envia (ele tem endpoint próprio).
  if (!c.catalogo || typeof c.catalogo !== "object") {
    c.catalogo = config.get().catalogo || { grupos: [], subgrupos: [], especificacoes: [], produtos: [] };
  }
  if (!Array.isArray(c.servicos)) throw new Error('"servicos" deve ser uma lista.');
  if (!Array.isArray(c.faqRapido)) throw new Error('"faqRapido" deve ser uma lista.');
  if (!Array.isArray(c.entrega.taxas)) throw new Error('"entrega.taxas" deve ser uma lista.');
  return c;
}

function iniciarAdmin(porta) {
  const app = express();
  app.set("trust proxy", 1); // atrás do proxy do Railway: respeita x-forwarded-for/proto
  app.use(express.json({ limit: "8mb" }));

  semearUploads();

  // A logo e a imagem do robô são públicas (aparecem na tela de login).
  app.use("/uploads", express.static(UPLOAD_DIR));
  app.get("/robot.png", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "robot.png")));
  app.get("/favicon.ico", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "robot.png")));
  app.get("/og-gestalize.png", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "og-gestalize.png")));

  // ---- Rotas públicas (login) ----
  app.get("/login", (req, res) => {
    if (estaLogado(req)) return res.redirect("/");
    res.sendFile(path.join(PUBLIC_DIR, "login.html"));
  });

  app.post("/api/login", (req, res) => {
    const ip = ipDe(req);
    const reg = tentativas.get(ip);
    if (reg && reg.lockUntil && reg.lockUntil > Date.now()) {
      const min = Math.ceil((reg.lockUntil - Date.now()) / 60000);
      return res.status(429).json({ ok: false, erro: `Muitas tentativas. Tente novamente em ${min} min.` });
    }
    const { email, senha } = req.body || {};
    if (conta.verifica(email || "", senha || "")) {
      tentativas.delete(ip);
      const sid = crypto.randomBytes(24).toString("hex");
      sessoes.set(sid, Date.now() + SESSAO_MS);
      const secure = req.secure ? "; Secure" : ""; // só em HTTPS (Railway); não quebra o localhost
      res.setHeader("Set-Cookie", `sid=${sid}; HttpOnly; Path=/; SameSite=Lax${secure}; Max-Age=${SESSAO_MS / 1000}`);
      return res.json({ ok: true });
    }
    const r = reg || { fails: 0, lockUntil: 0 };
    r.fails += 1;
    if (r.fails >= MAX_TENTATIVAS) { r.lockUntil = Date.now() + BLOQUEIO_MS; r.fails = 0; }
    tentativas.set(ip, r);
    res.status(401).json({ ok: false, erro: "E-mail ou senha incorretos." });
  });

  // ---- Webhook do WhatsApp Cloud API (público — a Meta chama aqui) ----
  // Verificação (a Meta faz um GET ao configurar o webhook).
  app.get("/webhook", (req, res) => {
    const esperado = process.env.WHATSAPP_VERIFY_TOKEN || "";
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === esperado) {
      return res.status(200).send(req.query["hub.challenge"]);
    }
    res.sendStatus(403);
  });
  // Recebimento de mensagens (a Meta faz POST a cada mensagem).
  app.post("/webhook", (req, res) => {
    res.sendStatus(200); // responde rápido; processa em seguida
    try {
      for (const entry of (req.body && req.body.entry) || []) {
        for (const ch of entry.changes || []) {
          for (const msg of (ch.value && ch.value.messages) || []) {
            if (msg.type !== "text" || !msg.text) continue;
            conversa.processar(msg.from, msg.text.body || "").catch((e) => console.error("Erro ao processar mensagem:", e.message));
          }
        }
      }
    } catch (e) {
      console.error("Erro no webhook:", e.message);
    }
  });

  // ---- A partir daqui, exige login ----
  app.use((req, res, next) => {
    if (estaLogado(req)) return next();
    if (req.path.startsWith("/api/")) return res.status(401).json({ ok: false, erro: "Não autenticado." });
    return res.redirect("/login");
  });

  app.post("/api/logout", (req, res) => {
    const sid = parseCookies(req).sid;
    if (sid) sessoes.delete(sid);
    res.setHeader("Set-Cookie", "sid=; HttpOnly; Path=/; Max-Age=0");
    res.json({ ok: true });
  });

  // Painel
  app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin.html")));

  // Configuração do bot
  app.get("/api/config", (req, res) => res.json(config.get()));
  app.post("/api/config", (req, res) => {
    try {
      config.salvar(validar(req.body));
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, erro: e.message });
    }
  });

  // Logo (data URL base64 -> arquivo)
  app.post("/api/logo", (req, res) => {
    try {
      const dataUrl = (req.body && req.body.dataUrl) || "";
      const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/.exec(dataUrl);
      if (!m) throw new Error("Imagem inválida.");
      const ext = m[1] === "jpeg" ? "jpg" : m[1];
      const buf = Buffer.from(m[2], "base64");
      if (buf.length > 5 * 1024 * 1024) throw new Error("Imagem muito grande (máx 5MB).");
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      for (const f of fs.readdirSync(UPLOAD_DIR)) {
        if (f.startsWith("logo.")) fs.unlinkSync(path.join(UPLOAD_DIR, f));
      }
      const nome = `logo.${ext}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, nome), buf);
      const rel = `/uploads/${nome}`;
      const c = config.get();
      c.negocio = c.negocio || {};
      c.negocio.logo = rel;
      config.salvar(c);
      res.json({ ok: true, path: rel });
    } catch (e) {
      res.status(400).json({ ok: false, erro: e.message });
    }
  });

  // Catálogo (tem endpoint próprio para salvar só essa seção, sem mexer no resto).
  app.post("/api/catalogo", (req, res) => {
    try {
      const cat = req.body || {};
      const c = config.get();
      c.catalogo = {
        grupos: Array.isArray(cat.grupos) ? cat.grupos : [],
        subgrupos: Array.isArray(cat.subgrupos) ? cat.subgrupos : [],
        especificacoes: Array.isArray(cat.especificacoes) ? cat.especificacoes : [],
        produtos: Array.isArray(cat.produtos) ? cat.produtos : [],
      };
      config.salvar(c);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, erro: e.message });
    }
  });

  // Imagem de produto (data URL base64 -> arquivo em /uploads).
  app.post("/api/catalogo/imagem", (req, res) => {
    try {
      const dataUrl = (req.body && req.body.dataUrl) || "";
      const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/.exec(dataUrl);
      if (!m) throw new Error("Imagem inválida.");
      const ext = m[1] === "jpeg" ? "jpg" : m[1];
      const buf = Buffer.from(m[2], "base64");
      if (buf.length > 5 * 1024 * 1024) throw new Error("Imagem muito grande (máx 5MB).");
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const nome = `prod-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, nome), buf);
      res.json({ ok: true, path: `/uploads/${nome}` });
    } catch (e) {
      res.status(400).json({ ok: false, erro: e.message });
    }
  });

  // Liga/desliga do bot no WhatsApp + status de conexão.
  app.get("/api/bot", (req, res) => {
    res.json({ ativo: config.get().botAtivo === true, conectado: estado.whatsappConectado === true });
  });
  app.post("/api/bot", (req, res) => {
    try {
      const ativo = !!(req.body && req.body.ativo);
      const c = config.get();
      c.botAtivo = ativo;
      config.salvar(c);
      res.json({ ok: true, ativo, conectado: estado.whatsappConectado === true });
    } catch (e) {
      res.status(400).json({ ok: false, erro: e.message });
    }
  });

  // Status da automação (só booleanos — nunca expõe as chaves).
  app.get("/api/status", (req, res) => {
    res.json({ gemini: !!process.env.GEMINI_API_KEY, ors: !!process.env.ORS_API_KEY });
  });

  // Conta
  app.get("/api/conta", (req, res) => res.json(conta.get()));
  app.post("/api/conta", (req, res) => {
    try {
      res.json({ ok: true, conta: conta.atualizar(req.body || {}) });
    } catch (e) {
      res.status(400).json({ ok: false, erro: e.message });
    }
  });
  app.post("/api/conta/senha", (req, res) => {
    try {
      const { atual, nova } = req.body || {};
      conta.alterarSenha(atual || "", nova || "");
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, erro: e.message });
    }
  });

  return new Promise((resolve) => {
    // No Railway (PORT definido) escuta em 0.0.0.0; localmente fica só em 127.0.0.1.
    const host = process.env.PORT ? "0.0.0.0" : "127.0.0.1";
    const server = app.listen(porta, host, () => {
      console.log(`🛠️  Painel de administração: http://localhost:${porta}`);
      resolve(server);
    });
  });
}

module.exports = { iniciarAdmin };
