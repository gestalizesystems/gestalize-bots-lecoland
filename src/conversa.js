// Lógica de conversa do bot (triagem, menus, IA, handoff), separada do transporte de mensagens.
// O envio é injetado via configurar(fn), onde fn(para, texto) entrega a mensagem (Cloud API).

const fs = require("fs");
const path = require("path");
const { triar, menuPrincipal } = require("./triage");
const { responder, limparHistorico, registrarTurno, resumirConversa, buscarProdutos } = require("./ai");
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

const _dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Roda `fn` até `tentativas` vezes, com um pequeno atraso entre elas — cobre blips
// passageiros (rate limit momentâneo, timeout de rede) que costumam vingar na 2ª tentativa.
async function _comRetry(fn, tentativas = 2, atrasoMs = 700) {
  let ultimoErro;
  for (let t = 0; t < tentativas; t++) {
    try { return await fn(); }
    catch (e) { ultimoErro = e; if (t < tentativas - 1) await _dormir(atrasoMs); }
  }
  throw ultimoErro;
}

// Envia até 5 produtos achados como foto + nome + preço (formato de catálogo).
// Se TODOS os envios falharem (instabilidade da Cloud API, mídia rejeitada etc.), o cliente
// não pode ficar só com a promessa ("achei essas opções") e nada depois — avisa e chama
// um atendente em vez de engolir o erro em silêncio.
async function enviarProdutos(from, produtos) {
  const lista = (produtos || []).slice(0, 5);
  let falharam = 0;
  let ultimoErro = "";
  for (let i = 0; i < lista.length; i++) {
    const p = lista[i];
    // Pequena pausa ENTRE os envios (não antes do 1º) — manda até 5 mensagens em rajada sem
    // isso, o que é uma causa clássica de esbarrar no limite de taxa por segundo da Cloud API
    // do WhatsApp e derrubar os envios seguintes justo depois do texto de introdução já ter
    // sido entregue (o cliente vê "achei essas opções" e nada mais).
    if (i > 0) await _dormir(350);
    const preco = String(p.preco || "").trim();
    const precoFmt = preco && preco !== "(sob consulta)"
      ? (!/r\$/i.test(preco) && /^[\d.,\s]+$/.test(preco) ? "R$ " + preco : preco)
      : "Sob consulta";
    const legenda = `*${p.nome}*\n💰 ${precoFmt}`;
    const linkImagem = p.imagem && /^\/uploads\//.test(p.imagem) ? PUBLIC_URL + p.imagem
      : p.imagem && /^https?:\/\//i.test(p.imagem) ? p.imagem
      : "";
    try {
      // 2 tentativas na chamada principal — resolve a maioria dos blips passageiros sem
      // precisar cair pro fallback (que, na imagem, perde a foto e vira só texto).
      if (linkImagem) await _comRetry(() => enviarImagem(from, linkImagem, legenda));
      else await _comRetry(() => enviar(from, legenda));
    } catch (e) {
      ultimoErro = e.message;
      console.error(`Falha ao enviar produto "${p.nome}":`, e.message);
      // Só tenta de novo como texto se a 1ª tentativa foi por IMAGEM — repetir a mesma
      // chamada de texto que acabou de falhar não teria efeito e mascararia o erro real.
      if (!linkImagem) { falharam++; continue; }
      try {
        await _comRetry(() => enviar(from, legenda));
      } catch (e2) {
        ultimoErro = e2.message;
        console.error(`Falha no fallback de texto pro produto "${p.nome}":`, e2.message);
        falharam++;
      }
    }
  }
  if (lista.length && falharam === lista.length) {
    // Última mensagem antes do handoff — a mais importante de todas — também ganha retry.
    try { await _comRetry(() => enviar(from, "Tive um problema ao carregar as opções aqui 🙈 Um atendente já te ajuda!")); }
    catch (e) { console.error("Falha ao enviar aviso de recuperação:", e.message); }
    pausar(from);
    // Motivo inclui o erro real (status/corpo da Cloud API) — dá pra ver na tela de
    // Atendimentos o que de fato quebrou, sem precisar ir direto no log do servidor.
    await abrirHandoff(from, `Falha ao enviar produtos ao cliente (instabilidade no envio)${ultimoErro ? ": " + ultimoErro : ""}.`);
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
// Janela de validade da pergunta de NPS — depois disso, a próxima mensagem do cliente NÃO é
// mais interpretada como nota (evita, ex.: cliente mandar um áudio no dia seguinte e o bot
// achar que é resposta da pesquisa de satisfação de ontem).
const _LIMITE_NPS_MS = 2 * 60 * 60 * 1000;
const aguardandoNpsComentario = new Map();
const aguardandoGranelEspecie = new Set(); // aguardando o cliente dizer "cão" ou "gato" para granel
const historicoConversa = new Map();
const proximaMsgParaIA = new Set();        // próxima msg desse contato vai direto à IA (bot fez pergunta ou respondeu menu de serviço)

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
    // NPS: restaura entradas dentro da janela de validade (independente de ultimaMsgTs — finalizar apaga o timestamp)
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
  proximaMsgParaIA.delete(contactId);
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
  proximaMsgParaIA.delete(contactId);
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

// Palavras que indicam pergunta de serviço/logística/comparação — nenhum produto do catálogo vai responder.
// Prefixos/palavras que indicam serviço/logística/comparação. SEM \b no final para que prefixos
// como "vacin" casem "vacinar"/"vacinação" e "consult" case "consulta"/"consultar".
const _RE_SERVICO = /\b(banho|tosa|consult|veterin|vacin|castrar|cirurgi|agend|horari|hor[aá]rio|endere[cç]o|funciona|fecha|abre|parcel|pagament|frete|taxi|t[aá]xi|entrega|descont|promoc|indica[cç]|diferen|recomend|comparar|versus|d[uú]vida|qual\s+[eéeh]\s+o\s+melhor|o\s+que\s+[eéeh]\s+melhor|reclama[cç]|n[aã]o\s+foi|n[aã]o\s+voltou|n[aã]o\s+devolveu|esqueceu|esqueceram|perdeu|perderam|sumiu|sumiram|veio\s+errad|veio\s+quebrad|cobr[ao]u\s+errad|verificar|ficou\s+a[ií]|ficou\s+l[aá]|ficou\s+esqu|deixou\s+(?:a[ií]|l[aá])|deixaram\s+(?:a[ií]|l[aá])|n[aã]o\s+devolver|n[aã]o\s+trouxe|n[aã]o\s+entregou|cadê|cade\b|quero\s+reclamar|quero\s+devolver|quero\s+reembolso)/i;

// Pergunta se o PET está pronto/pode ser buscado (serviço presencial em andamento) — o bot NUNCA
// tem visibilidade real disso (não sabe se o banho/tosa/procedimento já terminou), então nunca
// pode confirmar nem negar. Intercepta ANTES da IA pra garantir isso mesmo se o modelo "chutar".
const _RE_STATUS_PET = /\b(t[aá]|est[aá]|ficou|j[aá]\s+ficou|j[aá]\s+est[aá])\s+pront[oa]\b|\bpront[oa]\s+(pra|para)\s+(buscar|ir|voltar|casa|entregar)\b|\bj[aá]\s+(posso|pode)\s+buscar\b|\bposso\s+buscar\b|\bpode\s+buscar\b|\bj[aá]\s+terminou\b|\bterminou\s+(o|a)\s+(banho|tosa)\b|\bj[aá]\s+acabou\s+(o|a)\s+(banho|tosa)\b/i;


// Detecta pedido com itens e quantidades já definidos (ex: "1 saca de pipicat, 2 latas de patê chanin").
// Critério: pelo menos 2 ocorrências de dígito + unidade/item, ou 1 ocorrência + vírgula/quebra separando mais itens.
function _ehPedidoPronto(texto) {
  const t = texto.toLowerCase();
  // Quantidade: dígito OU número por extenso (um/dois/meia etc.) + unidade de medida/embalagem
  const _NUM = "(?:\\d+(?:[,.]\\d+)?|um|uma|dois|duas|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|meia|meio)";
  const unidades = new RegExp(
    "\\b" + _NUM + "\\s*(?:saca|sacos?|fardos?|kg|kilo|quilo|quilos?|gramas?|g\\b|lata|latas?|pote|potes?|pacote|pacotes?|caixa|caixas?|cx|frasco|frascos?|unidade|unidades?|und?|bisnaga|bisnagas?|kit|kits?)",
    "gi"
  );
  const ocorrencias = [...t.matchAll(unidades)];
  // 2+ itens com quantidade → pedido pronto sem dúvida
  if (ocorrencias.length >= 2) return true;
  if (ocorrencias.length === 1) {
    const pos = ocorrencias[0].index;
    const antes = t.slice(0, pos);
    const depois = t.slice(pos + ocorrencias[0][0].length);
    // Há uma lista: separador vírgula ou " e " antes OU depois do item
    if (/,|\se\s/.test(antes) || (/,|\se\s/.test(depois) && depois.length > 10)) return true;
    // Item único com intenção de compra clara
    if (/\b(gostaria|quero|queria|preciso|me\s+manda|pode\s+mandar|poderia\s+(?:mandar|enviar)|manda|pe[cç]o|pedindo|por\s+favor|quero\s+pedir|gostaria\s+de\s+pedir)\b/.test(t)) return true;
  }
  return false;
}

// Processa uma mensagem recebida do cliente.
async function processar(from, _textoRaw, nomeWpp) {
  // \x1F = marcador interno de "citação" (cliente respondeu a uma mensagem anterior do bot)
  const ehCitacao = typeof _textoRaw === "string" && _textoRaw.startsWith("\x1F");
  const texto = ehCitacao ? _textoRaw.slice(1) : (_textoRaw || "");

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
    const enviadoEm = aguardandoNps.get(from);
    if (Date.now() - enviadoEm > _LIMITE_NPS_MS) {
      // Janela expirou (ex.: cliente só respondeu no dia seguinte) — não é mais resposta da
      // pesquisa. Não retorna: a mensagem segue pro fluxo normal de atendimento abaixo.
      aguardandoNps.delete(from);
    } else {
      const t = String(texto || "").trim();
      // Aceita dois formatos: (1) resposta CURTA e OBJETIVA — "8", "nota 9", "10!" — ou
      // (2) nota LOGO NO INÍCIO seguida de pontuação e um comentário — "10, sempre bom preço",
      // "9 - ótimo atendimento". NUNCA extrai um número de dentro de uma frase/pergunta de
      // verdade (ex.: "chega antes das 2 horas" não é nota 2, "2 pacotes de ração" não é nota 2
      // — falta a pontuação logo depois do número) nem de transcrição de áudio.
      const mCurta = t.length <= 12 ? /^(?:nota\s*:?\s*)?(10|[0-9])\s*[!.]?$/i.exec(t) : null;
      const mComComentario = !mCurta ? /^\**\s*(10|[0-9])\s*[-,:.]\s*(.+)$/is.exec(t) : null;
      const m = mCurta || mComComentario;
      if (m) {
        aguardandoNps.delete(from);
        ultimaMsgTs.delete(from); // qualquer resposta ao NPS nunca reabre em atendimentos
        const { id, nota } = nps.registrar(from, Number(m[1]));
        if (mComComentario && mComComentario[2]) nps.comentar(id, mComComentario[2].trim());
        if (nota <= 6) {
          await enviar(from, "Poxa, sentimos muito pela experiência! 😔 Em breve um atendente vai entrar em contato. 🐾");
        } else {
          await enviar(from, `Obrigada pela nota ${nota}! 💛 Significa muito pra gente. 🐾`);
          await enviarConviteRedes(from);
        }
        return;
      }
      // Não parece uma nota (dentro da janela) — mantém aguardando e deixa a mensagem seguir
      // o fluxo normal abaixo (pode ser uma pergunta de verdade, não a resposta da pesquisa).
    }
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

  // ── Pedido pronto: tem prioridade sobre triage e IA ─────────────────────
  if (_ehPedidoPronto(texto)) {
    const msgPedido = config.preencher(dados.mensagens.atendente || "Já vou chamar um atendente! 🐾");
    await enviar(from, msgPedido);
    pausar(from);
    await abrirHandoff(from, "Cliente enviou pedido pronto com itens e quantidades.");
    return;
  }

  // ── Triagem ──────────────────────────────────────────────────────────────
  const ctx = menuContexto.get(from) || null;
  const r = triar(texto, ctx);
  if ("novoContexto" in r) {
    if (r.novoContexto) menuContexto.set(from, r.novoContexto);
    else menuContexto.delete(from);
  }

  // ── Story / Status reply: primeira msg já vem como citação, bot não vê o conteúdo ──
  if (ehCitacao && !jaSaudou.has(from)) {
    const msgAtendente = config.preencher(dados.mensagens.atendente || "Já vou chamar um atendente! 🐾");
    await enviar(from, msgAtendente);
    jaSaudou.add(from);
    pausar(from);
    await abrirHandoff(from, "Cliente respondeu a um story/status sem histórico de conversa.");
    return;
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
    // Detecta espécie pelo TÍTULO da opção (ex: "Granel para Cães") antes de tentar o texto do cliente
    const especie = detectarEspecieGranel(r.titulo || "") || detectarEspecieGranel(texto);
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
    // Bot fez pergunta ou é menu de serviço que abre conversa → próxima msg usa IA com contexto
    if (r.resposta.includes("?") || (r.tipo === "opcao" && /banho|tosa|consult|veterin|loja/i.test(r.titulo || ""))) {
      proximaMsgParaIA.set(from, true);
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

  // ── Produtos que não trabalhamos — resposta direta ───────────────────────
  if (/\binjet[aá]vel\b/i.test(texto) && /\bverm[ei]/i.test(texto)) {
    await enviar(from, "Vermífugo injetável não trabalhamos por aqui 🐾 Temos apenas nas versões *comprimido* ou *líquido*. Quer ver as opções?");
    agendarInatividade(from);
    _agendarSalvar();
    return;
  }
  if (/\banticoncepcional\b/i.test(texto)) {
    await enviar(from, "Anticoncepcional para animais não trabalhamos por aqui 🐾 Para essa necessidade, recomendamos consultar um médico veterinário.");
    agendarInatividade(from);
    _agendarSalvar();
    return;
  }

  // ── Status do pet (pronto/pode buscar?) — NUNCA confirma nem nega, sempre atendente ──────
  if (_RE_STATUS_PET.test(texto)) {
    await enviar(from, "Deixa eu confirmar com um atendente e já te digo! 🐾");
    pausar(from);
    await abrirHandoff(from, "Cliente perguntou se o pet está pronto/pode buscar — confirmar status real.");
    _agendarSalvar();
    return;
  }

  // ── IA: decide buscar produto, responder ou encaminhar ao atendente ───────
  const resp = await responder(from, texto);
  let _textoResp = (resp.texto || "").trim();
  // Se há cards de produtos para enviar, garante que o texto seja só a intro (sem lista duplicada)
  if (resp.produtos && resp.produtos.length) {
    _textoResp = _textoResp.replace(/\n+[•\-\*\d][\s\S]*/g, "").trim();
  }
  // Rede de segurança: IA prometeu produtos ("Achei…", "Encontrei…") mas busca retornou vazio →
  // o texto seria mentira. Encaminha ao atendente silenciosamente.
  if (!resp.encaminhar && (!resp.produtos || !resp.produtos.length) && /\b(achei|encontrei|aqui est[aã]|aqui v[aã]o|seguem as|veja as|essas opç[oõ]es|essas opções|esses produtos)\b/i.test(_textoResp)) {
    await enviar(from, "Deixa eu verificar com um atendente o que temos disponível! 🐾");
    pausar(from);
    await abrirHandoff(from, "Produto não encontrado no catálogo — atendente confirma disponibilidade.");
    _agendarSalvar();
    return;
  }
  // Rede de segurança: IA encaminhou ao atendente E encontrou produtos no mesmo turno — os
  // cards NÃO serão enviados (o atendente assume a partir daqui, ver abaixo), mas se o texto só
  // fala dos produtos ("achei essas opções...") sem mencionar atendente, o cliente fica com a
  // promessa e silêncio total depois. Completa a mensagem pra deixar claro que alguém vai continuar.
  if (resp.encaminhar && resp.produtos && resp.produtos.length && !/atendente/i.test(_textoResp)) {
    _textoResp = (_textoResp ? _textoResp + "\n\n" : "") + "🙋 Vou confirmar os detalhes com um atendente e já te retorno com as opções certas!";
  }
  await enviar(from, _textoResp);
  // Rede de segurança: IA disse "vou chamar um atendente" no texto mas não chamou a função →
  // pausar nunca seria acionado. Detecta o padrão e força o handoff.
  if (!resp.encaminhar && /\bvou\s+(te\s+)?chamar\b.{0,100}\batendentes?\b|\bvou\s+(te\s+)?encaminhar\b|\bchamarei\b/i.test(_textoResp)) {
    resp.encaminhar = true;
    if (!resp.motivo) resp.motivo = "IA prometeu chamar atendente no texto.";
  }
  if (resp.encaminhar) {
    pausar(from); // já limpa proximaMsgParaIA
    await abrirHandoff(from, resp.motivo || "A IA encaminhou para um atendente.");
  } else {
    // IA respondeu → próxima mensagem começa com contexto da IA (melhora acerto)
    proximaMsgParaIA.set(from, true);
    agendarInatividade(from);
  }
  // Quando encaminhando ao atendente, produtos acumulados no loop de function calling
  // NÃO devem ser enviados — o atendente assume o atendimento a partir daqui.
  if (!resp.encaminhar && resp.produtos && resp.produtos.length) await enviarProdutos(from, resp.produtos);
  if (!resp.encaminhar && resp.respostaGranel) try { await enviar(from, resp.respostaGranel); } catch (e) { console.error("Falha ao enviar granel:", e.message); }
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

function estaPausado(contactId) { return pausados.has(contactId); }

// Rede de segurança de ÚLTIMA instância: chamada por quem invoca processar() (fila de
// mensagens, transcrição de áudio etc.) quando ele lança uma exceção não tratada em NENHUM
// ponto interno (bug, timeout de API, instabilidade externa...). Sem isso, o cliente já pode
// ter recebido um "achei essas opções..." (ou qualquer outro texto) e depois fica em silêncio
// total pra sempre — o erro só aparecia no log do servidor, que ninguém da loja vê. Garante que
// SEMPRE existe uma resposta e um atendente é chamado, não importa onde exatamente quebrou.
async function tratarFalhaCritica(from, erro) {
  console.error(`Falha crítica ao processar mensagem de ${from}:`, (erro && erro.stack) || erro);
  try {
    await enviar(from, "Ops, tive um probleminha aqui 🙈 Já chamei um atendente pra te ajudar!");
  } catch (e) {
    console.error("Falha ao enviar aviso de falha crítica:", e.message);
  }
  try {
    pausar(from);
    await abrirHandoff(from, "Falha técnica durante o atendimento automático — conferir a conversa.");
  } catch (e) {
    console.error("Falha ao abrir handoff de falha crítica:", e.message);
  }
}

module.exports = { configurar, processar, pausar, retomar, concluirAtendimento, registrarSessaoAtendente, ehMsgBot, conversasAtivas, abrirHandoff, estaPausado, tratarFalhaCritica };
