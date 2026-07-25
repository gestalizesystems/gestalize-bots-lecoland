// Lógica de conversa do bot (triagem, menus, IA, handoff), separada do transporte de mensagens.
// O envio é injetado via configurar(fn), onde fn(para, texto) entrega a mensagem (Cloud API).

const { triar, menuPrincipal } = require("./triage");
const { responder, limparHistorico, registrarTurno, resumirConversa } = require("./ai");
const config = require("./config");
const clientes = require("./clientes");
const nps = require("./nps");
const atendimentos = require("./atendimentos");
const metricas = require("./metricas");

let _enviarTexto = async () => {}; // texto — definido pelo ponto de entrada (Cloud API)
let _enviarImagem = async () => {}; // imagem (link + legenda)
function configurar(fnTexto, fnImagem) {
  if (fnTexto) _enviarTexto = fnTexto;
  if (fnImagem) _enviarImagem = fnImagem;
}
// Wrappers que contam as mensagens enviadas (métricas do dashboard).
async function enviar(para, texto) { metricas.inc("enviada"); return _enviarTexto(para, texto); }
async function enviarImagem(para, link, legenda) { metricas.inc("enviada"); return _enviarImagem(para, link, legenda); }

// URL pública do painel (pra montar o link das fotos do catálogo no WhatsApp).
const PUBLIC_URL = (process.env.PUBLIC_URL || "https://bots.gestalizesystems.com.br").replace(/\/$/, "");

// Aviso enviado SEMPRE junto com a saudação (novo sistema em testes).
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
      else await enviar(from, legenda); // produto sem foto → só texto
    } catch (e) {
      console.error("Falha ao enviar produto:", e.message);
      try { await enviar(from, legenda); } catch (_) {}
    }
  }
}

// ===== Estado por contato (em memória) =====
const pausados = new Map(); // contactId -> { timer, ultimaMsg }
const aguardandoFecho = new Map(); // contactId -> { timer }
const menuContexto = new Map(); // contactId -> opções do menu atual
const jaSaudou = new Set(); // contatos que já receberam o menu de saudação nesta conversa
const aguardandoNome = new Set(); // contatos a quem o bot perguntou o nome e espera a resposta
const aguardandoNps = new Set(); // contatos a quem o bot perguntou a nota (NPS) e espera a resposta
const aguardandoNpsComentario = new Map(); // contactId -> { id, detrator } esperando o comentário do NPS
const historicoConversa = new Map(); // contactId -> [últimas mensagens do cliente] (pro resumo do handoff)
const ausenciaEnviada = new Map(); // contactId -> instante do último aviso de ausência
const AUSENCIA_THROTTLE_MS = 60 * 60 * 1000; // não repete a ausência mais de 1x/h por contato
const inatividade = new Map(); // contactId -> timer de silêncio (reengaja/encerra a conversa do bot)

