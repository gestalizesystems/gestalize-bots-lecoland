// Estado de runtime compartilhado entre o bot e o painel (rodam no mesmo processo
// quando se usa `npm start`). Não persiste — reflete a situação atual da conexão.
module.exports = { whatsappConectado: false };
