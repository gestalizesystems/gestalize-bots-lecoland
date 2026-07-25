// Equipe / colaboradores da loja. O bot usa pra reconhecer quando o cliente
// pergunta por uma pessoa (ex.: "a Dra. Ana está?") ou por uma função ("o veterinário").
// Guardado em data/equipe.json (no Volume do Railway).

const fs = require("fs");
const path = require("path");

const DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const CAMINHO = path.join(DIR, "equipe.json");

let lista = carregar();

function carregar() {
  try { const d = JSON.parse(fs.readFileSync(CAMINHO, "utf8")); return Array.isArray(d) ? d : []; }
  catch (_) { return []; }
}
function persistir() {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(CAMINHO, JSON.stringify(lista, null, 2), "utf8"); }
  catch (e) { console.error("Falha ao salvar equipe:", e.message); }
}

function listar() {
  return lista.slice().sort((a, b) => (a.nome || "").localeCompare(b.nome || ""));
}

// Adiciona ou atualiza um colaborador.
function salvar({ id, nome, cargo, obs } = {}) {
  if (!nome || !String(nome).trim()) return null;
  let m = id ? lista.find((x) => x.id === id) : null;
  if (m) {
    m.nome = String(nome).trim();
    m.cargo = String(cargo || "").trim();
    m.obs = String(obs || "").trim();
  } else {
    m = {
      id: "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      nome: String(nome).trim(),
      cargo: String(cargo || "").trim(),
      obs: String(obs || "").trim(),
    };
    lista.push(m);
  }
  persistir();
  return m;
}

function remover(id) {
  lista = lista.filter((x) => x.id !== id);
  persistir();
}

// Texto da equipe para a IA reconhecer colaboradores nas conversas.
function resumoParaIA() {
  if (!lista.length) return "";
  return lista
    .map((m) => `- ${m.nome}${m.cargo ? " — " + m.cargo : ""}${m.obs ? " (" + m.obs + ")" : ""}`)
    .join("\n");
}

module.exports = { listar, salvar, remover, resumoParaIA };
