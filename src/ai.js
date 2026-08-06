// Responde perguntas livres usando a IA gratuita do Google Gemini,
// ancorada nos dados atuais do negócio (lidos ao vivo do config.json).
//
// Function calling: quando o cliente informa um ENDEREÇO para entrega/táxi dog,
// a IA chama a função `consultar_taxa_entrega`, que geolocaliza o endereço,
// mede a distância de carro e calcula as taxas (cálculo determinístico no geo/config).

const { GoogleGenAI } = require("@google/genai");
const config = require("./config");
const geo = require("./geo");
const clientes = require("./clientes");
const equipe = require("./equipe");

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
              description: "Endereço completo informado pelo cliente, ex.: 'Rua das Flores, 123, Centro'.",
            },
          },
          required: ["endereco"],
        },
      },
      {
        name: "salvar_dados_cliente",
        description:
          "Guarda na memória os dados do cliente (nome e/ou endereço) para lembrar nas próximas conversas. Chame SEMPRE que o cliente informar o nome dele ou um endereço. Passe só o que ele disse.",
        parameters: {
          type: "object",
          properties: {
            nome: { type: "string", description: "Nome do cliente, se ele informou." },
            endereco: { type: "string", description: "Endereço do cliente (rua, número, bairro), se ele informou." },
          },
          required: [],
        },
      },
      {
        name: "salvar_pet",
        description:
          "Guarda na memória um PET do cliente (nome e raça). Chame quando o cliente informar o nome e/ou a raça do pet — especialmente em assuntos de banho, tosa ou consulta. Assim nas próximas vezes você já sabe o nome do pet.",
        parameters: {
          type: "object",
          properties: {
            nome: { type: "string", description: "Nome do pet (ex.: 'Belinha')." },
            raca: { type: "string", description: "Raça do pet, se informada (ex.: 'Poodle', 'SRD/vira-lata')." },
          },
          required: ["nome"],
        },
      },
      {
        name: "buscar_produtos",
        description:
          "Busca produtos no CATÁLOGO da loja. Use quando o cliente quiser comprar/ver um PRODUTO (ração, petisco, brinquedo, acessório, areia, cosmético, medicamento, vermifugo, antipulgas, etc.). Se a espécie (cão/gato) e outras informações já forem conhecidas pelo contexto da conversa, BUSQUE DIRETO sem perguntar de novo. Só faça perguntas quando as informações realmente não estiverem disponíveis. Passe os filtros que já souber. Apresente só o que a função retornar (não invente produtos nem preços).",
        parameters: {
          type: "object",
          properties: {
            grupo: { type: "string", description: "Categoria principal (use exatamente um dos grupos listados no contexto, ex.: 'Rações')." },
            subgrupo: { type: "string", description: "Para qual animal/tipo (use um dos subgrupos do contexto, ex.: 'Cão', 'Gato')." },
            especificacao: { type: "string", description: "Detalhe de idade/porte/linha (use uma das especificações do contexto, ex.: 'Filhote', 'Adulto porte médio', 'Premium')." },
            texto: { type: "string", description: "Busca livre por nome/descrição, se o cliente citar marca ou termo específico." },
            ordenarPor: { type: "string", enum: ["preco"], description: "Use 'preco' quando o cliente pedir o MAIS BARATO / mais em conta — ordena do menor para o maior preço." },
          },
          required: [],
        },
      },
      {
        name: "obter_info_granel",
        description:
          "Obtém as informações de ração a granel (preços, disponibilidade, como funciona) registradas nas respostas rápidas da loja, para cães ou gatos. Use APENAS quando o cliente quiser ração a granel (no quilo / fracionado) sem citar uma marca específica. Não use para ração em saca fechada.",
        parameters: {
          type: "object",
          properties: {
            especie: {
              type: "string",
              enum: ["cao", "gato"],
              description: "Espécie do pet: 'cao' para cão/cachorro, 'gato' para gato.",
            },
          },
          required: ["especie"],
        },
      },
      {
        name: "encaminhar_para_atendente",
        description:
          "Use quando o atendimento precisar de um ATENDENTE HUMANO. Exemplos: AGENDAR/MARCAR/TRAZER pet pro BANHO ou TOSA (confirmar vaga e horário), exames (precisa da guia do veterinário), fechar valor de pacote de banho de cliente frequente, venda de aves/animais (ex.: calopsita), reclamações, ENTREGA de medicamento/pedido a fechar, ou qualquer caso fora do seu conhecimento. NÃO use só porque o cliente mandou uma receita — primeiro busque os medicamentos no catálogo e passe os valores. Ao chamar esta função, escreva TAMBÉM uma mensagem curta e simpática avisando o cliente que você já vai chamar um atendente.",
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

// Conectivos ignorados na busca por texto (não ajudam a casar e atrapalham o "todas as palavras").
const STOPWORDS = new Set([
  "de", "do", "da", "dos", "das", "para", "pra", "pro", "com", "e", "o", "a", "os", "as", "em", "no", "na", "ml", "mg",
  // Pronomes pessoais/possessivos — nunca identificam um produto
  "ele", "ela", "eles", "elas", "eu", "tu", "nos", "voce", "voces", "pet",
  "meu", "minha", "meus", "minhas", "seu", "sua", "seus", "suas",
  // Indefinidos e advérbios conversacionais — nunca identificam um produto
  "nenhum", "nenhuma", "nenhuns", "nenhumas", "nada", "ninguem",
  "ainda", "ja", "so", "ate", "nunca", "sempre", "tambem", "mesmo",
  "isso", "esse", "essa", "esses", "essas", "este", "esta", "estes", "estas", "aquele", "aquela",
  // Verbos auxiliares conversacionais — nunca identificam um produto
  "vou", "vai", "vem", "ira", "iria", "sera", "serei", "vim", "foi", "fui", "tem",
]);

// Sinônimos de busca: a palavra da esquerda casa se QUALQUER termo à direita aparecer no produto.
// Resolve os nomes técnicos do catálogo: "a quilo/kg/fracionado" = GRANEL.
// ESPÉCIE (gato/cão) ficam em SINONIMOS_EXATOS (match palavra inteira) para evitar que
// "cao" case dentro de "racao", devolvendo produtos da espécie errada.
const ESPECIE_GATO = ["gato", "gata", "gatos", "cat", "cats", "felino", "felina", "feline"];
const ESPECIE_CAO = ["cao", "cachorro", "cachorros", "caes", "cadela", "dog", "dogs", "canino", "canina", "canine"];
const SINONIMOS = {
  granel: ["granel", "fracionad"],
  quilo: ["granel", "fracionad"],
  quilos: ["granel", "fracionad"],
  kilo: ["granel", "fracionad"],
  kg: ["granel", "fracionad"],
  fracionado: ["granel", "fracionad"],
  fracionada: ["granel", "fracionad"],
  racao: ["racao", "racoes", "alimento"],
  racoes: ["racao", "racoes", "alimento"],
  comida: ["racao", "racoes", "alimento", "comida"],
  // PT ↔ EN — nomes de ração costumam vir em inglês (necessidade, idade, sabor).
  urinaria: ["urinaria", "urinario", "urinary"],
  urinario: ["urinaria", "urinario", "urinary"],
  urinary: ["urinaria", "urinario", "urinary"],
  filhote: ["filhote", "filhotes", "filhotinho", "puppy", "kitten", "junior"],
  filhotes: ["filhote", "filhotes", "puppy", "kitten", "junior"],
  adulto: ["adulto", "adultos", "adult", " ad "],  // " ad " = abreviação de adulto em nomes de produtos
  adultos: ["adulto", "adultos", "adult", " ad "],
  senior: ["senior", "idoso", "idosa", "mature"],
  idoso: ["senior", "idoso", "idosa", "mature"],
  frango: ["frango", "chicken"],
  chicken: ["frango", "chicken"],
  carne: ["carne", "beef"],
  salmao: ["salmao", "salmon"],
  salmon: ["salmao", "salmon"],
  peixe: ["peixe", "fish"],
  cordeiro: ["cordeiro", "lamb"],
  arroz: ["arroz", "rice"],
  sensivel: ["sensivel", "sensitive"],
  renal: ["renal", "kidney"],
  light: ["light", "control"],
};
// Sinônimos com match de PALAVRA INTEIRA (não substring).
// Matching: (" " + alvo + " ").includes(" " + termo + " ") — palavra delimitada por espaços.
// ESPÉCIE obrigatoriamente aqui: "cao" é substring de "racao", então match simples devolve
// ração de gato para buscas de cachorro (e vice-versa).
const SINONIMOS_EXATOS = {
  // Espécie — match exato para não confundir "racao" com "cao" nem "gato" com substring de marca
  gato: ESPECIE_GATO, gata: ESPECIE_GATO, gatos: ESPECIE_GATO, cat: ESPECIE_GATO, felino: ESPECIE_GATO, feline: ESPECIE_GATO,
  cao: ESPECIE_CAO, caes: ESPECIE_CAO, cachorro: ESPECIE_CAO, cachorros: ESPECIE_CAO, cadela: ESPECIE_CAO, dog: ESPECIE_CAO, canino: ESPECIE_CAO,
  // Antiparasitário — evita "verme" casar "vermelha", "pulga" casar prefixos etc.
  verme: ["verme"], vermes: ["verme"],
  vermifugo: ["verme"], vermifuge: ["verme"], vermifugar: ["verme"],
  pulga: ["pulga"], carrapato: ["carrapato"],
  // "cast" (abreviação de castrado/a nos nomes) é curto demais pra substring — bate dentro de
  // qualquer palavra que contenha essas letras (ex.: "ARRANHA CASTELO", "CASTANHA"), trazendo
  // produto aleatório sem nenhuma relação com castração.
  castrado: ["castrado", "castrada", "castrados", "cast", "neutered", "sterili"],
  castrada: ["castrado", "castrada", "cast", "neutered", "sterili"],
};

// Palavras GENÉRICAS de categoria (não identificam a marca/item) — dropadas PRIMEIRO no relaxamento,
// pra não sequestrar a busca (ex.: "ração chanin" nunca deve virar "ração" e trazer outra marca).
const GENERICOS = new Set(["racao", "racoes", "comida", "alimento", "produto", "item", "sabor", "racaozinha", "remedio", "remedios", "medicamento", "medicamentos", "suplemento", "vitamina", "vitaminas", "mineral", "minerais", "nutricional", "nutritivo", "nutritiva"]);
// "Saca / saco / fechada / pacote" = ração ENSACADA (fechada) — o oposto de granel. Quando aparece,
// a busca EXCLUI os produtos a granel e mostra só as sacas fechadas (7,5kg, 10kg, 15kg, 20kg, 25kg...).
const SACA = new Set(["saca", "sacas", "saco", "sacos", "sacaria", "fechada", "fechado", "fechadas", "pacote", "pacotes", "ensacada", "ensacado"]);
// Palavras-ÂNCORA: nunca são relaxadas. A ESPÉCIE (cão/gato) impede misturar as duas espécies;
// granel/quilo garante que "a quilo" só traga produtos a granel.
const ANIMAIS = new Set([...ESPECIE_GATO, ...ESPECIE_CAO]);
const ANCORAS = new Set([...ANIMAIS, "granel", "quilo", "quilos", "kilo", "kg", "fracionado", "fracionada"]);

// Busca produtos ativos no catálogo por grupo / subgrupo / especificação / texto livre.
function precoNum(p) {
  const s = String(p || "").replace(/[^\d,]/g, "").replace(",", ".");
  const n = parseFloat(s);
  return isNaN(n) || n <= 0 ? Infinity : n; // sem preço/sob consulta vai pro fim
}

function buscarProdutos({ grupo, subgrupo, especificacao, texto, ordenarPor } = {}) {
  const cat = config.get().catalogo || {};
  const produtos = (cat.produtos || []).filter((p) => p && p.ativo !== false);
  const g = norm(grupo), sg = norm(subgrupo), esp = norm(especificacao), tx = norm(texto);
  // Nem todo produto do catálogo tem grupo/subgrupo/especificação tagueados (cadastro
  // manual item a item, então alguns ficam pra trás). Filtrar de forma rígida puniria
  // exatamente esses produtos sem tag com um falso "não temos" (ex.: "golden gato castrado"
  // com subgrupo="Gato" zeraria se aquele item específico não tiver subgrupo marcado, mesmo
  // existindo e batendo perfeitamente pelo nome). Por isso o filtro abaixo (em filtrarPor) só
  // é aplicado produto a produto, exigindo a tag SÓ de quem a tem preenchida — quem não tem
  // simplesmente não é descartado por isso, e continua valendo pela busca por texto/nome.
  const grupoEmUso = produtos.some((p) => p.grupo);
  const subgruposEmUso = produtos.some((p) => Array.isArray(p.subgrupos) && p.subgrupos.length);
  const especEmUso = produtos.some((p) => Array.isArray(p.especificacoes) && p.especificacoes.length);
  let palavrasTx = tx.split(/\s+/).filter((w) => w && w.length >= 3 && !STOPWORDS.has(w)); // ≥3 chars evita "vi"/"pé" casarem por substring
  // "saca / saco / fechada / pacote" = ração ensacada → exclui granel. É modificador, sai da busca por texto.
  const querSaca = palavrasTx.some((w) => SACA.has(w));
  palavrasTx = palavrasTx.filter((w) => !SACA.has(w));
  // Sem nenhum critério que o catálogo de fato usa → não retorna tudo (filtrarPor([]) é
  // vacuosamente verdadeiro). Um filtro que NENHUM produto do catálogo usa não conta como
  // critério (senão zeraria a busca sozinho, sem chance de cair no fallback por texto).
  if (!(g && grupoEmUso) && !(sg && subgruposEmUso) && !(esp && especEmUso) && !palavrasTx.length) return { total: 0, produtos: [] };
  const casa = (valor, alvo) => valor && (norm(valor).includes(alvo) || alvo.includes(norm(valor)));
  const casaLista = (lista, alvo) => Array.isArray(lista) && lista.some((x) => casa(x, alvo));
  // Alvo da busca por texto: nome + descrição + tags (grupo/subgrupos/especificações).
  // Separadores (- + / |) são substituídos por espaço para que palavras como "AMOXICILINA" em
  // "AGEMOXI CL 250MG - AMOXICILINA +CLAVULANATO" virem tokens independentes.
  const normAlvo = (s) => norm(s).replace(/[-+/|]+/g, " ").replace(/\s+/g, " ").trim();
  const alvoDe = (p) => [p.nome, p.descricao, p.grupo, ...(p.subgrupos || []), ...(p.especificacoes || [])].map(normAlvo).join(" ");
  // Quando o subgrupo pedido é espécie (Cão/Gato) e o produto NÃO tem subgrupo tagueado,
  // não deixa passar às cegas: se o nome/descrição do produto citar a espécie OPOSTA (ex.:
  // "GOLDEN GATOS..." numa busca de Cão), exclui — nunca mistura espécie, mesmo em item
  // esquecido no cadastro. Produto cujo nome não cita nenhuma das duas (marca implicitamente
  // de uma espécie, ex.: Chanin) passa — a IA já embute a espécie certa no texto da busca.
  const especieOposta = (alvo, sgAlvo) => {
    if (sgAlvo === "gato") return ESPECIE_CAO.some((s) => (" " + alvo + " ").includes(" " + s + " "));
    if (sgAlvo === "cao") return ESPECIE_GATO.some((s) => (" " + alvo + " ").includes(" " + s + " "));
    return false;
  };
  // Uma palavra casa se QUALQUER um dos seus sinônimos aparecer (ex.: "gato" casa "cat"; "quilo" casa "granel").
  const casaPalavra = (alvo, w) => {
    if (SINONIMOS_EXATOS[w]) return SINONIMOS_EXATOS[w].some((s) => (" " + alvo + " ").includes(" " + s + " "));
    if (SINONIMOS[w]) return SINONIMOS[w].some((s) => alvo.includes(s));
    if (/^\d/.test(w)) {
      // Quantidade (ex.: "7kg", "10kg"): casa o tamanho ESCRITO no nome, com decimal OPCIONAL e
      // como token inteiro. Ex.: "7kg" casa "7,5KG"; "10kg" casa "10KG" e "10.1KG"; e nunca pega
      // "1kg" dentro de "10.1kg". Além disso, "1kg/1quilo" também significa ração a GRANEL.
      // "g" é opcional (kg?) para casas com produtos cadastrados como "25K" em vez de "25KG".
      const num = (w.match(/^\d+/) || [""])[0]; // parte inteira do tamanho
      if (num && new RegExp("(?<![\\d.,])" + num + "([.,]\\d+)?\\s*kg?(?![a-z0-9])").test(alvo)) return true;
      if (num === "1" && /^1\s*(k|kg|kilo|quilo)?$/.test(w)) return alvo.includes("granel") || alvo.includes("fracionad");
      return false;
    }
    if (alvo.includes(w)) return true;
    // Fallback: compara sem espaços — resolve "pipicat" vs "pipi cat" / "pipi-cat"
    if (!w.includes(" ")) return alvo.replace(/\s+/g, "").includes(w);
    return false;
  };

  // RAÇÃO é o grupo com cadastro de subgrupo/especificação mais confiável no catálogo — ali
  // vale a regra estrita: só entra quem TEM a tag pedida (senão cai no handoff, nunca mistura
  // espécie nem "adivinha" por nome). Nas demais categorias (medicamento, acessório etc.), o
  // cadastro de tags é mais incompleto — mantém o comportamento tolerante (produto sem tag não
  // é descartado por isso, só protegido contra espécie oposta quando o subgrupo pedido é cão/gato).
  const ehRacao = (p) => /^rac/.test(norm(p.grupo)); // "ração"→"racao" / "rações"→"racoes": só o prefixo é comum
  const filtrarPor = (palavras) => produtos.filter((p) => {
    const alvo = alvoDe(p);
    const racao = ehRacao(p);
    // Ração "GRANEL ..." é item de outro fluxo (obter_info_granel, que já funciona e cobre
    // preço/disponibilidade a granel) — nunca deve aparecer misturado numa busca normal de saca.
    if (racao && /^granel\b/.test(norm(p.nome))) return false;
    if (g && p.grupo && !casa(p.grupo, g)) return false;
    if (sg) {
      if (racao || (Array.isArray(p.subgrupos) && p.subgrupos.length)) {
        if (!casaLista(p.subgrupos, sg)) return false;
      } else if (especieOposta(alvo, sg)) return false;
    }
    if (esp) {
      if (racao || (Array.isArray(p.especificacoes) && p.especificacoes.length)) {
        if (!casaLista(p.especificacoes, esp)) return false;
      }
    }
    if (querSaca && (alvo.includes("granel") || alvo.includes("fracionad"))) return false; // "saca" exclui granel
    if (palavras.length && !palavras.every((w) => casaPalavra(alvo, w))) return false;
    return true;
  });

  // ÂNCORAS (espécie/granel) são obrigatórias e nunca dropadas → nunca mistura cão com gato,
  // e "a quilo" só traz granel. As demais palavras ('outras') podem ser relaxadas.
  const ancoras = palavrasTx.filter((w) => ANCORAS.has(w));
  let outras = palavrasTx.filter((w) => !ANCORAS.has(w));

  let achados = filtrarPor([...ancoras, ...outras]);
  if (!achados.length && outras.length) {
    // Quantas vezes cada palavra casa sozinha (mede o quão seletiva ela é).
    const cnt = (w) => produtos.reduce((n, p) => n + (casaPalavra(alvoDe(p), w) ? 1 : 0), 0);
    // 0) Dropa palavras genéricas (racao, comida...) se sobrar algo específico — a marca/tipo manda.
    if (outras.some((w) => GENERICOS.has(w)) && outras.some((w) => !GENERICOS.has(w))) {
      outras = outras.filter((w) => !GENERICOS.has(w));
      achados = filtrarPor([...ancoras, ...outras]);
    }
    // 1) Remove palavras que não casam com NADA (typo/abreviação que zera o AND, ex.: "suspensao"
    //    quando o nome traz "SUSP"). Assim "hepvet suspensao" → "hepvet".
    if (!achados.length) {
      const outrasFiltradas = outras.filter((w) => cnt(w) > 0);
      const perdeuIdentificador = outrasFiltradas.length < outras.length; // alguma palavra específica foi removida
      outras = outrasFiltradas;
      // Se o identificador específico foi removido (não existe no catálogo) e só restam âncoras
      // de espécie/granel, a busca ficou genérica demais — "renapro dog" → "dog" → todos os dogs.
      // Melhor retornar 0 e acionar handoff do que devolver produtos errados.
      if (perdeuIdentificador && !outras.length && ancoras.length) {
        achados = [];
      // Se só restaram genéricos sem âncoras, mesma lógica: não arrisca uma busca ampla.
      } else if (!ancoras.length && outras.length && outras.every((w) => GENERICOS.has(w))) {
        achados = [];
      } else {
        achados = (ancoras.length || outras.length) ? filtrarPor([...ancoras, ...outras]) : [];
      }
    }
    // 2) Ainda 0: dropa a 'outra' MENOS seletiva (casa com mais produtos), preservando a mais
    //    distintiva (a marca). Nunca dropa a última → não retorna resultado amplo/genérico.
    //    Ex.: "racao chanin" dropa "racao" e mantém "chanin".
    while (!achados.length && outras.length > 1) {
      outras.sort((a, b) => cnt(a) - cnt(b));
      outras.pop(); // remove a de MAIOR contagem (menos seletiva)
      achados = filtrarPor([...ancoras, ...outras]);
    }
  }

  if (ordenarPor === "preco") achados.sort((a, b) => precoNum(a.preco) - precoNum(b.preco)); // mais barato primeiro

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

// Confere se CÃO ou GATO foi citado em algum ponto do texto (mensagem atual + histórico
// recente) — palavra inteira, mesmo critério de SINONIMOS_EXATOS. Usado como rede de segurança
// determinística: nunca deixa a IA "assumir" a espécie por conta própria quando o cliente nunca
// disse (ela às vezes ignora a instrução do prompt de perguntar antes).
function mencionaEspecie(texto) {
  // Troca pontuação por espaço antes de testar borda de palavra — sem isso, "gato," (vírgula
  // colada, comum em texto digitado por cliente) não bateria com " gato " por causa da vírgula.
  const t = " " + norm(texto).replace(/[^\w\s]/g, " ") + " ";
  return [...ESPECIE_GATO, ...ESPECIE_CAO].some((s) => t.includes(" " + s + " "));
}

async function executarFuncao(nome, args, contactId, contexto) {
  if (nome === "consultar_taxa_entrega") {
    const endereco = (args && args.endereco) || "";
    if (endereco && contactId) clientes.salvar(contactId, { endereco }); // memoriza o endereço
    return await geo.consultarTaxaPorEndereco(endereco);
  }
  if (nome === "salvar_dados_cliente") {
    if (contactId) clientes.salvar(contactId, { nome: args && args.nome, endereco: args && args.endereco });
    return { ok: true };
  }
  if (nome === "salvar_pet") {
    if (contactId && args && args.nome) clientes.salvarPet(contactId, { nome: args.nome, raca: args.raca });
    return { ok: true };
  }
  if (nome === "buscar_produtos") {
    return buscarProdutos(args || {});
  }
  if (nome === "obter_info_granel") {
    // Rede de segurança mais básica: só existe "granel" pra RAÇÃO. Se a conversa nem menciona
    // ração/comida nem granel/quilo/fracionado, a IA se distraiu (ex.: "Simparic até 20kg" — aqui
    // "kg" é peso do PET pra dosagem do medicamento, não tamanho de saca) — é provavelmente um
    // produto com nome/marca específica (carrapaticida, vermífugo, cosmético...), que tem busca
    // própria. Checa ISSO primeiro (mais genérico) — só depois entra no detalhe saca vs. granel.
    if (!/\b(granel|fracionad|quilo|quilos|racao|racoes|alimento|comida)\b/i.test(norm(contexto || ""))) {
      return { ok: false, naoEhGranel: true, instrucao: "Essa pergunta não parece ser sobre ração a granel (não menciona ração/granel/quilo/fracionado). NÃO chame obter_info_granel. Se o cliente citou o nome de um produto/marca específico (ex.: 'Simparic', 'NexGard'), BUSQUE ESSE NOME DIRETAMENTE com buscar_produtos({texto:'<nome>'}) — não confunda peso do PET (dosagem) com tamanho de saca." };
    }
    // Tamanho de SACA de verdade (7, 10, 15, 20, 25kg... — os tamanhos comerciais fechados do
    // catálogo, nenhum abaixo de 7kg) — nunca granel, mesmo sem marca. Abaixo de 7kg (1-6kg) é
    // ambíguo: pode ser uma quantidade pedida a granel, então não força nada aqui (cai nas
    // regras normais/pergunta de espécie abaixo). A IA às vezes chama granel mesmo com um
    // tamanho de saca na mensagem, então essa rede de segurança não confia no palpite: barra a
    // função e manda buscar no catálogo por tamanho.
    const mKg = /\b(\d{1,3}(?:[.,]\d+)?)\s*(?:kg|kilos?|quilos?)\b/i.exec(contexto || "");
    if (mKg && parseFloat(mKg[1].replace(",", ".")) >= 7) {
      return { ok: false, ehSaca: true, instrucao: `O cliente mencionou um tamanho específico (${mKg[0]}) — isso é SACA (fechada), NUNCA granel. NÃO chame obter_info_granel. CHAME buscar_produtos com a espécie + esse tamanho no texto (ex.: 'gato ${mKg[0]}') para mostrar as opções de saca desse tamanho.` };
    }
    // Se o cliente nunca disse cão/gato em nenhum ponto da conversa, a espécie que a IA passou
    // é só um palpite — força a pergunta em vez de confiar nela (ver mencionaEspecie acima).
    if (!mencionaEspecie(contexto || "")) {
      return { ok: false, precisaPerguntarEspecie: true, instrucao: "O cliente NÃO disse em nenhum momento se é pra cão ou gato. NÃO informe preços nem chame obter_info_granel de novo agora — pergunte 'É para cão ou gato? 🐾' e espere a resposta." };
    }
    const especie = (args && args.especie) || "";
    const dados = config.get();
    // Busca em mensagensExtras E em faqRapido (o usuário pode cadastrar em qualquer um dos dois)
    const todas = [...(dados.mensagensExtras || []), ...(dados.faqRapido || []), ...(dados.servicos || [])];
    const ehGato = /^gat/i.test(especie);
    const temEspecie = (t) => ehGato
      ? (t.includes("gato") || t.includes("cat") || t.includes("felin"))
      : (t.includes("cao") || t.includes("caes") || t.includes("cach") || t.includes("dog") || t.includes("can"));
    // Busca: "granel" + espécie correta no título
    const found = todas.find((x) => { const t = norm(x.titulo); return t.includes("granel") && temEspecie(t); });
    if (found) return { titulo: found.titulo, resposta: found.resposta, ok: true };
    return { ok: false, naoEncontrado: true, erro: "Resposta rápida de granel não encontrada para essa espécie. Diga ao cliente: 'Deixa eu verificar as opções de granel pra você e já te passo! 🐾' — NÃO chame encaminhar_para_atendente." };
  }
  if (nome === "encaminhar_para_atendente") {
    return { ok: true, instrucao: "Escreva uma mensagem curta e simpática avisando o cliente que você já vai chamar um atendente humano para continuar o atendimento por aqui." };
  }
  return { erro: "funcao_desconhecida" };
}

// Monta a "system instruction" com o contexto do negócio. Reconstruída a cada
// chamada para refletir edições feitas no painel sem reiniciar o bot.
function montarContexto(cliente) {
  const dados = config.get();
  const n = dados.negocio;
  const g = (dados.entrega && dados.entrega.gratis) || {}; // regra de entrega grátis
  const cat = dados.catalogo || {}; // catálogo (grupos/subgrupos/especificações/produtos)
  const pets = (cliente && Array.isArray(cliente.pets) ? cliente.pets : [])
    .map((p) => p.nome + (p.raca ? " (" + p.raca + ")" : ""))
    .join(", ");
  const linhasCliente = cliente && (cliente.nome || cliente.endereco || pets)
    ? "DADOS DO CLIENTE (já conhecidos — NÃO pergunte de novo, use direto):"
        + (cliente.nome ? "\nNome: " + cliente.nome : "")
        + (cliente.endereco ? "\nEndereço: " + cliente.endereco : "")
        + (pets ? "\nPets: " + pets : "")
    : "DADOS DO CLIENTE: ainda não temos o nome/endereço/pet deste cliente.";

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
    "Use português brasileiro informal, com tom SIMPÁTICO e BRINCALHÃO (leve, descontraído) — mas com CUIDADO pra nunca insultar, forçar intimidade nem constranger o cliente. No máximo um emoji por mensagem.",
    "",
    "INFORMAÇÕES DO NEGÓCIO:",
    `Endereço: ${n.endereco}`,
    n.mapsLink ? `Link do Google Maps: ${n.mapsLink}` : "",
    `Telefone: ${n.telefone}`,
    `Horário: ${n.horarioSemana}; ${n.horarioSabado}; ${n.horarioDomingo}`,
    `Pagamento: ${n.pagamento}`,
    "- ENDEREÇO: sempre que informar o endereço da loja, INCLUA o link do Google Maps acima (o endereço sozinho pode levar o cliente ao lugar errado). Não use um estabelecimento vizinho como ponto de referência.",
    "",
    equipe.resumoParaIA()
      ? "NOSSA EQUIPE (reconheça quando o cliente perguntar por uma pessoa pelo nome ou por uma função, ex.: 'a Dra. Ana está?', 'tem veterinário?'):\n" + equipe.resumoParaIA()
        + "\nSe o colaborador existe, confirme que faz parte da equipe e, se o cliente quiser falar/agendar com ele, use encaminhar_para_atendente. Se a pessoa NÃO estiver na lista, diga gentilmente que não temos esse nome na equipe."
      : "",
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
    "- MEMÓRIA: nunca pergunte de novo algo que o cliente já disse na conversa ou que esteja em DADOS DO CLIENTE. Use o endereço/pet já informados diretamente.",
    "- PRIMEIRO CONTATO: NÃO comece com 'Olá/Oi/Seja bem-vindo' — a saudação já é enviada pelo sistema. Vá direto ao ponto. NÃO mande menu.",
    "- ENDEREÇO: quando o cliente informar um endereço, CHAME salvar_dados_cliente para guardar.",
    "- PET: quando o assunto for banho/tosa/consulta/vacina e não souber o pet, pergunte nome e raça e CHAME salvar_pet. Se o cliente citar um pet pelo nome, assuma que é o pet dele — nunca questione. Se já souber o pet, use o nome dele.",
    "- SERVIÇO PRESENCIAL EM ANDAMENTO (pet na loja): quando o cliente indicar que trouxe o pet ou perguntar sobre o status dele ('quando fica pronto?', 'posso buscar?', 'deixei o cachorro aí', 'tá pronto?', 'já terminou?'), você NÃO tem visibilidade real disso — NUNCA diga que está pronto nem que não está, nunca invente ou suponha o status. SEMPRE encaminhe para atendente sem confirmar nem negar.",
    "- Responda APENAS com base nas informações acima. Não invente preços, serviços ou taxas. Em caso clínico/emergência, oriente a ligar para o telefone da loja.",
    "- BANHO E TOSA: nunca diga que não precisa agendar (pode lotar, fecha às 17h). Pergunte se é só banho ou banho+tosa; se tosa, peça descrição. Só depois CHAME encaminhar_para_atendente — o atendente confirma vaga e horário. Capture nome/raça do pet antes (salvar_pet).",
    "- PREÇO DE BANHO/TOSA: informe conforme base de conhecimento; se depender de avaliação presencial, diga isso e não invente valor.",
    "- CONSULTAS/CONSULTÓRIO: se por ordem de chegada, não peça dia/horário. Informe valores conforme base de conhecimento; sem informação → atendente.",
    "- VACINAS: informe DIRETAMENTE os preços e tipos de vacinas disponíveis conforme a base de conhecimento — NÃO chame encaminhar_para_atendente só para informar preço. Só encaminhe se o cliente quiser AGENDAR/MARCAR a aplicação (aí o atendente confirma horário).",
    "- VACINAS — MARCAS: 'Vanguard' é o nome comercial da nossa V10. Se o cliente perguntar por uma marca de vacina que não está na base de conhecimento, NÃO diga que não temos — liste os tipos disponíveis e pergunte se um deles atende.",
    "- EXAMES: se o cliente perguntar VALOR de exames ou informações sobre exames, NÃO responda com preço — CHAME encaminhar_para_atendente.",
    "- DESCONTOS: siga a política de descontos da base de conhecimento; se pedirem desconto, responda com gentileza conforme essa política.",
    "- O QUE VENDEMOS — ANIMAIS: vendemos apenas calopsita, periquito australiano e hamster. NÃO vendemos cachorro, gato nem nenhum outro animal além desses três. Se perguntarem por outro animal, diga gentilmente que não trabalhamos com a venda dele. (Para preço/disponibilidade desses que vendemos, encaminhe para um atendente.)",
    "- O QUE VENDEMOS — PRODUTOS: vendemos artigos para animais aquáticos, répteis, roedores e aves (comida, comedouros, gaiolas, aquários, acessórios, etc.).",
    "- NÃO TRABALHAMOS COM: (1) Vermífugo/remédio para verme INJETÁVEL — não temos essa apresentação; temos apenas comprimido ou líquido (oral). (2) Anticoncepcional para animais — não trabalhamos com esse tipo de medicamento. Informe ao cliente com gentileza e, se quiser, sugira procurar um veterinário ou outra petshop especializada.",
    "- RECLAMAÇÃO / PROBLEMA COM SERVIÇO OU PRODUTO JÁ COMPRADO — PRIORIDADE MÁXIMA: se a mensagem indicar um problema com algo já adquirido ou serviço já prestado, NÃO busque produtos — CHAME encaminhar_para_atendente com motivo 'Reclamação do cliente.' IMEDIATAMENTE. Exemplos que SEMPRE são reclamação: 'não foi devolvido', 'não devolveram', 'ficou aí', 'ficou lá', 'deixou aí', 'esqueceu', 'esqueceram', 'perderam meu item', 'cadê', 'sumiu', 'veio errado', 'veio quebrado', 'não funcionou', 'não foi feito', 'cobrou errado', 'quero reclamar', 'pode verificar', 'faltou', 'não voltou', 'não entregou'. ATENÇÃO: mesmo que a mensagem mencione um produto (ex.: 'a escova ficou aí', 'o shampoo veio errado'), NÃO chame buscar_produtos — é reclamação, não pedido. Esta regra tem prioridade ABSOLUTA sobre a REGRA GERAL de nome/marca.",
    "- Quando precisar de um atendente humano (exames com guia, fechar valor de pacote de cliente frequente, venda de aves/animais, reclamações, ou algo fora do seu conhecimento), CHAME a função encaminhar_para_atendente e avise o cliente que vai chamar alguém. Não invente que já resolveu.",
    "- MENSAGEM FORA DE CONTEXTO / DÚVIDA GERAL: se a mensagem não for sobre produtos, serviços, preços, entregas, banho/tosa ou outra dúvida do pet shop — por exemplo mensagens pessoais, perguntas sobre adoção de animais, fotos de terceiros, perguntas sobre funcionários específicos pelo nome ou conteúdo sem relação com a loja — NÃO tente responder nem chame buscar_produtos. CHAME encaminhar_para_atendente com motivo 'Mensagem fora do escopo do bot.'.",
    "- REFERÊNCIA VISUAL SEM NOME ('tem esse produto?', 'vocês têm isso?', 'tem esse aí?', 'esse aqui', 'tem esse item?'): quando o cliente perguntar por 'esse/isso/aquele produto' SEM citar nome, marca ou tipo do produto — a mensagem veio provavelmente junto de uma imagem que o bot não consegue ver. NÃO tente adivinhar o produto. CHAME encaminhar_para_atendente com motivo 'Cliente perguntou sobre produto sem identificar o nome.'.",
    "- MENSAGEM DE ESPERA / CONFIRMAÇÃO PENDENTE: quando o cliente indicar que vai confirmar em breve, vai mandar a lista, vai verificar ou está aguardando — ex.: 'já vou confirmar', 'vou te mandar', 'deixa eu ver', 'espera um pouco', 'vou pegar a informação', 'já já confirmo', 'vou checar' — NÃO busque produtos. Responda apenas com mensagem curta de espera ('Claro, pode chamar quando quiser! 🐾' ou similar), sem chamar nenhuma função.",
    "- RECEITA / MEDICAMENTOS: quando o cliente mandar uma receita (lista de medicamentos), BUSQUE cada item no catálogo com buscar_produtos e informe os que TEMOS com o VALOR. Se tivermos PELO MENOS UM, NÃO encaminhe — passe os valores dos que temos e, para os que faltarem, diga que confirma com um atendente. Só encaminhe para o atendente se NENHUM dos medicamentos da receita estiver no catálogo, OU quando o cliente pedir a ENTREGA do medicamento (aí o atendente finaliza).",
    "",
    "PRODUTOS / CATÁLOGO (vale para QUALQUER produto: ração, petisco, brinquedo, acessório, areia, cosmético...):",
    "- PEDIDO (LISTA DE ITENS): se o cliente JÁ manda uma LISTA de itens com quantidades (um pedido para fechar — ex.: '1kg de X, 2kg de Y, 1 fardo de areia'), NÃO fique buscando item por item. Diga que vai te encaminhar para um atendente FINALIZAR o pedido e CHAME encaminhar_para_atendente.",
    "- IMPORTANTE: pergunta sobre UM produto NUNCA é respondida com o menu de saudação nem pedindo para o cliente escolher 1/2/3. SEMPRE use a função buscar_produtos.",
    "- RESPOSTA A CARD/MENSAGEM ANTERIOR: quando o cliente responder/citar uma mensagem do bot pedindo uma variação ('tem essa filhote?', 'e em 15kg?', 'tem pra gato?'), use o HISTÓRICO para identificar o produto referenciado e chame buscar_produtos com o nome + variação. Se buscar_produtos retornar 0 resultados, CHAME encaminhar_para_atendente.",
    "- REGRA GERAL — NOME/MARCA CITADO (máxima prioridade): se o cliente mencionar QUALQUER nome de produto, marca ou item específico (ex.: 'pipicat', 'chanin', 'amoxicilina', 'bolsa de transporte', 'hepvet'), BUSQUE ESSE NOME DIRETAMENTE com buscar_produtos({ texto: '<nome>' }) usando poucas palavras. Se retornar 0 com o nome + tamanho, tente uma segunda busca só com o nome da marca (sem o tamanho) para ver se existe em outro tamanho. Só chame encaminhar_para_atendente se ambas as buscas retornarem 0. Exemplos: 'tem pipicat?' → texto 'pipicat'; 'tem amoxicilina?' → texto 'amoxicilina'; 'tem bolsa de transporte?' → texto 'bolsa transporte'. Esta regra prevalece sobre TODAS as regras de categoria abaixo — EXCETO a regra 'RAÇÃO COM MARCA — ESPÉCIE' logo adiante: se a marca de RAÇÃO citada não for exclusiva de uma espécie e o cliente não disse cão/gato (ex.: 'ração Fargo Premium', só isso), a pergunta 'É pra cão ou gato?' vem ANTES de buscar, mesmo perguntando só o preço — nunca assuma a espécie pra não trazer opção da espécie errada.",
    "- RECEITA / LISTA DE REMÉDIOS: quando chegar uma receita com vários itens, CHAME buscar_produtos para CADA item (pelo nome/princípio ativo) antes de dizer se tem ou não.",
    "- MARCAS SÓ DE GATO: CHANIN, KATBOM, FRISKIES, MATISSE são marcas EXCLUSIVAMENTE de ração para GATO. Se o cliente pedir por uma dessas marcas: (1) NÃO pergunte 'cão ou gato' — já sabe que é gato. (2) Na busca, use APENAS marca + variante + tamanho no parâmetro texto — NUNCA inclua a palavra 'gato' no texto da busca, pois ela pode excluir produtos cadastrados sem essa palavra no nome. Exemplos CERTOS: buscar_produtos({texto:'chanin castrado 25kg'}), buscar_produtos({texto:'chanin filhote'}). Exemplos ERRADOS: buscar_produtos({texto:'chanin gato castrado 25kg'}). (3) Pergunte apenas saca ou granel se ainda não souber.",
    "- RAÇÃO COM MARCA — ESPÉCIE: para marcas NÃO exclusivas de gato (ex.: FARGO, GOLDEN, PREMIER, GUABI e qualquer outra não listada acima), se o cliente NÃO informar a espécie (cão ou gato) — MESMO que a pergunta seja só sobre preço/valor (ex.: 'qual o preço da ração Fargo Premium?') — PERGUNTE PRIMEIRO 'É pra *cão* ou *gato*? 🐾' e aguarde a resposta antes de chamar buscar_produtos. NUNCA assuma cão por padrão. Só depois de saber a espécie pergunte saca/granel (se necessário) e busque.",
    "- RAÇÃO COM MARCA — SACA OU GRANEL: após saber a espécie (ou se a marca for exclusiva de gato), se o cliente ainda não informou saca/granel, pergunte 'Você quer em *saca* (fechada) ou a *granel* (por quilo)? 🐾'. Se SACA → buscar_produtos com texto '<marca> <espécie> [tamanho]'. Se GRANEL → buscar_produtos com texto 'granel <marca> <espécie>'. Se o cliente já informou tamanho em kg → é saca, busque direto.",
    "- RAÇÃO GENÉRICA (sem marca): quando o cliente pedir ração sem citar marca (ex.: 'tem ração pra gato?'), pergunte UMA coisa por vez: (1) cão ou gato, (2) adulto ou filhote, (3) necessidade especial. Com essas infos, CHAME buscar_produtos com o texto montado (ex.: 'racao gato castrado'). EXCEÇÃO: se o cliente já disse um tamanho em kg (ex.: 'ração pra gato de 10kg'), é SACA — vá direto pra regra 'TAMANHO EM KG = SACA' abaixo (buscar_produtos com espécie + tamanho), SEM perguntar adulto/filhote e SEM usar obter_info_granel.",
    "- RAÇÃO A GRANEL (sem marca específica): se o cliente pedir 'no quilo', 'granel', 'fracionado' para ração de cão ou gato — SEM mencionar um tamanho de saca em kg — NÃO chame buscar_produtos — SEMPRE use obter_info_granel. Pergunte a espécie se não souber. Se o cliente MENCIONOU um tamanho (ex.: '10kg', '15kg'), NÃO é granel — é saca, use buscar_produtos (regra 'TAMANHO EM KG = SACA' abaixo).",
    "- GRANULADO (areia/substrato): 'granulado de madeira', 'granulado vegetal', 'granulado de papel' são AREIA ou SUBSTRATO — produto do catálogo, NÃO ração a granel. Use buscar_produtos({ texto: 'granulado madeira' }) ou similar. NUNCA use obter_info_granel para granulado de madeira/vegetal.",
    "- RAÇÃO PARA AVES (calopsita, periquito, papagaio, canário, etc.): NUNCA use obter_info_granel para aves. Busque SEMPRE com buscar_produtos({ texto: 'granel <espécie>' }) — ex.: 'granel calopsita', 'granel papagaio'. Não pergunte cão ou gato.",
    "- ESPÉCIE (NUNCA MISTURE): se o cliente pediu para GATO, só ofereça produtos de GATO; se pediu para CÃO, só de CÃO.",
    "- RAÇÃO — SACA OU GRANEL: NUNCA pergunte saca/granel para areia, petisco, medicamento ou acessório — só para RAÇÃO.",
    "- TAMANHO EM KG = SACA (a partir de 7kg): se o cliente pedir um tamanho de saca comercial (7, 10, 15, 20, 25kg ou similar — sempre ≥7kg), é saca — NUNCA use obter_info_granel nesse caso, mesmo sem marca. Com marca: busque '<marca> <tamanho>' (ex.: buscar_produtos({texto: 'chanin 25kg'})). Sem marca: busque '<espécie> <tamanho>' (ex.: buscar_produtos({texto: 'gato 10kg'})). NUNCA acrescente filhote/adulto/castrado/mix se o cliente não especificou — a busca retorna todas as variantes disponíveis nesse tamanho para o cliente escolher. Se retornar 0, busque só com a marca (ou só a espécie, sem marca) para ver tamanhos disponíveis e informe. Tamanhos MENORES que 7kg (1kg, 2kg, 3kg...) são ambíguos — podem ser uma quantidade pedida a granel; siga as regras de granel/saca normalmente pra esses casos.",
    "- MARCA PEDIDA — NUNCA SUBSTITUA: mostre SOMENTE produtos da marca pedida. Se buscar_produtos não retornar a marca específica (0 resultados), CHAME encaminhar_para_atendente com motivo 'Cliente quer [marca+tamanho] — verificar disponibilidade.' NÃO diga 'não temos' e NÃO ofereça substitutos por conta própria — o atendente confirma se o produto existe no estoque real.",
    "- MAIS BARATO / MAIS EM CONTA: CHAME buscar_produtos com ordenarPor='preco' e indique o de menor preço.",
    "- ROUPA CIRÚRGICA: pergunte o PESO do pet e busque 'roupa cirurgica' + peso. NÃO confunda com bolsa/caixa de transporte.",
    "- VERMÍFUGO / ANTIPULGAS / ANTIPARASITÁRIO: são PRODUTOS do catálogo — NUNCA encaminhe para atendente só porque o cliente quer vermifugar ou tratar pulgas/carrapatos. Se já souber a espécie pelo contexto, BUSQUE IMEDIATAMENTE usando texto com espécie + produto: buscar_produtos({texto: 'verme gato'}) para gato ou buscar_produtos({texto: 'verme cao'}) para cão/cachorro. NUNCA use o parâmetro subgrupo para espécie — use sempre no texto. Só pergunte a espécie se ela realmente não estiver na conversa.",
    "- Quando buscar_produtos retornar produtos, dê UMA ÚNICA frase de introdução curta (ex.: 'Achei essas opções pra você 🐾' ou 'Não temos X, mas tenho essas opções com Y 🐾'). NUNCA liste nomes, preços ou detalhes dos produtos no texto — os cards com foto e preço são enviados automaticamente pelo sistema. Qualquer lista de produtos no texto será ignorada.",
    "- Se buscar_produtos retornar 0 resultados: NUNCA escreva 'Achei', 'encontrei', 'aqui estão as opções' ou qualquer frase que sugira que produtos foram encontrados — seria uma mentira que confunde o cliente. SEMPRE CHAME encaminhar_para_atendente — o atendente confirma se o produto existe de verdade no estoque.",
    "- CONFIRMAÇÃO DE COMPRA: quando o cliente responder 'quero', 'esse', 'esse mesmo', 'esse aí', 'sim', 'pode ser', 'vou levar', 'fechado', 'pode mandar', 'tá bom', 'ok', 'quero esse', 'quero comprar', 'manda' — ou qualquer variação de confirmação — LOGO APÓS o bot ter apresentado produtos (verifique o histórico): NÃO busque produtos novamente. CHAME IMEDIATAMENTE encaminhar_para_atendente com motivo 'Cliente confirmou interesse no produto — finalizar venda.'",
    "- OBRIGATÓRIO ao ENVIAR: quando disser que está mostrando produtos, TEM que ter chamado buscar_produtos na MESMA resposta e a função TEM que ter retornado produtos (total > 0). Quando PERGUNTAR 'posso te mandar opções?', NÃO chame buscar_produtos — espere o cliente responder.",
    "- Nunca invente produtos, marcas ou preços — use exclusivamente o que a função retornar.",
    "",
    "TAXA DE ENTREGA / TÁXI DOG:",
    "- ENDEREÇO INFORMADO PELO CLIENTE: quando o cliente informar uma rua, avenida, número, bairro ou endereço completo — chame SEMPRE consultar_taxa_entrega. Nunca interprete o endereço como produto ou busque no catálogo. Endereço nunca é uma marca de ração.",
    "- Se já tiver o endereço do cliente, confirme antes de calcular ('A entrega seria pra esse endereço: <endereço>? 🛵'). Só chame consultar_taxa_entrega após confirmação. Nunca calcule distância manualmente. Se não souber o endereço, peça rua, número e bairro ('Qual o endereço de entrega? Preciso da rua, número e bairro 🛵').",
    `- ENTREGA GRÁTIS (só Entrega moto): até ${g.km || 2} km com pedido acima de R$ ${g.valor || 50} → grátis. Táxi dog sempre cobra. Pode haver pedido mínimo conforme base de conhecimento.`,
    "- Apresente a cotação EXATAMENTE neste formato:\nSegue a cotação da sua taxa:\n\n📍 *Endereço:* <endereço>\n📏 *Distância aproximada:* <km> km\n🚚 *Serviço:* <serviço>\n\n💰 *Valor da taxa:* *R$ <valor>*",
    "- Táxi Dog é ida e volta. Se o serviço já foi escolhido, não pergunte de novo. Se a função não cobrir a área, diga que um atendente confirma.",
    "- CONFIRMAÇÃO DO PEDIDO: se o cliente concordar com a taxa ('ok', 'pode mandar', 'fechado'), CHAME encaminhar_para_atendente para finalizar — não mude de assunto nem busque produtos.",
    "",
    // Dados do cliente ficam por ÚLTIMO (de propósito): assim todo o resto do prompt é IGUAL
    // para qualquer cliente e o Gemini reaproveita esse "prefixo" (cache de contexto = mais barato).
    linhasCliente,
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
  // Texto puro de toda a conversa recente + mensagem atual, usado pelas redes de segurança
  // determinísticas (ex.: mencionaEspecie em obter_info_granel).
  const contexto = historico.map((h) => (h.parts || []).map((p) => p.text || "").join(" ")).join(" ") + " " + mensagem;

  const cfg = {
    systemInstruction: montarContexto(clientes.get(contactId)),
    maxOutputTokens: 350,
    temperature: 0.3,
    tools: TOOLS,
  };
  if (MODELO.includes("2.5")) cfg.thinkingConfig = { thinkingBudget: 0 };

  let encaminhar = false;
  let motivo = "";
  let produtos = []; // produtos achados na última busca (pra enviar com foto)
  let respostaGranel = ""; // conteúdo da resposta rápida de granel (enviado verbatim após o texto da IA)
  let resp;
  try {
    resp = await ai.models.generateContent({ model: MODELO, contents: working, config: cfg });

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
        const resultado = await executarFuncao(chamada.name, chamada.args, contactId, contexto);
        // Acumula (sem duplicar) os produtos de TODAS as buscas da rodada — ex.: vários itens
        // de uma receita, ou busca específica + ampla. Antes sobrescrevia e só sobrava a última.
        if (chamada.name === "buscar_produtos" && resultado && Array.isArray(resultado.produtos)) {
          for (const p of resultado.produtos) if (!produtos.some((x) => x.nome === p.nome)) produtos.push(p);
        }
        let resultadoParaIA = resultado;
        // Quando buscar_produtos retorna 0 itens, reforça a instrução para o modelo não alucinar
        // "Achei opções" nem dizer "não temos" — o atendente confirma a disponibilidade real.
        if (chamada.name === "buscar_produtos" && resultado && resultado.total === 0) {
          resultadoParaIA = {
            total: 0,
            produtos: [],
            instrucao: "RESULTADO: ZERO produtos encontrados. PROIBIDO dizer 'Achei', 'encontrei', 'aqui estão as opções' ou qualquer frase que indique que produtos foram encontrados — seria mentira. OBRIGATÓRIO: CHAME encaminhar_para_atendente com motivo descrevendo o produto que o cliente buscou. O atendente humano vai confirmar se o item existe no estoque.",
          };
        }
        if (chamada.name === "obter_info_granel" && resultado && resultado.ok && resultado.resposta) {
          respostaGranel = resultado.resposta;
          // Não envia o conteúdo à IA para ela não duplicar na resposta de texto.
          resultadoParaIA = { titulo: resultado.titulo, ok: true, instrucao: "Conteúdo de granel encontrado e será enviado automaticamente após sua mensagem. Escreva APENAS uma frase curta de confirmação, como 'Aqui estão as opções de granel pra [cão/gato]! 🐾' — NÃO copie nem liste os itens." };
        }
        partesResposta.push({ functionResponse: { name: chamada.name, response: resultadoParaIA } });
      }
      working.push({ role: "user", parts: partesResposta });

      resp = await ai.models.generateContent({ model: MODELO, contents: working, config: cfg });
    }
  } catch (e) {
    // Instabilidade do Gemini (timeout/cota/erro) → NÃO deixa o cliente sem resposta e NÃO
    // grava histórico quebrado (a próxima mensagem tenta de novo, limpa).
    console.error("Falha na IA (responder):", e.message);
    return {
      texto: "Ops, tive uma instabilidade aqui 🙈 Pode repetir, por favor? Se preferir, digite *atendente* para falar com uma pessoa.",
      encaminhar: false, motivo: "", produtos: [],
    };
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

  return { texto, encaminhar, motivo, produtos, respostaGranel };
}

function limparHistorico(contactId) {
  historicos.delete(contactId);
}

// Resumo curto da conversa pro atendente assumir rápido (usado no handoff).
async function resumirConversa(mensagens, motivo) {
  const linhas = (mensagens || []).filter(Boolean).map((m) => `- ${m}`).join("\n");
  if (!linhas) return motivo || "Cliente pediu atendimento humano.";
  const prompt =
    "Você ajuda um atendente de pet shop a assumir uma conversa do WhatsApp. " +
    "Resuma em no máximo 2 frases curtas e diretas (em português, sem saudação) o que o cliente quer e em que ponto está.\n\n" +
    "Mensagens do cliente:\n" + linhas + (motivo ? "\n\nMotivo do encaminhamento: " + motivo : "");
  try {
    const cfg = { maxOutputTokens: 200, temperature: 0.2 };
    if (MODELO.includes("2.5")) cfg.thinkingConfig = { thinkingBudget: 0 };
    const resp = await ai.models.generateContent({ model: MODELO, contents: [{ role: "user", parts: [{ text: prompt }] }], config: cfg });
    return (resp.text || "").trim() || (motivo || "Cliente pediu atendimento humano.");
  } catch (e) {
    console.error("Falha ao resumir conversa:", e.message);
    return motivo || "Cliente pediu atendimento humano.";
  }
}

// Transcreve um áudio (base64) em texto, usando o Gemini (multimodal).
async function transcreverAudio(base64, mimeType) {
  try {
    const cfg = { maxOutputTokens: 600, temperature: 0 };
    if (MODELO.includes("2.5")) cfg.thinkingConfig = { thinkingBudget: 0 };
    const resp = await ai.models.generateContent({
      model: MODELO,
      contents: [{ role: "user", parts: [
        { text: "Transcreva este áudio em português, exatamente o que a pessoa falou. Responda apenas com a transcrição, sem comentários nem aspas." },
        { inlineData: { mimeType: String(mimeType || "audio/ogg").split(";")[0].trim(), data: base64 } },
      ] }],
      config: cfg,
    });
    return (resp.text || "").trim();
  } catch (e) {
    console.error("Falha ao transcrever áudio:", e.message);
    return "";
  }
}

// Lê um documento (ex.: PDF de receita) e extrai os nomes dos medicamentos/produtos.
async function lerDocumento(base64, mimeType) {
  try {
    const cfg = { maxOutputTokens: 500, temperature: 0 };
    if (MODELO.includes("2.5")) cfg.thinkingConfig = { thinkingBudget: 0 };
    const resp = await ai.models.generateContent({
      model: MODELO,
      contents: [{ role: "user", parts: [
        { text: "Este documento é provavelmente uma receita veterinária. Liste APENAS os nomes dos medicamentos/produtos que aparecem nele, separados por vírgula, sem dosagem nem instruções de uso. Se não houver nenhum, responda exatamente 'NENHUM'." },
        { inlineData: { mimeType: String(mimeType || "application/pdf").split(";")[0].trim(), data: base64 } },
      ] }],
      config: cfg,
    });
    return (resp.text || "").trim();
  } catch (e) {
    console.error("Falha ao ler documento:", e.message);
    return "";
  }
}

// Identifica o produto/marca numa foto que o cliente enviou (ex.: print de anúncio do Instagram).
async function identificarProdutoImagem(base64, mimeType, legenda) {
  try {
    const cfg = { maxOutputTokens: 200, temperature: 0 };
    if (MODELO.includes("2.5")) cfg.thinkingConfig = { thinkingBudget: 0 };
    const partes = [
      { text: "Esta é uma foto enviada por um cliente de pet shop (provavelmente de um produto que ele viu num anúncio/publicação). Diga em poucas palavras QUAL produto e marca aparecem na imagem (ex.: 'Antipulgas NexGard', 'Ração Golden cães adultos', 'Areia Pipicat'). Responda só o nome do produto. Se não der pra identificar um produto, responda exatamente 'NENHUM'." },
      { inlineData: { mimeType: String(mimeType || "image/jpeg").split(";")[0].trim(), data: base64 } },
    ];
    if (legenda) partes.push({ text: "Legenda escrita pelo cliente: " + legenda });
    const resp = await ai.models.generateContent({ model: MODELO, contents: [{ role: "user", parts: partes }], config: cfg });
    return (resp.text || "").trim();
  } catch (e) {
    console.error("Falha ao identificar imagem:", e.message);
    return "";
  }
}

module.exports = { responder, limparHistorico, registrarTurno, buscarProdutos, resumirConversa, transcreverAudio, lerDocumento, identificarProdutoImagem };
