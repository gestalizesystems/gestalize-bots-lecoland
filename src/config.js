// Carrega e salva os dados do negócio a partir de data/config.json.
// Tudo que o bot responde vem daqui — e o painel web (admin) edita este arquivo.

const fs = require("fs");
const path = require("path");

const CAMINHO = path.join(__dirname, "..", "data", "config.json");

let dados = carregar();

function carregar() {
  const bruto = fs.readFileSync(CAMINHO, "utf8");
  return JSON.parse(bruto);
}

// Relê o arquivo do disco (chamado após salvar pelo painel).
function reload() {
  dados = carregar();
  return dados;
}

// Retorna os dados atuais em memória.
function get() {
  return dados;
}

// Salva novos dados no arquivo e atualiza a memória.
function salvar(novos) {
  fs.writeFileSync(CAMINHO, JSON.stringify(novos, null, 2), "utf8");
  dados = novos;
  return dados;
}

// Substitui {nome}, {telefone}, {endereco}, {horarioSemana}, etc. em qualquer texto.
function preencher(texto) {
  if (!texto) return texto;
  const n = dados.negocio;
  return texto
    .replace(/{nome}/g, n.nome)
    .replace(/{tipo}/g, n.tipo)
    .replace(/{endereco}/g, n.endereco)
    .replace(/{telefone}/g, n.telefone)
    .replace(/{horarioSemana}/g, n.horarioSemana)
    .replace(/{horarioSabado}/g, n.horarioSabado)
    .replace(/{horarioDomingo}/g, n.horarioDomingo)
    .replace(/{pagamento}/g, n.pagamento);
}

// Monta o texto da resposta de entrega: agrupa as taxas por serviço e lista
// os valores por faixa de distância (até X km) ou por local fixo (ex.: Caucaia).
function respostaEntrega() {
  const e = dados.entrega;
  const grupos = []; // preserva a ordem de aparição dos serviços
  for (const t of e.taxas || []) {
    const nome = t.servico || "Entrega";
    let g = grupos.find((x) => x.servico === nome);
    if (!g) {
      g = { servico: nome, linhas: [] };
      grupos.push(g);
    }
    const obs = t.obs ? ` (${t.obs})` : "";
    if (t.ate_km === "" || t.ate_km === null || t.ate_km === undefined) {
      // Entrada de local fixo (sem faixa de km).
      g.linhas.push(`• ${t.obs || "outras localidades"}: R$ ${t.valor}`);
    } else {
      g.linhas.push(`• até ${t.ate_km} km: R$ ${t.valor}${obs}`);
    }
  }
  const blocos = grupos.map((g) => `*${g.servico}*\n${g.linhas.join("\n")}`).join("\n\n");

  let texto = e.intro;
  if (blocos) texto += "\n\n" + blocos;
  if (e.rodape) texto += "\n\n" + e.rodape;
  return preencher(texto);
}

// Dada uma distância em km, devolve a taxa de cada serviço (faixa cujo "até X km"
// é o menor valor >= km). valor null = acima da maior faixa daquele serviço.
function calcularTaxas(km) {
  const porServico = {};
  for (const t of (dados.entrega && dados.entrega.taxas) || []) {
    if (t.ate_km === "" || t.ate_km === null || t.ate_km === undefined) continue; // ignora locais fixos
    (porServico[t.servico] = porServico[t.servico] || []).push(t);
  }
  const res = [];
  for (const servico of Object.keys(porServico)) {
    const tiers = porServico[servico].slice().sort((a, b) => a.ate_km - b.ate_km);
    const tier = tiers.find((t) => km <= t.ate_km);
    res.push({ servico, valor: tier ? tier.valor : null, ate_km: tier ? tier.ate_km : null });
  }
  return res;
}

// Lista unificada de "intenções" para o menu numerado e a busca por palavra-chave.
// Ordem: serviços, FAQ rápido e (se ativa) a entrega. O número no menu = posição aqui.
function intents() {
  const lista = [];
  for (const s of dados.servicos) {
    lista.push({ chave: s.chave, titulo: s.titulo, gatilhos: s.gatilhos, resposta: preencher(s.resposta) });
  }
  for (const f of dados.faqRapido) {
    lista.push({ chave: f.chave, titulo: f.titulo, gatilhos: f.gatilhos, resposta: preencher(f.resposta) });
  }
  if (dados.entrega && dados.entrega.ativo) {
    lista.push({
      chave: "entrega",
      titulo: dados.entrega.titulo,
      gatilhos: dados.entrega.gatilhos,
      resposta: respostaEntrega(),
    });
  }
  return lista;
}

module.exports = { get, reload, salvar, preencher, respostaEntrega, intents, calcularTaxas, CAMINHO };
