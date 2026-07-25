// Campanhas (mensagens ativas): envia uma mensagem para uma audiência de clientes.
// ⚠️ Regra do WhatsApp: texto livre só chega a quem falou nas últimas 24h.
//    Para alcançar todo mundo a qualquer hora, use um TEMPLATE aprovado na Meta.
// Histórico em data/campanhas.json (no Volume do Railway).

const fs = require("fs");
const path = require("path");
const clientes = require("./clientes");
const wa = require("./wa");

const DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const CAMINHO = path.join(DIR, "campanhas.json");

let lista = carregar();

function carregar() {
  try { const d = JSON.parse(fs.readFileSync(CAMINHO, "utf8")); return Array.isArray(d) ? d : []; }
  catch (_) { return []; }
}
function persistir() {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(CAMINHO, JSON.stringify(lista, null, 2), "utf8"); }
  catch (e) { console.error("Falha ao salvar campanhas:", e.message); }
}

// Lista de clientes-alvo conforme a audiência escolhida.
function audiencia({ tipo, valor } = {}) {
  const todos = clientes.listar().filter((c) => c.telefone);
  if (tipo === "etapa") return todos.filter((c) => (c.etapa || "lead") === valor);
  if (tipo === "tag") return todos.filter((c) => Array.isArray(c.tags) && c.tags.some((t) => String(t).toLowerCase() === String(valor).toLowerCase()));
  return todos; // "todos"
}

function rotuloAudiencia(aud = {}) {
  if (aud.tipo === "etapa") return "Etapa: " + aud.valor;
  if (aud.tipo === "tag") return "Tag: " + aud.valor;
  return "Todos os clientes";
}

// Cria a campanha e dispara o envio em segundo plano (~1 msg/seg).
function enviar({ modo, mensagem, template, idioma, audiencia: aud } = {}) {
  const alvos = audiencia(aud || {});
  const camp = {
    id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    criadoEm: Date.now(),
    modo: modo === "template" ? "template" : "texto",
    mensagem: mensagem || "",
    template: template || "",
    idioma: idioma || "pt_BR",
    audiencia: rotuloAudiencia(aud || {}),
    total: alvos.length,
    enviados: 0,
    falhas: 0,
    status: alvos.length ? "enviando" : "concluida",
  };
  lista.unshift(camp);
  persistir();

  if (alvos.length) {
    (async () => {
      for (const c of alvos) {
        try {
          if (camp.modo === "template") await wa.enviarTemplate(c.telefone, template, idioma);
          else await wa.enviarTexto(c.telefone, mensagem);
          camp.enviados++;
        } catch (e) {
          camp.falhas++;
        }
        persistir();
        await new Promise((r) => setTimeout(r, 1100)); // ~1 msg/seg (evita flood/limite da Meta)
      }
      camp.status = "concluida";
      camp.concluidaEm = Date.now();
      persistir();
    })().catch((e) => { camp.status = "erro"; camp.erro = e.message; persistir(); });
  }
  return camp;
}

function listar() { return lista.slice(0, 50); }

module.exports = { enviar, listar, audiencia };
