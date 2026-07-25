# Lecoland — Bot de triagem do WhatsApp 🐾

Bot de atendimento para pet shop / clínica veterinária. Ele:

- Conecta ao WhatsApp por **QR code** (via [whatsapp-web.js](https://wwebjs.dev/)).
- Faz **triagem por palavra-chave**: reconhece intenções como *banho*, *veterinário*, *vacina*, *horário*, *endereço*, *pagamento* e responde na hora com respostas prontas.
- Responde **perguntas livres** com a IA **gratuita** do **Google Gemini** (`gemini-2.5-flash`), ancorada nos dados do negócio — sem inventar preço, horário ou serviço.
- Faz **handoff para humano**: quando o cliente digita *atendente*, o bot se cala para aquele contato por 1 hora.
- Tem um **painel de administração no navegador**: edite saudação, serviços, palavras-chave, preços e taxas de entrega por formulários — sem mexer em código. As mudanças valem na hora.
- **Calcula a taxa de entrega / táxi dog pelo endereço do cliente**: geolocaliza o endereço, mede a **distância de carro** a partir da loja (via [OpenRouteService](https://openrouteservice.org/), gratuito) e responde o valor da faixa de km correspondente.

## Requisitos

- **Node.js 18 ou superior** (as libs atuais do WhatsApp/Gemini pedem Node 18+).
  Seu ambiente está no Node 16 — instale o 18 com [nvm](https://github.com/nvm-sh/nvm): `nvm install 18 && nvm use 18`.
- Uma **chave da API do Google Gemini** — **gratuita** e sem cartão: https://aistudio.google.com/apikey
- *(Opcional)* Uma **chave gratuita do [OpenRouteService](https://openrouteservice.org/dev/#/signup)** (sem cartão) — só é necessária para calcular a taxa pelo **endereço** do cliente. Sem ela, o bot ainda calcula a taxa pela **distância (km)** informada.
- Um número de WhatsApp para o bot (de preferência dedicado).

## Como rodar

```bash
# 1. Instale as dependências
npm install

# 2. Configure a chave da API (gratuita)
cp .env.example .env
#   edite .env e cole sua GEMINI_API_KEY (https://aistudio.google.com/apikey)
#   (opcional) cole também a ORS_API_KEY para calcular a taxa pelo endereço do cliente

# 3. (opcional) Teste a triagem sem WhatsApp nem API
node test-triagem.js

# 4. Suba o bot (também abre o painel em http://localhost:4500)
npm start
```

Na primeira vez, um **QR code** aparece no terminal. No celular: WhatsApp → *Aparelhos conectados* → *Conectar um aparelho* → escaneie. A sessão fica salva em `.wwebjs_auth/`, então nas próximas vezes não precisa escanear de novo.

## Personalizar (painel no navegador — recomendado)

Você **não precisa mexer em código**. Toda a configuração fica em `data/config.json`, editável por um painel web:

- Com o bot rodando (`npm start`), abra **http://localhost:4500**.
- Ou abra **só o painel** (sem conectar o WhatsApp): `npm run painel`.

No painel você edita:
- **Dados do negócio** (nome, endereço, telefone, horários, pagamento).
- **Mensagens** (saudação e resposta de atendente).
- **Serviços** — adicionar/remover, com palavras-chave e preços.
- **Respostas rápidas (FAQ)**.
- **Entrega / Táxi Dog** — taxas por **serviço** e **faixa de distância (km)**, e o **endereço de partida da loja** (usado para medir a distância).
- **Palavras-chave gerais** (atendente, saudação).

Clique em **Salvar tudo** e o bot passa a usar as mudanças na hora (sem reiniciar). Dica: em qualquer texto você pode usar `{nome}`, `{telefone}`, `{endereco}`, `{pagamento}`, `{horarioSemana}` etc., que são preenchidos com os dados do negócio.

> O painel roda só na sua máquina (localhost). Não fica exposto na internet.

## Cálculo de taxa pelo endereço (mapa)

O bot calcula a taxa de **entrega** e de **táxi dog** automaticamente a partir do endereço do cliente. Funciona assim:

1. O cliente manda o endereço (ex.: *"quanto é a entrega pra Rua das Carnaúbas, 777, Passaré?"*).
2. O bot **geolocaliza** o endereço pelo [OpenRouteService](https://openrouteservice.org/) (texto → coordenadas).
3. Mede a **distância de carro** entre a **loja** e o endereço.
4. Escolhe a **faixa de km** correspondente em cada serviço (a conta é determinística, no `config.js`/`geo.js` — a IA só formula a resposta).

**Configuração necessária:**
- `ORS_API_KEY` no `.env` (chave gratuita do OpenRouteService).
- O **ponto de partida da loja**, na seção *Entrega / Táxi Dog* do painel. Você pode informar só o endereço, **ou** fixar a posição exata com coordenadas em `data/config.json`:
  ```json
  "origem": { "endereco": "R. Dois, 190 - Passaré, Fortaleza - CE", "lat": -3.802437, "lon": -38.534313 }
  ```
  > 💡 As coordenadas exatas podem ser obtidas do **Plus Code** da loja no Google Maps (ex.: `5FX8+27`).

**Precisão e segurança:**
- A geolocalização é **restrita a um raio de 50 km** da loja, para nunca casar com um lugar de mesmo nome em outra cidade.
- Distâncias **acima da maior faixa** (ou endereço não localizado com segurança) → o bot encaminha para um **atendente humano**, sem dar valor errado.
- O geocoder gratuito acerta bem **endereços residenciais** (rua + número + bairro); pontos de referência/endereços incompletos podem falhar — nesses casos o bot pede para confirmar ou chama o atendente. Para precisão máxima em todo endereço, o caminho é o Google Maps (pago).
- Sem a `ORS_API_KEY`, o cálculo por endereço fica indisponível, mas o bot continua calculando pela **distância (km)** informada direto pelo cliente.

## Estrutura

```
data/
  config.json  → TODA a configuração (editada pelo painel)
src/
  config.js    → carrega/salva o config.json e monta as respostas
  triage.js    → triagem por palavra-chave e menu numerado
  ai.js        → respostas livres via Google Gemini (+ cálculo de taxa por endereço)
  geo.js       → geolocalização e distância de carro (OpenRouteService)
  admin.js     → servidor do painel de administração
  painel-only.js → abre só o painel (npm run painel)
  index.js     → conexão com o WhatsApp + painel
public/
  admin.html   → página do painel
test-triagem.js → teste offline da triagem
```

## Observações

- **Custo:** o Gemini tem uma cota **gratuita** generosa por dia, e só perguntas livres (que não casam com palavra-chave) chamam a IA — as respostas de menu são instantâneas e não consomem cota. Limites do plano gratuito: https://ai.google.dev/gemini-api/docs/rate-limits
- **whatsapp-web.js não é oficial.** É ótimo para protótipo e uso interno; para escala/produção considere a [WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api) oficial da Meta. 👉 Veja o guia completo de prós/contras e passo a passo da migração em **[MIGRACAO.md](MIGRACAO.md)**.
- **Sessão/estado em memória:** o handoff para humano e o histórico de conversa vivem na RAM e somem ao reiniciar. Para produção, troque por Redis ou um banco.
