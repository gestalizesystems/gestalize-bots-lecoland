// Carrega e salva os dados do negócio a partir de data/config.json.
// Tudo que o bot responde vem daqui — e o painel web (admin) edita este arquivo.

const fs = require("fs");
const path = require("path");

// Em produção (Railway) o DATA_DIR aponta para um Volume persistente; local usa data/.
const DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const SEMENTE = path.join(__dirname, "..", "data", "config.json"); // versão inicial (no repo)
const CAMINHO = path.join(DIR, "config.json");

let dados = carregar();

function carregar() {
  if (!fs.existsSync(CAMINHO)) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.copyFileSync(SEMENTE, CAMINHO); // 1ª vez no Volume: semeia a partir do repo
  }
  const d = JSON.parse(fs.readFileSync(CAMINHO, "utf8"));
  if (migrar(d)) fs.writeFileSync(CAMINHO, JSON.stringify(d, null, 2), "utf8");
  return d;
}

// Migrações pontuais aplicadas ao config persistido (ex.: no Volume do Railway).
function migrar(d) {
  let mudou = false;
  if (d.entrega && !d.entrega.gratis) { d.entrega.gratis = { km: "2", valor: "50" }; mudou = true; }
  if (!d._entregaSubmenu) {
    if (d.entrega) d.entrega.ativo = false; // entrega vira sub-menu (sai do menu principal)
    if (!Array.isArray(d.menus)) d.menus = [];
    if (!d.menus.some((m) => m.id === "entrega")) {
      d.menus.push({
        id: "entrega",
        nome: "Entrega / Táxi Dog",
        gatilhos: ["entrega", "delivery", "frete", "taxa", "taxa de entrega", "taxi dog", "taxidog", "leva e traz", "buscar", "buscam", "entregam"],
        intro: "🛵 *Entrega / Táxi Dog* — qual serviço você quer?",
        opcoes: [
          { titulo: "Entrega (moto)", resposta: "Beleza! 🛵 Me diga seu *endereço completo* (rua, número e bairro) que eu calculo o valor da entrega. 🐾" },
          { titulo: "Táxi Dog moto (ida e volta)", resposta: "Show! 🐕 Me diga seu *endereço completo* que eu calculo o valor do táxi dog (moto). 🐾" },
          { titulo: "Táxi Dog carro (ida e volta)", resposta: "Combinado! 🚗 Me diga seu *endereço completo* que eu calculo o valor do táxi dog (carro). 🐾" },
        ],
      });
    }
    d._entregaSubmenu = true; mudou = true;
  }
  // Importa o catálogo ONEPET (nome + preço) para o Volume, uma única vez.
  if (!d._onepetImportado) {
    try {
      const sem = JSON.parse(fs.readFileSync(SEMENTE, "utf8"));
      const semProds = (sem.catalogo && sem.catalogo.produtos) || [];
      if (!d.catalogo || typeof d.catalogo !== "object") d.catalogo = { grupos: [], subgrupos: [], especificacoes: [], produtos: [] };
      if (!Array.isArray(d.catalogo.produtos)) d.catalogo.produtos = [];
      const tem = new Set(d.catalogo.produtos.map((p) => String(p.nome || "").toLowerCase().trim()));
      for (const p of semProds) {
        const k = String(p.nome || "").toLowerCase().trim();
        if (k && !tem.has(k)) { d.catalogo.produtos.push(p); tem.add(k); }
      }
      d._onepetImportado = true; mudou = true;
    } catch (_) { /* sem seed acessível — ignora */ }
  }
  // Remove gatilhos de saudação amplos demais que sequestravam pedidos reais
  // (ex.: "queria pedir uma ração" batia em "pedir" e mandava o menu).
  if (!d._gatilhosLimpos) {
    if (Array.isArray(d.gatilhosSaudacao)) {
      const remover = ["quero", "pedir", "queria"];
      d.gatilhosSaudacao = d.gatilhosSaudacao.filter((g) => !remover.includes(String(g).toLowerCase().trim()));
    }
    d._gatilhosLimpos = true; mudou = true;
  }
  // Endereço: garante o link do Google Maps e remove a referência ao restaurante.
  if (!d._mapsEndereco) {
    if (!d.negocio) d.negocio = {};
    if (!d.negocio.mapsLink) d.negocio.mapsLink = "https://maps.app.goo.gl/CJWisnSGuaf3yCtQA";
    (d.faqRapido || []).forEach((f) => {
      if (/endere/i.test(f.titulo || "") && typeof f.resposta === "string") {
        f.resposta = f.resposta
          .replace(/\s*\(?em frente ao restaurante[^)\n]*\)?/gi, "") // tira o restaurante (e o parêntese)
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n");
        if (!/maps\.app\.goo\.gl|\{maps\}/i.test(f.resposta)) {
          f.resposta = f.resposta.replace(/(\{endereco\})/i, "$1\n🗺️ Ver no mapa: {maps}");
        }
      }
    });
    d._mapsEndereco = true; mudou = true;
  }
  // Catálogo: mantém só os produtos VENDIDOS no último ano (data/codigos-vendidos.json).
  if (!d._catalogoVendidos) {
    try {
      const lista = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "codigos-vendidos.json"), "utf8"));
      const codigos = new Set(lista.map(String));
      if (d.catalogo && Array.isArray(d.catalogo.produtos)) {
        d.catalogo.produtos = d.catalogo.produtos.filter((p) => {
          const cod = String(p.codigo || "").trim();
          return !cod || codigos.has(cod); // mantém os sem-código (cadastrados à mão) e os vendidos
        });
      }
      d._catalogoVendidos = true; mudou = true;
    } catch (_) { /* sem a lista de vendidos — não filtra */ }
  }
  // Catálogo: atualiza preços e desativa estoque 0 / N/D (data/precos-estoque.json).
  if (!d._precosEstoque) {
    try {
      const mapa = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "precos-estoque.json"), "utf8"));
      ((d.catalogo && d.catalogo.produtos) || []).forEach((p) => {
        const u = mapa[String(p.codigo || "").trim()];
        if (!u) return;
        if (u.preco) p.preco = u.preco;
        if (u.inativar) p.ativo = false;
      });
      d._precosEstoque = true; mudou = true;
    } catch (_) { /* sem a tabela de preços/estoque — não altera */ }
  }
  // Conhecimento operacional da Lecoland (respostas do dia a dia) → adiciona ao "Sobre o negócio" (infoIA).
  if (!d._conhecimentoLecoland) {
    const marca = "=== Operação da Lecoland (informações para o atendimento) ===";
    const bloco = [
      "",
      "",
      marca,
      "ESTACIONAMENTO: há estacionamento na rua em frente à loja — só mencione se o cliente perguntar.",
      "HORÁRIOS: não fechamos para almoço nem em dia de semana (só em feriados). Feriados: decidimos perto da data se abrimos.",
      "BANHO E TOSA: temos leva-e-traz (táxi dog), com valor calculado pelo endereço (táxi dog moto; táxi dog carro para cães maiores). O tempo depende da demanda do dia — não damos hora marcada, pra não frustrar o cliente se atrasar. Fazemos hidratação, tosa de raça específica e tratamento de pele (valor só com avaliação do pet).",
      "VETERINÁRIO: além de clínico geral e oftalmologia, fazemos outras especialidades (dermato, cardio, etc.) — valores e horários a consultar com a equipe (encaminhar). O RETORNO da consulta é GRÁTIS, marcado com o vet no dia da 1ª consulta. NÃO fazemos atendimento a domicílio. NÃO fazemos internação e NÃO temos hotel para pets. Fazemos aplicações (medicação/soro) — quando for aplicação com encaminhamento, encaminhar para atendente.",
      "VACINAS: aplicamos V8, V10, antirrábica, gripe, giárdia e, para gato, quádrupla/quíntupla e FeLV. NÃO precisa de consulta nem jejum para vacinar. Fazemos carteirinha para pets que não têm. NÃO aplicamos vacinas/produtos comprados em outro lugar. Valores das vacinas: consultar com a equipe.",
      "EXAMES: fazemos exames (sangue, ultrassom, raio-x, leishmaniose, etc.) COM AGENDAMENTO — encaminhar para atendente. Hemograma sem guia exige consulta antes e jejum (definido pelo vet).",
      "CASTRAÇÃO/CIRURGIA: fazemos castração. O tutor passa por consulta com o clínico geral, que pede os exames necessários e passa o orçamento.",
      "PRODUTOS: a maioria dos medicamentos NÃO precisa de receita. Fazemos encomenda de produto sem estoque (às vezes chega em 1 dia útil) — encaminhar para atendente verificar disponibilidade. Troca/devolução: trocamos produtos LACRADOS por crédito na loja ou estorno pelo mesmo meio de pagamento da compra.",
      "RAÇÕES — marcas que trabalhamos: Cão = Premier, Golden, Fargo, Zuppy, GranPlus, Guabi Natural, ND, Dog Chow, VetLife, Blend. Gato = Golden, Fargo, Zuppy, Chanin, Friskies, Katbom, GranPlus, ND, VetLife. (Marcas SÓ de gato: Chanin, Friskies, Katbom, Matisse.)",
    ].join("\n");
    if (typeof d.infoIA !== "string") d.infoIA = "";
    if (!d.infoIA.includes(marca)) d.infoIA = (d.infoIA + bloco).trim();
    d._conhecimentoLecoland = true; mudou = true;
  }
  // Conhecimento operacional — parte 2 (entrega/retirada/políticas).
  if (!d._conhecimentoLecoland2) {
    const marca2 = "=== Operação da Lecoland (parte 2) ===";
    const bloco2 = [
      "",
      "",
      marca2,
      "ENTREGA — PRAZO: prazo médio de 1h30, podendo passar um pouco conforme a demanda e o horário de almoço.",
      "ENTREGA — ACIMA DE 10 km: pedido mínimo de R$ 100. A taxa não é fixa — é calculada pela distância.",
      "RETIRADA/RESERVA: liberamos retirada na loja. Reserva de produto só APÓS o pagamento.",
      "FIDELIDADE: não temos programa de fidelidade, cashback nem clube de desconto.",
      "FIADO: não vendemos fiado nem temos cliente mensalista.",
      "VENDA DE ANIMAIS: damos garantia e orientação de cuidados na venda.",
    ].join("\n");
    if (typeof d.infoIA !== "string") d.infoIA = "";
    if (!d.infoIA.includes(marca2)) d.infoIA = (d.infoIA + bloco2).trim();
    d._conhecimentoLecoland2 = true; mudou = true;
  }
  // Conhecimento operacional — parte 3 (regras na loja / emergência).
  if (!d._conhecimentoLecoland3) {
    const marca3 = "=== Operação da Lecoland (parte 3) ===";
    const bloco3 = [
      "",
      "",
      marca3,
      "LEVAR O PET: não precisa de caixa de transporte. Mas se o pet vier para o BANHO, precisa vir de COLEIRA E GUIA.",
      "PETS BRAVOS: recebemos pets bravos / que precisam de focinheira. Se não conseguirmos fazer o serviço com segurança, avisamos o tutor e o pet volta para casa.",
      "EMERGÊNCIA FORA DO HORÁRIO: oriente o cliente a ligar para a clínica 24h mais próxima. Normalmente indicamos a JulyPet, na Av. Silas Munguba.",
    ].join("\n");
    if (typeof d.infoIA !== "string") d.infoIA = "";
    if (!d.infoIA.includes(marca3)) d.infoIA = (d.infoIA + bloco3).trim();
    d._conhecimentoLecoland3 = true; mudou = true;
  }
  return mudou;
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
    .replace(/{maps}/g, n.mapsLink || "")
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

module.exports = { get, salvar, preencher, respostaEntrega, intents, calcularTaxas, CAMINHO };
