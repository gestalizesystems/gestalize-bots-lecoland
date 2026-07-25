// Memória de clientes (mini-CRM) do bot: nome, endereço e telefone, por contato.
// Guardado em data/clientes.json (no Volume do Railway, sobrevive a redeploys).

const fs = require("fs");
const path = require("path");

const DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const CAMINHO = path.join(DIR, "clientes.json");

let clientes = carregar();

function carregar() {
  try {
    return JSON.parse(fs.readFileSync(CAMINHO, "utf8"));
  } catch (_) {
    return {}; // ainda não há arquivo
  }
}

function persistir() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(CAMINHO, JSON.stringify(clientes, null, 2), "utf8");
  } catch (e) {
    console.error("Falha ao salvar clientes:", e.message);
  }
}

// Dados conhecidos de um contato (ou null).
function get(telefone) {
  return clientes[telefone] || null;
}

// Salva/atualiza só os campos informados (não apaga o que já existe).
function salvar(telefone, dados = {}) {
  if (!telefone) return null;
  const atual = clientes[telefone] || { telefone, criadoEm: Date.now() };
  if (!atual.etapa) atual.etapa = "lead"; // todo cliente novo entra como lead no funil
  if (dados.nome != null && String(dados.nome).trim()) atual.nome = String(dados.nome).trim();
  if (dados.endereco != null && String(dados.endereco).trim()) atual.endereco = String(dados.endereco).trim();
  atual.telefone = telefone;
  atual.atualizadoEm = Date.now();
  clientes[telefone] = atual;
  persistir();
  return atual;
}

// Salva/atualiza um PET do cliente (por nome). Usado pelo bot.
function salvarPet(telefone, { nome, raca } = {}) {
  if (!telefone || !nome || !String(nome).trim()) return null;
  const atual = clientes[telefone] || { telefone, criadoEm: Date.now() };
  if (!atual.etapa) atual.etapa = "lead";
  if (!Array.isArray(atual.pets)) atual.pets = [];
  const n = String(nome).trim();
  const existente = atual.pets.find((p) => (p.nome || "").toLowerCase() === n.toLowerCase());
  if (existente) {
    if (raca != null && String(raca).trim()) existente.raca = String(raca).trim();
  } else {
    atual.pets.push({ nome: n, raca: raca ? String(raca).trim() : "" });
  }
  atual.telefone = telefone;
  atual.atualizadoEm = Date.now();
  clientes[telefone] = atual;
  persistir();
  return atual;
}

// Edição manual pelo painel (sobrescreve, inclusive permitindo limpar um campo).
function definir(telefone, dados = {}) {
  if (!telefone) return null;
  const atual = clientes[telefone] || { telefone, criadoEm: Date.now() };
  ["nome", "endereco", "notas", "etapa", "cpf"].forEach((k) => {
    if (dados[k] != null) atual[k] = String(dados[k]).trim();
  });
  if (Array.isArray(dados.tags)) {
    atual.tags = dados.tags.map((t) => String(t).trim()).filter(Boolean);
  }
  if (Array.isArray(dados.pets)) {
    atual.pets = dados.pets
      .filter((p) => p && String(p.nome || "").trim())
      .map((p) => ({ nome: String(p.nome).trim(), raca: String(p.raca || "").trim() }));
  }
  atual.telefone = telefone;
  atual.atualizadoEm = Date.now();
  clientes[telefone] = atual;
  persistir();
  return atual;
}

function remover(telefone) {
  delete clientes[telefone];
  persistir();
}

// Lista (mais recentes primeiro).
function listar() {
  return Object.values(clientes).sort((a, b) => (b.atualizadoEm || 0) - (a.atualizadoEm || 0));
}

module.exports = { get, salvar, salvarPet, definir, remover, listar };
