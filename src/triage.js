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

function menuPrincipal(nome) {
  const { mensagens } = config.get();
  const linhas = config
    .intents()
    .map((opcao, i) => `${i + 1} - ${opcao.titulo}`)
    .join("\n");
  let intro = config.preencher(mensagens.saudacaoIntro);
  if (nome) {
    // Personaliza: troca o "Olá!" inicial por "Olá, <nome>!".
    intro = /^\s*ol[aá]/i.test(intro)
      ? intro.replace(/^\s*ol[aá]\s*[!,.]?\s*/i, `Olá, ${nome}! `)
      : `Olá, ${nome}! ` + intro;
  }
  return (
    intro +
    "\n\n" +
    config.preencher(mensagens.saudacaoChamada) +
    "\n" +
    linhas +
    "\n\n" +
    config.preencher(mensagens.saudacaoRodape)
  );
}

// Monta o texto de um sub-menu: introdução + opções numeradas + rodapé.
function menuTexto(menu) {
  const linhas = (menu.opcoes || []).map((o, i) => `${i + 1} - ${o.titulo}`).join("\n");
  const intro = config.preencher(menu.intro || `*${menu.nome || "Menu"}*`);
  return intro + "\n\n" + linhas + "\n\nDigite o *número* da opção (ou *0* para voltar).";
}

// Retorna { tipo, resposta, [novoContexto] } ou { tipo: "ia" } quando não há match.
// `contexto` = lista de opções do menu atual do cliente (para resolver o número escolhido).
// `novoContexto` (quando presente) = lista de opções a lembrar para esse cliente.
function triar(textoBruto, contexto) {
  const dados = config.get();
  const texto = normalizar(textoBruto);
  const principais = config.intents();
  const ctxPrincipal = { opcoes: principais, texto: menuPrincipal(), sub: false };

  if (!texto) {
    return { tipo: "menu", saudacao: true, resposta: menuPrincipal(), novoContexto: ctxPrincipal };
  }

  if (casaAlgumGatilho(texto, dados.gatilhosAtendente)) {
    return { tipo: "atendente", resposta: config.preencher(dados.mensagens.atendente) };
  }

  // Saudação só abre o menu em mensagens CURTAS (saudações são curtas). Assim uma
  // pergunta longa que por acaso contenha uma palavra de saudação vai para a IA.
  // `saudacao: true` deixa o conversa.js mostrar o menu só UMA vez por conversa.
  const numPalavras = texto.split(/\s+/).filter(Boolean).length;
  if (dados.gatilhosSaudacao.includes(texto) || (numPalavras <= 5 && casaAlgumGatilho(texto, dados.gatilhosSaudacao))) {
    return { tipo: "menu", saudacao: true, resposta: menuPrincipal(), novoContexto: ctxPrincipal };
  }

  // "0" ou "voltar" → volta ao menu atual (sub-menu) ou, se não houver, ao principal.
  if (texto === "0" || casaAlgumGatilho(texto, ["voltar", "voltar menu", "menu anterior", "voltar ao menu"])) {
    if (contexto && contexto.sub && contexto.texto) {
      return { tipo: "menu", resposta: contexto.texto }; // re-mostra o sub-menu (mantém o contexto)
    }
    return { tipo: "menu", resposta: menuPrincipal(), novoContexto: ctxPrincipal };
  }

  // Número → responde a opção do MENU ATUAL (sub-menu) ou, se não houver, do principal.
  if (/^\d+$/.test(texto)) {
    const lista = contexto && contexto.opcoes && contexto.opcoes.length ? contexto.opcoes : principais;
    const indice = parseInt(texto, 10) - 1;
    if (indice >= 0 && indice < lista.length) {
      const opcao = lista[indice];
      let resp = config.preencher(opcao.resposta);
      if (contexto && contexto.sub) resp += "\n\n↩️ Digite *0* para voltar ao menu.";
      return { tipo: "opcao", chave: opcao.chave, titulo: opcao.titulo, resposta: resp };
    }
    return { tipo: "menu", resposta: menuPrincipal(), novoContexto: ctxPrincipal };
  }

  // Palavra-chave de um SUB-MENU → abre o sub-menu e lembra suas opções + o texto.
  for (const menu of dados.menus || []) {
    if (casaAlgumGatilho(texto, menu.gatilhos)) {
      const t = menuTexto(menu);
      return { tipo: "submenu", chave: menu.id, resposta: t, novoContexto: { opcoes: menu.opcoes || [], texto: t, sub: true } };
    }
  }

  // Palavra-chave de serviço/FAQ (menu principal).
  for (const opcao of principais) {
    if (casaAlgumGatilho(texto, opcao.gatilhos)) {
      return { tipo: "opcao", chave: opcao.chave, titulo: opcao.titulo, resposta: config.preencher(opcao.resposta), novoContexto: ctxPrincipal };
    }
  }

  // Mensagens personalizadas (só por palavra-chave).
  for (const ex of dados.mensagensExtras || []) {
    if (casaAlgumGatilho(texto, ex.gatilhos)) {
      return { tipo: "mensagem", chave: ex.chave, resposta: config.preencher(ex.resposta) };
    }
  }

  // Sem palavra-chave reconhecida → deixa a IA (Gemini) responder a pergunta livre.
  return { tipo: "ia" };
}

module.exports = { triar, normalizar, menuPrincipal, menuTexto };
