// Triagem por palavras-chave: normaliza o texto do cliente e tenta casar
// com as intenções (serviços, FAQ, entrega), atendente humano ou saudação/menu.
// Lê a configuração ao vivo via config.get()/intents(), então edições no painel
// valem imediatamente, sem reiniciar o bot.

const config = require("./config");

// Remove acentos, deixa minúsculo e tira pontuação — pra casar "veterinário" com "veterinario".
function normalizar(texto) {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Casa um gatilho como palavra inteira (evita "vet" casar dentro de "veterano").
function contemGatilho(textoNormalizado, gatilho) {
  const g = normalizar(gatilho);
  if (!g) return false;
  const re = new RegExp(`(^|\\s)${g.replace(/\s+/g, "\\s+")}($|\\s)`);
  return re.test(textoNormalizado);
}

function casaAlgumGatilho(textoNormalizado, gatilhos) {
  return (gatilhos || []).some((g) => contemGatilho(textoNormalizado, g));
}

function menuPrincipal() {
  const { mensagens } = config.get();
  const linhas = config
    .intents()
    .map((opcao, i) => `${i + 1} - ${opcao.titulo}`)
    .join("\n");
  return (
    config.preencher(mensagens.saudacaoIntro) +
    "\n\n" +
    config.preencher(mensagens.saudacaoChamada) +
    "\n" +
    linhas +
    "\n\n" +
    config.preencher(mensagens.saudacaoRodape)
  );
}

// Retorna { tipo, resposta } ou { tipo: "ia" } quando não há match e deve cair na IA (Gemini).
function triar(textoBruto) {
  const dados = config.get();
  const texto = normalizar(textoBruto);

  if (!texto) {
    return { tipo: "menu", resposta: menuPrincipal() };
  }

  if (casaAlgumGatilho(texto, dados.gatilhosAtendente)) {
    return { tipo: "atendente", resposta: config.preencher(dados.mensagens.atendente) };
  }

  if (casaAlgumGatilho(texto, dados.gatilhosSaudacao) || dados.gatilhosSaudacao.includes(texto)) {
    return { tipo: "menu", resposta: menuPrincipal() };
  }

  const opcoes = config.intents();

  // Cliente digitou só um número → responde a opção correspondente do menu.
  if (/^\d+$/.test(texto)) {
    const indice = parseInt(texto, 10) - 1;
    if (indice >= 0 && indice < opcoes.length) {
      const opcao = opcoes[indice];
      return { tipo: "opcao", chave: opcao.chave, resposta: opcao.resposta };
    }
    return { tipo: "menu", resposta: menuPrincipal() };
  }

  // Palavra-chave de algum serviço/FAQ/entrega.
  for (const opcao of opcoes) {
    if (casaAlgumGatilho(texto, opcao.gatilhos)) {
      return { tipo: "opcao", chave: opcao.chave, resposta: opcao.resposta };
    }
  }

  // Sem palavra-chave reconhecida → deixa a IA (Gemini) responder a pergunta livre.
  return { tipo: "ia" };
}

module.exports = { triar, normalizar, menuPrincipal };
