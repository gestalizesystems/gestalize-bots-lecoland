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
// Timeout em TODA chamada à API do Gemini — sem isso, uma conexão que trava sem responder
// (sem erro, sem timeout) nunca libera a vaga no pool de conexões do Node pro mesmo host,
// prendendo CADA chamada seguinte atrás da travada pra sempre (processo fica "vivo" mas para
// de responder qualquer cliente, sem nenhum erro no log — foi causa raiz de uma indisponibilidade real).
const GEMINI_TIMEOUT_MS = 20000;

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
  // Porte (tamanho da raça) — nomes de produto costumam abreviar ("RACAS PEQ", "GDE", "MED").
  // Sem isso, "premier adulto pequeno" não achava "GRANEL PREMIER AD RACAS PEQ" (só existe a
  // abreviação no nome), caindo pro relaxamento e trazendo variantes de porte erradas.
  pequeno: ["pequeno", "pequena", "pequenos", "pequenas", "peq", "mini", "toy"],
  pequena: ["pequeno", "pequena", "pequenos", "pequenas", "peq", "mini", "toy"],
  mini: ["pequeno", "pequena", "peq", "mini", "toy"],
  grande: ["grande", "grandes", "gde", "grd", "giant", "gigante"],
  gigante: ["grande", "grandes", "gde", "grd", "giant", "gigante"],
  medio: ["medio", "media", "medios", "medias", "med", "medium"],
  media: ["medio", "media", "medios", "medias", "med", "medium"],
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
  // Textura de areia — gênero/plural variam entre o que o cliente digita e o nome cadastrado
  // (ex.: cliente pede "fargo FINA", produto cadastrado é "FARGO GRAOS FINOS"). Sem isso, "fina"
  // não batia em "finos" por serem palavras diferentes (match de palavra inteira, não substring)
  // — a busca perdia o produto certo e caía no relaxamento, que podia até dropar a MARCA (por
  // aparecer em muitos produtos) e sobrar só "fina", batendo em areia de outra marca qualquer.
  fino: ["fino", "fina", "finos", "finas"],
  fina: ["fino", "fina", "finos", "finas"],
  grosso: ["grosso", "grossa", "grossos", "grossas"],
  grossa: ["grosso", "grossa", "grossos", "grossas"],
  grao: ["grao", "graos"],
  graos: ["grao", "graos"],
};

