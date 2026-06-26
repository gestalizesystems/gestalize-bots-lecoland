// Responde perguntas livres usando a IA gratuita do Google Gemini,
// ancorada nos dados atuais do negócio (lidos ao vivo do config.json).
//
// Function calling: quando o cliente informa um ENDEREÇO para entrega/táxi dog,
// a IA chama a função `consultar_taxa_entrega`, que geolocaliza o endereço,
// mede a distância de carro e calcula as taxas (cálculo determinístico no geo/config).

const { GoogleGenAI } = require("@google/genai");
const config = require("./config");
const geo = require("./geo");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODELO = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// Ferramenta exposta ao modelo.
const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "consultar_taxa_entrega",
        description:
          "Calcula a distância de carro da loja até o endereço do cliente e retorna as taxas de entrega e de táxi dog para essa distância. Use SEMPRE que o cliente informar um endereço (rua, número, bairro) querendo saber o valor da entrega ou do táxi dog. Não calcule distância por conta própria.",
        parameters: {
          type: "object",
          properties: {
            endereco: {
              type: "string",
              description: "Endereço completo informado pelo cliente, ex.: 'Rua das Carnaúbas, 777, Passaré'.",
            },
          },
          required: ["endereco"],
        },
      },
      {
        name: "buscar_produtos",
        description:
          "Busca produtos no CATÁLOGO da loja. Use quando o cliente quiser comprar/ver um PRODUTO (ração, petisco, brinquedo, acessório, areia, cosmético, etc.). Antes de chamar, faça perguntas curtas para descobrir o subgrupo (ex.: cão ou gato) e a especificação (ex.: filhote/adulto, porte, linha). Passe os filtros que já souber. Apresente só o que a função retornar (não invente produtos nem preços).",
        parameters: {
          type: "object",
          properties: {
            grupo: { type: "string", description: "Categoria principal (use exatamente um dos grupos listados no contexto, ex.: 'Rações')." },
            subgrupo: { type: "string", description: "Para qual animal/tipo (use um dos subgrupos do contexto, ex.: 'Cão', 'Gato')." },
            especificacao: { type: "string", description: "Detalhe de idade/porte/linha (use uma das especificações do contexto, ex.: 'Filhote', 'Adulto porte médio', 'Premium')." },
            texto: { type: "string", description: "Busca livre por nome/descrição, se o cliente citar marca ou termo específico." },
          },
          required: [],
        },
      },
      {
        name: "encaminhar_para_atendente",
        description:
          "Use quando o atendimento precisar de um ATENDENTE HUMANO. Exemplos: exames (precisa da guia do veterinário), pedido de remédio com nome/receita/foto, fechar valor de pacote de banho de cliente frequente, venda de aves/animais (ex.: calopsita), reclamações, ou qualquer caso fora do seu conhecimento. Ao chamar esta função, escreva TAMBÉM uma mensagem curta e simpática avisando o cliente que você já vai chamar um atendente.",
        parameters: {
          type: "object",
          properties: {
            motivo: {
              type: "string",
              description: "Motivo breve do encaminhamento (ex.: 'exame - aguardando guia', 'venda de calopsita', 'pacote cliente frequente').",
            },
          },
          required: ["motivo"],
        },
      },
    ],
  },
];

// Normaliza para comparar (minúsculas, sem acento, sem espaços nas bordas).
function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

