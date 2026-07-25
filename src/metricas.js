// Métricas reais de uso do bot (por dia), pro dashboard.
// Guardado em data/metricas.json (no Volume do Railway, sobrevive a redeploys).

const fs = require("fs");
const path = require("path");

const DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const CAMINHO = path.join(DIR, "metricas.json");
const TZ = "America/Fortaleza";

let dados = carregar();

function carregar() {
  try {
    const d = JSON.parse(fs.readFileSync(CAMINHO, "utf8"));
    d.dias = d.dias || {};
    d.servicos = d.servicos || {};
    return d;
  } catch (_) {
    return { dias: {}, servicos: {} };
  }
}

// Grava no máximo a cada 3s (evita escrever a cada mensagem).
let pendente = false, timer = null;
function persistir() {
  pendente = true;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    if (!pendente) return;
    pendente = false;
    try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(CAMINHO, JSON.stringify(dados), "utf8"); }
    catch (e) { console.error("Falha ao salvar métricas:", e.message); }
  }, 3000);
}

function hojeStr() {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ }); // YYYY-MM-DD
}
function diaStr(d) {
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

const CAMPOS = ["recebidas", "enviadas", "handoffs", "atendimentos"];

// Incrementa um contador do dia de hoje.
function inc(campo, n = 1) {
  if (!CAMPOS.includes(campo === "recebida" ? "recebidas" : campo)) {
    // aceita singular/plural
  }
  const c = { recebida: "recebidas", enviada: "enviadas", handoff: "handoffs", atendimento: "atendimentos" }[campo] || campo;
  if (!CAMPOS.includes(c)) return;
  const dia = hojeStr();
  dados.dias[dia] = dados.dias[dia] || { recebidas: 0, enviadas: 0, handoffs: 0, atendimentos: 0 };
  dados.dias[dia][c] = (dados.dias[dia][c] || 0) + n;
  persistir();
}

// Conta um serviço/opção escolhido (pra "mais procurados").
function registrarServico(titulo) {
  const t = String(titulo || "").trim();
  if (!t) return;
  dados.servicos[t] = (dados.servicos[t] || 0) + 1;
  persistir();
}

// Resumo dos últimos `dias` dias: totais, série diária e serviços mais procurados.
function resumo(dias) {
  const n = Math.max(1, Math.min(365, Number(dias) || 30));
  const serie = [];
  const totais = { recebidas: 0, enviadas: 0, handoffs: 0, atendimentos: 0 };
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = diaStr(d);
    const v = dados.dias[k] || { recebidas: 0, enviadas: 0, handoffs: 0, atendimentos: 0 };
    serie.push({ dia: k, ...v });
    CAMPOS.forEach((c) => { totais[c] += v[c] || 0; });
  }
  const topServicos = Object.entries(dados.servicos)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([titulo, qtd]) => ({ titulo, qtd }));
  return { totais, serie, topServicos };
}

module.exports = { inc, registrarServico, resumo };