// Palavras GENÉRICAS de categoria (não identificam a marca/item) — dropadas PRIMEIRO no relaxamento,
// pra não sequestrar a busca (ex.: "ração chanin" nunca deve virar "ração" e trazer outra marca).
// Embalagem (sachê/lata/pote/...) também é genérica: descreve o FORMATO, não a necessidade/
// sabor/linha do produto. Sem isso, "sachê gástrico" (linha terapêutica) perdia "gastrico" (não
// existe no catálogo com esse nome exato) e caía de volta em "sachê" sozinho — que bate em
// QUALQUER sachê do catálogo, devolvendo uma lista aleatória sem nenhuma relação com o pedido.
const GENERICOS = new Set(["racao", "racoes", "comida", "alimento", "produto", "item", "sabor", "racaozinha", "remedio", "remedios", "medicamento", "medicamentos", "suplemento", "vitamina", "vitaminas", "mineral", "minerais", "nutricional", "nutritivo", "nutritiva", "sache", "saches", "lata", "latas", "pote", "potes", "frasco", "frascos", "bisnaga", "bisnagas", "caixa", "caixas"]);
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
  const casa = (valor, alvo) => valor && (norm(valor).includes(alvo) || alvo.includes(norm(valor)));
  const casaLista = (lista, alvo) => Array.isArray(lista) && lista.some((x) => casa(x, alvo));
  // Nem todo produto do catálogo tem grupo/subgrupo/especificação tagueados (cadastro
  // manual item a item, então alguns ficam pra trás). Filtrar de forma rígida puniria
  // exatamente esses produtos sem tag com um falso "não temos" (ex.: "golden gato castrado"
  // com subgrupo="Gato" zeraria se aquele item específico não tiver subgrupo marcado, mesmo
  // existindo e batendo perfeitamente pelo nome). Por isso o filtro abaixo (em filtrarPor) só
  // é aplicado produto a produto, exigindo a tag SÓ de quem a tem preenchida — quem não tem
  // simplesmente não é descartado por isso, e continua valendo pela busca por texto/nome.
  // IMPORTANTE: "em uso" aqui exige que o VALOR PEDIDO bata em pelo menos um produto tagueado
  // — não basta o catálogo usar a tag em OUTRA categoria (ex.: ração tagueada não pode liberar
  // um grupo="Areia" vazio como se fosse critério real, senão a busca sem texto vira
  // vacuosamente verdadeira e devolve o catálogo inteiro, sem relação com o que foi pedido).
  const grupoEmUso = !!g && produtos.some((p) => p.grupo && casa(p.grupo, g));
  const subgruposEmUso = !!sg && produtos.some((p) => casaLista(p.subgrupos, sg));
  const especEmUso = !!esp && produtos.some((p) => casaLista(p.especificacoes, esp));
  let palavrasTx = tx.split(/\s+/).filter((w) => w && w.length >= 3 && !STOPWORDS.has(w)); // ≥3 chars evita "vi"/"pé" casarem por substring
  // "saca / saco / fechada / pacote" = ração ensacada → exclui granel. É modificador, sai da busca por texto.
  const querSaca = palavrasTx.some((w) => SACA.has(w));
  palavrasTx = palavrasTx.filter((w) => !SACA.has(w));
  // Sem nenhum critério que o catálogo de fato usa → não retorna tudo (filtrarPor([]) é
  // vacuosamente verdadeiro). Um filtro que NENHUM produto do catálogo usa não conta como
  // critério (senão zeraria a busca sozinho, sem chance de cair no fallback por texto).
  if (!grupoEmUso && !subgruposEmUso && !especEmUso && !palavrasTx.length) return { total: 0, produtos: [] };
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
  // Estágio de vida (adulto × filhote) — mesma lógica de "nunca mistura" da espécie: se o
  // cliente pediu explicitamente "adulto", produto de FILHOTE nunca pode aparecer (e vice-versa),
  // mesmo que o relaxamento abaixo precise afrouxar outras palavras pra achar alguma coisa. Sem
  // essa trava, "premier adulto pequeno" caía de volta em "premier filhote pequeno" só porque não
  // existe adulto exatamente daquele porte — e a IA oferecia a idade errada como se fosse igual.
  const FILHOTE_TERMOS = ["filhote", "filhotes", "filhotinho", "puppy", "kitten", "junior"];
  const ADULTO_TERMOS = ["adulto", "adultos", "adult", "ad"];
  const temTermoPalavra = (alvo, termos) => termos.some((t) => (" " + alvo + " ").includes(" " + t + " "));
  const pedeAdulto = palavrasTx.some((w) => w === "adulto" || w === "adultos");
  const pedeFilhote = palavrasTx.some((w) => w === "filhote" || w === "filhotes");
  // Uma palavra casa se QUALQUER um dos seus sinônimos aparecer (ex.: "gato" casa "cat"; "quilo" casa "granel").
  const casaPalavra = (alvo, w) => {
    if (SINONIMOS_EXATOS[w]) return SINONIMOS_EXATOS[w].some((s) => (" " + alvo + " ").includes(" " + s + " "));
    if (SINONIMOS[w]) return SINONIMOS[w].some((s) => alvo.includes(s));
    // Só entra na lógica de tamanho em KG quando a palavra realmente é isso (ou um número puro,
    // sem unidade) — outra unidade explícita (mg, ml, g, cm de dosagem/medida de remédio) NÃO é
    // "kg" disfarçado. Sem essa checagem, "50mg" (dosagem) batia em "50KG" (faixa de peso de
    // antiparasitário) por engano — ex.: "agemoxi 50mg" devolvia NEXGARD.
    if (/^\d/.test(w) && !/^\d+([.,]\d+)?\s*(mg|ml|cm|mm|g)\b/i.test(w)) {
      // Quantidade (ex.: "7kg", "10kg"): casa o tamanho ESCRITO no nome, com decimal OPCIONAL e
      // como token inteiro. Ex.: "7kg" casa "7,5KG"; "10kg" casa "10KG" e "10.1KG"; e nunca pega
      // "1kg" dentro de "10.1kg". Além disso, "1kg/1quilo" também significa ração a GRANEL.
      // "g" é opcional (kg?) para casas com produtos cadastrados como "25K" em vez de "25KG".
      const num = (w.match(/^\d+/) || [""])[0]; // parte inteira do tamanho
      if (num && new RegExp("(?<![\\d.,])" + num + "([.,]\\d+)?\\s*kg?(?![a-z0-9])").test(alvo)) return true;
      if (num === "1" && /^1\s*(k|kg|kilo|quilo)?$/.test(w)) return alvo.includes("granel") || alvo.includes("fracionad");
      return false;
    }
    // Palavra INTEIRA, não substring solta — "dor" não pode casar "adestrador"/"condicionador",
    // "blu" não pode casar "blusa", "american" não pode casar "americano" (peitoral). Isso já
    // causou produto aleatório sendo oferecido de verdade pro cliente mais de uma vez.
    if ((" " + alvo + " ").includes(" " + w + " ")) return true;
    // Fallback: resolve "pipicat" (cliente digitou junto) vs "PIPI CAT"/"PIPI-CAT" (produto
    // cadastrado com espaço/hífen no meio). Junta só PARES DE PALAVRAS ADJACENTES do produto —
    // nunca a string toda (isso reabriria o mesmo problema de casar pedaço de palavra à toa,
    // ex.: "american" "vazando" pra dentro de "peitoral americano" por causa da concatenação).
    if (!w.includes(" ")) {
      const tokens = alvo.split(" ").filter(Boolean);
      for (let i = 0; i < tokens.length - 1; i++) {
        if (tokens[i] + tokens[i + 1] === w) return true;
      }
    }
    return false;
  };

  // RAÇÃO é o grupo com cadastro de subgrupo/especificação mais confiável no catálogo — ali
  // vale a regra estrita: só entra quem TEM a tag pedida (senão cai no handoff, nunca mistura
  // espécie nem "adivinha" por nome). Nas demais categorias (medicamento, acessório etc.), o
  // cadastro de tags é mais incompleto — mantém o comportamento tolerante (produto sem tag não
  // é descartado por isso, só protegido contra espécie oposta quando o subgrupo pedido é cão/gato).
  const ehRacao = (p) => /^rac/.test(norm(p.grupo)); // "ração"→"racao" / "rações"→"racoes": só o prefixo é comum
  // A tolerância "produto sem tag não é descartado" só é segura quando existe TEXTO livre
  // fazendo o trabalho de casar o produto certo — sem texto, ela vira uma porta aberta: filtro
  // de categoria/espécie "pedido de graça" para TODO produto sem tag do catálogo inteiro
  // (medicamento, ave à venda, hamster...), devolvendo lixo tipo "ALERGOVET"/"ANIMAL SIRIO" pra
  // uma busca de ração pra pet idoso. Sem texto, produto sem tag é EXCLUÍDO, não liberado.
  const temTexto = palavrasTx.length > 0;
  const filtrarPor = (palavras) => produtos.filter((p) => {
    const alvo = alvoDe(p);
    const racao = ehRacao(p);
    // Ração "GRANEL ..." é item de outro fluxo (obter_info_granel, que já funciona e cobre
    // preço/disponibilidade a granel) — nunca deve aparecer misturado numa busca normal de saca.
    if (racao && /^granel\b/.test(norm(p.nome))) return false;
    if (g) {
      if (p.grupo) { if (!casa(p.grupo, g)) return false; }
      else if (!temTexto) return false;
    }
    if (sg) {
      if (racao || (Array.isArray(p.subgrupos) && p.subgrupos.length)) {
        if (!casaLista(p.subgrupos, sg)) return false;
      } else if (!temTexto || especieOposta(alvo, sg)) return false;
    }
    if (esp) {
      if (racao || (Array.isArray(p.especificacoes) && p.especificacoes.length)) {
        if (!casaLista(p.especificacoes, esp)) return false;
      } else if (!temTexto) return false;
    }
    if (querSaca && (alvo.includes("granel") || alvo.includes("fracionad"))) return false; // "saca" exclui granel
    // Estágio de vida oposto ao pedido nunca passa — nem por relaxamento (ver comentário acima
    // de pedeAdulto/pedeFilhote). Checado aqui, fora do array `palavras`, porque o relaxamento
    // pode remover "adulto"/"filhote" da lista ativa tentando achar QUALQUER match — isso não
    // pode reabrir a porta pro estágio errado.
    if (pedeAdulto && temTermoPalavra(alvo, FILHOTE_TERMOS) && !temTermoPalavra(alvo, ADULTO_TERMOS)) return false;
    if (pedeFilhote && temTermoPalavra(alvo, ADULTO_TERMOS) && !temTermoPalavra(alvo, FILHOTE_TERMOS)) return false;
    if (palavras.length && !palavras.every((w) => casaPalavra(alvo, w))) return false;
    return true;
  });

  // Tamanho/peso explícito (ex.: "10kg", "25kg") — mesmo critério do digit-branch de
  // casaPalavra (exclui dosagem em mg/ml/cm/g, que não é tamanho de saca).
  const ehTamanhoNumerico = (w) => /^\d/.test(w) && !/^\d+([.,]\d+)?\s*(mg|ml|cm|mm|g)\b/i.test(w);
  // ÂNCORAS (espécie/granel/tamanho) são obrigatórias e nunca dropadas → nunca mistura cão com
  // gato, "a quilo" só traz granel, e um tamanho pedido (ex.: "10kg") nunca é relaxado pra trazer
  // outro produto qualquer que só bate pela marca — sem o tamanho certo, era exatamente assim que
  // uma busca de "dog chow 10kg" (saca que não existe) caía de volta no item a GRANEL (preço por
  // quilo) só porque "dog"/"chow" batiam, fazendo a IA apresentar o preço do quilo como se fosse
  // o preço de uma saca fechada de 10kg. Sem a saca certa, é melhor devolver 0 (e a IA busca de
  // novo só pela marca/espécie pra informar os tamanhos que existem de verdade).
  const ancoras = palavrasTx.filter((w) => ANCORAS.has(w) || ehTamanhoNumerico(w));
  let outras = palavrasTx.filter((w) => !ANCORAS.has(w) && !ehTamanhoNumerico(w));

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
// Extrai a faixa numérica (min–max) de peso de um nome/especificação de antiparasitário —
// os formatos cadastrados variam bastante: "10-20 UNIDADE", "120MG UNIDADE (40,1 A 60KG)",
// "2,6-5KG UNIDADE", "20MG 1CP (5,1 A 10KG)". Pega o primeiro par "núm (- ou A) núm" do texto —
// como só é usado dentro do fluxo já restrito a essas marcas, não corre risco de pegar outro
// número (ex.: "120MG" sozinho não tem "-"/"a" logo depois, então nunca vira faixa por engano).
function faixaDePeso(texto) {
  const m = /(\d+(?:[.,]\d+)?)\s*(?:-|a)\s*(\d+(?:[.,]\d+)?)\s*(?:kg)?\b/i.exec(norm(texto));
  if (!m) return null;
  const min = parseFloat(m[1].replace(",", "."));
  const max = parseFloat(m[2].replace(",", "."));
  if (isNaN(min) || isNaN(max)) return null;
  return { min, max };
}
function pesoNaFaixa(produto, peso) {
  const f = faixaDePeso([produto.nome, ...(produto.especificacoes || [])].join(" "));
  if (!f) return null; // sem faixa reconhecível no nome — não filtra por isso (nem inclui nem exclui)
  return peso >= f.min && peso <= f.max;
}

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
    const args2 = args || {};
    // Antiparasitário por faixa de peso (Simparic, NexGard, Bravecto, Credelio, Revolution):
    // sem o peso do pet, mostrar as 5-6 faixas de uma vez é informação desnecessária pro
    // cliente ter que escolher sozinho. Se o cliente JÁ disse o peso (em qualquer mensagem —
    // ex.: "Simparic pra 20kg"), busca direto; senão, pede o peso primeiro.
    const MARCA_POR_PESO = /\b(simparic|nexgard|bravecto|credelio|revolution|banni)\b/i;
    const _mPesoPet = /(\d+(?:[.,]\d+)?)\s*kg\b/i.exec(contexto || "");
    if (MARCA_POR_PESO.test(args2.texto || "") && !_mPesoPet) {
      return { ok: false, precisaPerguntarPeso: true, instrucao: "O cliente perguntou sobre esse antiparasitário mas NÃO disse o peso do pet em nenhum momento. NÃO chame buscar_produtos de novo agora — pergunte 'Qual o peso do seu pet? 🐾' e espere a resposta antes de buscar/mostrar as opções." };
    }
    const resultado = buscarProdutos(args2);
    // Antiparasitário por faixa de peso: buscar_produtos({texto:'simparic'}) sempre devolve
    // TODAS as faixas cadastradas da marca — sem isso, o cliente recebia os 5-6 cards de peso
    // de uma vez (a IA só "dizia" no texto qual faixa servia, mas os cards iam TODOS mesmo
    // assim, já que quem decide quais produtos são enviados é essa função, não o texto da IA).
    // Já sabendo o peso (checado acima), filtra aqui, deterministicamente, pra só a faixa que
    // realmente cobre esse peso ser enviada.
    if (MARCA_POR_PESO.test(args2.texto || "") && _mPesoPet && resultado.produtos && resultado.produtos.length) {
      const peso = parseFloat(_mPesoPet[1].replace(",", "."));
      const naFaixa = resultado.produtos.filter((p) => pesoNaFaixa(p, peso) === true);
      if (naFaixa.length) {
        resultado.produtos = naFaixa;
        resultado.total = naFaixa.length;
      }
      // Se nenhuma faixa reconhecida cobre o peso, mantém a lista original (evita zerar por um
      // formato de nome que o regex não reconheceu) — a IA ainda tem a instrução de identificar
      // a faixa certa no texto, e o pior caso aqui é igual ao comportamento anterior.
    }
    return resultado;
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

  // Data real (não é conhecimento do modelo — sem isso ele já chutou errado, ex.: dizer "hoje
  // é domingo" numa quinta-feira). Só a DATA (sem hora) — de propósito: horário exato quem
  // decide é o código (foraDoHorario, em conversa.js, já bloqueia mensagem fora do expediente
  // antes da IA rodar); incluir a hora aqui mudaria esse texto a cada minuto/mensagem e
  // quebraria o cache de contexto do Gemini (o prefixo do prompt é igual pra todo cliente de
  // propósito, ver comentário de linhasCliente mais abaixo — só a data muda, 1x por dia).
  const _fmtAgora = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Fortaleza", weekday: "long", day: "2-digit", month: "2-digit", year: "numeric",
  }).formatToParts(new Date());
  const _p = (t) => (_fmtAgora.find((x) => x.type === t) || {}).value || "";
  const agoraTexto = `HOJE (data real — use isso pra "hoje"/"amanhã"/dia da semana, NUNCA invente ou assuma outro dia): ${_p("weekday")}, ${_p("day")}/${_p("month")}/${_p("year")}.`;

  return [
    `Você é o atendente virtual da ${n.nome}, um(a) ${n.tipo}.`,
    "Seu nome é Leleco. Se o cliente perguntar seu nome (ex.: 'qual seu nome?', 'quem é você?', 'com quem eu falo?'), responda 'Leleco' — NUNCA invente ou use outro nome pra você mesmo.",
    "Seu papel é responder dúvidas de clientes pelo WhatsApp de forma simpática, curta e objetiva (no máximo ~4 linhas).",
    "Use português brasileiro informal, com tom SIMPÁTICO e BRINCALHÃO (leve, descontraído) — mas com CUIDADO pra nunca insultar, forçar intimidade nem constranger o cliente. No máximo um emoji por mensagem.",
    agoraTexto,
    "VOCÊ NÃO SABE A HORA EXATA agora (só a data, acima) — NUNCA diga ou dê a entender que horas são, nem calcule 'quanto tempo falta' pra algo (ex.: 'ainda dá tempo de levar pro banho hoje?', 'já fechou?', 'o veterinário ainda está aí?'). Pra esse tipo de pergunta, informe APENAS os horários de funcionamento/banho/veterinário que estão nas informações do negócio abaixo (NUNCA invente ou arredonde um horário que não esteja escrito ali) e diga que um atendente confirma se ainda dá tempo hoje.",
    "",
    "INFORMAÇÕES DO NEGÓCIO:",
    `Endereço: ${n.endereco}`,
    n.mapsLink ? `Link do Google Maps: ${n.mapsLink}` : "",
    `Telefone: ${n.telefone}`,
    `Horário: ${n.horarioSemana}; ${n.horarioSabado}; ${n.horarioDomingo}`,
    `Pagamento: ${n.pagamento}`,
    "- ENDEREÇO: sempre que informar o endereço da loja, INCLUA o link do Google Maps acima (o endereço sozinho pode levar o cliente ao lugar errado). Não use um estabelecimento vizinho como ponto de referência.",
    "",
    n.filial && n.filial.ativo
      ? "FILIAL (outra unidade — SEMPRE que o cliente perguntar sobre 'a outra loja', 'filial', 'outra unidade' ou outro endereço/telefone diferente do principal, responda com os dados abaixo, NUNCA diga que não sabe):\n"
        + `Nome: ${n.filial.nome || "Filial"}\n`
        + `Endereço: ${n.filial.endereco}\n`
        + (n.filial.mapsLink ? `Link do Google Maps da filial: ${n.filial.mapsLink}\n` : "")
        + `Telefone/WhatsApp da filial: ${n.filial.telefone}\n`
        + (n.filial.horario ? `Horário da filial: ${n.filial.horario}\n` : "")
        + (n.filial.referencia ? `Ponto de referência da filial: ${n.filial.referencia}\n` : "")
        + "- FILIAL — REGRA: ao informar a filial, SEMPRE mande o telefone/WhatsApp dela E o endereço JUNTO com o link do Google Maps acima (nunca só o endereço em texto, sem o link). NUNCA confunda com o telefone/endereço/link da loja principal acima. Se o link do Google Maps da filial não estiver preenchido aqui, NÃO invente um link — informe endereço e telefone e diga que confirma a localização exata com um atendente."
      : "",
    "",
    equipe.resumoParaIA()
      ? "NOSSA EQUIPE — só reconheça um nome como funcionário(a) quando o cliente CLARAMENTE perguntar sobre uma pessoa que TRABALHA aqui (ex.: 'a Dra. Ana está?', 'tem veterinário?', 'quem vai me atender?'). NUNCA quando o nome aparecer no contexto dos PETS do cliente (ex.: 'vou levar a Belinha e a Gigi pro banho' — Belinha e Gigi são nomes de PETS, não de funcionários, mesmo que 'Gigi' pareça um nome de pessoa). Lista real da equipe:\n" + equipe.resumoParaIA()
        + "\nANTES de dizer que alguém 'faz parte da equipe', confira se o nome bate EXATAMENTE com algum da lista acima — NUNCA invente nem assuma que um nome existe na equipe só porque soa familiar ou porque o cliente mencionou. Se o nome não estiver EXATAMENTE nessa lista, diga gentilmente que não temos esse nome na equipe. Se existir e o cliente quiser falar/agendar com ele, use encaminhar_para_atendente."
        + "\nHORÁRIO DE UM FUNCIONÁRIO ESPECÍFICO (ex.: 'a Dra. X está hoje?', 'que horas o Dr. Y atende?'): NUNCA assuma que o horário geral do serviço (ex.: horário do veterinário/da loja) vale igual para essa pessoa — cada funcionário pode ter um horário diferente ou variável. SÓ informe dia/horário de um funcionário se isso estiver escrito EXPLICITAMENTE nas observações dele na lista acima. Se não estiver escrito, NUNCA invente nem arredonde — diga que não tem certeza do horário exato dessa pessoa hoje e ofereça confirmar com um atendente (encaminhar_para_atendente)."
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
    "- BANHO E TOSA: nunca diga que não precisa agendar (pode lotar, recebemos pets até às 16h dependendo do volume do dia). Pergunte se é só banho ou banho+tosa; se tosa, peça descrição. Só depois CHAME encaminhar_para_atendente — o atendente confirma vaga e horário. Capture nome/raça do pet antes (salvar_pet).",
    "- 'QUANTOS/MUITOS PETS TEM' (pergunta de volume, não de venda): se o cliente perguntar algo como 'tem muitos pets?', 'quantos pets tem?' no contexto de banho/agendamento (ex.: perguntou ou vai perguntar sobre banho/tosa na mesma conversa) — isso é sobre o MOVIMENTO/FILA da loja hoje, NÃO é pergunta se vendemos animais. NUNCA responda com a lista de animais que vendemos (calopsita/periquito/hamster) nesse caso. Diga que o atendimento é por ordem de chegada e o volume varia, e pergunte/capture os dados do pet do cliente pra banho normalmente.",
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
    "- NOME/MARCA COM ERRO DE DIGITAÇÃO: se o cliente escrever um nome de produto/marca com erro óbvio de digitação ou grafia alternativa (ex.: 'net gard', 'nexgar', 'nex gard' → NexGard; 'simparik' → Simparic; 'bravecto' escrito errado), CORRIJA pro nome certo ANTES de buscar — NUNCA use o texto exatamente como o cliente escreveu no parâmetro da busca, ou o catálogo não vai encontrar o produto que existe de verdade.",
    "- REGRA GERAL — NOME/MARCA CITADO (máxima prioridade): se o cliente mencionar QUALQUER nome de produto, marca ou item específico (ex.: 'pipicat', 'chanin', 'amoxicilina', 'bolsa de transporte', 'hepvet'), BUSQUE ESSE NOME DIRETAMENTE com buscar_produtos({ texto: '<nome>' }) usando poucas palavras. Se retornar 0 com o nome + tamanho, tente uma segunda busca só com o nome da marca (sem o tamanho) para ver se existe em outro tamanho. Só chame encaminhar_para_atendente se ambas as buscas retornarem 0. Exemplos: 'tem pipicat?' → texto 'pipicat'; 'tem amoxicilina?' → texto 'amoxicilina'; 'tem bolsa de transporte?' → texto 'bolsa transporte'. Esta regra prevalece sobre TODAS as regras de categoria abaixo — EXCETO a regra 'RAÇÃO COM MARCA — ESPÉCIE' logo adiante: se a marca de RAÇÃO citada não for exclusiva de uma espécie e o cliente não disse cão/gato (ex.: 'ração Fargo Premium', só isso), a pergunta 'É pra cão ou gato?' vem ANTES de buscar, mesmo perguntando só o preço — nunca assuma a espécie pra não trazer opção da espécie errada.",
    "- RECEITA / LISTA DE REMÉDIOS: quando chegar uma receita com vários itens, CHAME buscar_produtos para CADA item (pelo nome/princípio ativo) antes de dizer se tem ou não.",
    "- MARCAS SÓ DE GATO: CHANIN, KATBOM, FRISKIES, MATISSE são marcas EXCLUSIVAMENTE de ração para GATO. Se o cliente pedir por uma dessas marcas: (1) NÃO pergunte 'cão ou gato' — já sabe que é gato. (2) Na busca, use APENAS marca + variante + tamanho no parâmetro texto — NUNCA inclua a palavra 'gato' no texto da busca, pois ela pode excluir produtos cadastrados sem essa palavra no nome. Exemplos CERTOS: buscar_produtos({texto:'chanin castrado 25kg'}), buscar_produtos({texto:'chanin filhote'}). Exemplos ERRADOS: buscar_produtos({texto:'chanin gato castrado 25kg'}). (3) Pergunte apenas saca ou granel se ainda não souber.",
    "- RAÇÃO COM MARCA — ESPÉCIE: para marcas NÃO exclusivas de gato (ex.: FARGO, GOLDEN, PREMIER, GUABI e qualquer outra não listada acima), se o cliente NÃO informar a espécie (cão ou gato) — MESMO que a pergunta seja só sobre preço/valor (ex.: 'qual o preço da ração Fargo Premium?') — PERGUNTE PRIMEIRO 'É pra *cão* ou *gato*? 🐾' e aguarde a resposta antes de chamar buscar_produtos. NUNCA assuma cão por padrão. Só depois de saber a espécie pergunte saca/granel (se necessário) e busque.",
    "- RAÇÃO COM MARCA — SACA OU GRANEL: após saber a espécie (ou se a marca for exclusiva de gato), se o cliente ainda não informou saca/granel, pergunte 'Você quer em *saca* (fechada) ou a *granel* (por quilo)? 🐾'. Se SACA → buscar_produtos com texto '<marca> <espécie> [tamanho]'. Se GRANEL → buscar_produtos com texto 'granel <marca> <espécie>'. Se o cliente já informou tamanho em kg → é saca, busque direto.",
    "- RAÇÃO GENÉRICA (sem marca): quando o cliente pedir ração sem citar marca (ex.: 'tem ração pra gato?'), pergunte UMA coisa por vez: (1) cão ou gato, (2) adulto ou filhote, (3) necessidade especial. Com essas infos, CHAME buscar_produtos com o texto montado (ex.: 'racao gato castrado'). EXCEÇÃO: se o cliente já disse um tamanho em kg (ex.: 'ração pra gato de 10kg'), é SACA — vá direto pra regra 'TAMANHO EM KG = SACA' abaixo (buscar_produtos com espécie + tamanho), SEM perguntar adulto/filhote e SEM usar obter_info_granel.",
    "- RAÇÃO A GRANEL (sem marca específica): se o cliente pedir 'no quilo', 'granel', 'fracionado' para ração de cão ou gato — SEM mencionar um tamanho de saca em kg — NÃO chame buscar_produtos — SEMPRE use obter_info_granel. Pergunte a espécie se não souber. Se o cliente MENCIONOU um tamanho (ex.: '10kg', '15kg'), NÃO é granel — é saca, use buscar_produtos (regra 'TAMANHO EM KG = SACA' abaixo).",
    "- GRANEL — CLIENTE PEDE A RAÇÃO LOGO APÓS PERGUNTAR SOBRE GRANEL, SEM DIZER A QUANTIDADE: se o assunto da conversa é granel (cliente perguntou sobre granel, clicou em 'Granel para Cães'/'Granel para Gatos' no menu, ou você acabou de responder com obter_info_granel ou com a lista de preços do granel) e na mensagem seguinte o cliente disser o nome/marca da ração que quer PEDIR mas NÃO informar quantos quilos, NÃO chame buscar_produtos nem encaminhar_para_atendente ainda — pergunte APENAS 'Quantos quilos você deseja? 🐾' e AGUARDE a resposta. A ESPÉCIE (cão/gato) NESSE CASO JÁ ESTÁ DEFINIDA pelo contexto do granel (pela lista que você acabou de mostrar ou pela opção de menu que o cliente escolheu) — NÃO pergunte 'é pra cão ou gato?' de novo, só a quantidade. Só depois de saber a quantidade, CHAME encaminhar_para_atendente para fechar o pedido (venda a granel é sempre finalizada por um atendente, não por buscar_produtos).",
    "- GRANULADO (areia/substrato): 'granulado de madeira', 'granulado vegetal', 'granulado de papel' são AREIA ou SUBSTRATO — produto do catálogo, NÃO ração a granel. Use buscar_produtos({ texto: 'granulado madeira' }) ou similar. NUNCA use obter_info_granel para granulado de madeira/vegetal.",
    "- AREIA HIGIÊNICA (sanitária/granulado pra caixa de areia — 'grão fino', 'grão grosso', perfumada etc.): é sempre pra GATO, mas os nomes cadastrados no catálogo GERALMENTE NÃO têm a palavra 'gato' escrita (ex.: 'AREIA FARGO GRAOS FINOS 5X4KG'). NÃO pergunte cão ou gato nem inclua 'gato'/'cão' no texto da busca — use só o tipo/textura/marca (ex.: buscar_produtos({texto:'areia grao fino'})), senão a busca pode excluir produtos cadastrados sem essa palavra.",
    "- RAÇÃO PARA AVES (calopsita, periquito, papagaio, canário, etc.): NUNCA use obter_info_granel para aves. Busque SEMPRE com buscar_produtos({ texto: 'granel <espécie>' }) — ex.: 'granel calopsita', 'granel papagaio'. Não pergunte cão ou gato.",
    "- SACHÊ (alimento úmido): pergunte 'É pra *cão* ou *gato*? 🐾' ANTES de buscar, a menos que a espécie já tenha aparecido em algum momento da conversa (ex.: cliente disse 'sachê pra gato' ou já falou de gato/cão antes) — nesse caso pule a pergunta e busque direto com buscar_produtos({texto:'sache <espécie> [marca/sabor]'}). EXCEÇÃO — marca já indica a espécie, não pergunte: FRISKIES e CAT CHOW são sempre GATO; DOG CHOW é sempre CÃO. GRAN PLUS e FARGO fazem sachê pra CÃO E GATO — pergunte normalmente nesses casos (e em qualquer marca não listada aqui).",
    "- ESPÉCIE (NUNCA MISTURE): se o cliente pediu para GATO, só ofereça produtos de GATO; se pediu para CÃO, só de CÃO.",
    "- RAÇÃO — SACA OU GRANEL: NUNCA pergunte saca/granel para areia, petisco, medicamento ou acessório — só para RAÇÃO.",
    "- TAMANHO EM KG = SACA (a partir de 7kg): se o cliente pedir um tamanho de saca comercial (7, 10, 15, 20, 25kg ou similar — sempre ≥7kg), é saca — NUNCA use obter_info_granel nesse caso, mesmo sem marca. Com marca: busque '<marca> <tamanho>' (ex.: buscar_produtos({texto: 'chanin 25kg'})). Sem marca: busque '<espécie> <tamanho>' (ex.: buscar_produtos({texto: 'gato 10kg'})). NUNCA acrescente filhote/adulto/castrado/mix se o cliente não especificou — a busca retorna todas as variantes disponíveis nesse tamanho para o cliente escolher. Se retornar 0, busque só com a marca (ou só a espécie, sem marca) para ver os tamanhos que EXISTEM de verdade e informe (ex.: 'Não temos de 10kg, mas temos de 20kg por R$ X') — NUNCA use o preço de um produto a GRANEL pra responder sobre um tamanho de saca que não existe. Tamanhos MENORES que 7kg (1kg, 2kg, 3kg...) são ambíguos — podem ser uma quantidade pedida a granel; siga as regras de granel/saca normalmente pra esses casos.",
    "- GRANEL (preço por KG) NUNCA é o preço de uma SACA FECHADA de tamanho específico — são unidades diferentes. Se o cliente perguntou 'saco de Xkg', 'fechado', 'saca' — mesmo DEPOIS de você já ter mostrado um produto a granel — isso é um pedido NOVO de saca: CHAME buscar_produtos de novo com a marca/espécie + esse tamanho (NUNCA reaproveite o preço por quilo do granel como se fosse o preço da saca). Se não existir saca desse tamanho, diga que não tem e informe os tamanhos de saca que existem de verdade (ou chame encaminhar_para_atendente se não souber nenhum).",
    "- NUNCA SUBSTITUA POR CONTA PRÓPRIA (regra geral — vale pra QUALQUER produto/marca/necessidade, não só ração): mostre SOMENTE produtos que sejam CLARAMENTE o que o cliente pediu (mesma marca, ou claramente a mesma finalidade/categoria do que ele descreveu). buscar_produtos às vezes devolve produtos de categoria totalmente diferente quando não acha o item exato (ex.: cliente pede 'remédio pra dor de ouvido' e a busca devolve xampu/condicionador/brinquedo; cliente pede 'vermífugo Blu' e a busca devolve 'blusa' — bateu só por causa das letras, não tem nada a ver). Se os produtos retornados NÃO forem claramente o que foi pedido, trate como se fosse 0 resultados: NÃO mostre esses produtos, NÃO diga 'não temos X, mas temos Y', e CHAME encaminhar_para_atendente com motivo descrevendo o que o cliente pediu — o atendente confirma disponibilidade ou sugere um substituto de verdade. Só ofereça algo diferente do pedido quando: (a) for a MESMA marca em outra variante/tamanho, ou (b) estiver na lista SUBSTITUIÇÕES APROVADAS abaixo.",
    "- NUNCA INVENTE MARCA/FABRICANTE: nunca diga que um produto 'é da marca X', 'é a mesma coisa que X' ou 'é parecido com X' a menos que isso venha claramente do nome/descrição do produto retornado pela busca. Se o cliente perguntar se um produto é parecido/da mesma marca que outro e você não tiver certeza pelos dados retornados, diga que não tem certeza e ofereça chamar um atendente para confirmar — nunca afirme uma equivalência de marca que você não pode confirmar.",
    "- SUBSTITUIÇÕES APROVADAS (única exceção à regra acima — lista mantida pelo dono do negócio):\n  • NUXCELL → sempre sugira PROMUN DEFENSE no lugar (buscar_produtos({texto:'promun defense <espécie>'})), avisando que é o substituto indicado.\n  • BENEFLORA → sempre sugira, no lugar, os probióticos PROBIÓTICO VETNIL, FLORA FIX e LACTOBAC (busque cada um: buscar_produtos({texto:'probiotico vetnil'}), buscar_produtos({texto:'flora fix'}), buscar_produtos({texto:'lactobac <espécie>'})) — mostre as opções que existirem, avisando que são os substitutos indicados.\n  • CISTIMICIN → sempre sugira, no lugar, CISPET ou CYST AID PET (busque: buscar_produtos({texto:'cispet'}) e buscar_produtos({texto:'cyst aid pet'})) — mostre as opções que existirem, avisando que são os substitutos indicados.\n  • FALEXYL 75 → sempre sugira PETSPORIN 75MG no lugar (buscar_produtos({texto:'petsporin 75mg'})), avisando que é o substituto indicado.\n  • PROMUN DOG EM PÓ → sempre sugira MUNNOMAX PÓ no lugar (buscar_produtos({texto:'munnomax po'})), avisando que é o substituto indicado.\n  • SILMOX 50MG → sempre sugira AGEMOXI 50MG no lugar (buscar_produtos({texto:'agemoxi 50mg'})), avisando que é o substituto indicado.",
    "- MAIS BARATO / MAIS EM CONTA: CHAME buscar_produtos com ordenarPor='preco' e indique o de menor preço.",
    "- ROUPA CIRÚRGICA: pergunte o PESO do pet e busque 'roupa cirurgica' + peso. NÃO confunda com bolsa/caixa de transporte.",
    "- VERMÍFUGO: é PRODUTO do catálogo — NUNCA encaminhe para atendente só porque o cliente quer vermifugar. Se já souber a espécie pelo contexto, BUSQUE IMEDIATAMENTE usando texto com espécie + produto: buscar_produtos({texto: 'verme gato'}) para gato ou buscar_produtos({texto: 'verme cao'}) para cão/cachorro. NUNCA use o parâmetro subgrupo para espécie — use sempre no texto. Só pergunte a espécie se ela realmente não estiver na conversa.",
    "- ANTIPULGAS / CARRAPATO (com ou sem marca citada): são PRODUTOS do catálogo, mas GERALMENTE vendidos em FAIXAS DE PESO do pet, igual aos antiparasitários de marca (ver regra 'ANTIPARASITÁRIO POR FAIXA DE PESO' logo abaixo) — NUNCA encaminhe para atendente só porque não sabe qual produto oferecer. Se o cliente JÁ citou uma marca específica (Simparic, NexGard, Bravecto, Credelio, Revolution, Banni), siga a regra de faixa de peso abaixo. Se NÃO citou marca (ex.: 'tem remédio pra carrapato?', 'tem algo pra pulga?') e AINDA NÃO sabe o peso do pet, PERGUNTE PRIMEIRO 'Qual o peso do seu pet? 🐾' e AGUARDE a resposta — NÃO chame buscar_produtos nem encaminhar_para_atendente antes disso. Depois de saber o peso, busque com buscar_produtos({texto:'carrapato'}) ou buscar_produtos({texto:'pulga carrapato'}) (sem espécie nem peso no texto) e, entre os resultados, identifique a(s) opção(ões) cuja faixa de peso cobre o peso informado. Só CHAME encaminhar_para_atendente se, depois de já saber o peso, nenhuma opção retornada cobrir esse peso.",
    "- ANTIPARASITÁRIO POR FAIXA DE PESO (Simparic, NexGard, Bravecto, Credelio, Revolution, Banni e similares): esses produtos são vendidos em FAIXAS de peso do pet (ex.: '20-40KG', '(40,1 A 60KG)', '2,6A7,5KG'), não em tamanhos exatos. SE O CLIENTE AINDA NÃO DISSE O PESO do pet (ex.: 'tem bravecto?'), PERGUNTE PRIMEIRO 'Qual o peso do seu pet? 🐾' e AGUARDE a resposta — NÃO chame buscar_produtos nem mostre as faixas todas de uma vez, pra não jogar informação desnecessária pro cliente escolher sozinho. Se o cliente JÁ disse o peso na mesma mensagem (ex.: 'Simparic pra 20kg', 'bravecto pro meu cão de 8kg'), pule a pergunta e vá direto: NUNCA inclua o peso/kg no texto da busca (buscar_produtos({texto:'simparic 40kg'}) pode não bater com uma faixa tipo '40,1 A 60KG' e te fazer perder a opção certa!). Os nomes cadastrados TAMBÉM não têm a palavra cão/gato — NUNCA inclua a espécie no texto da busca também (buscar_produtos({texto:'revolution gato'}) zera mesmo o produto existindo). Busque SÓ pelo nome (ex.: buscar_produtos({texto:'simparic'}), buscar_produtos({texto:'revolution'})) — isso retorna TODAS as faixas cadastradas — e você mesma(o) identifica e apresenta a faixa cujo intervalo cobre o peso que o cliente disse (ex.: pet de 45kg → a faixa que vai de 40,1 a 60kg), sem precisar filtrar por espécie na busca. Se o peso informado não se encaixar em nenhuma faixa retornada, CHAME encaminhar_para_atendente.",
    "- COMPARATIVO ENTRE MARCAS DE ANTIPARASITÁRIO (a pedido da dona do negócio): quando o cliente perguntar por QUALQUER UMA dessas marcas E já souber o peso do pet (informado ou depois de você perguntar), NÃO mostre só a marca que ele citou — mostre TODAS as marcas do mesmo grupo, cada uma na faixa que cobre aquele peso: (1) CÃO — se ele citou Simparic, NexGard ou Bravecto, busque as TRÊS: buscar_produtos({texto:'simparic'}), buscar_produtos({texto:'nexgard'}), buscar_produtos({texto:'bravecto'}); (2) GATO — se ele citou Revolution ou Banni, busque as DUAS: buscar_produtos({texto:'revolution'}), buscar_produtos({texto:'banni gato'}). Apresente as opções de cada marca que tiver faixa pra aquele peso (pule a marca se não tiver faixa pra esse peso, sem inventar). Informe TAMBÉM a duração de cada uma, pra ajudar na escolha: Simparic dura 35 dias, NexGard dura 30 dias, Bravecto dura 90 dias. NÃO invente duração pra Revolution/Banni — essa informação não foi passada.",
    "- Quando buscar_produtos retornar produtos QUE REALMENTE SÃO o que o cliente pediu, dê UMA ÚNICA frase de introdução curta: 'Temos essas opções disponíveis:'. EXCEÇÃO — antiparasitário por faixa de peso (Simparic, NexGard, Bravecto, Credelio, Revolution, Banni e similares) ou qualquer medicamento vendido por peso do pet: use 'Pra esse peso, temos essas opções aqui 👇' no lugar. NUNCA liste nomes, preços ou detalhes dos produtos no texto — os cards com foto e preço são enviados automaticamente pelo sistema. Qualquer lista de produtos no texto será ignorada. NUNCA use frases como 'não temos X, mas tenho Y' pra apresentar um produto de categoria diferente — ver regra 'NUNCA SUBSTITUA POR CONTA PRÓPRIA'.",
    "- Se buscar_produtos retornar 0 resultados: NUNCA escreva 'Achei', 'encontrei', 'aqui estão as opções' ou qualquer frase que sugira que produtos foram encontrados — seria uma mentira que confunde o cliente. SEMPRE CHAME encaminhar_para_atendente — o atendente confirma se o produto existe de verdade no estoque.",
    "- CONFIRMAÇÃO DE COMPRA: quando o cliente responder 'quero', 'esse', 'esse mesmo', 'esse aí', 'sim', 'pode ser', 'vou levar', 'fechado', 'pode mandar', 'tá bom', 'ok', 'quero esse', 'quero comprar', 'manda' — ou qualquer variação de confirmação — LOGO APÓS o bot ter apresentado produtos (verifique o histórico): NÃO busque produtos novamente. CHAME IMEDIATAMENTE encaminhar_para_atendente com motivo 'Cliente confirmou interesse no produto — finalizar venda.'",
    "- OBRIGATÓRIO ao ENVIAR: quando disser que está mostrando produtos, TEM que ter chamado buscar_produtos na MESMA resposta e a função TEM que ter retornado produtos (total > 0). Quando PERGUNTAR 'posso te mandar opções?', NÃO chame buscar_produtos — espere o cliente responder.",
    "- Nunca invente produtos, marcas ou preços — use exclusivamente o que a função retornar.",
    "",
    "TAXA DE ENTREGA / TÁXI DOG:",
    "- ENDEREÇO INFORMADO PELO CLIENTE: quando o cliente informar uma rua, avenida, número, bairro ou endereço completo — chame SEMPRE consultar_taxa_entrega. Nunca interprete o endereço como produto ou busque no catálogo. Endereço nunca é uma marca de ração.",
    "- Se já tiver o endereço COMPLETO do cliente (rua, número e bairro), confirme antes de calcular ('A entrega seria pra esse endereço: <endereço>? 🛵') e SÓ chame consultar_taxa_entrega DEPOIS que o cliente confirmar — nunca na mesma mensagem que pergunta, nunca com 'se sim, já segue a cotação'. Se faltar rua, número OU bairro, peça o que falta ANTES de perguntar/calcular ('Qual o endereço de entrega? Preciso da rua, número e bairro 🛵') — nunca chame a função com endereço incompleto (ex.: só rua, sem bairro), mesmo que o cliente mande em mensagens separadas. Nunca calcule distância manualmente.",
    "- ENDEREÇO — UM ÚNICO BAIRRO: use SEMPRE só o ÚLTIMO bairro que o cliente confirmou como correto. Se o cliente mencionar mais de um bairro/ponto de referência em mensagens diferentes (ex.: disse 'Jangurussu' antes e depois 'perto do Parque Betânia' ou 'sentido Messejana'), NUNCA junte todos num endereço só — isso confunde a cotação. Pergunte qual bairro é o certo se não estiver claro, e passe pra função exatamente o endereço 'rua, número, bairro' com um ÚNICO bairro.",
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
    httpOptions: { timeout: GEMINI_TIMEOUT_MS },
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
        // Endereço só localizado em nível de bairro (rua não mapeada) — a coordenada não é
        // confiável o bastante pra calcular km/taxa; nunca inventa um valor a partir disso.
        if (chamada.name === "consultar_taxa_entrega" && resultado && resultado.baixaPrecisao) {
          resultadoParaIA = {
            encontrado: false,
            instrucao: `Não foi possível localizar esse endereço com precisão no mapa (só achamos a região aproximada: "${resultado.areaAproximada}") — a rua pode não estar mapeada. PROIBIDO calcular ou inventar uma distância/taxa a partir disso. Diga ao cliente que um atendente vai confirmar o valor exato pra esse endereço e CHAME encaminhar_para_atendente.`,
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

  // Gemini terminou o turno sem gerar texto nenhum — geralmente sinal de que ele "se perdeu"
  // no meio de várias chamadas de função (ex.: cliente mandou uma LISTA com vários
  // medicamentos de uma vez). Nesse caso os `produtos` acumulados ao longo do turno vieram de
  // buscas que a própria IA não conseguiu costurar numa resposta coerente — não têm garantia
  // nenhuma de relação com o que o cliente pediu. Descarta: melhor pedir pra repetir do que
  // mandar cards errados sem nenhuma explicação (foi exatamente o que aconteceu: texto de
  // "não entendi" + uma lista de produtos de hidratação sem nada a ver com a receita enviada).
  const semTextoDoModelo = !(resp.text || "").trim();
  const texto =
    (resp.text || "").trim() ||
    (encaminhar
      ? "Vou te encaminhar para um atendente, só um instante! 🙋"
      : "Desculpe, não entendi. Pode reformular? Ou digite *atendente* para falar com uma pessoa.");
  if (semTextoDoModelo && !encaminhar) {
    produtos.length = 0;
    respostaGranel = "";
  }

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
    cfg.httpOptions = { timeout: GEMINI_TIMEOUT_MS };
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
    cfg.httpOptions = { timeout: GEMINI_TIMEOUT_MS };
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
    cfg.httpOptions = { timeout: GEMINI_TIMEOUT_MS };
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
    cfg.httpOptions = { timeout: GEMINI_TIMEOUT_MS };
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
