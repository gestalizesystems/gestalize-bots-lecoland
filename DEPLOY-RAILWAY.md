# Deploy no Railway + Webhook do WhatsApp

Guia para colocar o bot no ar (servidor público 24h) e ligar o webhook da Meta.
Com o Cloud API **não há Chromium**, então o Railway roda liso.

## Pré-requisitos
- Repositório no GitHub (✅ `nathashaloppes/Lecoland`).
- Credenciais do WhatsApp (Phone Number ID + token) e a chave do Gemini.

## 1. Criar o projeto no Railway
1. Acesse **railway.app** e faça login **com o GitHub**.
2. **New Project → Deploy from GitHub repo →** selecione **Lecoland**.
3. O Railway detecta Node e roda `npm start` (que sobe o painel + webhook). Não precisa configurar build.

## 2. Variáveis de ambiente (Settings → Variables)
Adicione (os valores estão no seu `.env` local — **não** copie o `.env` pro Git):
```
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
ADMIN_EMAIL=...
ADMIN_SENHA=...
ORS_API_KEY=...
WHATSAPP_TOKEN=...          (token; troque pelo PERMANENTE antes de produção)
WHATSAPP_PHONE_ID=...
WHATSAPP_VERIFY_TOKEN=...   (o mesmo que está no seu .env)
```
> Não defina `ADMIN_PORT` — o Railway injeta `PORT` automaticamente.

## 3. Gerar a URL pública
- Em **Settings → Networking → Generate Domain**. Vai sair algo como
  `https://lecoland-production.up.railway.app` (já com HTTPS).
- Teste abrindo `https://SUA-URL/login` — deve aparecer a tela de login.

## 4. Configurar o Webhook na Meta
Na Meta (app) → **WhatsApp → Configuração** (ou *Configuration*) → **Webhook → Editar**:
- **URL de callback:** `https://SUA-URL/webhook`
- **Token de verificação:** o mesmo `WHATSAPP_VERIFY_TOKEN`
- Clique em **Verificar e salvar**.
- Em **Campos do webhook**, clique em **Gerenciar** e **assine `messages`**.

## 5. Testar de verdade
1. Na Meta (Etapa 1) → adicione **seu celular** como destinatário de teste (recebe um código).
2. No painel (`https://SUA-URL`), **ligue o bot** (interruptor do rodapé).
3. Do seu celular, mande **"oi"** para o número de teste → o bot responde o menu. 🎉
   (Como você mandou primeiro, a janela de 24h abre e o bot pode responder texto livre.)

## ⚠️ Persistência (importante para produção)
O disco do Railway é **efêmero**: a cada novo deploy, alterações feitas pelo painel
(`data/config.json`, imagens em `public/uploads/`) e a conta (`data/conta.json`) **se perdem**.
- Para testar, tudo bem (o `config.json` versionado já vai junto).
- Para produção, adicione um **Volume** do Railway montado em `/app/data` (e idealmente
  `/app/public/uploads`), ou migre para um **banco de dados**. (Ver MULTICONTA.md.)

## 🔁 Token permanente (antes de produção)
O token de teste expira em ~24h. Gere um **permanente**:
Business Settings → **Usuários do sistema** → criar um, dar acesso ao app/WhatsApp,
**Gerar token** (sem expiração) com as permissões `whatsapp_business_messaging` e
`whatsapp_business_management`. Troque o `WHATSAPP_TOKEN` no Railway.
