// Teste rápido da triagem por palavra-chave — não usa WhatsApp nem a API do Gemini.
// Rode com: node test-triagem.js
const { triar } = require("./src/triage");

const casos = [
  "oi",
  "1",
  "5",
  "99",
  "queria marcar um banho pro meu cachorro",
  "preciso de um veterinario, meu gato ta doente",
  "vcs aplicam vacina v10?",
  "que horas vocês abrem no sábado?",
  "onde fica a loja?",
  "aceitam pix?",
  "vocês têm leva e traz?",
  "quero falar com um atendente",
  "vcs vendem ração da marca X?", // sem palavra-chave → deve cair na IA
];

let ok = 0;
for (const texto of casos) {
  const r = triar(texto);
  const etiqueta = r.tipo === "ia" ? "→ IA / Gemini (pergunta livre)" : `[${r.tipo}${r.chave ? ":" + r.chave : ""}]`;
  console.log(`\n"${texto}"\n  ${etiqueta}`);
  if (r.resposta) console.log("  resposta:", r.resposta.split("\n")[0]);
  ok++;
}
console.log(`\n✅ ${ok} casos processados sem erro.`);
