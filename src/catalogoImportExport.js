// Importação/exportação da lista de preços do catálogo (fornecedor ↔ painel).
//
// IMPORTAR (PDF ou Excel com código/nome/preço, ex.: lista de tabela do fornecedor):
//   - código do catálogo que aparece na lista importada → só o PREÇO é atualizado
//     (nome, código, grupo, subgrupos e especificações NUNCA mudam);
//   - código do catálogo que NÃO aparece na lista importada → produto é DESATIVADO;
//   - código que estava desativado e voltou a aparecer na lista → é REATIVADO;
//   - código da lista que não existe em nenhum produto do catálogo → não cria nada,
//     só é reportado pro admin decidir se cadastra manualmente.
//
// EXPORTAR: gera um PDF com código/nome/preço de TODOS os produtos (ativos e inativos,
// sinalizando a situação de cada um), no mesmo estilo da lista que o fornecedor manda.

const pdfParse = require("pdf-parse");
const XLSX = require("xlsx");
const PDFDocument = require("pdfkit");
const config = require("./config");

function normTxt(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

// Extrai [{codigo, preco}] de um PDF de lista de preços. Cada produto ocupa uma linha de
// texto no formato "<código><nome>R$ <preço>" (colunas de uma tabela sem espaço entre elas
// na extração de texto) — ex.: "300527ACEPRAN GOTAS 48X10MLR$ 74,90".
async function extrairDoPdf(buffer) {
  const data = await pdfParse(buffer);
  const linhas = data.text.split("\n").map((l) => l.trim()).filter(Boolean);
  const re = /^(\d+)\s*(.+?)\s*r\$\s*([\d.,]+)\s*$/i;
  const itens = [];
  for (const linha of linhas) {
    const m = re.exec(linha);
    if (m) itens.push({ codigo: m[1], nome: m[2].trim(), preco: m[3] });
  }
  return itens;
}

// Extrai [{codigo, preco}] de uma planilha Excel. Reconhece cabeçalho "código"/"preço" (ou
// "valor") em qualquer ordem/coluna; sem cabeçalho reconhecível, assume A=código, B=nome, C=preço.
function extrairDoExcel(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const planilha = wb.Sheets[wb.SheetNames[0]];
  if (!planilha) return [];
  const linhas = XLSX.utils.sheet_to_json(planilha, { header: 1, raw: false, defval: "" });
  if (!linhas.length) return [];
  const cab = (linhas[0] || []).map(normTxt);
  let iCodigo = cab.findIndex((c) => c.includes("cod"));
  let iPreco = cab.findIndex((c) => c.includes("preco") || c.includes("valor"));
  let inicio = 1;
  if (iCodigo === -1 || iPreco === -1) { iCodigo = 0; iPreco = 2; inicio = 0; } // sem cabeçalho reconhecível
  const itens = [];
  for (let i = inicio; i < linhas.length; i++) {
    const l = linhas[i] || [];
    const codigo = String(l[iCodigo] || "").trim().replace(/\.0$/, ""); // Excel às vezes vira "123.0"
    const preco = String(l[iPreco] || "").trim();
    if (codigo && preco) itens.push({ codigo, preco });
  }
  return itens;
}

// Aplica a lista importada no catálogo. Muta só `preco`/`ativo` — nome, código, grupo,
// subgrupos e especificações de cada produto ficam exatamente como já estavam cadastrados.
function aplicarImportacao(itens) {
  const mapa = new Map();
  for (const it of itens || []) if (it && it.codigo) mapa.set(String(it.codigo).trim(), String(it.preco || "").trim());

  const c = config.get();
  if (!c.catalogo || typeof c.catalogo !== "object") c.catalogo = { grupos: [], subgrupos: [], especificacoes: [], produtos: [] };
  if (!Array.isArray(c.catalogo.produtos)) c.catalogo.produtos = [];
  const produtos = c.catalogo.produtos;

  const usados = new Set();
  let atualizados = 0, reativados = 0, desativados = 0, semMudanca = 0;
  for (const p of produtos) {
    const cod = String(p.codigo || "").trim();
    if (cod && mapa.has(cod)) {
      usados.add(cod);
      const novoPreco = mapa.get(cod);
      let mudou = false;
      if (novoPreco && novoPreco !== String(p.preco || "").trim()) { p.preco = novoPreco; mudou = true; }
      if (p.ativo === false) { p.ativo = true; reativados++; mudou = true; }
      if (mudou) atualizados++; else semMudanca++;
    } else if (p.ativo !== false) {
      p.ativo = false;
      desativados++;
    }
  }
  const naoEncontrados = [...mapa.keys()].filter((cod) => !usados.has(cod));

  config.salvar(c);
  return {
    totalImportado: mapa.size,
    atualizados, reativados, desativados, semMudanca,
    naoEncontrados: naoEncontrados.length,
    codigosNaoEncontrados: naoEncontrados.slice(0, 100),
  };
}

const COR_CABECALHO = "#1f3a5f"; // var(--navy) do painel
const COR_LINHA_PAR = "#f1f5f9";
const COR_INATIVO = "#b91c1c";

// Gera o PDF de exportação (código/nome/preço/situação de todos os produtos) e devolve o
// PDFDocument já com o conteúdo desenhado — quem chamar faz doc.pipe(res) e doc.end().
function gerarPdfExportacao() {
  const c = config.get();
  const produtos = ((c.catalogo && c.catalogo.produtos) || []).slice()
    .sort((a, b) => String(a.nome || "").localeCompare(String(b.nome || ""), "pt-BR"));
  const ativos = produtos.filter((p) => p.ativo !== false).length;
  const inativos = produtos.length - ativos;

  const doc = new PDFDocument({ size: "A4", margin: 40, bufferPages: true });
  const largura = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colCodigo = 55, colPreco = 75, colSituacao = 75;
  const colNome = largura - colCodigo - colPreco - colSituacao;
  const xCodigo = doc.page.margins.left;
  const xNome = xCodigo + colCodigo;
  const xPreco = xNome + colNome;
  const xSituacao = xPreco + colPreco;
  const alturaLinha = 22;

  function cabecalhoTabela(y) {
    doc.rect(xCodigo, y, largura, alturaLinha).fill(COR_CABECALHO);
    doc.fillColor("#fff").fontSize(10).font("Helvetica-Bold");
    doc.text("Cód.", xCodigo + 6, y + 6, { width: colCodigo - 10 });
    doc.text("Nome do Produto", xNome + 6, y + 6, { width: colNome - 10 });
    doc.text("Preço Tabela", xPreco, y + 6, { width: colPreco - 8, align: "right" });
    doc.text("Situação", xSituacao, y + 6, { width: colSituacao - 8, align: "right" });
    return y + alturaLinha;
  }

  doc.font("Helvetica-Bold").fontSize(18).fillColor(COR_CABECALHO)
    .text("GESTALIZE — Lista de Produtos e Preço de Tabela", xCodigo, doc.y, { width: largura, align: "center" });
  doc.moveDown(0.3);
  doc.font("Helvetica").fontSize(10).fillColor("#475569")
    .text(`Total de produtos: ${produtos.length} | Ativos: ${ativos} | Inativos: ${inativos} | Ordenado por nome`, xCodigo, doc.y, { width: largura, align: "center" });
  doc.moveDown(1);

  let y = cabecalhoTabela(doc.y);
  produtos.forEach((p, i) => {
    if (y + alturaLinha > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = cabecalhoTabela(doc.page.margins.top);
    }
    const inativo = p.ativo === false;
    if (i % 2 === 0) { doc.rect(xCodigo, y, largura, alturaLinha).fill(COR_LINHA_PAR); }
    const corTexto = inativo ? COR_INATIVO : "#0f172a";
    doc.fillColor(corTexto).font("Helvetica").fontSize(9.5);
    doc.text(String(p.codigo || ""), xCodigo + 6, y + 6, { width: colCodigo - 10 });
    doc.text(String(p.nome || ""), xNome + 6, y + 6, { width: colNome - 10, ellipsis: true });
    doc.text(p.preco ? "R$ " + p.preco : "(sob consulta)", xPreco, y + 6, { width: colPreco - 8, align: "right" });
    doc.font(inativo ? "Helvetica-Bold" : "Helvetica").text(inativo ? "Inativo" : "Ativo", xSituacao, y + 6, { width: colSituacao - 8, align: "right" });
    y += alturaLinha;
  });

  return doc;
}

module.exports = { extrairDoPdf, extrairDoExcel, aplicarImportacao, gerarPdfExportacao };
