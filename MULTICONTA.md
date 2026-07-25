# Plano: Multi-conta / Multi-bot (multi-tenant)

Registro do que falta para o seletor de contas do topo (perfis conectados,
"Adicionar conta", logout com escolha de conta) funcionar de verdade — quando
um cliente tiver **mais de um bot**, ou quando a plataforma atender **vários clientes**.

## Situação atual (conta única)
- Um único login: `src/conta.js` lê/grava `data/conta.json` (e-mail + senha com hash).
- Uma única configuração de bot: `data/config.json`.
- Sessões em memória em `src/admin.js` (`sessoes`: token → expiração).
- O front (`public/admin.html`) **já tem** a interface pronta:
  - botão com a seta no topo (`.conta-wrap`),
  - dropdown "Perfis conectados" + "Adicionar conta" + "Logout",
  - modal "Sair de qual conta?" (aparece quando há 2+ contas).
  Hoje a lista mostra só 1 perfil (o atual) e "Adicionar conta" só avisa "em breve".

## O que precisa mudar no backend

### 1. Modelo de dados
- **Vários bots/perfis**, cada um com sua configuração própria. Duas opções:
  - Arquivos: `data/bots/<botId>/config.json` (simples, sem banco), **ou**
  - Banco (SQLite/Postgres) com tabela `bots` — recomendado quando passar de uns poucos.
- **Contas/usuários** (quem faz login): tabela `contas` (id, nome, e-mail, senhaHash).
- **Vínculo** conta ↔ bots: uma conta pode ter acesso a 1+ bots (tabela `conta_bots`).

### 2. Autenticação com várias contas logadas
- Hoje o cookie `sid` aponta para 1 sessão. Para "Adicionar conta":
  - Permitir **várias sessões simultâneas** no mesmo navegador (ex.: cookie guarda uma
    lista de `sid`s, ou um `sid` "guarda-chuva" que referencia várias contas logadas).
  - "Adicionar conta" = abrir o login, autenticar a 2ª conta e **manter as duas** ativas.
  - Guardar qual é a conta/bot **ativo** no momento (para o painel saber o que editar).

### 3. Endpoints novos (o front já está pronto para consumir)
- `GET  /api/contas` → lista de perfis conectados `[{ id, nome, sub, ativo }]`.
- `POST /api/contas/trocar` `{ id }` → troca o bot/conta ativo do painel.
- `POST /api/contas/adicionar` → fluxo de login de uma conta adicional.
- `POST /api/logout` `{ id }` → sai de **uma** conta específica (o modal já manda o id).
- Todas as rotas de config/catálogo/etc. passam a ser **escopadas pelo bot ativo**.

### 4. Ajustes no front (pequenos, a UI já existe)
- `montarContas()` passa a popular a lista a partir de `GET /api/contas` (em vez do mock).
- `adicionarConta()` chama o fluxo real (em vez do alerta "em breve").
- `confirmarLogout(i)` já manda sair da conta `i` — ligar ao `POST /api/logout {id}`.
- Clicar num perfil da lista → `POST /api/contas/trocar` e recarregar os dados.

## Ligação com a plataforma (Gestalize Bots)
Este é o passo que transforma o projeto de "um bot do Lecoland" em **plataforma**
que vende vários bots. Faz sentido fazer **junto com**:
- a migração para o **WhatsApp Cloud API** (cada bot = um número/identidade própria),
- um **banco de dados** (sair dos arquivos JSON),
- e o **deploy no Railway** com domínio.

## Ordem sugerida
1. Banco de dados (substitui `config.json`/`conta.json` por tabelas).
2. Escopar tudo por `botId` (config, catálogo, menus, métricas).
3. Auth multi-sessão + endpoints `/api/contas/*`.
4. Ligar a UI já pronta (lista, adicionar, trocar, logout por conta).
