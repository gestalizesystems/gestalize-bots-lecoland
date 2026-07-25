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
const clientes = require("./clientes");
const nps = require("./nps");
const atendimentos = require("./atendimentos");
const equipe = require("./equipe");
const metricas = require("./metricas");
const campanhas = require("./campanhas");
const wa = require("./wa");
const ai = require("./ai");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

// Baixa o áudio recebido, transcreve com a IA e processa como se fosse texto.
async function processarAudio(from, mediaId, nomeWpp) {
  try {
    const { buffer, mimeType } = await wa.baixarMidia(mediaId);
    const texto = await ai.transcreverAudio(buffer.toString("base64"), mimeType);
    if (texto && texto.trim()) {
      // Eco da transcrição: confirma o que o bot entendeu (visível pra cliente e atendente no chat).
      try { await wa.enviarTexto(from, `🎤 _Entendi seu áudio:_ "${texto.trim()}"`); } catch (_) {}
      await conversa.processar(from, texto.trim(), nomeWpp);
    } else {
      try { await wa.enviarTexto(from, "Desculpa, não consegui entender o áudio 🙏 Pode me mandar por texto?"); } catch (_) {}
    }
  } catch (e) {
    console.error("Falha ao processar áudio:", e.message);
  }
}

// Lê um documento recebido (ex.: PDF de receita), extrai os medicamentos e processa como texto.
async function processarDocumento(from, mediaId, mimeType, nomeWpp) {
  try {
    const { buffer, mimeType: mt } = await wa.baixarMidia(mediaId);
    try { await wa.enviarTexto(from, "📄 Recebi seu documento! Já vou verificar os itens. 🐾"); } catch (_) {}
    const lista = await ai.lerDocumento(buffer.toString("base64"), mt || mimeType);
    if (lista && lista.toUpperCase() !== "NENHUM") {
      await conversa.processar(from, `Mandei uma receita com estes itens: ${lista}. Quais vocês têm e quanto custa cada um?`, nomeWpp);
    } else {
      await conversa.processar(from, "Enviei um documento (receita). Vocês conseguem ver e me passar os valores?", nomeWpp);
    }
  } catch (e) {
    console.error("Falha ao processar documento:", e.message);
  }
}

// Cliente mandou uma FOTO (ex.: print de anúncio do Instagram): identifica o produto e responde.
async function processarImagem(from, mediaId, caption, nomeWpp) {
  try {
    const { buffer, mimeType } = await wa.baixarMidia(mediaId);
    const produto = await ai.identificarProdutoImagem(buffer.toString("base64"), mimeType, caption);
    let texto;
    if (produto && produto.toUpperCase() !== "NENHUM") {
      texto = `O cliente enviou uma FOTO de um produto: ${produto}.${caption ? ` Ele escreveu: "${caption}".` : ""} Busque no catálogo e passe as informações/valor. Se não tiver exatamente, mande opções parecidas.`;
    } else if (caption && caption.trim()) {
      texto = caption.trim();
    } else {
      texto = "O cliente mandou uma foto mas não deu pra identificar o produto. Pergunte gentilmente o que ele procura.";
    }
    await conversa.processar(from, texto, nomeWpp);
  } catch (e) {
    console.error("Falha ao processar imagem:", e.message);
  }
}

// Monta um aviso de contexto quando a mensagem vem de um anúncio (Instagram/Facebook).
function contextoAnuncio(ref) {
  if (!ref) return "";
  const ad = [ref.headline, ref.body].filter(Boolean).join(" — ");
  if (!ad) return "";
  return `(O cliente veio de um anúncio do Instagram/Facebook sobre: "${ad}". Reconheça o produto/serviço do anúncio e passe as informações.) `;
}
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

