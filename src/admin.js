// Painel de administração: servidor web (só na sua máquina) com tela de login.
// Serve a página, lê/grava o data/config.json, recebe a logo e gerencia a conta.

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const config = require("./config");
const conta = require("./conta");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads");

// Sessões em memória: token -> instante de expiração (ms). Some ao reiniciar.
const sessoes = new Map();
const SESSAO_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

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
  if (!Array.isArray(c.servicos)) throw new Error('"servicos" deve ser uma lista.');
  if (!Array.isArray(c.faqRapido)) throw new Error('"faqRapido" deve ser uma lista.');
  if (!Array.isArray(c.entrega.taxas)) throw new Error('"entrega.taxas" deve ser uma lista.');
  return c;
}

function iniciarAdmin(porta) {
  const app = express();
  app.use(express.json({ limit: "8mb" }));

  // A logo e a imagem do robô são públicas (aparecem na tela de login).
  app.use("/uploads", express.static(UPLOAD_DIR));
  app.get("/robot.png", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "robot.png")));

  // ---- Rotas públicas (login) ----
  app.get("/login", (req, res) => {
    if (estaLogado(req)) return res.redirect("/");
    res.sendFile(path.join(PUBLIC_DIR, "login.html"));
  });

  app.post("/api/login", (req, res) => {
    const { email, senha } = req.body || {};
    if (conta.verifica(email || "", senha || "")) {
      const sid = crypto.randomBytes(24).toString("hex");
      sessoes.set(sid, Date.now() + SESSAO_MS);
      res.setHeader("Set-Cookie", `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSAO_MS / 1000}`);
      return res.json({ ok: true });
    }
    res.status(401).json({ ok: false, erro: "E-mail ou senha incorretos." });
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
    const server = app.listen(porta, "127.0.0.1", () => {
      console.log(`🛠️  Painel de administração: http://localhost:${porta}`);
      resolve(server);
    });
  });
}

module.exports = { iniciarAdmin };
