// Lógica de conversa do bot (triagem, menus, IA, handoff), separada do transporte de mensagens.
// O envio é injetado via configurar(fn), onde fn(para, texto) entrega a mensagem (Cloud API).

const { triar } = require("./triage");
const { responder, limparHistorico, registrarTurno } = require("./ai");
const config = require("./config");

let enviar = async () => {}; // definido pelo ponto de entrada (Cloud API ou web.js)
function configurar(fn) {
  enviar = fn;
}

// ===== Estado por contato (em memória) =====
const pausados = new Map(); // contactId -> { timer, ultimaMsg }
const aguardandoFecho = new Map(); // contactId -> { timer }
const menuContexto = new Map(); // contactId -> opções do menu atual
const jaSaudou = new Set(); // contatos que já receberam o menu de saudação nesta conversa
const ausenciaEnviada = new Map(); // contactId -> instante do último aviso de ausência
const AUSENCIA_THROTTLE_MS = 60 * 60 * 1000; // não repete a ausência mais de 1x/h por contato

const PAUSA_SILENCIO_MS = 60 * 60 * 1000; // 1h de silêncio do cliente → "posso ajudar?"
const SEM_RESPOSTA_MS = 2 * 60 * 60 * 1000; // sem resposta em 2h → finaliza
const LIMITE_REENGAJAR_MS = 24 * 60 * 60 * 1000; // não reengaja conversas paradas há +24h

const FECHO_PALAVRAS = ["nao", "no", "obrigado", "obrigada", "obg", "vlw", "valeu", "era so isso", "so isso", "so isso mesmo", "era isso", "isso mesmo", "tudo certo", "ok", "blz", "beleza", "nada mais", "agradecido", "grato", "grata", "por enquanto so"];

function normaliza(t) {
  return (t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}
function ehFecho(t) {
  const n = normaliza(t);
  if (!n || n.length > 28) return false;
  return FECHO_PALAVRAS.some((p) => n === p || n.includes(p));
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

function pausar(contactId) {
  const atual = pausados.get(contactId);
  if (atual && atual.timer) clearTimeout(atual.timer);
  const timer = setTimeout(() => aoSilenciar(contactId), PAUSA_SILENCIO_MS);
  pausados.set(contactId, { timer, ultimaMsg: Date.now() });
}

async function aoSilenciar(contactId) {
  const p = pausados.get(contactId);
  pausados.delete(contactId);
  if (!p || Date.now() - p.ultimaMsg > LIMITE_REENGAJAR_MS) return;
  try {
    await enviar(contactId, "Posso te ajudar em mais alguma coisa? 😊");
    const timer = setTimeout(() => finalizar(contactId, true), SEM_RESPOSTA_MS);
    aguardandoFecho.set(contactId, { timer });
  } catch (e) {
    console.error("Falha ao reengajar:", e.message);
  }
}

async function finalizar(contactId, enviarDespedida) {
  const f = aguardandoFecho.get(contactId);
  if (f && f.timer) clearTimeout(f.timer);
  aguardandoFecho.delete(contactId);
  menuContexto.delete(contactId);
  jaSaudou.delete(contactId); // conversa nova → pode saudar de novo
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
async function processar(from, texto) {
  const dados = config.get();
  // Bot desligado no painel → não responde nada.
  if (!dados.botAtivo) return;

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

  // Resposta ao "Posso te ajudar em mais alguma coisa?".
  if (aguardandoFecho.has(from)) {
    if (ehFecho(texto)) {
      await finalizar(from, false);
      await enviar(from, "Atendimento finalizado, qualquer coisa é só chamar! 🐾");
      return;
    }
    await finalizar(from, false); // trouxe algo novo → começa um atendimento novo
  }

  const ctx = menuContexto.get(from) || null;
  const r = triar(texto, ctx);
  if ("novoContexto" in r) {
    if (r.novoContexto) menuContexto.set(from, r.novoContexto);
    else menuContexto.delete(from);
  }

  // Menu de saudação aparece só UMA vez por conversa (no início). Depois disso, IA.
  if (r.saudacao) {
    if (jaSaudou.has(from)) { r.tipo = "ia"; r.resposta = null; }
    else jaSaudou.add(from);
  }

  if (r.tipo === "atendente") {
    await enviar(from, r.resposta);
    pausar(from);
    return;
  }

  if (r.resposta) {
    await enviar(from, r.resposta);
    // Memória: grava só ESCOLHAS com significado (opção/comando), nunca o texto de menus
    // — senão a IA pode "repetir" o menu. Registra a escolha POR EXTENSO (ex.: "Entrega (moto)")
    // pra a IA não reperguntar o que o cliente já escolheu.
    if (r.tipo === "opcao" || r.tipo === "mensagem") {
      const nota = r.titulo ? `(O cliente escolheu: ${r.titulo}.) ` : "";
      registrarTurno(from, texto, nota + r.resposta);
    }
    return;
  }

  // tipo === "ia": pergunta livre.
  const resp = await responder(from, texto);
  await enviar(from, resp.texto);
  if (resp.encaminhar) pausar(from); // a IA pediu um atendente humano
}

module.exports = { configurar, processar };
