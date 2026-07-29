// Lógica de conversa do bot (triagem, menus, IA, handoff), separada do transporte de mensagens.
// O envio é injetado via configurar(fn), onde fn(para, texto) entrega a mensagem (Cloud API).

const fs = require("fs");
const path = require("path");
const { triar, menuPrincipal } = require("./triage");
const { responder, limparHistorico, registrarTurno, resumirConversa } = require("./ai");
const config = require("./config");
const clientes = require("./clientes");
const equipe = require("./equipe");
const nps = require("./nps");
const atendimentos = require("./atendimentos");
const metricas = require("./metricas");

let _enviarTexto = async () => {}; // texto — definido pelo ponto de entrada (Cloud API)
let _enviarImagem = async () => {}; // imagem (link + legenda)
function configurar(fnTexto, fnImagem) {
  if (fnTexto) _enviarTexto = fnTexto;
  if (fnImagem) _enviarImagem = fnImagem;
}
// IDs de mensagens enviadas pelo bot (para distinguir do atendente no webhook de statuses).
const _botMsgIds = new Set();
function _rastrearId(result) {
  try { const id = result && result.messages && result.messages[0] && result.messages[0].id; if (id) { _botMsgIds.add(id); setTimeout(() => _botMsgIds.delete(id), 120000); } } catch (_) {}
}
function ehMsgBot(id) { return _botMsgIds.has(id); }
// Wrappers que contam as mensagens enviadas (métricas do dashboard).
async function enviar(para, texto) { metricas.inc("enviada"); const r = await _enviarTexto(para, texto); _rastrearId(r); return r; }
async function enviarImagem(para, link, legenda) { metricas.inc("enviada"); const r = await _enviarImagem(para, link, legenda); _rastrearId(r); return r; }

// URL pública do painel (pra montar o link das fotos do catálogo no WhatsApp).
const PUBLIC_URL = (process.env.PUBLIC_URL || "https://bots.gestalizesystems.com.br").replace(/\/$/, "");

// Aviso enviado UMA VEZ junto com a saudação do novo cliente (nunca repetido).
const AVISO_SISTEMA = "🔔 Estamos com um novo sistema de atendimento por aqui, ainda em fase de *testes*! Se tiver alguma sugestão, pode deixar no final da conversa. 🐾";

