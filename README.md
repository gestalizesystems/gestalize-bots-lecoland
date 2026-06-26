# Lecoland — Bot de atendimento do WhatsApp 🐾

Bot de atendimento para pet shop / clínica veterinária, integrado à **WhatsApp Cloud API**
(oficial da Meta). Ele:

- Recebe mensagens por **webhook** oficial da Meta (sem QR code, sem navegador, sem risco de ban).
- Faz **triagem por palavra-chave**: reconhece intenções como *banho*, *veterinário*, *vacina*,
  *horário*, *endereço*, *pagamento*, *entrega* e responde na hora com respostas prontas.
- Tem um **menu de saudação** numerado e **sub-menus** próprios por palavra-chave
  (ex.: "carrapaticida" abre um menu com as opções de carrapaticida).
- Responde **perguntas livres** com a IA **Google Gemini** (`gemini-2.5-flash`), ancorada nos
  dados do negócio — sem inventar preço, horário ou serviço.
- Faz **handoff para humano** de forma inteligente: por pedido do cliente (*atendente*) **ou**
  quando a própria IA decide encaminhar; depois reengaja/encerra sozinho (ver abaixo).
- **Calcula a taxa de entrega / táxi dog pelo endereço do cliente**: geolocaliza, mede a
  **distância de carro** a partir da loja (OpenRouteService, gratuito) e responde o valor da faixa.
- Tem um **painel de administração no navegador** (com login) pra editar tudo por formulários —
  saudação, menus, FAQ, preços, taxas, catálogo e a base de conhecimento da IA. Mudanças valem na hora.
- Tem um **interruptor liga/desliga** do bot, pra preparar tudo com ele em silêncio e só ativar quando quiser.

## Como o handoff funciona
1. Handoff (cliente pede *atendente* ou a IA encaminha) → o bot fica em silêncio para aquele contato.
2. A cada mensagem do cliente, o cronômetro reinicia (não interrompe um atendimento ativo).
3. Após **1h de silêncio** → o bot pergunta *"Posso te ajudar em mais alguma coisa?"*.
4. Se o cliente disser que não (ou ficar **2h** sem responder) → encerra com uma despedida.
   Se trouxer algo novo → começa um atendimento novo.
A conversa **não é apagada** — o atendente lê todo o histórico no WhatsApp.

## Stack

| Camada | Tecnologia |
|---|---|
| **Runtime** | Node.js ≥ 18 |
| **Servidor** | Express 4 — painel web + webhook do WhatsApp (serviço único) |
| **Frontend (painel)** | HTML + CSS + JavaScript puro, sem framework · fonte Poppins |
| **Dados** | Arquivos **JSON** (sem banco SQL): `config`, `conta`, `clientes`, `sessoes` |
| **WhatsApp** | WhatsApp Cloud API (oficial da Meta) — webhook + Graph API |
| **IA** | Google Gemini (`@google/genai`) · `gemini-2.5-flash` · function calling |
| **Geolocalização** | OpenRouteService — distância de carro p/ a taxa de entrega |
| **Auth (painel)** | Sessão por cookie + senha com hash **scrypt** (módulo `crypto` do Node) |
| **Persistência** | Volume do Railway (`DATA_DIR`) — config, contas, clientes, sessões, uploads |
| **Deploy** | Railway — Node, serviço único, auto-deploy no `git push` |

## Requisitos
- **Node.js 18+**.
- **Chave da API do Google Gemini** — gratuita: https://aistudio.google.com/apikey
  (para produção, ative o faturamento no Google para sair do limite gratuito de 5 req/min).
- **Credenciais da WhatsApp Cloud API** (Phone Number ID + token) — ver "Configurar o WhatsApp" abaixo.
- *(Opcional)* Chave gratuita do **OpenRouteService** — só para calcular a taxa pelo **endereço**
  do cliente. Sem ela, o bot ainda calcula pela **distância (km)** informada.

## Variáveis de ambiente

Defina no `.env` (local) ou nas **Variables** do serviço no **Railway** (produção):

| Variável | Valor / origem | Obrigatória? |
|---|---|---|
| `GEMINI_API_KEY` | Chave do Google AI Studio (Gemini) | ✅ (p/ a IA) |
| `GEMINI_MODEL` | Modelo da IA — padrão `gemini-2.5-flash` | opcional |
| `WHATSAPP_TOKEN` | Token permanente (Usuário do Sistema) do app na Meta | ✅ produção |
| `WHATSAPP_PHONE_ID` | Phone Number ID do número (WhatsApp Manager) | ✅ produção |
| `WHATSAPP_VERIFY_TOKEN` | Senha que **você inventa** (verificação do webhook) | ✅ produção |
| `WHATSAPP_API_VERSION` | Versão da Graph API — padrão `v21.0` | opcional |
| `ORS_API_KEY` | Chave do OpenRouteService (taxa de entrega por endereço) | opcional |
| `ADMIN_EMAIL` / `ADMIN_SENHA` | Login do painel (semeia `data/conta.json` na 1ª vez) | ✅ |
| `PUBLIC_URL` | URL pública (ex.: `https://bots.gestalizesystems.com.br`) — link das fotos do catálogo | opcional |
| `DATA_DIR` | Pasta persistente (Volume do Railway, ex.: `/data`) | ✅ no Railway |
| `PORT` | Porta do servidor — **definida automaticamente pelo Railway** | auto |
| `ADMIN_PORT` | Porta local do painel — padrão `4500` | opcional (local) |