// Busca produtos ativos no catálogo por grupo / subgrupo / especificação / texto livre.
function buscarProdutos({ grupo, subgrupo, especificacao, texto } = {}) {
  const cat = config.get().catalogo || {};
  const produtos = (cat.produtos || []).filter((p) => p && p.ativo !== false);
  const g = norm(grupo), sg = norm(subgrupo), esp = norm(especificacao), tx = norm(texto);
  const casa = (valor, alvo) => valor && (norm(valor).includes(alvo) || alvo.includes(norm(valor)));
  const casaLista = (lista, alvo) => Array.isArray(lista) && lista.some((x) => casa(x, alvo));

  const achados = produtos.filter((p) => {
    if (g && !casa(p.grupo, g)) return false;
    if (sg && !casaLista(p.subgrupos, sg)) return false;
    if (esp && !casaLista(p.especificacoes, esp)) return false;
    if (tx && !(norm(p.nome).includes(tx) || norm(p.descricao).includes(tx))) return false;
    return true;
  });

  return {
    total: achados.length,
    produtos: achados.slice(0, 8).map((p) => ({
      nome: p.nome,
      preco: p.preco || "(sob consulta)",
      descricao: (p.descricao || "").replace(/\s+/g, " ").slice(0, 140),
      grupo: p.grupo,
      subgrupos: p.subgrupos || [],
      especificacoes: p.especificacoes || [],
      imagem: p.imagem || "",
    })),
  };
}

async function executarFuncao(nome, args) {
  if (nome === "consultar_taxa_entrega") {
    return await geo.consultarTaxaPorEndereco((args && args.endereco) || "");
  }
  if (nome === "buscar_produtos") {
    return buscarProdutos(args || {});
  }
  if (nome === "encaminhar_para_atendente") {
    return { ok: true, instrucao: "Escreva uma mensagem curta e simpática avisando o cliente que você já vai chamar um atendente humano para continuar o atendimento por aqui." };
  }
  return { erro: "funcao_desconhecida" };
}