// Envia até 5 produtos achados como foto + nome + preço (formato de catálogo).
async function enviarProdutos(from, produtos) {
  for (const p of (produtos || []).slice(0, 5)) {
    const preco = String(p.preco || "").trim();
    const precoFmt = preco && preco !== "(sob consulta)"
      ? (!/r\$/i.test(preco) && /^[\d.,\s]+$/.test(preco) ? "R$ " + preco : preco)
      : "Sob consulta";
    const legenda = `*${p.nome}*\n💰 ${precoFmt}`;
    try {
      if (p.imagem && /^\/uploads\//.test(p.imagem)) await enviarImagem(from, PUBLIC_URL + p.imagem, legenda);
      else if (p.imagem && /^https?:\/\//i.test(p.imagem)) await enviarImagem(from, p.imagem, legenda);
      else await enviar(from, legenda);
    } catch (e) {
      console.error("Falha ao enviar produto:", e.message);
      try { await enviar(from, legenda); } catch (_) {}
    }
  }
}

// ===== Persistência de sessões (sobrevive a redeploys) ======================
const _DIR_DADOS = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const _SESSOES_PATH = path.join(_DIR_DADOS, "sessoes.json");
const _LIMITE_SESSAO_MS = 24 * 60 * 60 * 1000; // descarta sessões com mais de 24h sem mensagem

// ===== Estado por contato (em memória) =====
const pausados = new Map();            // contactId -> { ultimaMsg }
const ultimaMsgTs = new Map();         // contactId -> timestamp da última mensagem recebida
const aguardandoFecho = new Map();     // contactId -> { timer }
const menuContexto = new Map();        // contactId -> opções do menu atual
const jaSaudou = new Set();            // contatos que já receberam o fluxo de boas-vindas
const aguardandoNome = new Map();      // contactId -> { textoOriginal, rTriagem }
const aguardandoNps = new Map(); // contactId → timestamp em que o NPS foi enviado (persiste em sessoes.json)
const aguardandoNpsComentario = new Map();
const aguardandoGranelEspecie = new Set(); // aguardando o cliente dizer "cão" ou "gato" para granel
const historicoConversa = new Map();

// Restaura estado a partir do snapshot salvo no Volume.
(function restaurarSessoes() {
  try {
    const snap = JSON.parse(fs.readFileSync(_SESSOES_PATH, "utf8"));
    const agora = Date.now();
    // Restaura apenas contatos ativos nas últimas 24h.
    const ativos = new Set(
      Object.entries(snap.ultimaMsgTs || {})
        .filter(([, ts]) => agora - ts < _LIMITE_SESSAO_MS)
        .map(([id]) => id)
    );
    for (const id of (snap.jaSaudou || [])) if (ativos.has(id)) jaSaudou.add(id);
    for (const [id, v] of Object.entries(snap.menuContexto || {})) if (ativos.has(id)) menuContexto.set(id, v);
    for (const [id, v] of Object.entries(snap.historicoConversa || {})) if (ativos.has(id)) historicoConversa.set(id, v);
    for (const [id, ts] of Object.entries(snap.ultimaMsgTs || {})) if (ativos.has(id)) ultimaMsgTs.set(id, ts);
    // NPS: restaura entradas dos últimos 120 min (independente de ultimaMsgTs — finalizar apaga o timestamp)
    const _LIMITE_NPS_MS = 2 * 60 * 60 * 1000;
    for (const [id, ts] of Object.entries(snap.aguardandoNps || {})) {
      if (agora - ts < _LIMITE_NPS_MS) aguardandoNps.set(id, ts);
    }
    const totalRestaurados = ativos.size + aguardandoNps.size;
    if (totalRestaurados) console.log(`[bot] ${totalRestaurados} sessão(ões) restaurada(s) do snapshot.`);
  } catch (_) { /* primeira vez ou arquivo corrompido — começa do zero */ }
  // Restaura pausados a partir dos atendimentos pendentes persistidos.
  for (const a of atendimentos.pendentes()) {
    if (a.telefone) pausados.set(a.telefone, { ultimaMsg: a.atualizadoEm || Date.now() });
  }
  if (pausados.size) console.log(`[bot] ${pausados.size} atendimento(s) em pausa restaurado(s).`);
})();

// Salva snapshot das sessões ativas (debounced — no máximo 1 escrita a cada 3s).
let _saveTimer = null;
function _agendarSalvar() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      fs.mkdirSync(_DIR_DADOS, { recursive: true });
      fs.writeFileSync(_SESSOES_PATH, JSON.stringify({
        ts: Date.now(),
        jaSaudou: [...jaSaudou],
        menuContexto: Object.fromEntries(menuContexto),
        historicoConversa: Object.fromEntries(historicoConversa),
        ultimaMsgTs: Object.fromEntries(ultimaMsgTs),
        aguardandoNps: Object.fromEntries(aguardandoNps),
      }), "utf8");
    } catch (_) {}
  }, 3000);
}
const ausenciaEnviada = new Map();
const AUSENCIA_THROTTLE_MS = 60 * 60 * 1000;
setInterval(() => {
  const expirou = Date.now() - AUSENCIA_THROTTLE_MS;
  for (const [id, ts] of ausenciaEnviada) if (ts < expirou) ausenciaEnviada.delete(id);
}, 12 * 60 * 60 * 1000);
const inatividade = new Map();

// Contatos que existiam ANTES da conexão do bot → bot fica silencioso para eles até
// que enviem uma saudação clara (aí começa uma nova conversa normalmente).
const preBot = new Set();
let preBotIniciado = false;

function garantirPreBot() {
  if (preBotIniciado) return;
  // Lazy: tenta iniciar a cada mensagem até as credenciais estarem disponíveis.
  const waonboard = require("./waonboard");
  const creds = waonboard.getCredenciais();
  if (!creds || !creds.conectadoEm) return;
  preBotIniciado = true;
  for (const c of clientes.listar()) {
    if (c.telefone && !c.preBotClearado) preBot.add(c.telefone);
  }
  if (preBot.size > 0) {
    console.log(`[bot] ${preBot.size} contatos anteriores à conexão marcados como preBot (bot silencioso até saudação).`);
  }
}

const PAUSA_SILENCIO_MS = 60 * 60 * 1000;
const SEM_RESPOSTA_MS = 2 * 60 * 60 * 1000;

