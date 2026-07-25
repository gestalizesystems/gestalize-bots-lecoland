// Abre APENAS o painel de administração, sem conectar o WhatsApp.
// Útil para editar as respostas/preços/taxas com calma.
// Rode com: npm run painel

require("dotenv").config();
const { iniciarAdmin } = require("./admin");

const ADMIN_PORT = process.env.ADMIN_PORT || 3000;

iniciarAdmin(ADMIN_PORT).then(() => {
  console.log("✏️  Painel aberto. Acesse no navegador o endereço acima.");
  console.log("   (Este modo NÃO conecta o WhatsApp — é só para editar a configuração.)");
});
