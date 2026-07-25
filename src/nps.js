// NPS (satisfação): guarda as notas (0–10) que os clientes dão ao encerrar o atendimento.
// Arquivo data/nps.json (no Volume do Railway, sobrevive a redeploys).

const fs = require("fs");
const path = require("path");

const DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const CAMINHO = path.join(DIR, "nps.json");
const THROTTLE_MS = 30 * 24 * 60 * 60 * 1000; // não pergunta de novo o NPS antes de 30 dias

let dados = carregar();

function carregar() {
  try {
    const d = JSON.parse(fs.readFileSync(CAMINHO, "utf8"));
    d.respostas = Array.isArray(d.respostas) ? d.respostas : [];
    d.perguntadoEm = d.perguntadoEm || {};
    return d;
  } catch (_) {
    return { respostas: [], perguntadoEm: {} };
  }
}

function persistir() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(CAMINHO, JSON.stringify(dados, null, 2), "utf8");
  } catch (e) {
    console.error("Falha ao salvar NPS:", e.message);
  }
}

// Pode perguntar a nota? (respeita o limite de 1x a cada 30 dias por contato)
function podePerguntar(telefone) {
  return Date.now() - (dados.perguntadoEm[telefone] || 0) > THROTTLE_MS;
}
function marcarPerguntado(telefone) {
  dados.perguntadoEm[telefone] = Date.now();
  persistir();
}

// Registra uma nota (0–10). Devolve { id, nota } (o id permite anexar o comentário depois).
function registrar(telefone, nota) {
  const n = Math.max(0, Math.min(10, Math.round(Number(nota))));
  const id = "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  dados.respostas.push({ id, telefone, nota: n, comentario: "", data: Date.now() });
  persistir();
  return { id, nota: n };
}

// Anexa um comentário a uma resposta já registrada.
function comentar(id, comentario) {
  const r = dados.respostas.find((x) => x.id === id);
  if (r) { r.comentario = String(comentario || "").trim().slice(0, 500); persistir(); }
}

// Resumo agregado (a partir de uma data, em ms). NPS = %promotores − %detratores.
function resumo(desdeMs) {
  const lista = dados.respostas.filter((r) => !desdeMs || r.data >= desdeMs);
  const total = lista.length;
  const promotores = lista.filter((r) => r.nota >= 9).length;
  const neutros = lista.filter((r) => r.nota >= 7 && r.nota <= 8).length;
  const detratores = lista.filter((r) => r.nota <= 6).length;
  const score = total ? Math.round((promotores / total - detratores / total) * 100) : null;
  const media = total ? Number((lista.reduce((s, r) => s + r.nota, 0) / total).toFixed(1)) : null;
  return { total, promotores, neutros, detratores, score, media };
}

// Respostas no período (a partir de uma data, em ms), mais recentes primeiro.
function listar(desdeMs) {
  return dados.respostas.filter((r) => !desdeMs || r.data >= desdeMs).slice().reverse();
}

module.exports = { podePerguntar, marcarPerguntado, registrar, comentar, resumo, listar };