const PAUSA_SILENCIO_MS = 60 * 60 * 1000; // 1h SEM novas mensagens (do cliente OU do bot) → "ainda por aí?"
const SEM_RESPOSTA_MS = 2 * 60 * 60 * 1000; // sem resposta em 2h após o reengajamento → finaliza

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
// Retorna "" se não parecer um nome (ex.: uma pergunta) — aí o fluxo segue normal.
function extrairNome(texto) {
  if (!texto || /\?/.test(texto)) return ""; // pergunta não é nome
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

// Despedida/agradecimento CLARO (encerra o atendimento). Mais forte que ehFecho (não pega "ok"/"blz").
const DESPEDIDA = ["obrigado", "obrigada", "obg", "brigado", "brigada", "vlw", "valeu", "tchau", "ate mais", "ate logo", "ate breve", "era isso", "era so isso", "so isso", "so isso mesmo", "agradecido", "agradecida", "grato", "grata", "nada mais"];
function ehDespedidaForte(t) {
  const n = normaliza(t);
  if (!n || n.length > 22) return false;
  return DESPEDIDA.some((p) => n === p || n.includes(p));
}

// Envia o encerramento e, se elegível (1x/30 dias), faz a pergunta de NPS (nota 0–10).
async function encerrarComNps(from, msgPadrao) {
  if (nps.podePerguntar(from)) {
    nps.marcarPerguntado(from);
    aguardandoNps.add(from);
    const cli = clientes.get(from);
    const nm = cli && cli.nome ? cli.nome + ", de " : "De ";
    const nomeLoja = config.get().negocio.nome || "a loja";
    await enviar(from, `${msgPadrao}\n\n${nm}0 a 10, o quanto você recomendaria a *${nomeLoja}* a um amigo? 🐾`);
  } else {
    await enviar(from, msgPadrao);
  }
}

// Convida o cliente a seguir no Instagram e avaliar no Google (vai junto com o NPS, 1x/30 dias).
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

// Abre um atendimento na fila do painel com um RESUMO da conversa feito pela IA (handoff).
async function abrirHandoff(from, motivo) {
  metricas.inc("handoff"); // métrica: transferência para humano
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

// Verdadeiro se, AGORA, a loja está fora do horário de atendimento do bot.
function foraDoHorario(dados) {
  const exp = dados.expediente;
  if (!exp || !exp.ativo) return false; // recurso desligado → sempre atende
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
  } catch (_) {
    return false; // em caso de erro de fuso, não bloqueia o atendimento
  }
  // Feriado (formato DD/MM, todo ano) → loja fechada.
  if (Array.isArray(exp.feriados) && exp.feriados.includes(hoje)) return true;
  const agora = hh * 60 + mm;
  const faixa = wd === "Sun" ? exp.domingo : wd === "Sat" ? exp.sabado : exp.semana;
  if (!faixa || !faixa.abre || !faixa.fecha) return true; // dia fechado
  const [ah, am] = String(faixa.abre).split(":").map(Number);
  const [fh, fm] = String(faixa.fecha).split(":").map(Number);
  const abre = ah * 60 + am, fecha = fh * 60 + fm;
  return !(agora >= abre && agora < fecha);
}

// Agenda/renova o timer de silêncio: 1h SEM novas mensagens (do cliente OU do bot) →
// reengaja ("ainda por aí?") e, se continuar mudo por +2h, encerra. Chamado ao FINAL de
// toda resposta do bot, pra o atendimento nunca ficar parado sem solução.
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
  pausados.set(contactId, { ultimaMsg: Date.now() }); // atendimento humano em andamento (bot fica quieto)
  agendarInatividade(contactId);
}