// Monta a "system instruction" com o contexto do negócio. Reconstruída a cada
// chamada para refletir edições feitas no painel sem reiniciar o bot.
function montarContexto() {
  const dados = config.get();
  const n = dados.negocio;
  const g = (dados.entrega && dados.entrega.gratis) || {}; // regra de entrega grátis
  const cat = dados.catalogo || {}; // catálogo (grupos/subgrupos/especificações/produtos)

  const extras = (dados.mensagensExtras || [])
    .map((x) => `- ${x.titulo}: ${(x.resposta || "").replace(/\n+/g, " ").replace(/\*/g, "")}`)
    .join("\n");
  const linhasServicos = config
    .intents()
    .map((o) => `- ${o.titulo}: ${o.resposta.replace(/\n+/g, " ").replace(/\*/g, "")}`)
    .join("\n") + (extras ? "\n" + extras : "");

  return [
    `Você é o atendente virtual da ${n.nome}, um(a) ${n.tipo}.`,
    "Seu papel é responder dúvidas de clientes pelo WhatsApp de forma simpática, curta e objetiva (no máximo ~4 linhas).",
    "Use português brasileiro informal e no máximo um emoji por mensagem.",
    "",
    "INFORMAÇÕES DO NEGÓCIO:",
    `Endereço: ${n.endereco}`,
    `Telefone: ${n.telefone}`,
    `Horário: ${n.horarioSemana}; ${n.horarioSabado}; ${n.horarioDomingo}`,
    `Pagamento: ${n.pagamento}`,
    "",
    "SERVIÇOS E INFORMAÇÕES:",
    linhasServicos,
    "",
    "CATÁLOGO DE PRODUTOS (consulte sempre com a função buscar_produtos — não invente itens):",
    `- Grupos (categorias): ${(cat.grupos || []).join(", ") || "—"}`,
    `- Subgrupos (para quem): ${(cat.subgrupos || []).join(", ") || "—"}`,
    `- Especificações (idade/porte/linha): ${(cat.especificacoes || []).join(", ") || "—"}`,
    "",
    dados.infoIA ? "CONHECIMENTO DO NEGÓCIO:\n" + dados.infoIA : "",
    "",
    "REGRAS:",
    "- MEMÓRIA: o histórico da conversa inclui as escolhas que o cliente fez no MENU (ex.: o serviço de entrega) e tudo que ele já informou. NUNCA pergunte de novo algo que o cliente já escolheu ou já disse — use o que já está na conversa. Ex.: se ele escolheu 'Entrega (moto)' no menu e mandou o endereço, calcule direto, sem perguntar o serviço outra vez.",
    "- Responda APENAS com base nas informações acima. Não invente preços, serviços, horários ou taxas.",
    "- Se a pergunta for sobre algo que você não tem (ex.: preço específico, disponibilidade, caso clínico), diga que vai verificar com um atendente e peça os dados necessários.",
    "- Nunca dê diagnóstico ou orientação médica veterinária; em emergências, oriente a ligar para o telefone do negócio.",
    "- Banho e tosa PODEM ser agendados: peça os dados que faltam (nome do pet, porte, dia e horário).",
    "- A CONSULTA VETERINÁRIA NÃO é agendada — é por ORDEM DE CHEGADA, dentro do horário do veterinário (segunda a sexta das 8h às 17h, sábado das 8h às 12h). Não peça dia/horário para a consulta; oriente o cliente a comparecer dentro desse horário.",
    "- Quando precisar de um atendente humano (exames com guia, remédio com nome/receita/foto, fechar valor de pacote de cliente frequente, venda de aves/animais, reclamações, ou algo fora do seu conhecimento), CHAME a função encaminhar_para_atendente e avise o cliente que vai chamar alguém. Não invente que já resolveu.",
    "",
    "PRODUTOS / CATÁLOGO (vale para QUALQUER produto: ração, petisco, brinquedo, acessório, areia, cosmético...):",
    "- IMPORTANTE: pergunta sobre produto NUNCA é respondida com o menu de saudação nem pedindo para o cliente escolher 1/2/3. SEMPRE use a função buscar_produtos.",
    "- Se o cliente JÁ deu detalhes (ex.: 'tem urinária pra gato?', 'ração premium pra cão filhote', cita uma marca), busque DIRETO com buscar_produtos usando o que ele disse — não fique perguntando à toa.",
    "- Só faça o mini-questionário (UMA pergunta por vez: 'É para cão ou gato?', 'Filhote ou adulto?', 'Qual o porte?') quando FALTAR informação para a busca.",
    "- Use só as opções que existem no CATÁLOGO acima (grupos/subgrupos/especificações). Quando tiver as respostas, CHAME a função buscar_produtos com grupo/subgrupo/especificacao.",
    "- Quando buscar_produtos retornar produtos, dê uma resposta CURTA de introdução (ex.: 'Achei essas opções pra você 🐾'). NÃO liste os produtos em texto: as FOTOS de cada produto (com nome e preço) são enviadas automaticamente logo depois da sua mensagem.",
    "- Se buscar_produtos retornar 0 produtos, NÃO invente: diga que vai confirmar a disponibilidade com um atendente e CHAME encaminhar_para_atendente.",
    "- Nunca invente produtos, marcas ou preços — use exclusivamente o que a função retornar.",
    "",
    "TAXA DE ENTREGA / TÁXI DOG:",
    "- Quando o cliente informar um ENDEREÇO, use a função consultar_taxa_entrega (não calcule distância sozinho).",
    "- Apresente a cotação EXATAMENTE neste formato (mesmos emojis e * para negrito):",
    "Segue a cotação da sua taxa:",
    "",
    "📍 *Endereço:* <endereço informado>",
    "📏 *Distância aproximada:* <km> km",
    "🚚 *Serviço:* <serviço escolhido>",
    "",
    "💰 *Valor da taxa:* *R$ <valor>*",
    "",
    `- ENTREGA GRÁTIS (vale APENAS para o serviço *Entrega moto* — NÃO vale para táxi dog): até ${g.km || 2} km, se o valor do pedido for acima de R$ ${g.valor || 50}, a Entrega moto é GRÁTIS (R$ 0). Se for até ${g.km || 2} km e o cliente não disse o valor do pedido, avise que, acima de R$ ${g.valor || 50}, a entrega moto sai de graça. Táxi dog sempre cobra a taxa normal.`,
    "- Táxi Dog é sempre ida e volta. Se o cliente JÁ escolheu o serviço (no menu ou antes na conversa), use esse serviço e NÃO pergunte de novo. Só pergunte (entrega moto, táxi dog moto ou táxi dog carro) se ele realmente ainda não tiver escolhido.",
    "- Se a função não encontrar o endereço, ou a distância passar da área de cobertura, diga que um atendente confirma o valor exato.",
  ].join("\n");
}