const FECHO_PALAVRAS = ["nao", "no", "obrigado", "obrigada", "obg", "vlw", "valeu", "era so isso", "so isso", "so isso mesmo", "era isso", "isso mesmo", "tudo certo", "ok", "blz", "beleza", "nada mais", "agradecido", "grato", "grata", "por enquanto so"];

function normaliza(t) {
  return (t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}
function ehFecho(t) {
  const n = normaliza(t);
  if (!n || n.length > 28) return false;
  return FECHO_PALAVRAS.some((p) => n === p || n.includes(p));
}

// Extrai o nome de uma resposta tipo "Ana", "meu nome é Ana", "sou a Ana Silva".
function extrairNome(texto) {
  if (!texto || /\?/.test(texto)) return "";
  let t = String(texto).trim()
    .replace(/^(meu nome (e|eh|é)|me chamo|pode me chamar de|sou (o|a)|sou|aqui (e|eh|é)|e|eh|é|nome:?)\s+/i, "")
    .replace(/[^\p{L}\s'.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const palavras = t.split(" ").filter(Boolean);
  if (!palavras.length || palavras.length > 3) return "";
  const nome = palavras.join(" ");
  if (nome.length < 2 || nome.length > 40) return "";
  return palavras.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

const DESPEDIDA = ["obrigado", "obrigada", "obg", "brigado", "brigada", "vlw", "valeu", "tchau", "ate mais", "ate logo", "ate breve", "era isso", "era so isso", "so isso", "so isso mesmo", "agradecido", "agradecida", "grato", "grata", "nada mais"];
function ehDespedidaForte(t) {
  const n = normaliza(t);
  if (!n || n.length > 22) return false;
  return DESPEDIDA.some((p) => n === p || n.includes(p));
}

// Detecta espécie (cão/gato) explicitada na mensagem para o fluxo de granel.
function detectarEspecieGranel(texto) {
  const t = normaliza(String(texto || ""));
  if (/\bgat[ao]s?\b|felino|\bcat\b/.test(t)) return "gato";
  if (/\b(cao|caes|cachorro|cachorros|cadela|dog|canino)\b/.test(t)) return "cao";
  return null;
}

// Busca a resposta rápida de granel correta no faqRapido / mensagensExtras.
function buscarRespostaGranel(especie) {
  const dados = config.get();
  const todas = [...(dados.faqRapido || []), ...(dados.mensagensExtras || [])];
  const ehGato = especie === "gato";
  const found = todas.find((x) => {
    const t = normaliza(x.titulo || "");
    const temGranel = t.includes("granel");
    const temEspecie = ehGato
      ? (t.includes("gato") || t.includes("cat") || t.includes("felin"))
      : (t.includes("cao") || t.includes("caes") || t.includes("cach") || t.includes("dog") || t.includes("can"));
    return temGranel && temEspecie;
  });
  return found ? config.preencher(found.resposta) : null;
}

function ehPedidoRepetido(texto) {
  if (!texto) return false;
  const t = normaliza(String(texto));
  return /(ultim[ao]|anterior)\s+(pedido|compra|encomenda)|mesmo\s+pedido|repetir\s+(o\s+|meu\s+)?(pedido|compra)|pedir\s+(de\s+)?novo|igual\s+ao?\s+ultim[ao]|mesm[ao]\s+de\s+(antes|sempre|ontem|semana)|pode\s+repetir|quero\s+o\s+mesmo\b|manda\s+de\s+novo|pedido\s+anterior/.test(t);
}

async function encerrarComNps(from, msgPadrao) {
  if (nps.podePerguntar(from)) {
    nps.marcarPerguntado(from);
    aguardandoNps.set(from, Date.now());
    _agendarSalvar();
    const cli = clientes.get(from);
    const nm = cli && cli.nome ? cli.nome + ", de " : "De ";
    const nomeLoja = config.get().negocio.nome || "a loja";
    await enviar(from, `${msgPadrao}\n\n${nm}0 a 10, o quanto você recomendaria a *${nomeLoja}* a um amigo? 🐾`);
  } else {
    await enviar(from, msgPadrao);
  }
}

async function enviarConviteRedes(from) {
  const n = config.get().negocio || {};
  const insta = String(n.instagram || "").trim();
  const google = String(n.googleReview || "").trim();
  if (!insta && !google) return;
  let msg = "🌟 Se curtiu nosso atendimento, dá uma força pra gente:";
  if (insta) msg += `\n\n📸 Siga no Instagram: ${insta}`;
  if (google) msg += `\n⭐ Avalie no Google: ${google}`;
  msg += "\n\nMuito obrigada! 🐾";
  try { await enviar(from, msg); } catch (e) { console.error("Falha no convite redes:", e.message); }
}

async function abrirHandoff(from, motivo) {
  metricas.inc("handoff");
  try {
    const msgs = (historicoConversa.get(from) || []).slice(-15);
    const cli = clientes.get(from);
    const resumo = await resumirConversa(msgs, motivo);
    atendimentos.registrar({ telefone: from, nome: (cli && cli.nome) || "", resumo, motivo });
  } catch (e) {
    console.error("Falha ao abrir handoff:", e.message);
    atendimentos.registrar({ telefone: from, motivo });
  }
}

function foraDoHorario(dados) {
  const exp = dados.expediente;
  if (!exp || !exp.ativo) return false;
  const tz = exp.timezone || "America/Fortaleza";
  let wd, hh, mm, hoje;
  try {
    const partes = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date());
    wd = partes.find((p) => p.type === "weekday").value;
    hh = +partes.find((p) => p.type === "hour").value;
    mm = +partes.find((p) => p.type === "minute").value;
    hoje = partes.find((p) => p.type === "day").value + "/" + partes.find((p) => p.type === "month").value;
  } catch (_) { return false; }
  if (Array.isArray(exp.feriados) && exp.feriados.includes(hoje)) return true;
  const agora = hh * 60 + mm;
  const faixa = wd === "Sun" ? exp.domingo : wd === "Sat" ? exp.sabado : exp.semana;
  if (!faixa || !faixa.abre || !faixa.fecha) return true;
  const [ah, am] = String(faixa.abre).split(":").map(Number);
  const [fh, fm] = String(faixa.fecha).split(":").map(Number);
  const abre = ah * 60 + am, fecha = fh * 60 + fm;
  return !(agora >= abre && agora < fecha);
}

function agendarInatividade(contactId) {
  const t = inatividade.get(contactId);
  if (t) clearTimeout(t);
  inatividade.set(contactId, setTimeout(() => aoSilenciar(contactId), PAUSA_SILENCIO_MS));
}
function limparInatividade(contactId) {
  const t = inatividade.get(contactId);
  if (t) clearTimeout(t);
  inatividade.delete(contactId);
}

function pausar(contactId) {
  pausados.set(contactId, { ultimaMsg: Date.now() });
  agendarInatividade(contactId);
}
function registrarSessaoAtendente(contactId) {
  pausar(contactId);
}
function retomar(contactId) {
  pausados.delete(contactId);
  limparInatividade(contactId);
}
async function concluirAtendimento(contactId) {
  await finalizar(contactId, false);
  if (equipe.ehFuncionario(contactId)) return; // funcionário: só limpa o estado, sem enviar mensagem
  try {
    await encerrarComNps(contactId, "Atendimento finalizado, qualquer coisa é só chamar! 🐾");
  } catch (e) {
    console.error("Falha ao concluir atendimento:", e.message);
  }
}

async function aoSilenciar(contactId) {
  inatividade.delete(contactId);
  pausados.delete(contactId);
  if (equipe.ehFuncionario(contactId)) return; // não reengaja funcionário
  try {
    await enviar(contactId, "Ainda por aí? 😊 Se precisar de mais alguma coisa, é só me chamar!");
    aguardandoFecho.set(contactId, { timer: setTimeout(() => finalizar(contactId, true), SEM_RESPOSTA_MS) });
  } catch (e) {
    console.error("Falha ao reengajar:", e.message);
  }
}

async function finalizar(contactId, enviarDespedida) {
  limparInatividade(contactId);
  const f = aguardandoFecho.get(contactId);
  if (f && f.timer) clearTimeout(f.timer);
  aguardandoFecho.delete(contactId);
  menuContexto.delete(contactId);
  jaSaudou.delete(contactId);
  aguardandoNome.delete(contactId);
  aguardandoNps.delete(contactId);
  aguardandoNpsComentario.delete(contactId);
  aguardandoGranelEspecie.delete(contactId);
  historicoConversa.delete(contactId);
  ultimaMsgTs.delete(contactId);
  pausados.delete(contactId);
  preBot.delete(contactId); // conversa encerrada → sai do modo pré-bot se estiver lá
  atendimentos.resolver(contactId);
  limparHistorico(contactId);
  _agendarSalvar();
  if (enviarDespedida) {
    try {
      await enviar(contactId, "Atendimento finalizado, qualquer coisa é só chamar! 🐾");
    } catch (e) {
      console.error("Falha ao finalizar:", e.message);
    }
  }
}

// Processa uma mensagem recebida do cliente.
async function processar(from, texto, nomeWpp) {
  // Inicializa preBot na primeira mensagem após as credenciais estarem disponíveis.
  if (!preBotIniciado) garantirPreBot();

  const dados = config.get();
  if (!dados.botAtivo) return;

  // Funcionários cadastrados no painel não recebem mensagens do bot.
  if (equipe.ehFuncionario(from)) {
    // Apaga qualquer dado obsoleto para não aparecer em atendimentos.
    ultimaMsgTs.delete(from);
    jaSaudou.delete(from);
    menuContexto.delete(from);
    aguardandoNome.delete(from);
    aguardandoGranelEspecie.delete(from);
    const f = aguardandoFecho.get(from);
    if (f && f.timer) clearTimeout(f.timer);
    aguardandoFecho.delete(from);
    pausados.delete(from);
    atendimentos.resolver(from);
    return;
  }

  metricas.inc("recebida");
  ultimaMsgTs.set(from, Date.now());
  limparInatividade(from);

  if (texto && String(texto).trim()) {
    const buf = historicoConversa.get(from) || [];
    buf.push(String(texto).trim());
    if (buf.length > 20) buf.splice(0, buf.length - 20);
    historicoConversa.set(from, buf);
  }

  // ── NPS: cliente manda nota ─────────────────────────────────────────────
  if (aguardandoNps.has(from)) {
    aguardandoNps.delete(from);
    ultimaMsgTs.delete(from); // qualquer resposta ao NPS nunca reabre em atendimentos
    const m = String(texto).match(/\b(10|[0-9])\b/);
    if (m) {
      const { nota } = nps.registrar(from, Number(m[1]));
      if (nota <= 6) {
        await enviar(from, "Poxa, sentimos muito pela experiência! 😔 Em breve um atendente vai entrar em contato. 🐾");
      } else {
        await enviar(from, `Obrigada pela nota ${nota}! 💛 Significa muito pra gente. 🐾`);
        await enviarConviteRedes(from);
      }
    }
    return; // absorve qualquer resposta ao NPS (número ou não) sem reprocessar
  }

  // ── NPS comentário (fluxo legado — mantido para conversas em andamento) ──
  if (aguardandoNpsComentario.has(from)) {
    const { id, detrator } = aguardandoNpsComentario.get(from);
    aguardandoNpsComentario.delete(from);
    const pular = /^(ok|nao|não|n|-|pular|nada|nenhum|sem coment\w*|tudo certo|tudo bem)$/i.test(String(texto).trim());
    if (!pular) nps.comentar(id, texto);
    if (detrator) {
      await enviar(from, "Obrigada por compartilhar! 🐾 Vou repassar pra um atendente cuidar disso pra você.");
      pausar(from);
      await abrirHandoff(from, "Cliente deu nota baixa no NPS (detrator)" + (pular ? "." : ": " + String(texto).trim()));
    } else {
      await enviar(from, "Valeu pela avaliação! 💛 Significa muito pra gente. 🐾");
      await enviarConviteRedes(from);
    }
    return;
  }

  // ── Granel: aguardando espécie (cão/gato) ──────────────────────────────
  if (aguardandoGranelEspecie.has(from)) {
    aguardandoGranelEspecie.delete(from);
    const especie = detectarEspecieGranel(texto);
    if (especie) {
      const respostaGranel = buscarRespostaGranel(especie);
      if (respostaGranel) {
        await enviar(from, respostaGranel);
        agendarInatividade(from);
        return;
      }
    }
    // Não identificou a espécie — cai no fluxo normal abaixo
  }

  // ── Fora do horário ─────────────────────────────────────────────────────
  if (foraDoHorario(dados)) {
    const ultimo = ausenciaEnviada.get(from) || 0;
    if (Date.now() - ultimo > AUSENCIA_THROTTLE_MS) {
      ausenciaEnviada.set(from, Date.now());
      try {
        await enviar(from, config.preencher(dados.mensagens.ausencia || "No momento estamos fora do horário de atendimento. Retornamos no horário comercial. 🐾"));
      } catch (e) { console.error("Falha ao enviar ausência:", e.message); }
    }
    return;
  }

  // ── Atendimento humano em andamento ────────────────────────────────────
  if (pausados.has(from)) {
    pausar(from);
    return;
  }

  // ── Resposta ao "Ainda por aí?" ─────────────────────────────────────────
  if (aguardandoFecho.has(from)) {
    if (ehFecho(texto)) {
      await finalizar(from, false);
      await encerrarComNps(from, "Atendimento finalizado, qualquer coisa é só chamar! 🐾");
      return;
    }
    const f = aguardandoFecho.get(from);
    if (f && f.timer) clearTimeout(f.timer);
    aguardandoFecho.delete(from);
  }

  // ── Contatos anteriores à conexão do bot ────────────────────────────────
  // Fica silencioso para quem já estava em atendimento humano antes do bot conectar.
  // Quando o cliente mandar uma saudação, inicia uma conversa nova normalmente.
  if (preBot.has(from)) {
    const rCheck = triar(texto, null);
    if (rCheck.saudacao) {
      preBot.delete(from);
      clientes.salvar(from, { preBotClearado: true });
      // Não retorna → cai no fluxo normal abaixo
    } else {
      return; // silêncio — humano ainda atende
    }
  }

  // ── Despedida clara ──────────────────────────────────────────────────────
  if (ehDespedidaForte(texto)) {
    await finalizar(from, false);
    await encerrarComNps(from, "Por nada, qualquer coisa é só chamar! 🐾");
    return;
  }

  // ── Triagem ──────────────────────────────────────────────────────────────
  const ctx = menuContexto.get(from) || null;
  const r = triar(texto, ctx);
  if ("novoContexto" in r) {
    if (r.novoContexto) menuContexto.set(from, r.novoContexto);
    else menuContexto.delete(from);
  }

  // ── Primeiro contato (ainda não saudou nesta sessão) ────────────────────
  if (!jaSaudou.has(from)) {
    jaSaudou.add(from);
    metricas.inc("atendimento");
    const cli = clientes.get(from);
    const deveAviso = !cli || !cli.avisoEnviado;
    const avisoTexto = deveAviso ? ("\n\n" + AVISO_SISTEMA) : "";

    const nomeCliente = cli && cli.nome ? cli.nome : null;

    if (r.saudacao) {
      // Saudação → menu (personalizado se tiver nome, genérico se não tiver)
      const menu = menuPrincipal(nomeCliente);
      menuContexto.set(from, { opcoes: config.intents(), texto: menu, sub: false });
      const msgBV = config.preencher(dados.mensagens.saudacao || "Olá! 🐾 Seja muito bem-vindo(a) à {nome}!");
      const intro = nomeCliente ? "" : (msgBV + avisoTexto + "\n\n");
      await enviar(from, nomeCliente ? (menu + avisoTexto) : (intro + menu));
      if (deveAviso) clientes.salvar(from, { avisoEnviado: true });
      agendarInatividade(from);
      return;
    }

    // Primeira mensagem é pergunta direta → saudação breve + cai para responder abaixo
    if (nomeCliente) {
      await enviar(from, `Oi, ${nomeCliente}! 🐾` + avisoTexto);
    } else {
      const msgBV = config.preencher(dados.mensagens.saudacao || "Olá! 🐾 Seja muito bem-vindo(a) à {nome}!");
      await enviar(from, msgBV + avisoTexto);
    }
    if (deveAviso) clientes.salvar(from, { avisoEnviado: true });

    if (ehPedidoRepetido(texto)) {
      pausar(from);
      await abrirHandoff(from, "Cliente quer repetir o último pedido.");
      return;
    }
    // Não retorna — responde a pergunta a seguir
  }

  // ── Atendente humano ────────────────────────────────────────────────────
  if (r.tipo === "atendente") {
    await enviar(from, r.resposta);
    pausar(from);
    await abrirHandoff(from, "Cliente pediu para falar com um atendente.");
    return;
  }

  // Saudação em conversa já iniciada — menu foi enviado no início, não repete
  if (r.saudacao) {
    agendarInatividade(from);
    return;
  }

  // ── Granel: responde com a resposta rápida certa sem acionar a IA ────────
  if (r.tipo === "opcao" && /granel/i.test(r.titulo || "")) {
    const especie = detectarEspecieGranel(texto);
    const respostaGranel = especie ? buscarRespostaGranel(especie) : null;
    if (respostaGranel) {
      await enviar(from, respostaGranel);
    } else {
      aguardandoGranelEspecie.add(from);
      await enviar(from, "É para cão ou gato? 🐾");
    }
    agendarInatividade(from);
    return;
  }

  // ── Resposta por palavra-chave ───────────────────────────────────────────
  if (r.resposta) {
    if (r.tipo === "opcao" && /banho|tosa|consult|veterin|vacin/i.test(r.titulo || "")) {
      const cli = clientes.get(from);
      if (!cli || !Array.isArray(cli.pets) || !cli.pets.length) {
        r.resposta += "\n\n🐾 Pra deixar tudo certinho, me diz o *nome* e a *raça* do seu pet?";
      }
    }
    await enviar(from, r.resposta);
    if (r.tipo === "opcao" || r.tipo === "mensagem") {
      const nota = r.titulo ? `(O cliente escolheu: ${r.titulo}.) ` : "";
      registrarTurno(from, texto, nota + r.resposta);
      if (r.titulo) metricas.registrarServico(r.titulo);
    }
    agendarInatividade(from);
    return;
  }

  // ── IA: pergunta livre ───────────────────────────────────────────────────
  if (ehPedidoRepetido(texto)) {
    await enviar(from, config.preencher(dados.mensagens.atendente));
    pausar(from);
    await abrirHandoff(from, "Cliente quer repetir o último pedido.");
    return;
  }
  const resp = await responder(from, texto);
  await enviar(from, (resp.texto || "").trim());
  if (resp.encaminhar) {
    pausar(from);
    await abrirHandoff(from, resp.motivo || "A IA encaminhou para um atendente.");
  } else {
    agendarInatividade(from);
  }
  if (resp.produtos && resp.produtos.length) await enviarProdutos(from, resp.produtos);
  if (resp.respostaGranel) try { await enviar(from, resp.respostaGranel); } catch (e) { console.error("Falha ao enviar granel:", e.message); }
  _agendarSalvar();
}

function conversasAtivas() {
  const todos = new Set([
    ...jaSaudou,
    ...aguardandoNome.keys(),
    ...aguardandoFecho.keys(),
    ...menuContexto.keys(),
    ...pausados.keys(),
  ]);
  // Inclui qualquer contato que mandou mensagem nas últimas 24h,
  // mesmo que o bot tenha ficado silencioso (preBot, fora do horário, etc.)
  const RECENTE_MS = 24 * 60 * 60 * 1000;
  const agora = Date.now();
  for (const [id, ts] of ultimaMsgTs.entries()) {
    if (agora - ts < RECENTE_MS) todos.add(id);
  }
  const pendentesAt = atendimentos.pendentes();
  for (const a of pendentesAt) todos.add(a.telefone);
  const atMap = new Map(pendentesAt.map(a => [a.telefone, a]));
  return Array.from(todos).map(id => {
    const at = atMap.get(id);
    const ts = ultimaMsgTs.get(id)
      || (pausados.get(id) && pausados.get(id).ultimaMsg)
      || (at && at.atualizadoEm) || 0;
    const estado = at ? "aguardando" : pausados.has(id) ? "pausado" : "bot";
    return { contactId: id, estado, ultimaMsgTs: ts, atendimento: at || null };
  }).sort((a, b) => {
    const ord = { aguardando: 0, pausado: 1, bot: 2 };
    return ((ord[a.estado] ?? 3) - (ord[b.estado] ?? 3)) || ((b.ultimaMsgTs || 0) - (a.ultimaMsgTs || 0));
  });
}

module.exports = { configurar, processar, pausar, retomar, concluirAtendimento, registrarSessaoAtendente, ehMsgBot, conversasAtivas };
