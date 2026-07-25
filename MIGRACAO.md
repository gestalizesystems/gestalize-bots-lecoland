# WhatsApp Cloud API — setup (passo a passo)

O bot usa a **WhatsApp Cloud API** oficial da Meta. Já está **implementado**:
`npm start` sobe o servidor (painel + webhook). Falta só **configurar a Meta** e preencher
as variáveis. O envio sai por `src/wa.js`; o recebimento entra pelo `POST /webhook` (em `src/admin.js`).

---

## 1. Criar o app na Meta
1. Acesse **developers.facebook.com** → **Criar app**.
2. Em **"Casos de uso"**, escolha **"Conectar-se com clientes pelo WhatsApp"** (isso já adiciona o produto WhatsApp e cria o app do tipo *Empresa*).
3. Selecione/crie um **portfólio empresarial (Meta Business)** e finalize.

## 2. Pegar as credenciais
No app → **WhatsApp → Configuração da API** (Etapa 1 / Quickstart):
- **Phone Number ID** → vira `WHATSAPP_PHONE_ID`.
- **Token de acesso**: o **temporário (24h)** serve para testar; para produção, gere um
  **permanente** (Business Settings → **Usuários do sistema** → criar usuário com acesso ao
  app/WhatsApp → **Gerar token** sem expiração, com as permissões `whatsapp_business_messaging`
  e `whatsapp_business_management`). → vira `WHATSAPP_TOKEN`.
- Adicione **seu celular** como destinatário de teste.

## 3. Preencher o `.env`
```
WHATSAPP_PHONE_ID=<phone number id>
WHATSAPP_TOKEN=<token>
WHATSAPP_VERIFY_TOKEN=<uma senha que você inventa>
```
> Confira que o token está válido sem enviar mensagem:
> `curl -s "https://graph.facebook.com/v21.0/<PHONE_ID>?fields=display_phone_number" -H "Authorization: Bearer <TOKEN>"`

## 4. Deploy + webhook (precisa de URL pública HTTPS)
O webhook só funciona numa URL pública — não dá pra usar `localhost`. Suba no Railway
(ver **DEPLOY-RAILWAY.md**) e, na Meta → **WhatsApp → Configuração → Webhook**:
- **Callback URL:** `https://SUA-URL/webhook`
- **Token de verificação:** o mesmo `WHATSAPP_VERIFY_TOKEN`
- **Verificar e salvar** → depois, em **Campos do webhook**, **assine `messages`**.

## 5. Ligar e testar
1. No painel, **ligue o bot** (interruptor no rodapé do menu).
2. Do seu celular (já adicionado como destinatário), mande **"oi"** para o número → o bot responde. 🎉

---

## Como funciona (arquitetura)
- **Receber:** a Meta faz um `POST` no seu `/webhook` a cada mensagem. O servidor responde `200`
  na hora e processa em seguida (`conversa.processar`).
- **Enviar:** o bot faz um `POST` para `https://graph.facebook.com/v21.0/<PHONE_ID>/messages`
  com o token no cabeçalho (`src/wa.js`).
- A lógica do bot (triagem, menus, IA, handoff) fica em `triage.js` / `ai.js` / `conversa.js` e
  **independe do transporte** — por isso o mesmo código serve para o Cloud API e para o modo QR.

## Regras importantes da Cloud API
- ⏰ **Janela de 24h:** você só envia mensagens de **texto livre** até 24h após a última mensagem
  do cliente. Como o bot **responde a quem escreveu**, normalmente está dentro da janela. (Por isso
  o reengajamento do bot não tenta voltar depois de 24h.)
- 📝 **Templates:** mensagens **proativas** (iniciadas por você) ou fora da janela de 24h precisam
  de **templates aprovados** pela Meta.
- 💰 **Custo:** é pago por conversa (conversas **iniciadas pelo cliente** costumam ter isenção/volume
  gratuito; as iniciadas por você/templates são as principais cobradas). Confira os valores atuais na Meta.
- 🏢 **Verificação do negócio:** pode ser exigida para sair do número de teste e aumentar os limites.

## Hardening opcional (depois)
- Validar a assinatura `X-Hub-Signature-256` do webhook com o **App Secret**, para recusar
  requisições falsas.