// Histórico em memória no formato do Gemini: contactId -> [{role, parts:[{text}]}]
// Guardamos só as mensagens de texto (não as chamadas de função intermediárias).
const historicos = new Map();
const MAX_TURNOS = 12;

function getHistorico(contactId) {
  if (!historicos.has(contactId)) historicos.set(contactId, []);
  return historicos.get(contactId);
}

// Registra no histórico um turno tratado FORA da IA (menu/opção/comando), para que
// a IA "lembre" o que já aconteceu (ex.: o cliente já escolheu Entrega moto no menu).
function registrarTurno(contactId, userMsg, botMsg) {
  const historico = getHistorico(contactId);
  historico.push({ role: "user", parts: [{ text: String(userMsg || "") }] });
  historico.push({ role: "model", parts: [{ text: String(botMsg || "") }] });
  if (historico.length > MAX_TURNOS) historico.splice(0, historico.length - MAX_TURNOS);
}

async function responder(contactId, mensagem) {
  const historico = getHistorico(contactId);
  // Array de trabalho: histórico + nova mensagem (recebe as chamadas de função).
  const working = [...historico, { role: "user", parts: [{ text: mensagem }] }];

  const cfg = {
    systemInstruction: montarContexto(),
    maxOutputTokens: 600,
    temperature: 0.3,
    tools: TOOLS,
  };
  if (MODELO.includes("2.5")) cfg.thinkingConfig = { thinkingBudget: 0 };

  let resp = await ai.models.generateContent({ model: MODELO, contents: working, config: cfg });

  let encaminhar = false;
  let motivo = "";
  let produtos = []; // produtos achados na última busca (pra enviar com foto)

  // Loop de function calling (até 3 rodadas).
  for (let i = 0; i < 3; i++) {
    const chamadas = resp.functionCalls;
    if (!chamadas || chamadas.length === 0) break;

    working.push({ role: "model", parts: resp.candidates[0].content.parts });
    const partesResposta = [];
    for (const chamada of chamadas) {
      if (chamada.name === "encaminhar_para_atendente") {
        encaminhar = true;
        motivo = (chamada.args && chamada.args.motivo) || "";
      }
      const resultado = await executarFuncao(chamada.name, chamada.args);
      if (chamada.name === "buscar_produtos" && resultado && Array.isArray(resultado.produtos)) produtos = resultado.produtos;
      partesResposta.push({ functionResponse: { name: chamada.name, response: resultado } });
    }
    working.push({ role: "user", parts: partesResposta });

    resp = await ai.models.generateContent({ model: MODELO, contents: working, config: cfg });
  }

  const texto =
    (resp.text || "").trim() ||
    (encaminhar
      ? "Vou te encaminhar para um atendente, só um instante! 🙋"
      : "Desculpe, não entendi. Pode reformular? Ou digite *atendente* para falar com uma pessoa.");

  // Persiste só a mensagem do cliente e a resposta final (texto), mantendo o histórico limpo.
  historico.push({ role: "user", parts: [{ text: mensagem }] });
  historico.push({ role: "model", parts: [{ text: texto }] });
  if (historico.length > MAX_TURNOS) historico.splice(0, historico.length - MAX_TURNOS);

  return { texto, encaminhar, motivo, produtos };
}

function limparHistorico(contactId) {
  historicos.delete(contactId);
}

module.exports = { responder, limparHistorico, registrarTurno, buscarProdutos };