async function aoSilenciar(contactId) {
  inatividade.delete(contactId);
  pausados.delete(contactId); // se vinha de atendimento humano, encerra o modo "quieto"
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
  jaSaudou.delete(contactId); // conversa nova → pode saudar de novo
  aguardandoNome.delete(contactId);
  aguardandoNps.delete(contactId);
  aguardandoNpsComentario.delete(contactId);
  historicoConversa.delete(contactId);
  atendimentos.resolver(contactId); // conversa encerrada → tira da fila de atendimentos
  limparHistorico(contactId);
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
  const dados = config.get();
  // Bot desligado no painel → não responde nada.
  if (!dados.botAtivo) return;

  metricas.inc("recebida"); // métrica: mensagem recebida

  // Cliente respondeu → cancela o reengajamento pendente. A MEMÓRIA da conversa é mantida
  // até o atendimento ser realmente finalizado (despedida do cliente ou silêncio prolongado),
  // mesmo que ele fique horas parado — assim o bot lembra o assunto (ex.: remédio de verme).
  limparInatividade(from);

  // Guarda as últimas mensagens do cliente (em memória) pra montar o resumo no handoff.
  if (texto && String(texto).trim()) {
    const buf = historicoConversa.get(from) || [];
    buf.push(String(texto).trim());
    if (buf.length > 20) buf.splice(0, buf.length - 20);
    historicoConversa.set(from, buf);
  }

  // NPS — passo 1: cliente manda a nota 0–10 → registra e pede um comentário.
  if (aguardandoNps.has(from)) {
    aguardandoNps.delete(from);
    const m = String(texto).match(/\b(10|[0-9])\b/);
    if (m) {
      const { id, nota } = nps.registrar(from, Number(m[1]));
      const detrator = nota <= 6;
      aguardandoNpsComentario.set(from, { id, detrator });
      await enviar(from, detrator
        ? "Poxa, sentimos muito! 😔 O que podemos melhorar? (se preferir, mande *ok* que já chamo um atendente)"
        : `Obrigada pela nota ${nota}! 🐾 Quer deixar um comentário? (ou mande *ok*)`);
      return;
    }
    // não veio uma nota → segue o fluxo normal (não trava o atendimento)
  }

  // NPS — passo 2: comentário (após a nota).
  if (aguardandoNpsComentario.has(from)) {
    const { id, detrator } = aguardandoNpsComentario.get(from);
    aguardandoNpsComentario.delete(from);
    const pular = /^(ok|nao|não|n|-|pular|nada|nenhum|sem coment\w*|tudo certo|tudo bem)$/i.test(String(texto).trim());
    if (!pular) nps.comentar(id, texto);
    if (detrator) {
      await enviar(from, "Obrigada por compartilhar! 🐾 Vou repassar pra um atendente cuidar disso pra você.");
      pausar(from); // ouvir o detrator
      await abrirHandoff(from, "Cliente deu nota baixa no NPS (detrator)" + (pular ? "." : ": " + String(texto).trim()));
    } else {
      await enviar(from, "Valeu pela avaliação! 💛 Significa muito pra gente. 🐾");
      await enviarConviteRedes(from); // só p/ quem gostou (promotores/neutros): segue no Insta + avalia no Google
    }
    return;
  }

  // Fora do horário → só a mensagem de ausência (sem menu/saudação/IA), no máximo 1x/h.
  if (foraDoHorario(dados)) {
    const ultimo = ausenciaEnviada.get(from) || 0;
    if (Date.now() - ultimo > AUSENCIA_THROTTLE_MS) {
      ausenciaEnviada.set(from, Date.now());
      try {
        await enviar(from, config.preencher(dados.mensagens.ausencia || "No momento estamos fora do horário de atendimento. Retornamos no horário comercial. 🐾"));
      } catch (e) {
        console.error("Falha ao enviar ausência:", e.message);
      }
    }
    return;
  }

  // Atendimento humano em andamento: fica quieto e reinicia o cronômetro de silêncio.
  if (pausados.has(from)) {
    pausar(from);
    return;
  }

  // Resposta ao "Ainda por aí?".
  if (aguardandoFecho.has(from)) {
    if (ehFecho(texto)) {
      await finalizar(from, false);
      await encerrarComNps(from, "Atendimento finalizado, qualquer coisa é só chamar! 🐾");
      return;
    }
    // Trouxe algo novo → cancela só o encerramento pendente e CONTINUA a conversa com a
    // memória intacta (o bot ainda lembra o assunto que estava em andamento).
    const f = aguardandoFecho.get(from);
    if (f && f.timer) clearTimeout(f.timer);
    aguardandoFecho.delete(from);
  }

  // Cliente se despediu/agradeceu (ex.: "obrigada", "era só isso") → encerra e pede a nota (NPS).
  if (ehDespedidaForte(texto)) {
    await finalizar(from, false);
    await encerrarComNps(from, "Por nada, qualquer coisa é só chamar! 🐾");
    return;
  }

  // O bot perguntou o nome e o cliente respondeu → guarda e manda a saudação personalizada.
  if (aguardandoNome.has(from)) {
    aguardandoNome.delete(from);
    const nome = extrairNome(texto);
    if (nome) {
      clientes.salvar(from, { nome });
      jaSaudou.add(from);
      const menu = menuPrincipal(nome);
      menuContexto.set(from, { opcoes: config.intents(), texto: menu, sub: false });
      await enviar(from, menu);
      agendarInatividade(from);
      return;
    }
    // não parece um nome → segue o fluxo normal (não trava o atendimento)
  }

  const ctx = menuContexto.get(from) || null;
  const r = triar(texto, ctx);
  if ("novoContexto" in r) {
    if (r.novoContexto) menuContexto.set(from, r.novoContexto);
    else menuContexto.delete(from);
  }

  // Menu de saudação aparece só UMA vez por conversa (no início). Depois disso, IA.
  if (r.saudacao) {
    if (jaSaudou.has(from)) {
      r.tipo = "ia"; r.resposta = null;
    } else {
      jaSaudou.add(from);
      metricas.inc("atendimento"); // métrica: nova conversa/atendimento iniciado
      const cli = clientes.get(from);
      if (cli && cli.nome) {
        r.resposta = menuPrincipal(cli.nome); // já conhece → "Olá, Ana!" personalizado
      } else {
        aguardandoNome.add(from); // cliente novo → pergunta o nome antes do menu
        menuContexto.delete(from);
        r.resposta = config.preencher(dados.mensagens.saudacaoNome || "Olá! 🐾 Seja muito bem-vindo(a) à {nome}! Antes de começar, como posso te chamar? 😊")
          + "\n\n" + AVISO_SISTEMA; // aviso do novo sistema — SOMENTE para clientes novos (sem nome ainda)
      }
    }
  }

  if (r.tipo === "atendente") {
    await enviar(from, r.resposta);
    pausar(from);
    await abrirHandoff(from, "Cliente pediu para falar com um atendente.");
    return;
  }

  if (r.resposta) {
    // Banho/tosa/consulta/vacina: se ainda não souber o pet, pergunta nome + raça (a IA cuida da resposta).
    if (r.tipo === "opcao" && /banho|tosa|consult|veterin|vacin/i.test(r.titulo || "")) {
      const cli = clientes.get(from);
      if (!cli || !Array.isArray(cli.pets) || !cli.pets.length) {
        r.resposta += "\n\n🐾 Pra deixar tudo certinho, me diz o *nome* e a *raça* do seu pet?";
      }
    }
    await enviar(from, r.resposta);
    // Memória: grava só ESCOLHAS com significado (opção/comando), nunca o texto de menus
    // — senão a IA pode "repetir" o menu. Registra a escolha POR EXTENSO (ex.: "Entrega (moto)")
    // pra a IA não reperguntar o que o cliente já escolheu.
    if (r.tipo === "opcao" || r.tipo === "mensagem") {
      const nota = r.titulo ? `(O cliente escolheu: ${r.titulo}.) ` : "";
      registrarTurno(from, texto, nota + r.resposta);
      if (r.titulo) metricas.registrarServico(r.titulo); // métrica: serviço mais procurado
    }
    agendarInatividade(from); // conversa segue aberta → programa o follow-up de silêncio
    return;
  }

  // tipo === "ia": pergunta livre.
  // SAUDAÇÃO SEMPRE no primeiro contato — mas SEM o menu quando o cliente já chegou
  // perguntando ou enviando arquivo (aí só damos as boas-vindas e já respondemos).
  let saudacao = "";
  if (!jaSaudou.has(from)) {
    jaSaudou.add(from);
    metricas.inc("atendimento"); // métrica: nova conversa/atendimento iniciado
    const cli = clientes.get(from);
    const loja = dados.negocio && dados.negocio.nome ? " à " + dados.negocio.nome : "";
    saudacao = (cli && cli.nome) ? `Oi, ${cli.nome}! 🐾 ` : `Olá! 🐾 Seja muito bem-vindo(a)${loja}! `;
  }
  const resp = await responder(from, texto);
  await enviar(from, (saudacao + (resp.texto || "")).trim());
  if (resp.encaminhar) { // a IA pediu um atendente humano
    pausar(from);
    await abrirHandoff(from, resp.motivo || "A IA encaminhou para um atendente.");
  } else {
    agendarInatividade(from); // conversa segue aberta → 1h de silêncio reengaja/encerra
  }
  if (resp.produtos && resp.produtos.length) await enviarProdutos(from, resp.produtos); // catálogo com foto
}

module.exports = { configurar, processar };
