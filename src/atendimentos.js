// Fila de atendimentos que precisam de um humano (handoff), com o resumo da IA.
// Guardado em data/atendimentos.json (no Volume do Railway, sobrevive a redeploys).

const fs = require("fs");
const path = require("path");

const DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const CAMINHO = path.join(DIR, "atendimentos.json");

let lista = carregar();

function carregar() {
  try {
    const d = JSON.parse(fs.readFileSync(CAMINHO, "utf8"));
    return Array.isArray(d) ? d : [];
  } catch (_) {
    return [];
  }
}

function persistir() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(CAMINHO, JSON.stringify(lista, null, 2), "utf8");
  } catch (e) {
    console.error("Falha ao salvar atendimentos:", e.message);
  }
}

// Abre/atualiza um atendimento pendente para um contato (não duplica).
function registrar({ telefone, nome, resumo, motivo } = {}) {
  if (!telefone) return null;
  let a = lista.find((x) => x.telefone === telefone && !x.atendido);
  if (a) {
    if (resumo) a.resumo = resumo;
    if (motivo) a.motivo = motivo;
    if (nome) a.nome = nome;
    a.atualizadoEm = Date.now();
  } else {
    a = {
      id: "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      telefone, nome: nome || "", resumo: resumo || "", motivo: motivo || "",
      criadoEm: Date.now(), atualizadoEm: Date.now(), atendido: false,
    };
    lista.push(a);
  }
  persistir();
  return a;
}

// Marca como atendido (por id ou telefone).
function resolver(ref) {
  const a = lista.find((x) => (x.id === ref || x.telefone === ref) && !x.atendido);
  if (a) { a.atendido = true; a.resolvidoEm = Date.now(); persistir(); }
  return a;
}

function pendentes() {
  return lista.filter((x) => !x.atendido).sort((a, b) => (b.atualizadoEm || 0) - (a.atualizadoEm || 0));
}
function contarPendentes() {
  return lista.filter((x) => !x.atendido).length;
}

module.exports = { registrar, resolver, pendentes, contarPendentes };