// Sessões persistidas em arquivo (sobrevivem a redeploys do Railway): token -> expiração (ms).
const SESSOES_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const SESSOES_FILE = path.join(SESSOES_DIR, "sessoes.json");
const sessoes = new Map();
const SESSAO_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
(function carregarSessoes() {
  try {
    const obj = JSON.parse(fs.readFileSync(SESSOES_FILE, "utf8"));
    const agora = Date.now();
    for (const [sid, exp] of Object.entries(obj)) if (exp > agora) sessoes.set(sid, exp);
  } catch (_) { /* ainda não há arquivo de sessões */ }
})();
function salvarSessoes() {
  try {
    fs.mkdirSync(SESSOES_DIR, { recursive: true });
    fs.writeFileSync(SESSOES_FILE, JSON.stringify(Object.fromEntries(sessoes)), "utf8");
  } catch (e) { console.error("Falha ao salvar sessões:", e.message); }
}

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
  // Nomes de arquivo são únicos por upload → pode cachear forte (carrega 1x e não "some" mais).
  app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "30d", immutable: true }));
  app.get("/robot.png", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "robot.png")));
  app.get("/favicon.ico", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "robot.png")));
  app.get("/og-gestalize.png", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "og-gestalize.png")));
  app.get("/og-gestalize-wide.png", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "og-gestalize-wide.png")));
  // Ícone de "adicionar à tela inicial" (PWA): manifest + ícones, públicos.
  app.get("/manifest.webmanifest", (req, res) => { res.type("application/manifest+json"); res.sendFile(path.join(PUBLIC_DIR, "manifest.webmanifest")); });
  app.get("/icon-192.png", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "icon-192.png")));
  app.get("/icon-512.png", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "icon-512.png")));

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
      salvarSessoes();
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
          const val = ch.value || {};
          const nomes = {};
          for (const ct of val.contacts || []) if (ct.wa_id) nomes[ct.wa_id] = ct.profile && ct.profile.name;
          for (const msg of val.messages || []) {
            const nomeWpp = nomes[msg.from] || Object.values(nomes)[0]; // nome do perfil do WhatsApp
            const ctxAd = contextoAnuncio(msg.referral); // veio de anúncio do Instagram/Facebook?
            if (msg.type === "text" && msg.text) {
              conversa.processar(msg.from, ctxAd + (msg.text.body || ""), nomeWpp).catch((e) => console.error("Erro ao processar mensagem:", e.message));
            } else if (msg.type === "image" && msg.image && msg.image.id) {
              processarImagem(msg.from, msg.image.id, (ctxAd + (msg.image.caption || "")).trim(), nomeWpp).catch((e) => console.error("Erro na imagem:", e.message));
            } else if (msg.type === "audio" && msg.audio && msg.audio.id) {
              processarAudio(msg.from, msg.audio.id, nomeWpp).catch((e) => console.error("Erro no áudio:", e.message));
            } else if (msg.type === "document" && msg.document && msg.document.id) {
              processarDocumento(msg.from, msg.document.id, msg.document.mime_type, nomeWpp).catch((e) => console.error("Erro no documento:", e.message));
            }
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
    if (sid) { sessoes.delete(sid); salvarSessoes(); }
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

  // Garante a estrutura do catálogo no config em memória.
  function catalogoDe(c) {
    if (!c.catalogo || typeof c.catalogo !== "object") c.catalogo = { grupos: [], subgrupos: [], especificacoes: [], produtos: [] };
    if (!Array.isArray(c.catalogo.produtos)) c.catalogo.produtos = [];
    return c.catalogo;
  }

  // Salva/atualiza UM produto (evita reenviar o catálogo inteiro).
  app.post("/api/catalogo/produto", (req, res) => {
    try {
      const prod = req.body && req.body.produto;
      if (!prod || !prod.id || !prod.nome) throw new Error("Produto inválido.");
      const c = config.get();
      const cat = catalogoDe(c);
      const i = cat.produtos.findIndex((p) => p.id === prod.id);
      if (i > -1) cat.produtos[i] = prod;
      else cat.produtos.unshift(prod);
      config.salvar(c);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, erro: e.message });
    }
  });

  // Remove UM produto.
  app.post("/api/catalogo/produto/remover", (req, res) => {
    try {
      const id = req.body && req.body.id;
      const c = config.get();
      const cat = catalogoDe(c);
      cat.produtos = cat.produtos.filter((p) => p.id !== id);
      config.salvar(c);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, erro: e.message });
    }
  });

  // Atualiza só a taxonomia (grupos/subgrupos/especificações) — preserva os produtos.
  app.post("/api/catalogo/taxonomia", (req, res) => {
    try {
      const { grupos, subgrupos, especificacoes } = req.body || {};
      const c = config.get();
      const cat = catalogoDe(c);
      if (Array.isArray(grupos)) cat.grupos = grupos;
      if (Array.isArray(subgrupos)) cat.subgrupos = subgrupos;
      if (Array.isArray(especificacoes)) cat.especificacoes = especificacoes;
      config.salvar(c);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, erro: e.message });
    }
  });

  // ---- Clientes (memória do bot: nome, telefone, endereço) ----
  app.get("/api/clientes", (req, res) => res.json({ ok: true, clientes: clientes.listar() }));
  app.post("/api/clientes", (req, res) => {
    try {
      const { telefone, nome, endereco, pets, tags, notas, etapa, cpf } = req.body || {};
      const tel = String(telefone || "").replace(/\D/g, "");
      if (!tel) throw new Error("Telefone obrigatório.");
      res.json({ ok: true, cliente: clientes.definir(tel, { nome, endereco, pets, tags, notas, etapa, cpf }) });
    } catch (e) {
      res.status(400).json({ ok: false, erro: e.message });
    }
  });
  // ---- NPS (satisfação) ----
  app.get("/api/nps", (req, res) => {
    const raw = Number(req.query.dias);
    const desde = raw === 0 ? 0 : Date.now() - Math.max(1, Math.min(3650, raw || 90)) * 24 * 60 * 60 * 1000;
    const respostas = nps.listar(desde).map((r) => {
      const cli = clientes.get(r.telefone);
      return { id: r.id, telefone: r.telefone, nome: (cli && cli.nome) || "", nota: r.nota, comentario: r.comentario || "", data: r.data };
    });
    res.json({ ok: true, resumo: nps.resumo(desde), respostas });
  });

  // ---- Atendimentos (fila de handoff com resumo da IA) ----
  app.get("/api/atendimentos", (req, res) => {
    res.json({ ok: true, pendentes: atendimentos.pendentes() });
  });
  app.post("/api/atendimentos/resolver", (req, res) => {
    atendimentos.resolver((req.body && req.body.id) || "");
    res.json({ ok: true, pendentes: atendimentos.pendentes() });
  });

  // ---- Equipe / colaboradores ----
  app.get("/api/equipe", (req, res) => res.json({ ok: true, equipe: equipe.listar() }));
  app.post("/api/equipe", (req, res) => {
    try {
      const { id, nome, cargo, obs } = req.body || {};
      if (!String(nome || "").trim()) throw new Error("Informe o nome do colaborador.");
      res.json({ ok: true, membro: equipe.salvar({ id, nome, cargo, obs }) });
    } catch (e) { res.status(400).json({ ok: false, erro: e.message }); }
  });
  app.post("/api/equipe/remover", (req, res) => {
    equipe.remover((req.body && req.body.id) || "");
    res.json({ ok: true, equipe: equipe.listar() });
  });

  // ---- Métricas reais (dashboard) ----
  app.get("/api/metricas", (req, res) => {
    res.json({ ok: true, ...metricas.resumo(req.query.dias) });
  });

  // ---- Campanhas (mensagens ativas) ----
  app.get("/api/campanhas", (req, res) => res.json({ ok: true, campanhas: campanhas.listar() }));
  app.post("/api/campanhas/contar", (req, res) => {
    res.json({ ok: true, total: campanhas.audiencia((req.body && req.body.audiencia) || {}).length });
  });
  app.post("/api/campanhas/enviar", (req, res) => {
    try {
      const { modo, mensagem, template, idioma, audiencia } = req.body || {};
      if (!wa.configurado()) throw new Error("WhatsApp Cloud API não configurado.");
      if (modo === "template") { if (!String(template || "").trim()) throw new Error("Informe o nome do template aprovado."); }
      else if (!String(mensagem || "").trim()) throw new Error("Escreva a mensagem da campanha.");
      const camp = campanhas.enviar({ modo, mensagem, template, idioma, audiencia });
      res.json({ ok: true, campanha: camp });
    } catch (e) {
      res.status(400).json({ ok: false, erro: e.message });
    }
  });

  app.post("/api/clientes/remover", (req, res) => {
    try {
      clientes.remover(String((req.body && req.body.telefone) || "").replace(/\D/g, ""));
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
