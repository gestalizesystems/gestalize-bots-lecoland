// Painel de administração: pequeno servidor web (só na sua máquina) que serve
// a página public/admin.html e lê/grava o data/config.json. Roda no mesmo
// processo do bot, então salvar já reflete nas respostas (sem reiniciar).

const express = require("express");
const path = require("path");
const fs = require("fs");
const config = require("./config");

const UPLOAD_DIR = path.join(__dirname, "..", "public", "uploads");

// Validação leve: garante que as seções e tipos básicos existem antes de gravar,
// para um envio malformado não corromper o config.json.
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
  app.use(express.json({ limit: "8mb" })); // maior para aceitar o upload da logo (base64)
  app.use(express.static(path.join(__dirname, "..", "public")));

  // Raiz "/" → abre o painel.
  app.get("/", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "admin.html")));

  // Devolve a configuração atual.
  app.get("/api/config", (req, res) => res.json(config.get()));

  // Salva a configuração enviada pelo painel.
  app.post("/api/config", (req, res) => {
    try {
      const novo = validar(req.body);
      config.salvar(novo);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, erro: e.message });
    }
  });

  // Recebe a logo da loja (data URL base64), salva como arquivo em public/uploads
  // e grava o caminho em negocio.logo.
  app.post("/api/logo", (req, res) => {
    try {
      const dataUrl = (req.body && req.body.dataUrl) || "";
      const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/.exec(dataUrl);
      if (!m) throw new Error("Imagem inválida.");
      const ext = m[1] === "jpeg" ? "jpg" : m[1];
      const buf = Buffer.from(m[2], "base64");
      if (buf.length > 5 * 1024 * 1024) throw new Error("Imagem muito grande (máx 5MB).");

      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      // remove logos anteriores
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

  return new Promise((resolve) => {
    // Bind em 127.0.0.1 → acessível só localmente, no seu Mac.
    const server = app.listen(porta, "127.0.0.1", () => {
      console.log(`🛠️  Painel de administração: http://localhost:${porta}`);
      resolve(server);
    });
  });
}

module.exports = { iniciarAdmin };
