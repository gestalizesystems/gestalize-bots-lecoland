// Conta de acesso ao painel. Guarda e-mail + senha (com hash) em data/conta.json.
// Na primeira execução, cria o arquivo a partir de ADMIN_EMAIL / ADMIN_SENHA do .env.
// Sem dependências externas — usa o módulo crypto do Node (scrypt).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CAMINHO = path.join(__dirname, "..", "data", "conta.json");

// Gera "salt:hash" para uma senha. Reaproveita o salt ao conferir.
function hashSenha(senha, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const h = crypto.scryptSync(String(senha), salt, 64).toString("hex");
  return `${salt}:${h}`;
}

function confere(senha, armazenado) {
  if (!armazenado || !armazenado.includes(":")) return false;
  const salt = armazenado.split(":")[0];
  const calc = hashSenha(senha, salt);
  const a = Buffer.from(calc);
  const b = Buffer.from(armazenado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function salvarArquivo(c) {
  fs.writeFileSync(CAMINHO, JSON.stringify(c, null, 2), "utf8");
}

function carregar() {
  if (fs.existsSync(CAMINHO)) {
    try {
      return JSON.parse(fs.readFileSync(CAMINHO, "utf8"));
    } catch (_) {
      /* arquivo corrompido — recria abaixo */
    }
  }
  // Semente inicial a partir do .env (só na 1ª vez).
  const email = process.env.ADMIN_EMAIL || "";
  const senha = process.env.ADMIN_SENHA || "";
  const c = {
    email,
    nomeUsuario: "Lecoland",
    telefone: "",
    senhaHash: senha ? hashSenha(senha) : "",
  };
  if (email && senha) salvarArquivo(c);
  return c;
}

let conta = carregar();

// Dados públicos (nunca expõe o hash da senha).
function get() {
  return { email: conta.email, nomeUsuario: conta.nomeUsuario, telefone: conta.telefone };
}

function verifica(email, senha) {
  if (!conta.email) return false;
  return String(email).trim().toLowerCase() === conta.email.toLowerCase() && confere(senha, conta.senhaHash);
}

function atualizar({ nomeUsuario, telefone, email } = {}) {
  if (nomeUsuario != null) conta.nomeUsuario = String(nomeUsuario).trim();
  if (telefone != null) conta.telefone = String(telefone).trim();
  if (email != null && String(email).trim()) conta.email = String(email).trim();
  salvarArquivo(conta);
  return get();
}

function alterarSenha(atual, nova) {
  if (!confere(atual, conta.senhaHash)) throw new Error("Senha atual incorreta.");
  if (!nova || String(nova).length < 6) throw new Error("A nova senha precisa de pelo menos 6 caracteres.");
  conta.senhaHash = hashSenha(nova);
  salvarArquivo(conta);
}

module.exports = { get, verifica, atualizar, alterarSenha };
