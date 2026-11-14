# Como adicionar uma source nova (versão simples)

Uma **source** é um ficheiro `.js` que ensina o ScrollScape a ler **um** site de manga. Este guia dá-te o caminho curto.
Para os detalhes, os casos difíceis e o exemplo completo, vê [adicionar-source-completo.md](adicionar-source-completo.md).

## O que precisas antes de começar

- O site tem de funcionar **sem login** e **sem CAPTCHA**. Não contornamos CAPTCHAs nem proteções anti-bot.
- Se o site mostrar anúncios, **não o abras no navegador** para o estudar, e **nunca guardes uma página em disco** (`curl -o`): o antivírus
  põe-na em quarentena (JavaScript malicioso). Estuda-o em memória com `tools\node\node.exe tools\source-lab.js peek <endereço> --grep <regex>`
  (ou `--select <css>`), que só imprime um excerto de texto simples.
- Só importas código **que tu escreveste** ou que leste por inteiro. Uma source corre dentro do servidor, com todo o acesso
  ao teu computador, e não há sandbox.

## Os 6 passos

0. **Olha para o site primeiro:** `tools\node\node.exe tools\source-lab.js probe <endereço>`. Diz em segundos se há Cloudflare ou
   outro anti-bot a atrapalhar, CAPTCHA, login, anúncios ou um `robots.txt` que proíbe; se der `not-viable` ou `unreachable`, páras
   aqui. A skill `add-source` do Claude Code faz este passo e os seguintes sozinha a partir de um link.
0. **Vê se já existe** (`ls data/sources`, e um `grep -i <nome>` em `public/modules/ui-advanced-search.js`): se existe, é uma
   atualização, não uma source nova.
1. **Estuda o site com `source-lab peek` (em memória), e confirma cada caminho também com o `fetchText` da app** (o cliente Node pode ser desafiado
   pelo Cloudflare mesmo quando o `curl` recebe 200; se for assim e o site tiver anúncios, o site não é viável: para e relata). Descobre 6 coisas: o endereço da **pesquisa**, como funcionam as **páginas** (paginação),
   a página de **detalhes** de um título, a **lista de capítulos**, as **imagens** de um capítulo e se o site tem
   **filtros** (estado, tipo, géneros). Confirma cada filtro pedindo dois valores diferentes e comparando as listas.
2. **Copia uma source parecida** de `data/sources/` (por exemplo `mangafreak.js` ou `manganato.js`) e muda o endereço
   (`BASE`) e os seletores. Uma source exporta `meta` e quatro funções obrigatórias: `search`, `mangaDetails`, `chapters`,
   `pages`.
3. **Testa-a ao vivo, fora da app**, chamando cada função contra o site real (o guia completo tem o script).
4. **Declara o que a app precisa de saber** num bloco `ui` dentro de `meta`, como um literal simples: que filtros são reais
   (`filters`), a lista de géneros do site (`genres`), se todos os títulos são adultos (`adultOnly`), se as datas dos capítulos
   são reais (`nativeDates`) e que *hosts* de imagens exigem um `Referer` (`imageReferers`). Não é preciso editar mais nenhum
   ficheiro nem subir nenhum `?v=`; o que não declarares fica genérico (e o *Check* avisa).
5. **Instala-a.** Põe o `.js` em `data/sources/` (aparece quando a app pede o estado), ou usa
   **Definições → Sources → Import a source** (verifica o ficheiro antes de o instalar). Nesse cartão podes também **colar o
   endereço do site** («Adicionar a partir de um link»): a app vê se o site deixa, escreve a source sozinha (sem IA) para os sites
   Madara e MangaThemesia, e mostra-ta para verificares e instalares. Por cima desse bloco está o **Catálogo de sources**: lista os
   sites de um repositório público compatível com o Mihon (inglês por defeito, com pesquisa e filtros), diz de cada um se a app o
   consegue escrever sozinha, e escolher um faz o mesmo que colar o link. Se o site mudar mais tarde, o mesmo bloco lista as que escreveu com um botão **Regenerar**: escreve-a de novo e tu confirmas a substituição. Depois de instalada, carrega em
   **Test** na mesma ferramenta: corre no site real a lista de verificação (lista, pesquisa, detalhes, capítulos, imagens, erros,
   categorias proibidas) e diz o que falhou; só fica «Verified» se tudo passar.
6. **Decide a edição.** Uma source nova fica só na edição **completa** até decidires o contrário. Para entrar no exe
   geral (SFW), o id tem de estar em `build-assets/light-sources.json`. Nomes e código de sites adultos nunca vão para a `main`.

## As armadilhas mais comuns

- Um título que **não existe** pode responder `200` com a página inicial: confirma que a página tem o que esperas e lança
  um erro claro se não tiver.
- A **paginação** que o site mostra nos links pode não funcionar. Testa `?page=2` e confirma que a primeira linha mudou.
- As datas dos capítulos têm de ser **reais** (`publishAt` em ISO) ou `null`. Nunca uses a data de hoje.
- Os capítulos têm de vir do **mais novo para o mais antigo**.
- Texto da sinopse pode vir com entidades HTML duplas (`&amp;quot;`): descodifica-o (um segundo `.text()` do cheerio).
- `fetchText(url)` repete um 404 três vezes e lança um erro sem `statusCode`: para um título inexistente usa `fetchText(url, 0)` e põe tu o 404.
- Um site pode ter **desafio do Cloudflare só em alguns caminhos**, servido com `200`: confirma o `<title>` de cada pedido, não só da home. Também podem ter mudado de domínio: segue os redirects um a um.
- Validar o id do capítulo com `/^[\w\-./]+$/` deixa passar `../../etc/passwd`: usa o `CHAPTER_ID_RE` do modelo do guia completo.
- Há categorias que nunca se listam (menores sexualizados) e podem estar escondidas do menu do site: o guia completo diz como as procurar e excluir.
- Listas de capítulos vindas de uma API costumam ser **paginadas**: confirma a contagem num título com centenas.

## Está pronto quando

- `search`, `mangaDetails`, `chapters` (com datas) e `pages` funcionam no site real, incluindo o caso de erro.
- Cada filtro que declaraste mexe mesmo nos resultados (e os que não funcionam estão a `false`).
- O *Check* mostra «Como a app a vai usar» sem avisos nem erros, e a app arranca sem erros na consola.
- O botão **Test** da ferramenta dá «Verified» (sem falhas) no site real.
- A source passa o lint a sério: `tools\node\node.exe node_modules\eslint\bin\eslint.js --no-ignore data/sources/<id>.js`
  (o `npm run lint` não olha para `data/`).
- Atualizaste a documentação no mesmo commit (README, e o GUIDELINES se criaste uma regra).
