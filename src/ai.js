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
    ],
  },
];

async function executarFuncao(nome, args) {
  if (nome === "consultar_taxa_entrega") {
    return await geo.consultarTaxaPorEndereco((args && args.endereco) || "");
  }
  return { erro: "funcao_desconhecida" };
}

// Monta a "system instruction" com o contexto do negócio. Reconstruída a cada
// chamada para refletir edições feitas no painel sem reiniciar o bot.
function montarContexto() {
  const dados = config.get();
  const n = dados.negocio;

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
    "REGRAS:",
    "- Responda APENAS com base nas informações acima. Não invente preços, serviços, horários ou taxas.",
    "- Se a pergunta for sobre algo que você não tem (ex.: preço específico, disponibilidade, caso clínico), diga que vai verificar com um atendente e peça os dados necessários.",
    "- Nunca dê diagnóstico ou orientação médica veterinária; em emergências, oriente a ligar para o telefone do negócio.",
    "- Banho e tosa PODEM ser agendados: peça os dados que faltam (nome do pet, porte, dia e horário).",
    "- A CONSULTA VETERINÁRIA NÃO é agendada — é por ORDEM DE CHEGADA, dentro do horário do veterinário (segunda a sexta das 8h às 17h, sábado das 8h às 12h). Não peça dia/horário para a consulta; oriente o cliente a comparecer dentro desse horário.",
    "",
    "TAXA DE ENTREGA / TÁXI DOG:",
    "- Se o cliente informar um ENDEREÇO, use a função consultar_taxa_entrega (não calcule distância sozinho). Depois apresente os valores retornados.",
    "- Se o cliente informar direto a DISTÂNCIA em km (sem endereço), use a tabela acima: escolha a faixa 'até X km' cujo limite seja o menor valor >= à distância (ex.: 2,5 km → 'até 3 km').",
    "- Táxi Dog é sempre ida e volta. Entrega (moto) é valor único.",
    "- Se faltar o endereço/distância OU o serviço, pergunte antes de dar o valor (não chute).",
    "- Se a função não encontrar o endereço, ou a distância passar da área de cobertura, diga que um atendente confirma o valor exato.",
  ].join("\n");
}

// Histórico em memória no formato do Gemini: contactId -> [{role, parts:[{text}]}]
// Guardamos só as mensagens de texto (não as chamadas de função intermediárias).
const historicos = new Map();
const MAX_TURNOS = 6;

function getHistorico(contactId) {
  if (!historicos.has(contactId)) historicos.set(contactId, []);
  return historicos.get(contactId);
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

  // Loop de function calling (até 3 rodadas).
  for (let i = 0; i < 3; i++) {
    const chamadas = resp.functionCalls;
    if (!chamadas || chamadas.length === 0) break;

    working.push({ role: "model", parts: resp.candidates[0].content.parts });
    const partesResposta = [];
    for (const chamada of chamadas) {
      const resultado = await executarFuncao(chamada.name, chamada.args);
      partesResposta.push({ functionResponse: { name: chamada.name, response: resultado } });
    }
    working.push({ role: "user", parts: partesResposta });

    resp = await ai.models.generateContent({ model: MODELO, contents: working, config: cfg });
  }

  const texto =
    (resp.text || "").trim() ||
    "Desculpe, não entendi. Pode reformular? Ou digite *atendente* para falar com uma pessoa.";

  // Persiste só a mensagem do cliente e a resposta final (texto), mantendo o histórico limpo.
  historico.push({ role: "user", parts: [{ text: mensagem }] });
  historico.push({ role: "model", parts: [{ text: texto }] });
  if (historico.length > MAX_TURNOS) historico.splice(0, historico.length - MAX_TURNOS);

  return texto;
}

function limparHistorico(contactId) {
  historicos.delete(contactId);
}

module.exports = { responder, limparHistorico };