> ⚠️ As variáveis sensíveis (`GEMINI_API_KEY`, `WHATSAPP_TOKEN`, senhas) ficam **só no `.env`** (local, no `.gitignore`) e nas **Variables** do Railway — **nunca** vão pro Git.

## Como rodar (local)
```bash
# 1. Instale as dependências
npm install

# 2. Configure as variáveis
cp .env.example .env
#   edite o .env e preencha GEMINI_API_KEY, ADMIN_EMAIL/ADMIN_SENHA e (depois) as WHATSAPP_*

# 3. (opcional) Teste a triagem sem WhatsApp nem API
node test-triagem.js

# 4. Suba o servidor (painel + webhook)
npm start
```
- O painel abre em **http://localhost:4500** (faça login com ADMIN_EMAIL / ADMIN_SENHA).
- O bot só responde de verdade depois do **deploy + webhook** (precisa de URL pública). Localmente, dá pra editar tudo no painel e testar a triagem com `node test-triagem.js`.

## Configurar o WhatsApp Cloud API (passo a passo)
O guia detalhado com prints/etapas está em **MIGRACAO.md**. Em resumo:

**Na Meta (uma vez):**
1. Crie um app em **developers.facebook.com** usando o caso de uso **"Conectar-se com clientes pelo WhatsApp"** (isso já adiciona o produto WhatsApp).
2. Em **WhatsApp → Configuração da API**, pegue o **Phone Number ID** e gere um **token**
   (o temporário serve para testar; gere um **permanente** via *Usuário do sistema* para produção).
3. Adicione **seu celular** como destinatário de teste.

**No projeto (`.env`):**
```
WHATSAPP_TOKEN=<token>
WHATSAPP_PHONE_ID=<phone number id>
WHATSAPP_VERIFY_TOKEN=<uma senha que você inventa>
```

**Deploy + webhook:** o webhook precisa de uma **URL pública (HTTPS)**. Suba no Railway
(guia em **DEPLOY-RAILWAY.md**) e, na Meta, cadastre o webhook:
- **Callback URL:** `https://SUA-URL/webhook`
- **Verify token:** o mesmo `WHATSAPP_VERIFY_TOKEN`
- Assine o campo **`messages`**.

Por fim, **ligue o bot** no painel e mande uma mensagem para o número. 🎉

## Painel de administração
Faça login e edite tudo por formulários (clique em **Salvar tudo** — vale na hora):
- **Dashboard** — visão geral (métricas demonstrativas + status real da automação).
- **Dados do negócio** — nome, endereço, telefone, horários, pagamento e a **base de conhecimento da IA**.
- **Mensagens** — saudação e mensagem de atendente.
- **Menu de saudação** — opções numeradas + **sub-menus** por palavra-chave.
- **Respostas rápidas (FAQ)**.
- **Taxas e serviços** — entrega/táxi dog por **faixa de km** + endereço de partida da loja.
- **Catálogo** — produtos (nome, imagem, descrição, preço) com **grupos/subgrupos/especificações**.
- **Palavras-chave** (atendente, saudação).
- **Configurações gerais** — dados de acesso ao painel e troca de senha.

Em qualquer texto dá pra usar `{nome}`, `{telefone}`, `{endereco}`, `{pagamento}`, `{horarioSemana}` etc.

## Estrutura
```
data/
  config.json     → TODA a configuração (editada pelo painel)
src/
  config.js       → carrega/salva o config.json e monta as respostas
  triage.js       → triagem por palavra-chave, menu e sub-menus
  conversa.js     → lógica da conversa (handoff, timers) — independente do transporte
  ai.js           → respostas livres via Google Gemini (+ cálculo de taxa por endereço)
  geo.js          → geolocalização e distância de carro (OpenRouteService)
  wa.js           → cliente da WhatsApp Cloud API (envio de mensagens)
  admin.js        → servidor do painel + webhook do WhatsApp
  conta.js        → conta de acesso ao painel (e-mail + senha com hash)
  estado.js       → estado de runtime (conexão)
  index.js        → entrada: sobe painel + webhook (Cloud API)
  painel-only.js  → abre só o painel (npm run painel)
public/
  admin.html      → painel  ·  login.html → tela de login
test-triagem.js   → teste offline da triagem
MIGRACAO.md       → setup do WhatsApp Cloud API (passo a passo)
DEPLOY-RAILWAY.md → deploy no Railway + webhook
MULTICONTA.md     → plano de multi-conta/multi-bot (futuro)
```

## Observações
- **Custo do Gemini:** só perguntas livres chamam a IA — menu e palavras-chave são instantâneos e não
  consomem cota. O plano gratuito limita ~5 req/min; para produção, ative o faturamento (custo baixíssimo por mensagem).
- **Estado em memória:** handoff, contexto de menu e histórico vivem na RAM e somem ao reiniciar.
  No Railway o disco também é efêmero — para produção, use um **Volume** ou um **banco** (ver MULTICONTA.md).
- **Sem atribuição externa:** o código é próprio do projeto.
