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
function salvar({ id, nome, cargo, obs, telefone } = {}) {
  if (!nome || !String(nome).trim()) return null;
  let m = id ? lista.find((x) => x.id === id) : null;
  if (m) {
    m.nome = String(nome).trim();
    m.cargo = String(cargo || "").trim();
    m.obs = String(obs || "").trim();
    m.telefone = String(telefone || "").replace(/\D/g, "");
  } else {
    m = {
      id: "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      nome: String(nome).trim(),
      cargo: String(cargo || "").trim(),
      obs: String(obs || "").trim(),
      telefone: String(telefone || "").replace(/\D/g, ""),
    };
    lista.push(m);
  }
  persistir();
  return m;
}

// Normaliza para: sem código de país (55), com 9° dígito (11 dígitos BR mobile).
// Resolve o bug do WhatsApp que às vezes omite o 9° dígito ao entregar o número.
function _normalizar(tel) {
  let d = String(tel).replace(/\D/g, "");
  if (d.startsWith("55") && d.length >= 12) d = d.slice(2); // remove prefixo 55
  if (d.length === 10) d = d.slice(0, 2) + "9" + d.slice(2); // insere o 9° dígito
  return d;
}

// Retorna true se o número (formato WhatsApp, ex: 5585982258020) pertence a um funcionário.
function ehFuncionario(telefone) {
  if (!telefone) return false;
  const norm = _normalizar(String(telefone));
  const comFone = lista.filter((m) => m.telefone);
  if (!comFone.length) return false;
  return comFone.some((m) => _normalizar(m.telefone) === norm);
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

module.exports = { listar, salvar, remover, ehFuncionario, resumoParaIA };
