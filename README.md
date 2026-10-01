# Meu Ponto

**Seu horário, sua prova.** Registro pessoal de ponto: um comprovante seu, independente do sistema da empresa.

## O que faz

- **Login com Google:** só o e-mail autorizado acessa. Sem login, nenhuma tela do app aparece.
- **Dados na nuvem** (Firebase): sincroniza entre celular e computador e funciona sem internet, enviando tudo quando a conexão volta.
- **Horário de trabalho:** entrada, saída, intervalo, tolerância de atraso e dias da semana trabalhados.
- **Bater ponto:** um botão grava entrada ou saída no instante do clique, com segundos.
- **Registro manual:** data e hora de entrada e de saída em campos separados.
- **Faltas, atestados e folgas/feriados** por data, com observação.
- **Relatório mensal:** horas trabalhadas, horas extras ou devidas, **dias com atraso**, faltas e atestados. Pode ser impresso, salvo em PDF ou exportado em CSV.
- **Comprovação:** cada registro informa se foi gravado *no momento* ou *manualmente*, quando isso aconteceu e se foi editado.
- **Backup:** exporta e restaura tudo em um arquivo `.json`.

## Como a segurança funciona

O GitHub Pages só hospeda arquivos estáticos, então **o código do site é público**. Por isso a proteção não está no código, e sim no **Firebase**:

| Camada | O que faz |
|---|---|
| Firebase Authentication | Confirma a identidade com a conta Google. Não há senha guardada no app. |
| Regras do Firestore | Rodam nos servidores do Google e só deixam ler e gravar **o e-mail autorizado**. Quem não é esse e-mail recebe "sem permissão", mesmo que leia o código. |
| `auth.js` | Esconde as telas até o login ser confirmado. É conveniência visual; a segurança real são as regras. |

O e-mail autorizado **não aparece no código nem no repositório**: ele fica apenas nas regras, no Console do Firebase.

## Arquivos que NÃO vão para o GitHub

| Arquivo | Por quê | Onde fica |
|---|---|---|
| `firebase-config.js` | Configuração do seu projeto Firebase | Local (para testes) e no secret `FIREBASE_CONFIG` do GitHub |
| `firestore.rules` | Contém o e-mail autorizado | Local e colado no Console do Firebase |
| `*.json`, `*.csv`, `*.pdf` | Backups e relatórios com seus dados | Fora da pasta do projeto |

No repositório ficam apenas os modelos `firebase-config.example.js` e `firestore.rules.example`.

> A configuração do Firebase (`apiKey` etc.) não é uma senha: o Google a trata como identificador público, e o navegador precisa dela para funcionar. Ela fica fora do repositório por organização; quem protege os dados são as regras do Firestore.

## Configuração (uma única vez)

### 1. Criar o projeto no Firebase

1. Acesse <https://console.firebase.google.com> e clique em **Adicionar projeto**. O nome pode ser `meu-ponto`, e o Google Analytics não é necessário.
2. **Authentication** → *Vamos começar* → **Sign-in method** → **Google** → Ativar → Salvar.
3. **Authentication → Settings → Authorized domains** → *Add domain* → `SEU_USUARIO.github.io`. O `localhost` já vem autorizado.
4. **Firestore Database** → *Criar banco de dados* → escolha a região `southamerica-east1` (São Paulo) → *Iniciar no modo de produção*.
5. **Firestore Database → Regras:** apague o conteúdo, cole o conteúdo do arquivo local `firestore.rules` e clique em **Publicar**.
6. Menu lateral **Configurações → Geral** → role até o final, em **Seus apps** → ícone **`</>`** (Web) → dê um apelido e clique em *Registrar app* (não marque Hosting) → copie o objeto `firebaseConfig` (o conteúdo entre `{ }`).

### 2. Testar no computador

1. Copie `firebase-config.example.js` para `firebase-config.js` e cole os valores do passo 1.6.
2. Rode um servidor local. O app **não funciona abrindo o `index.html` com dois cliques**, porque o login precisa de um endereço `http://`.
   ```bash
   cd ~/Documentos/meuponto
   python3 -m http.server 8000
   ```
3. Acesse <http://localhost:8000> e entre com a sua conta Google.

### 3. Publicar no GitHub Pages

1. Crie o repositório no GitHub (ex.: `meuponto`) e envie o código:
   ```bash
   git init
   git add .
   git status          # confira: firebase-config.js e firestore.rules NÃO podem aparecer
   git commit -m "Meu Ponto"
   git branch -M main
   git remote add origin https://github.com/SEU_USUARIO/meuponto.git
   git push -u origin main
   ```
2. No repositório: **Settings → Secrets and variables → Actions → New repository secret**
   - Nome: `FIREBASE_CONFIG`
   - Valor: o objeto copiado no passo 1.6, **só o que está entre as chaves, incluindo as chaves**:
     ```
     {
       apiKey: "...",
       authDomain: "...",
       projectId: "...",
       storageBucket: "...",
       messagingSenderId: "...",
       appId: "..."
     }
     ```
3. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. Vá em **Actions** e rode o workflow **"Publicar no GitHub Pages"** (ou faça um novo push). Em cerca de 1 minuto o app estará em `https://SEU_USUARIO.github.io/meuponto/`.

A cada `git push` na `main`, o site é publicado de novo automaticamente.

## Regras de cálculo

| Situação | Como conta |
|---|---|
| Atraso | Primeira entrada do dia útil depois de `entrada + tolerância`. Conta o atraso inteiro. |
| Intervalo | Se o dia tem **um único** par entrada/saída com mais de 6h, o intervalo configurado é descontado. |
| Hora extra | Trabalhado − jornada prevista. Em dia não útil, tudo conta como extra. |
| Falta | Gera débito da jornada do dia. |
| Atestado / folga | O dia fica abonado e não gera débito. |
| Sem registro | Dia útil passado sem ponto nem ocorrência. Aparece em destaque, mas não entra no saldo. |

## Observações

- **Primeiro login:** se havia registros salvos no navegador pela versão anterior (sem login), eles são enviados automaticamente para a nuvem.
- **Sair** apaga a cópia offline do aparelho. Use isso em computadores compartilhados.
- O horário vem do relógio do aparelho. O registro serve como controle pessoal e apoio, mas não é um sistema de ponto certificado.
- O plano gratuito do Firebase (Spark) atende com folga o uso pessoal.

## Estrutura

```
index.html                 telas (login + app)
style.css                  visual (claro/escuro, celular, impressão)
app.js                     regras, cálculos e interface
auth.js                    login Google e sincronização com o Firestore
firebase-config.example.js modelo da configuração do Firebase
firestore.rules.example    modelo das regras de segurança
.github/workflows/         publicação automática no GitHub Pages
```
