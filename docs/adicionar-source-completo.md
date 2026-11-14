# Como adicionar uma source nova (guia completo)

Este documento serve duas pessoas: alguém que nunca viu o projeto, e uma **IA** que tem de acrescentar uma source sem
ajuda. Contém tudo o que é preciso: factos do projeto, o processo passo a passo, um modelo de código, as armadilhas que já
custaram horas e uma lista de verificação final. A versão curta está em [adicionar-source-simples.md](adicionar-source-simples.md).

Factos marcados com **(medido)** foram verificados ao vivo no site em causa, não deduzidos.

---

## 1. Regras que não se discutem

1. **Sem contornar proteções.** Nenhum CAPTCHA, desafio anti-bot ou login é contornado. Se o site os tem, a source declara-o
   (limite conhecido) ou não se faz. O `fetchText()` já usa o FlareSolverr *se o utilizador o tiver ligado*; uma source nunca
   o liga nem o descarrega.
2. **Código de terceiros: não.** Decisão do utilizador (2026-10-27): só código que ele ou tu escreveste e leste. Não se
   importam sources de outras apps (Mihon, Aniyomi, Suwayomi, Paperback…): não correm em Node.
3. **Nunca arrancar a app a sério sem proteção.** O `server.js` pode descarregar o FlareSolverr (~700 MB) e o antivírus
   marca-o. Para testar uma source, usa o script da secção 5 (corre só o módulo) e fixa
   `FLARESOLVERR_DISABLED=1 FLARESOLVERR_AUTO_INSTALL=0 FLARESOLVERR_EXE_PATH=<ficheiro que não existe>`.
4. **Sites com anúncios: nunca um navegador**, nem o FlareSolverr: renderizar anúncios dispara o antivírus.
   **E nunca guardes uma página de um site em disco** (`curl -o`, `> ficheiro.html`, descarregar uma «amostra»): um site de manga,
   sobretudo com anúncios ou protegido, pode servir JavaScript malicioso e o antivírus põe o ficheiro em quarentena no momento em que é
   gravado (aconteceu: um `curl -o` foi classificado `INFECTED_JS`). Estuda os sites **em memória** com `source-lab peek` (resumo,
   texto à volta de um padrão, valores de um seletor: só texto simples, pequeno, sem códigos de controlo, nada vai para disco) e com
   `source-lab probe`. Os testes usam HTML escrito à mão, nunca uma cópia de uma página real.
   **Só se estudam sites que o utilizador conhece** (o endereço que ele deu, ou os sites das sources que já usa): nunca se escolhem sites
   por uma pesquisa na web, porque os clones de scans são um sítio comum de *malvertising* e *phishing* (o antivírus bloqueou dois
   deles, `sushiscan.fr` e `snowscans.com`, quando uma ferramenta os pediu). Esses dois estão numa lista que o `probe` e o `peek` nunca
   contactam (nem por um redirecionamento); acrescenta um domínio por linha a `data/site-denylist.txt` quando um produto de
   segurança avisar.
5. **Edições.** `complete` = edição completa (inclui fontes adultas); `main` = edição geral (SFW). Nomes e código de fontes
   **dedicadas a conteúdo adulto** ficam só na `complete`. Uma fonte geral cujo catálogo tem etiquetas adultas fica só na
   `complete` até o utilizador decidir. A linha do utilizador: "ecchi sim, o que passar disso não".
6. **Conteúdo que nunca se lista.** Se um site tem categorias sobre menores sexualizados, a source exclui-as em todas as
   consultas (se o site o permitir, enviando-as como "excluir"), recusa-as e não as oferece no seletor de géneros.
7. **Documentação no mesmo commit** (GUIDELINES, regra 33). Não há "docs depois".

## 2. O que é uma source e onde vive

- Um ficheiro CommonJS `data/sources/<id>.js` (ou `data/sources/<id>/<id>.js` se precisar de ficheiros de apoio).
- **O ficheiro não está no git** (`data/sources/` é ignorado): é um *plug-in local*. O que *está* no git são as tabelas por
  id (só para as sources do repositório) e a lista `build-assets/light-sources.json` do exe geral; uma source importada declara-se a si própria em `meta.ui` (secção 6).
- É carregado com `require()` **dentro do processo do servidor, sem sandbox**. Tem o mesmo acesso que a própria app.
- Descobre-se sozinha: a app varre `data/sources/` no arranque e em cada pedido de estado (`GET /api/state`). Não é preciso
  reiniciar. Um ficheiro que falha ao carregar não é registado e é re-executado (com aviso na consola) a cada varredura:
  por isso valida-o antes (secção 5) ou instala-o pela ferramenta de importação (secção 7).
- **O `id`** é o nome do ficheiro sem `.js`, só letras, dígitos, `_` e `-` (até 80), e tem de ser igual a `meta.id`.
  Reservados: `local`, `anilist`, `unknown`, nomes de dispositivos do Windows (`con`, `nul`, `com1`…) e nomes que todos os
  objetos já têm (`constructor`, `__proto__`…).

## 3. O contrato (exato)

```js
exports.meta = {
  id: 'meu-site',            // igual ao nome do ficheiro
  name: 'Meu Site',          // mostrado na app (obrigatório)
  version: '1.0.0',
  author: 'scraper',
  supportsPopularAllTime: true,   // opcional, ver abaixo
};
```

As funções são chamadas com **argumentos posicionais** (não com um objeto):

| Função | Obrigatória | Argumentos | Devolve |
|---|---|---|---|
| `search` | sim | `(query, page = 1, orderBy = '', filters = {})` | `{ results: [Item], hasNextPage }` |
| `mangaDetails` | sim | `(mangaId)` | `{ id, title, cover, description, status, genres, author, url }` |
| `chapters` | sim | `(mangaId)` | `{ chapters: [Capítulo] }`, **do mais novo para o mais antigo** |
| `pages` | sim | `(chapterId)` | `{ pages: [{ index, img }] }` |
| `trending`, `latestUpdates`, `recentlyAdded`, `popularAllTime` | não | `()` | `{ results: [Item] }` |
| `byGenres` | não | `(genres, orderBy, filters, page)` | `{ results, hasNextPage }` |
| `authorSearch` | não | `(name)` | `{ results, hasNextPage }` |
| `favorites` | não | `(page)` | só para sites com conta |
| `healthCheck` | não | `()` | `{ ok }` ou `{ ok:false, temporarilyUnavailable?, error }`; usado só pelo System Health |
| `firstPage` | não | `(chapterId)` | como `pages`, só a 1.ª; só para o System Health |

- **Item** = `{ id, title, cover, url, genres: [], status, author }` (+ `format` quando o site o diz).
- **Capítulo** = `{ id, name, title, chapter, url, publishAt, pages: [] }`. `publishAt` é uma data ISO **real** ou `null`
  (GUIDELINES §10: nunca a data de hoje para "desconhecido"; procura bem no HTML antes de concluir que não existe).
- `status`: usa `normalizeStatus()` de `server/modules/common/manga-status.js` (`ongoing`, `completed`, `hiatus`, `cancelled`).
- Capas e imagens passam por `proxyImageUrl()` (`server/modules/common/image-proxy.js`): o browser nunca pede ao site.
- Uma função opcional **ausente** esconde a funcionalidade na interface (não há flag a pôr). Flags `supportsTrending`,
  `supportsRecentlyAdded`, `supportsLatestUpdates` (opt-out) e `supportsPopularAllTime` (opt-in, `=== true`) existem;
  `beta: true` esconde a source por defeito.
- Tempos: cada chamada tem 45 s (90 s para `pages`). Uma chamada lenta não pode bloquear: sem laços infinitos.
- O cliente **volta a filtrar** cada resposta (`ui-advanced-search.js`, `_applyAdvFilters`): género = *qualquer* dos
  selecionados presente em `item.genres` (minúsculas, igualdade exata); estado e formato comparados após normalizar.
  Por isso, quando o servidor já filtrou por X, **etiqueta os resultados com X** (`status`, `format`, `genres`), senão o
  cliente rejeita tudo.
- Ajudantes úteis: `fetchText(url, retries = 2, opts = {})` (`server/modules/network/fetch-utils.js`: valida o endereço contra
  SSRF, limita o ritmo, e só cai no FlareSolverr se o utilizador o tiver ligado e houver um desafio), `proxyImageUrl`,
  `normalizeStatus`, `cheerio` (já é dependência). Comportamento que surpreende:
  - **Repete tudo**, também um 404 verdadeiro: 3 tentativas com pausas de 1,5 s e 3 s, e depois lança um `Error('HTTP 404')`
    **sem `statusCode`**. Para um pedido em que 404 é uma resposta normal (título que não existe), usa `fetchText(url, 0)` e
    põe tu o `statusCode = 404` no erro (modelo na secção 5). Só um 429 não é repetido (marca o host como bloqueado).
  - **Só o 403/503/429 contam como desafio.** **Qualquer 403 sai como «protegido pelo Cloudflare»** (a mensagem manda ligar o FlareSolverr), mesmo quando o corpo é um JSON
    do próprio site («Missing token»): vê o estado, o tipo e o corpo antes de concluir (secção 5). Uma página de desafio do Cloudflare servida com **200** só é apanhada se o texto
    parecer um desafio; um site pode desafiar só alguns caminhos (secção 4.1). Confirma sempre o `<title>` ou o bloco
    esperado antes de ler a página, em vez de assumir que "200 = HTML do site".
  - O 3.º argumento aceita `extraHeaders` e cookies; com `extraHeaders` o FlareSolverr nunca é usado.
  - **Só GET.** Não há POST em `fetchText`. Para uma **API JSON ou GraphQL** que aceite GET (`?query=…`), usa `fetchText` e
    `JSON.parse`; `fetchJson` existe no mesmo ficheiro, mas **não passa pelo arnês** da secção 5 (sem cache nem contagem): se o
    usares, troca-o também no arnês. O transporte do arnês (`realFetchText`) é substituível.
  - **`.exec(` dá falso positivo.** A análise estática marca `child-process` em qualquer `.exec(` (inclusive `RE.exec(s)`): usa
    `.match` ou `.test`, senão o relatório do *Check* mostra um risco que não existe.
  - **Em `catch`, `throw new Error(msg, { cause: err })`**: o lint (regra `preserve-caught-error`) recusa o erro sem `cause`.
  - Os hosts da API e do CDN do mesmo site (`api.…`, `thumb.…`) aparecem no relatório do *Check*; é normal.
- **Valores que o cliente envia** (`orderBy` e `filters`, vindos do `<select>` de `public/index.html`, ~linha 907):
  - `orderBy`: `relevance` (por defeito), `latestUploadedChapter`, `title`, `-title`, `rating`, `followedCount`, `createdAt`,
    `year`, `-year`. A source recebe-os tal e qual e traduz para o que o site tem; o resto ignora-se (e a entrada de
    `meta.ui.filters.orderBy` diz quais o site tem, secção 6).
  - `filters`: `{ publicationStatus, contentRating, format }`, sempre strings. Vazio = "qualquer". Valores:
    `ongoing|completed|hiatus|cancelled`; `safe|suggestive|erotica`; `manga|manhwa|manhua|doujinshi|oneshot|european-manga|
    american-manga|hongkong-manga|other-manga`. Um filtro declarado `false` em `ADV_SOURCE_CAPABILITIES` não é enviado na
    pesquisa de "todas as fontes" (chega vazio, e `orderBy` chega `relevance`) e o seu controlo fica escondido na de uma só
    fonte. Não dependas disso: a source **ignora** um filtro que declarou `false`, não "esvazia" os resultados por causa dele
    (`return empty()` só quando o filtro é pedido, declarado `true`, e o site não o consegue satisfazer).
  - `byGenres(genres, …)`: `genres` é um array de nomes (os de `meta.ui.genres`, secção 6). O cliente só exige que **pelo menos um** dos
    géneros pedidos esteja em `item.genres`, por isso tanto a união como a interseção passam. Escolhe uma, diz qual nos
    comentários, e etiqueta os itens com os géneros pedidos.
- **Tamanho de página.** A interface mostra **50** itens por pedido (`ADV_PAGE_SIZE` em `ui-advanced-search.js`) e volta a
  pedir a página seguinte da source até os ter. Uma página nativa de 20 ou 24 itens funciona (o cliente junta páginas); se o
  site pagina de forma desalinhada, `server/modules/common/paginate-stitch.js` (`fetchStitchedPage`) junta páginas nativas em
  páginas da app (exemplos: `allmanga.js`, `weebcentral.js`). `hasNextPage` tem de ser verdadeiro enquanto o site tiver mais.
- **O que mais o cliente faz a cada resposta** (`_applyAdvFilters`, por esta ordem): Hide NSFW (`isNsfwManga`, pelos `genres`
  do item), a lista negra de géneros do utilizador, **o texto da pesquisa tem de estar no título** (minúsculas, `includes`),
  género, estado, classificação e formato. Consequência: resultados de pesquisa cujo título não contém o texto pedido
  (sinónimos, título alternativo) são apagados no cliente; e um item sem `genres` nunca é apanhado por Hide NSFW nem pela
  lista negra. Onde a listagem não traz géneros, isso é um limite a dizer ao utilizador (secção 4.10).
  Dois pormenores: (a) com géneros escolhidos o cliente chama `byGenres` **sem** o texto da pesquisa (só o caminho sem
  géneros usa `search` com texto); (b) `isNsfwManga` e a classificação respeitam um campo `contentRating` no item, por isso uma
  source cujo site rotula cada título (Safe/Suggestive/Erotica) pode declarar `contentRating: true` e etiquetar os itens.
  Valores aceites: `safe`, `suggestive`, `erotica`, `pornographic` (minúsculas); sem campo, a app infere-o dos géneros
  (`hentai`, `smut`, `mature`, `adult`, `ecchi` dão `erotica`). Um marcador do próprio site nos cartões de lista
  (p. ex. atributos `data-nsfw`, `data-yaoi` nas capas) é um bom sítio de onde tirar `contentRating` e géneros quando as
  listagens não trazem géneros; confirma que cobre todos os adultos e que não marca os apenas sugestivos.
  O `fetchText` lança um `Error` simples (sem `statusCode`) em qualquer falha que não seja o `HTTP 404` que tu convertes.

## 4. Investigar o site (a parte que dá mais trabalho)

Faz tudo **em memória**: `source-lab peek <url> --grep <regex>` ou `--select <css> [--attr <nome>]` (ver a regra 1.4: nada de `curl -o`
nem de guardar páginas), e usa `cheerio` num script em
`scratchpad/` (nunca em `data/`). Responde, por escrito, a:

-2. **Olha para o site antes de tudo (`source-lab probe`).** `tools\node\node.exe tools\source-lab.js probe <url>` faz meia dúzia
   de pedidos simples (a home, o `robots.txt`, a pesquisa do próprio site e um título; quando a página não tem um formulário de pesquisa GET, a pesquisa é um palpite, `/?s=a`, e a saída marca-a «guessed»: a pesquisa verdadeira é a que descobriste a estudar o site) e diz, em segundos, o que está à frente do
   conteúdo: Cloudflare e outros serviços anti-bot (e se deixam passar o pedido ou o desafiam), CAPTCHA interativo, login, uma
   página vazia preenchida por JavaScript, redes de anúncios, o que o `robots.txt` proíbe e se o domínio redireciona. Não
   contorna nada: **observa**. O veredicto é `open`, `needs-solver` (só funciona com o FlareSolverr ligado), `not-viable` (CAPTCHA,
   login, `robots.txt`, desafio num site com anúncios, página de bloqueio) ou `unreachable`; os três últimos param o trabalho
   antes de se escrever uma linha. Cada caminho que a source vai usar confirma-se depois com `--path "/pesquisa?q=a"`, porque o
   `robots.txt` pode proibir um e deixar outro. O caminho **de onde vêm os dados** (a API) confirma-se com `--data "/api/x"`: é pedido uma vez, porque um site pode abrir as páginas a um pedido simples e guardar os dados atrás de uma proteção própria (o `probe` só às páginas diria `open`; com `--data` diz `not-viable`). O `--app-fetch` pergunta também ao `fetchText` da app (só usa o FlareSolverr se já
   estiver ligado). A skill `add-source` (`.claude/skills/add-source`) segue exatamente esta ordem.
   **Como ler o relatório do `probe`.** Cada linha tem um id, uma gravidade (`block` decide *not-viable*; `warn` é o que tens de ter em
   conta ao escrever; `info` é o que se viu) e uma frase. Os ids:

   | id | o que quer dizer | o que fazes |
   |---|---|---|
   | `challenge-js` | um desafio de JavaScript está à frente do conteúdo (algumas páginas ou todas) | só funciona com o FlareSolverr ligado: pergunta ao utilizador; confirma cada caminho |
   | `challenge-interactive`, `challenge-blocked` | CAPTCHA / Turnstile, ou a proteção recusou o pedido | *not-viable*: pára |
   | `challenge-with-ads` | desafio num site com redes de anúncios | *not-viable* (regra 1.4) |
   | `login-wall` | as páginas pedem login | *not-viable* |
   | `data-protected` | as páginas abrem, mas o caminho dos dados (`--data`) é recusado (403, página de bloqueio) ou desafiado | recusado: *not-viable* (a proteção é do site para a sua própria página; a app não a imita); só desafiado com JavaScript: *needs-solver* |
   | `data-open`, `data-unclear` | o caminho dos dados respondeu a um pedido simples / respondeu 4xx (pode precisar de parâmetros ou de um cabeçalho) | `data-unclear`: confirma à mão |
   | `robots-disallow-all`, `robots-disallows-home/path` | o `robots.txt` proíbe o site, a home ou um caminho que dizes que a source vai usar | *not-viable*; `--path` confirma cada caminho |
   | `robots-disallows-search` | o `robots.txt` proíbe a pesquisa por texto (muito comum: o WordPress proíbe `/?s=` por defeito) | *aviso*: a source pode listar, navegar e ler, mas não pesquisar por texto: diz ao utilizador antes de a escrever |
   | `robots-disallows-api`, `robots-search-like` | proíbe `/api/` ou algo que parece a pesquisa | não dependas desse caminho |
   | `spa-shell` | a página vem vazia e um *bundle* preenche-a: os títulos vêm de uma API JSON | procura a API (e confirma o `robots.txt` dela) |
   | `chapter-images-ajax` | o HTML do capítulo só tem marcadores «loading»; a página pede as imagens a um endpoint | a source faz esse pedido, não lê o HTML |
   | `chapter-images-mixed` | os capítulos tentados são servidos de formas diferentes | testa o mais antigo, um do meio e o mais novo |
   | `chapter-images-script` / `-inline` | as imagens estão num script (`ts_reader.run`, uma lista JSON) / no HTML (em `src` ou num atributo preguiçoso) | lê-as daí |
   | `chapter-images-unconfirmed` | não se achou nenhuma imagem no capítulo tentado (htmx, Alpine, JS que monta o pedido) | descobre à mão os pedidos que o leitor faz |
   | `chapter-list-ajax` | a página do título não tem as ligações dos capítulos: a lista vem de um pedido (Madara: `manga_get_chapters`) | faz esse pedido |
   | `images-referer-required` | o servidor de imagens recusa pedidos sem o Referer do site | declara-o em `meta.ui` `imageReferers` |
   | `images-foreign-blocked`, `images-open`, `images-blocked` | recusa um Referer estrangeiro mas aceita nenhum / serve sem Referer / recusa tudo | informação; `blocked`: a leitura pode precisar de algo que o probe não envia |
   | `engine` | o motor do site (Madara, Mangastream, NetTruyen, MangaBox, htmx, Next.js, Nuxt, WordPress) e a confiança | usa-o para saber onde procurar a pesquisa, as listas e as imagens |
   | `ads` | o site carrega redes de anúncios | nunca um navegador; só pedidos simples |
   | `domain-changed` | o endereço redireciona | usa o domínio final como base |

   **Calibração (2026-10-28, em memória, contra sites de sources que já funcionam na app).** `needs-solver`: BatCave, ComicHubFree,
   MangaHub, e um site de leitura com um desafio gerido (`robots.txt` a proibir `/api/`). Imagens que exigem Referer: MangaPill, Manganato, FanFox. Imagens num script: VortexScans. Motor reconhecido:
   KingOfShojo (Mangastream), ManhuaPlus (NetTruyen), FlameComics e outro site (Next.js), WeebCentral (htmx), Manganato (MangaBox).
   Páginas vazias preenchidas por JavaScript (`spa-shell`): MangaDex e outro site feito com Vite. Abertos sem mais nada: MangaKatana, AsuraScans
   (leitor sem contentor conhecido, achado pelo maior grupo de imagens numa pasta), DemonicScans, Comizy e um site cujo `robots.txt`
   proíbe `/search?`. **Segunda ronda (sites escolhidos na EverythingMoe, secções «manga» e «manhwa», só scanlators e sem críticas negativas; cada um
   sondado só com o `probe`, um de cada vez).** Dois sites Madara: a lista de capítulos não está no HTML e o probe pede-a como o
   script do tema (`POST <título>/ajax/chapters/`, sem corpo), as imagens estão em `data-src` e o servidor de imagens não pede Referer
   (um deles carrega redes de anúncios). Um site Mangastream e dois sites com tema próprio: imagens no HTML, sem Referer. Dois
   sites tinham o `robots.txt` a proibir a pesquisa por texto (o WordPress faz isso por defeito) e um deles mudou de domínio e é Next.js:
   a pesquisa por texto proibida passou a ser só um aviso (a source lista, navega e lê, mas não pesquisa por texto).
   **Limites**: a pesquisa que o probe adivinha (`/?s=a`) é só um palpite; um leitor montado por uma expressão de JavaScript
   (WeebCentral) fica «não confirmado».

   **Gerar sem IA: `source-lab generate <url>`.** Para os motores que têm modelo (**Madara** e **MangaThemesia / Mangastream**), a
   ferramenta escreve a source sozinha, sem nenhum modelo de linguagem: sonda o site (passo acima), confirma que o **modelo serve** ao
   site (procura, nas mesmas páginas que a source vai ler, os marcadores de que o modelo não pode prescindir: o título de uma página de
   título, os cartões da lista, a lista de capítulos; um tema personalizado mantém os *scripts* do motor e muda o HTML, e então não gera
   nada e diz o que falta), preenche o modelo só com o que mediu (nome, géneros, se o `robots.txt` deixa pesquisar por texto, o que se
   vê no site) e corre o *Check* e o Test ao vivo sobre o ficheiro. Cada valor é validado e entra como literal JSON (um site hostil não
   consegue pôr código no ficheiro) e **não instala nada**: o resultado é um ficheiro que lês e instalas com `install`. Os modelos estão em
   `server/modules/source-import/generator/*.template.txt` (texto de uma source real, com marcadores `__X__`). Ensaiado a 2026-10-28 em três
   sites: um Madara e um Mangastream deram **Verified** à primeira ou depois de aprender com a primeira passagem; um site Madara com
   tema personalizado foi **recusado** (era a resposta certa). O que cada site ensinou ao modelo: a lista do Madara pode ter só um botão
   «load more» e `/page/N/` funciona na mesma, e uma página para lá do fim é 404 (é uma lista vazia); um `robots.txt` que proíbe a
   pesquisa por texto leva a procurar num índice dos títulos da lista (lido uma vez e guardado meia hora); uma data que é só um dia não é
   um lote de importação; um capítulo que o site guarda para subscritores (*lock plugin*) é um 403 que o diz, e o Test passa ao capítulo
   seguinte (até três) em vez de dar a source por estragada. **Limites**: só estes dois motores têm modelo; os outros (e os temas
   personalizados) continuam a ser escritos à mão ou com a skill `add-source`; o género só se filtra um de cada vez; as datas nunca são
   declaradas como nativas. A mesma função (`generator/from-link.js`) corre na app: em **Definições → Sources → Import a source** o bloco
   «Adicionar a partir de um link» pede o endereço, devolve o texto da source, põe-no na caixa do cartão e corre o *Check* dele (a rota
   `POST /api/sources/import/link` é só da máquina anfitriã e não instala nada). Funciona numa instalação nova do exe: os modelos vão
   dentro do pacote (`pkg.assets`) e não há IA em nenhum passo. Um site que a pessoa pôs em `data/site-denylist.txt` nunca é
   consultado. **O que a source gerada faz por si**: os títulos de um género que a app nunca lista (os géneros que a regra 1.6 do
   projeto proíbe) são lidos das páginas desse género do próprio site e **tirados de todas as listas, da pesquisa e dos detalhes** (se
   uma dessas páginas não se consegue ler, a source recusa listar em vez de listar sem a exclusão); um site que se apresenta como
   adulto (no nome ou na descrição, ou com uma verificação de idade) fica declarado `adultOnly`. **Limite que a pessoa vê**: quando o
   `robots.txt` proíbe a pesquisa por texto, pesquisa-se nas primeiras 15 páginas da lista (cerca de 300 títulos); um título mais
   abaixo encontra-se a navegar.

   **Regenerar.** Uma source gerada leva, no topo, uma linha `// scrollscape-generated engine=… base=… on=…` (`generator/origin.js`). A
   app lista as geradas no bloco do link com um botão **Regenerar** (para quando o site mudou o HTML, os géneros ou o `robots.txt`):
   `POST /api/sources/import/link` com `{ regenerate: <id> }` escreve-a de novo a partir do endereço **do ficheiro instalado** (nunca
   do pedido) e devolve o texto, que vai para a caixa e para o *Check* normal; o *Check* diz se difere da instalada (só a data a
   mudar conta como «igual») e a pessoa confirma a substituição pelo fluxo de sempre. Só conta como gerada uma source importada cujo
   ficheiro ainda é o que foi instalado (o *sha256* da *store*): um ficheiro editado à mão depois é da pessoa. As geradas antes desta
   linha existir não aparecem: gera-se outra vez uma vez.

   **Catálogo de sources.** Para encontrar o site em vez de o ter à mão: o bloco «Catálogo de sources» (por cima do do link) lê a lista de um
   repositório público de extensões compatível com o Mihon e mostra os sites (inglês por defeito). A app não corre essas extensões; usa a lista
   para descobrir sites, e para os de tema Madara ou MangaThemesia o botão **Adicionar** escreve a source pelo mesmo fluxo do link
   (`POST /api/sources/import/link` com `{ catalog: { key } }`; o endereço é o da lista, procurado no servidor). O tema de cada extensão sai do
   `build.gradle.kts` dela no GitHub (a lista não o traz); sem essa linha é um scraper próprio e a source tem de ser escrita à mão. Cada linha diz
   o que é (18+, misto, Cloudflare, já adicionada, sem modelo). Código: `server/modules/source-catalog/`, `server/routes/source-catalog.js`,
   `public/modules/ui-settings-source-catalog.js`.
   **Sites com scraper próprio: o motor de extensões.** Com um Suwayomi-Server teu definido em Definições → Suwayomi, essas linhas ganham
   «Adicionar via Suwayomi»: a app pede-lhe (depois de confirmares) que instale a extensão do catálogo, acha a source pelo id do repositório e escreve
   uma source `sw-<id>` de `server/modules/source-catalog/engine/suwayomi-source.template.txt`, que passa pelo *Check* como as outras
   (`POST /api/sources/engine/prepare`, `server/routes/source-engine.js`). A extensão corre no teu Suwayomi, não na app.

-1. **Já existe?** Antes de tudo: `ls data/sources` e um `grep -i <nome>` em `public/modules/ui-advanced-search.js`,
   `server/modules/calendar/service.js`, `build-assets/light-sources.json` e no README. Se já existe uma source (ou entradas
   do front-end) desse site, o trabalho é **atualizar**, não acrescentar: não dupliques entradas.
0. **Qual é o domínio de hoje?** Os sites de manga mudam de domínio e as marcas são copiadas. Parte do endereço que o utilizador
   deu, segue os redirects **um salto de cada vez** (`curl -sS -I <url>`, lê o `Location`, repete; há servidores que dão 403 a
   um HEAD e então a cadeia não diz nada: confirma com o `fetchText` e lê a lista de domínios espelho no JavaScript do
   próprio site) e regista a cadeia
   completa. Confirma que o domínio final é do mesmo site (mesmo nome, mesmo catálogo, mesmos títulos) e não um clone ou um
   domínio estacionado; se não tiveres certeza, pergunta ao utilizador. **(medido)** `mangakakalot.gg` → `kakamanga.com` (dois
   saltos). Usa como `BASE` o nome estável e deixa o redirect resolver, mas **diz o domínio final** na documentação da source.
1. **Alcançável sem desafio? Testa com o cliente da app, não só com `curl`.** O `curl` e o `fetchText` (Node) têm impressões
   digitais diferentes: **(medido)** no MangaHub o `curl` dava 200 em todo o lado e o `fetchText` apanhava um desafio
   gerido do Cloudflare (403, cabeçalho `cf-mitigated: challenge`, "Just a moment...") em todas as páginas e na API. Por isso
   o **primeiro** pedido de cada caminho faz-se com o `fetchText` (um `node -e` ou o arnês da secção 5), e só depois se
   investiga com `curl`. Se o `curl` passa e o `fetchText` é desafiado, o site **não é viável tal como está**: a source não
   pode chamar `curl` nem `child_process` para contornar (regra 1.1). A única via é o utilizador ligar o FlareSolverr, e a
   regra 1.4 proíbe-o em sites com anúncios; **site com anúncios + cliente da app desafiado = parar e relatar**, não
   entregar uma source que só funciona com FlareSolverr. Procura "Just a moment", "cf-chl", "captcha". **Faz-o
   caminho a caminho**, não só na home: um site pode desafiar apenas alguns caminhos (**(medido)** no Mangakakalot duas das
   rotas de listagem davam desafio e as restantes não). Para cada pedido que a source vai fazer, guarda a resposta e
   confirma que o `<title>` ou o bloco esperado está lá. Um caminho desafiado não se contorna (regra 1.1): procura outro
   caminho do mesmo site que dê os mesmos dados (uma API JSON, outra listagem) ou declara o limite.

   **Há uma segunda condição de paragem, que não dá 403 nenhum.** Se as imagens de um capítulo só se obtêm com uma *concessão*
   emitida por código do navegador (um `POST` com um cabeçalho do tipo `x-…-token`, um token calculado no cliente,
   verificações do navegador como pontuação de bot, impressão digital de áudio ou WASM, mensagens como "couldn't verify this
   browser"), isso é uma proteção de acesso (regra 1.1): **para e relata**; reproduzi-la não é contornar menos do que um
   CAPTCHA. **(medido)** Kagane: a home, as listas de capítulos e as capas respondem a GET, mas as páginas só vêm de
   `POST /api/v2/books/<id>?intent=Read` com um token de integridade, e a pesquisa é um `POST` (o `fetchText` é só GET).
   **Variante com GET:** uma API JSON que se pede por GET, em que alguns caminhos são abertos e os que interessam (pesquisa,
   ficha, capítulos, páginas) respondem `403` com um corpo JSON do género `{"message":"Missing token."}`. Isso é a barreira
   do próprio site (não é um desafio do Cloudflare: não há `cf-mitigated`), e o token é calculado por código do navegador.
   **Testa a cadeia toda antes de investir** (pesquisa, ficha, capítulos, uma página de capítulo): é normal o resultado ser
   «partido» (**(medido)** MangaFire: `/api/filter-options` e `/api/top-titles` abertos, `/api/titles…` e `/api/chapters/…`
   com «Missing token»; ~15 pedidos chegaram para o saber). Sinais baratos de que há um token escondido: um *chunk* de nome
   inocente (`polyfill`) com dezenas ou centenas de KB e ofuscado; nomes como `DisableDevtool`, `AntiWebArchive`,
   `_CheckDomain`; um `window.__config` / `window.__build` opacos no `<head>`; um cliente HTTP sem interceptador visível,
   entregue a uma função importada. Não o descodifiques (seria reproduzir a proteção): para e relata. Para distinguir isto de
   um desafio do Cloudflare vê o estado, o tipo e o corpo da resposta (o *snippet* de diagnóstico da secção 5).
   **Páginas de uma SPA:** se `/`, `/xyz` e `/sitemap.xml` devolvem a mesma página do mesmo tamanho (todas com 200 e o mesmo
   `<title>`), o site é uma aplicação de uma só página: o `<title>` não confirma nada e «não há sitemap» aparece como a casca
   do site, não como 404. Vai direto ao JavaScript e à API.
   **Listagens desenhadas pelo navegador a partir de uma API de terceiros com chave pública** (um contentor vazio no HTML,
   `createClient`, `.supabase.co`, `sb.from(`, Firebase): a chave «publicável» que o site mete no seu JavaScript não é um token
   calculado no navegador, mas é uma credencial e a API está noutro *host* que o `robots.txt` do site não cobre. **Por defeito
   para e pergunta**: só se usa com autorização expressa do utilizador, que nomeia o *host* e o método (leituras `GET`), e fica
   no cabeçalho da source. Sem ela, entrega-se o que o HTML do servidor dá e declara-se o limite (**(medido)** um site de galerias:
   a pesquisa por texto e o feed de novidades só existem por essa API; sem ela a pesquisa só acerta em nomes de artista,
   círculo, paródia ou personagem).
   **Parar é um resultado normal**, não uma falha: uma source que só pesquisa e lista capítulos, mas não entrega as páginas,
   não é uma entrega; diz-se ao utilizador com as provas por caminho. **Lê também o `/robots.txt`**: se o caminho de dados
   de que precisas está em `Disallow` (o Kagane proíbe todo o `/api/`), diz-o ao utilizador antes de avançar; a decisão de
   usar esse caminho é dele. **O caso típico é a lista de capítulos:** a página do título mostra só os N mais recentes e
   um «Show all 263 chapters · loading all…» que carrega o resto por `fetch("/api/…")` (**(medido)** WebtoonClub: 40 de
   263 na página; o resto só por `/api/comics/<id>/chapters`, proibido pelo `robots.txt`). Nada no HTML avisa; vê-se lendo o
   *chunk* do cliente (`fetch(` e `/api/`) e comparando o caminho com o `robots.txt` **antes** de escrever código. Se a lista
   completa só vem por um caminho proibido, há um terceiro desfecho além de «entregue» e «não viável»: **fonte parcial**.
   **Excepção autorizada:** a autorização tem de vir **nas palavras do próprio utilizador** (uma mensagem de um agente a
   retransmiti-la não conta), cobre **um caminho e um método nomeados** (tudo o resto sob `/api/` continua proibido) e fica
   registada no cabeçalho da source com a data. Mesmo assim, o sistema de permissões do Claude Code pode bloquear o pedido
   («Website Access Circumvention»): se acontecer, **para**, não contornes (nada de `curl`, outra ferramenta ou outro URL) e
   pede ao utilizador que o aprove ali. Só com a autorização expressa do utilizador, e declarando no cabeçalho da source e ao utilizador exatamente o que falha
   (p. ex. «`chapters()` falha em títulos com mais de ~40 capítulos»), com um erro claro em vez de uma lista cortada em
   silêncio; sem essa autorização, para.
2. **Redirecionamentos.** O domínio muda (`mangafreak.me` → `ww3.mangafreak.me`)? Usa o nome estável e deixa o redirect
   resolver (preserva caminho e query) **(medido)**. Verifica que o redirect também preserva a query nos teus pedidos reais.
3. **Pesquisa.** Endereço, parâmetros, itens por página, ordenação. *Atenção:* lê o JavaScript do site (`/misc/search.js`)
   para ver como a caixa de pesquisa monta o endereço.
4. **Paginação. Testa-a de verdade.** Pede a página 1 e a 2 e compara a 1.ª linha. **(medido)** No MangaFreak
   `/Find/love?page=2` devolve a página 1 outra vez; só `/Find?search=love&page=2` pagina. O que o site põe nos links
   do paginador pode estar errado. Pede também uma página para lá do fim: devolve a última outra vez? Então uma página
   além do fim é "sem resultados", não uma repetição. **(medido)** Num site de galerias, `?page=99999` devolvia a última página
   com 200; o sinal fiável é o **número ativo do paginador** (a lista de itens não se pode comparar entre páginas quando a
   última se repete), e uma categoria de uma só página nem tem paginador: «sem número ativo» e `page > 1` também é «fim».
   Antes de dares um controlo por inexistente (p. ex. «não há ordenação no servidor»), lista **todas** as ligações e
   formulários da página de listagem, não só o bloco dos cartões (um site de galerias tinha uma barra `?sort=week|month|all`).
5. **Detalhes.** Título, capa, sinopse, estado, autor, géneros. Um título inexistente **(medido)** pode responder 200 com a
   página inicial: deteta pela falta do bloco esperado e lança erro com `statusCode = 404`.
6. **Capítulos.** Onde está a lista (na própria página de detalhes, num JSON, noutro pedido), em que ordem, se há datas.
   **(medido)** A tabela vinha do mais antigo para o mais novo: inverte. **Se for uma API, vê se é paginada**: pede a lista de
   um título com centenas de capítulos e confirma que a contagem bate com a do site. `manganato.js` pára nos primeiros 50;
   o Mangakakalot aceitava `limit=400` mas dava 403 do Cloudflare com `limit=1000`. Pagina até ao fim (com um teto e um
   `break` quando a página vem vazia), e uma falha a meio da lista **lança erro**, não devolve uma lista cortada em silêncio.
   **Datas:** procura bem. Uma data que o site mostra como "há 3 dias" vê-se no HTML; uma data só do JSON pode ser a da
   importação em massa (dezenas de capítulos com a mesma hora): se várias dezenas partilham a mesma hora, não é a data de
   publicação, usa `null` (modelo `cleanPublishDates` abaixo, secção 5). É esperado que, num título com mais de mil
   capítulos, a maioria dos antigos fique `null` (**(medido)** 813 de 1221 no One Piece): o calendário só precisa dos mais
   novos. A regra é por hora; um carimbo só com o dia (sem hora) comporta-se de outra maneira (4 capítulos no mesmo dia = `null`).
7. **Imagens de um capítulo.** Estão todas no HTML? **(medido)** No MangaHub a página do capítulo mostra "1/6" e 6 `<img>`,
   mas o capítulo tem 20: o CDN serve `7.png` … `20.png`. Confirma pedindo `n+1`, `n+5` e um índice alto ao CDN, ou compara
   com a contagem da API do site (o JavaScript do site diz qual é: `apiUrl`, as consultas, a chave da fonte). São
   carregadas por JavaScript (então há uma API)? **Antes de ler *chunks*, procura dados estruturados no HTML:** blocos
   `application/ld+json` (`ImageGallery`, `associatedMedia`, `Article`) trazem muitas vezes os URLs das imagens **em tamanho
   completo**, a contagem, as etiquetas e a data. Miniaturas e imagens completas podem ter *hashes* diferentes (não se deriva
   uma da outra), e a grelha e o JSON-LD podem parar nas 1000 entradas com a contagem declarada maior: compara as três
   (dados estruturados, miniaturas, número declarado) e, se não batem, lança erro em vez de cortar em silêncio.
   **Sites Next.js e parecidos:** o HTML é uma casca, os dados vêm de uma API,
   o id da API (um UUID) pode ser diferente do que vem no URL (`slug-uuid`), e o leitor pede as páginas por um pedido à parte.
   Lê os *chunks* de JavaScript antes de assumir que o HTML tem os dados, mas só os do leitor e da pesquisa: procura
   `/api/`, `fetch(` e `headers:` (um site pode ter 50 *chunks*; gastar 50 pedidos é desperdício). Um **sitemap** (`/sitemap.xml`)
   é uma boa fonte de ids de títulos e de URLs de capas, mas pode ter dezenas de MB: pede um só. **Num site Next.js com
   *App Router* os dados estão dentro do próprio HTML**, em `self.__next_f.push([1,"…"])` (imagens do capítulo, lista de
   capítulos com datas, contagens): descodifica-os antes de procurar uma API (secção 5, «Sites Next.js»). Cuidado com o
   número que o site mostra ao lado de um capítulo («140p»): pode não ser a contagem de imagens (**(medido)** no WebtoonClub
   um capítulo com «140p» tinha 16 imagens, e outro com «45p» tinha 91); fia-te nas imagens e em `n+1`, `n+5`, índice alto.
   E o HTML só desenha um `<img src>` para as primeiras páginas (o resto são `div` preenchidos por JavaScript): ler só as
   `<img>` daria 5 de 16. Há proteção contra
   hotlink: pede uma imagem com e sem `Referer` e compara. Se precisar de Referer, é `meta.ui.imageReferers` (secção 6) ou, se a regra for mais complexa, `inferRefererForUrl` em `fetch-utils.js`.
8. **Listagens:** o que serve para `trending`, `latestUpdates`, `popularAllTime`, `recentlyAdded`.
9. **Filtros (regra do GUIDELINES §10 — obrigatória).** Para cada filtro (ordenação, estado, formato, géneros, classificação
   de conteúdo): pede **dois valores diferentes** e compara as **listas**, não os endereços. Valores diferentes com a
   mesma lista = filtro decorativo: marca-o `false`. **(medido)** No MangaFreak o estado partiu 290 páginas em 104 + 187 e o
   tipo em 57 + 233: filtros verdadeiros. Os géneros tinham **dois sistemas que não concordam** (a pesquisa avançada chama
   "Act" a Action, "Ancients" a Historical, e "Sci Fi" e "Slice Of Life" não têm títulos; as páginas de género têm todos).
   Mede cada género pelos dois caminhos e usa uma tabela que diz o que pedir a cada sítio. Testa também **dois géneros
   juntos**: um site pode devolver a união com o mesmo título repetido uma vez por género (**(medido)** no MangaHub);
   confere os ids duplicados, não só a contagem, e deduplica ou pede só o primeiro género e filtra os restantes pelas etiquetas.
10. **Conteúdo.** **Dimensiona primeiro a exclusão:** a página pública de etiquetas dá a contagem de cada categoria que nunca se
    lista; divide pela dimensão da página. **(medido)** Num site de galerias são cerca de 23 % do catálogo (≈18 800 obras), as
    listagens não trazem etiquetas, e o conjunto de ids da camada 4 custaria ≈750 pedidos (inviável): o padrão que serviu é
    **verificar cada cartão** pela página da própria obra (cache de 10 min, concorrência limitada, descartar o que não se
    lê, lançar erro se **tudo** falhar, nunca devolver «sem resultados» em silêncio). Reconhece também o título e as palavras-
    -chave, não só as etiquetas, e inclui `toddler` além de `loli`/`shota`; o regex do modelo apanha o início de cada
    palavra (`oppai loli`, `low shotacon`). Lista as categorias do site. Há categorias adultas? Há alguma que nunca deve ser listada (secção 1.6)?
    **Procura as escondidas**: o menu de géneros de um site pode não mostrar categorias que existem (**(medido)** o
    Mangakakalot tem `/genre/loli`, `/genre/lolicon` e `/genre/shota` que o menu não mostra; o MangaFreak tinha-as só na
    pesquisa avançada). Tenta `/genre/<nome>` e variantes (`loli`, `lolicon`, `shota`, `shotacon`), olha para as etiquetas de
    uns títulos conhecidos, e vê o JavaScript do site (a lista completa de géneros costuma estar na API ou no *bundle*).
    Atenção: um `/genre/<nome>` que não existe pode responder **200 com uma lista vazia**, não 404 (e no mesmo site a forma
    `/webtoons?genre=<nome>` pode comportar-se de outra maneira: **(medido)** no WebtoonClub a primeira dá 404 e a segunda dá
    200 vazio); testa as duas formas de URL. Distingue «não existe» de «existe e está escondida» pela lista de géneros da API ou
    por uma página de género que traga títulos. **Lê todas as taxonomias que o site expõe**, não só os «géneros»: numa API a lista pode estar partida em duas (**(medido)** MangaFire:
    `genres` sem categorias proibidas e uma lista à parte, `themes`, com `Loli` e `Shota`). **O primeiro passo mais barato é ler a página pública de géneros** (`/genres`,
    com a contagem de cada um) e comparar os nomes com os prefixos: no WebtoonClub a categoria não estava escondida, estava
    lá com contagem 1. Depois aplica as camadas da secção 10 (exclusão por camadas; também
    está no modelo da secção 5). Os itens da pesquisa trazem os géneros? Se trouxerem, o filtro "Hide NSFW" da app
    funciona a partir deles; **as listagens sem géneros** (home, últimos, ranking, pesquisa em alguns sites) **não permitem esse
    filtro**: o `isNsfwManga` do cliente só olha para `item.genres`. Diz isso no comentário da entrada de capacidades
    (secção 6, no comentário ao lado de `meta.ui`) e ao utilizador.
11. **Tamanho e ritmo.** Páginas enormes (a de detalhes do MangaFreak com 1200 capítulos tem 650 KB)? Usa uma cache curta
    (60 s, poucos itens) para `mangaDetails` + `chapters` não pedirem a mesma página duas vezes. **Orçamento de pedidos:**
    o `fetchText` já espaça os pedidos ao mesmo host, mas tu também: durante o desenvolvimento guarda em disco cada resposta
    (a chave é o endereço) e repete os testes a partir dessa cache; um site que te marca como abusivo (429, 403) deixa de
    servir-te. O arnês da secção 5 faz isso.

## 5. Escrever e testar

**Atalho com os comandos do projeto.** `source-lab check <ficheiro>` faz o que o *Check* da ferramenta de importação faz (lê o
texto sem o correr) e acrescenta o contrato do módulo carregado; `source-lab test <ficheiro|id> [--full]` corre no site real a
mesma lista de verificação do botão *Test* (secção 7) sobre um ficheiro onde ele está, sem o instalar; `source-lab install
<ficheiro>` põe-no em `data/sources/` (nunca substitui um ficheiro que já lá esteja e não toca no `data/store.json`, que uma app a correr
voltaria a escrever) e deixa ao lado um marcador `<id>.js.import.json` com o sha256 do ficheiro: na próxima leitura do estado a app lista a
source como **importada** (com *Test* e *Uninstall* no cartão), e o marcador só conta enquanto o ficheiro for o mesmo (um ficheiro editado
a mão volta a ser uma source local). `source-lab mark <id>` põe o marcador num ficheiro teu que já lá esteja. O script
abaixo continua a servir para investigar função a função.

**Modelo** (copia, troca `BASE` e os seletores; o MangaFreak, `data/sources/mangafreak.js`, é um exemplo real completo):

```js
'use strict';
const cheerio = require('cheerio');
const { fetchText } = require('../../server/modules/network/fetch-utils');
const { normalizeStatus } = require('../../server/modules/common/manga-status');
const { proxyImageUrl: proxyImg } = require('../../server/modules/common/image-proxy');

const BASE = 'https://exemplo.invalid'; // o nome estável do site
// Categorias que nunca se listam (secção 1.6). Reconhecidas pelo início de cada palavra, para apanhar uma renomeação e os
// nomes com várias palavras ("oppai loli", "low shotacon"). Apanha também "gothic lolita": é o preço de falhar fechado.
const NEVER_LISTED_RE = /(^|[^a-z])(loli|shota|toddler)/i;
// Id de capítulo: segmentos de caminho simples. Recusa `..`, `/` à cabeça, espaços e tudo o que não é caminho.
const CHAPTER_ID_RE = /^(?!\/)(?!.*\.\.)[\w\-./]+$/;

function httpError(message, statusCode) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

// Um pedido onde 404 é uma resposta normal (título inexistente): sem repetições (secção 3) e com `statusCode`.
// Confirma também que a resposta é mesmo do site (um desafio do Cloudflare pode chegar com 200).
async function fetchPage(url) {
  let html;
  try {
    html = await fetchText(url, 0);
  } catch (err) {
    if (/^HTTP 404$/.test(err.message)) throw httpError('não encontrado', 404);
    throw err;
  }
  if (/<title>\s*Just a moment/i.test(html)) throw new Error('o site pediu uma verificação anti-bot (limite conhecido)');
  return html;
}

function extractMangaId(href = '') {
  const m = String(href).match(/\/manga\/([^/?#]+)/); // ajusta ao site
  return m ? decodeURIComponent(m[1]) : '';
}

function parseCards($) {
  const results = [];
  $('.item').each((_, el) => { // ajusta o seletor
    const a = $(el).find('a[href*="/manga/"]').first();
    const id = extractMangaId(a.attr('href'));
    if (!id) return;
    const genres = $(el).find('.genres a').map((_i, g) => $(g).text().trim()).get();
    if (genres.some((g) => NEVER_LISTED_RE.test(g))) return; // camada 3 da secção 10
    const cover = $(el).find('img').first().attr('src') || '';
    results.push({
      id,
      title: a.text().trim(),
      cover: cover ? proxyImg(cover.startsWith('http') ? cover : BASE + cover) : '',
      url: `${BASE}/manga/${id}`,
      genres, // vazio se a listagem não os dá (então Hide NSFW não a julga: secção 4.10)
      status: 'unknown',
      author: '',
    });
  });
  return results;
}

// Texto que o site escapou duas vezes ("&amp;quot;"): o primeiro `.text()` deixa "&quot;", o segundo dá `"`.
function plainText(html) {
  const once = cheerio.load(`<div>${html || ''}</div>`).text();
  return /&(?:#\d+|#x[\da-f]+|[a-z]+);/i.test(once) ? cheerio.load(`<div>${once}</div>`).text().trim() : once.trim();
}

// Datas dos capítulos vindas de uma API: se 4 ou mais capítulos partilham a mesma hora UTC, é a hora da importação em massa,
// não a da publicação: `null` (nunca uma data inventada). Usa-o quando o site só dá o carimbo de "guardado".
function cleanPublishDates(timestamps) {
  const perHour = new Map();
  const ms = timestamps.map((t) => Date.parse(t));
  ms.forEach((t) => { if (Number.isFinite(t)) perHour.set(Math.floor(t / 3600000), (perHour.get(Math.floor(t / 3600000)) || 0) + 1); });
  return ms.map((t) => (!Number.isFinite(t) || perHour.get(Math.floor(t / 3600000)) > 3 ? null : new Date(t).toISOString()));
}

module.exports = {
  meta: {
    id: 'meu-site', name: 'Meu Site', version: '1.0.0', author: 'scraper',
    // O que a app precisa de saber sobre o site (secção 6). Escreve-o como um literal simples. Estes `false` são o ponto de
    // partida honesto: só passam a `true` (ou a uma lista) o que medires com dois valores (secção 4.9).
    ui: {
      filters: { orderBy: false, publicationStatus: false, contentRating: false, format: false, genres: false },
    },
  },

  // `_orderBy` e `_filters` não são usados aqui (o lint recusa argumentos sem uso se não começarem por `_`). Num site com
  // filtros a sério, lê-os, traduz-os (secção 3) e etiqueta os resultados com o que filtraste.
  async search(query, page = 1, _orderBy = '', _filters = {}) {
    const $ = cheerio.load(await fetchPage(`${BASE}/search?q=${encodeURIComponent(query || '')}&page=${page}`));
    return { results: parseCards($), hasNextPage: $('a.next').length > 0 };
  },

  async mangaDetails(mangaId) {
    const $ = cheerio.load(await fetchPage(`${BASE}/manga/${encodeURIComponent(mangaId)}`));
    if (!$('h1').length) throw httpError(`"${mangaId}" não encontrado`, 404); // 200 com outra página (secção 4.5)
    const genres = $('.genres a').map((_, a) => $(a).text().trim()).get();
    if (genres.some((g) => NEVER_LISTED_RE.test(g))) throw httpError(`"${mangaId}" não encontrado`, 404); // camada 5
    return {
      id: mangaId,
      title: $('h1').first().text().trim(),
      cover: proxyImg($('.cover img').attr('src') || ''),
      description: plainText($('.summary').html()),
      status: normalizeStatus($('.status').text()),
      genres,
      author: $('.author').text().trim(),
      url: `${BASE}/manga/${mangaId}`,
    };
  },

  async chapters(mangaId) {
    const $ = cheerio.load(await fetchPage(`${BASE}/manga/${encodeURIComponent(mangaId)}`));
    const chapters = [];
    const rawDates = [];
    $('.chapter-list a').each((_, a) => {
      const href = $(a).attr('href') || '';
      chapters.push({
        id: href.replace(/^\//, ''),
        name: $(a).text().trim(),
        title: $(a).text().trim(),
        chapter: (href.match(/(\d+(?:\.\d+)?)$/) || [])[1] || '',
        url: BASE + href,
        publishAt: null, // preenchido abaixo
        pages: [],
      });
      rawDates.push($(a).closest('li').find('time').attr('datetime') || ''); // ajusta ao site: data ISO real ou nada
    });
    const dates = cleanPublishDates(rawDates); // null onde é hora de importação em massa; nunca new Date()
    chapters.forEach((c, i) => { c.publishAt = dates[i]; });
    return { chapters }; // do mais novo para o mais antigo: inverte se a lista vier ao contrário
  },

  async pages(chapterId) {
    if (!CHAPTER_ID_RE.test(String(chapterId || ''))) throw httpError('id de capítulo inválido', 400); // recusa ../../etc/passwd; 400, não 500 (que enche o registo de erros)
    const $ = cheerio.load(await fetchPage(`${BASE}/${chapterId}`));
    const pages = [];
    $('.reader img').each((i, img) => {
      const src = $(img).attr('src') || $(img).attr('data-src') || '';
      if (src) pages.push({ index: i, img: proxyImg(src) });
    });
    return { pages };
  },
};
```

**Teste ao vivo, fora da app.** O `.js` da source faz `require('../../server/...')`, por isso só resolve quando está dentro de
`data/sources/`. Para o testar a partir da tua pasta de trabalho (scratchpad) usa este arnês: carrega o ficheiro *tal como
está*, redireciona esses `require` para o repositório, conta e regista cada pedido à rede e, com `NS_CACHE=1`, guarda cada
resposta em disco para repetires os testes sem voltar a pedir ao site (orçamento de pedidos, secção 4.11).

```js
'use strict';
// arnes.js — uso: node arnes.js <ficheiro-da-source.js> ; depois chama os métodos num script teu que faça require('./arnes').
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const Module = require('module');

const REPO = process.env.SCROLLSCAPE_REPO; // caminho do repositório
const CACHE = path.join(__dirname, 'cache');
const fu = require(path.join(REPO, 'server/modules/network/fetch-utils'));
const realFetchText = fu.fetchText;
const stats = { wire: 0, cached: 0, failed: 0 };

fu.fetchText = async function (url, retries, opts) {
  // Falhas que não são "HTTP 4xx" (um desafio do Cloudflare, um bloqueio) não vão para a cache e repetem-se em todos os
  // pedidos: ao fim de 3 o arnês pára, em vez de martelar o site (medido: 47 pedidos desafiados numa só corrida).
  if (stats.failed >= 3) throw new Error('arnês: 3 falhas seguidas, abortado (ver pedidos.log)');
  const file = path.join(CACHE, createHash('sha1').update(url).digest('hex') + '.json');
  if (process.env.NS_CACHE === '1' && fs.existsSync(file)) {
    stats.cached++;
    const hit = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (hit.error) throw new Error(hit.error);
    return hit.body;
  }
  stats.wire++;
  fs.appendFileSync(path.join(__dirname, 'pedidos.log'), `${url}\n`);
  try {
    const body = await realFetchText(url, retries, opts);
    if (process.env.NS_CACHE === '1') { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ url, body })); }
    stats.failed = 0;
    return body;
  } catch (err) {
    if (!/^HTTP 404$/.test(err.message)) stats.failed++; // um 404 é uma resposta normal, não conta
    if (process.env.NS_CACHE === '1' && /^HTTP 4\d\d$/.test(err.message)) { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ url, error: err.message })); }
    throw err;
  }
};

function loadSource(file) {
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  const orig = m.require.bind(m);
  m.require = (id) => (id.startsWith('../../server/') ? require(path.join(REPO, id.slice(6))) : orig(id));
  m._compile(fs.readFileSync(file, 'utf8'), file);
  return m.exports;
}

module.exports = { loadSource, stats, fu };
```

Notas do arnês: (1) exporta `fu` (o módulo `fetch-utils`) para os teus testes usarem `fetchImageBuffer`,
`inferRefererForUrl` ou trocarem `fetchText` (p. ex. para provar que a source falha fechada). (2) Um 404 de um título
inexistente repete-se a partir da cache e **não** aparece em `stats.wire`: não significa que não houve pedido da primeira
vez. (3) `fetchImageBuffer` **não passa pelo arnês**: não conta nem espaça os pedidos de imagem. Conta-os tu (um capítulo
de 91 imagens demorou 43 s) e não peças centenas sem necessidade: verifica todas as de um capítulo curto e amostras dos
outros. Um embrulho de 6 linhas chega (conta, regista num `imagens.log` e espaça):
`const real = fu.fetchImageBuffer; fu.fetchImageBuffer = async (u, r) => { imgStats.n++; fs.appendFileSync('imagens.log', u + '\n'); await new Promise((r2) => setTimeout(r2, 300)); return real(u, r); };`.
(4) **Escreve estes ficheiros, e qualquer script de correção, com a ferramenta de edição, não com `heredoc` na shell**, sempre
que tenham um regex com barras invertidas: perdem-se em silêncio (`/[^.\s]/` vira `/[^.s]/`, `\u0000` vira um caractere de
controlo) e o `grep` passa a dizer «ficheiro binário». (5) Um `sitemap.xml` de dezenas de MB pode demorar minutos e só ter URLs
sem títulos: vê o tamanho (`curl -I`, `Content-Length`) antes de o pedir, e só o peças se o objetivo for recolher ids.

**Diagnóstico de uma resposta** (estado, tipo, `cf-mitigated`, tamanho e o início do corpo; o `fetchText` só lança «HTTP 403»).
Grava como `probe.js` junto do arnês e corre `node probe.js <url> [método]` com as mesmas variáveis; foi a ferramenta mais útil
do teste do MangaFire:

```js
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = process.env.SCROLLSCAPE_REPO;
const { safeFetch } = require(path.join(REPO, 'server/modules/network/safe-fetch'));
const fu = require(path.join(REPO, 'server/modules/network/fetch-utils'));

(async () => {
  const url = process.argv[2];
  fs.appendFileSync(path.join(__dirname, 'pedidos.log'), `PROBE ${url}\n`); // conta como pedido
  const res = await safeFetch(url, {
    method: process.argv[3] || 'GET',
    redirect: 'follow',
    headers: { 'User-Agent': fu.DEFAULT_USER_AGENT, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const body = await res.text();
  console.log(res.status, res.headers.get('content-type'), 'cf-mitigated=', res.headers.get('cf-mitigated'), 'len', body.length);
  console.log(body.slice(0, 400).replace(/\s+/g, ' '));
})();
```

**Imagens** (capas e páginas): o `fetchText` não serve para elas. O pedido equivalente ao do proxy de imagens da app é
`const buf = await fu.fetchImageBuffer(url, fu.inferRefererForUrl(url));` (ambos exportados de `fetch-utils.js`; lança
`HTTP <código>` se o CDN recusar). Usa-o para confirmar que cada imagem responde 200 e que não precisa de um Referer que
não existe na tabela. Para ver o **código de estado, o tipo e o tamanho** de uma resposta (o `fetchText` só lança
`HTTP 401` sem mais nada), faz um `HEAD`/`GET` por `safeFetch` (`server/modules/network/safe-fetch.js`) com os cabeçalhos da app.

Executa-o com o node do projeto (`tools/node/node.exe`), `NODE_PATH=<repo>/node_modules`, `SCROLLSCAPE_REPO=<repo>` e as três
variáveis do FlareSolverr da secção 1.3. O teu script chama cada método e imprime contagens, tempos e as primeiras linhas, e
ainda os **casos de erro** (título inexistente, id de capítulo inválido, incluindo `../../etc/passwd`). Antes de tocar na
rede, e **antes de investir tempo**, faz com o arnês **um** pedido de cada caminho (secção 4.1): se o `fetchText` for
desafiado, para aí. Corre as verificações **offline** que a ferramenta de importação também faz:
`checkSourceContract(mod, id)` (`server/modules/source-import/contract.js`) sobre o módulo carregado e
`analyzeSourceCode(texto)` (`static-report.js`) sobre o texto, para veres os hosts e os `require` que a ferramenta vai
mostrar. Verifica:
- `search('')` e `search('x')`, páginas 1, 2 e uma muito além do fim; **e pelo menos quatro textos diferentes** (uma palavra, duas
  palavras, um texto curto de 1 a 3 letras, um sem resultados): o mesmo endereço pode responder **noutro formato consoante o
  texto** (**(medido)** MangaKakalot: a página HTML de resultados para uns textos e uma lista JSON das primeiras 20 para
  outros, como «one» ou «one piece»; a source só lia HTML e devolvia 0 resultados nesses casos);
- cada filtro com dois valores (lista diferente) e `hasNextPage` coerente com o paginador do site;
- um título com muitos capítulos e um com poucos; um id com caracteres especiais (aspas, pontos, parênteses);
- que o `id` devolvido por uma lista é aceite por `mangaDetails`, e o de `chapters` por `pages`;
- datas reais; capítulos do mais novo para o mais antigo; nenhuma imagem com 404;
- que a **contagem de capítulos** de um título com centenas bate com a do site (listas paginadas, secção 4.6);
- que cada categoria que nunca se lista dá **0 resultados** em `byGenres`, não aparece em nenhuma listagem e dá 404 na página do
  título (secção 10, camadas); e que se a consulta que as descobre falhar, a source **falha fechada** (recusa listar) em vez de
  listar sem filtro.

### Sites de galerias (um título = uma galeria, sem capítulos)

Alguns sites não têm séries com capítulos, só galerias (um título, um conjunto de imagens). O contrato exige `chapters()`, por
isso uma galeria é **um título com exatamente um capítulo** (o padrão de uma source de galerias, que se vê lendo o código). Decide
isto, e escreve-o no cabeçalho da source: o `id` do título é o id da galeria; o capítulo único tem `chapter: '1'`, um nome
fixo (p. ex. «Read») e **o mesmo id** que a galeria; `pages(chapterId)` lê a página da galeria; `status` é `completed`;
`publishAt` é a data da galeria **ou `null`** (**(medido)** duas galerias vizinhas partilhavam o dia de importação:
a «data de envio» pode ser a de importação). `cleanPublishDates` não faz sentido com um só capítulo, e uma obra de um só
capítulo não deve entrar em `NATIVE_DATE_SOURCES` (o calendário precisa de um ritmo de capítulos).

### Sites Next.js (App Router): os dados estão no HTML

A página parece uma casca, mas o Next.js mete os dados dos componentes de servidor em `self.__next_f.push([1,"…"])`. Junta
essas cadeias e tens o texto (JSON misturado com referências) onde estão as imagens do capítulo, a lista de capítulos
com datas e as contagens, sem chamar nenhuma API. O agente que testou o WebtoonClub usou isto (foi validado numa página real):

```js
// Junta as cadeias de `self.__next_f.push([1,"…"])` de uma página Next.js e devolve o texto do fluxo.
function flight(html) {
  const out = [];
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  for (const m of String(html).matchAll(re)) {
    try { out.push(JSON.parse(m[1])); } catch (_) { /* cadeia truncada: ignora */ }
  }
  return out.join('');
}
module.exports = { flight };
```

Depois procura no texto o campo que queres (`initialChapters`, `chapterCount`, a lista de imagens) e extrai o objeto com um
leitor de parênteses **consciente de cadeias** (conta `{`/`[` fora das aspas e respeita `\"`). O primeiro elemento de uma lista
pode ser uma referência (`$3a:props:…:latest`) que se resolve para um objeto `"latest":{…}` vizinho. Usa `matchAll`, não
`.exec` (secção 3). E **escreve estes ficheiros com a ferramenta de edição, não com `heredoc` na shell**: as barras
invertidas dos regex perdem-se em silêncio e estragam o ficheiro.

## 6. Declarar o que a app precisa saber (`meta.ui`)

Instalar o ficheiro chega: **a source declara-se a si própria** num bloco opcional `meta.ui`, a app valida-o e usa-o sem que
ninguém edite uma tabela por id no front-end ou no servidor, e sem subir nenhum `?v=`. Tudo é opcional; o que não declarares
fica com o comportamento por omissão (que pode ser **decorativo**: filtros que não fazem nada neste site, a lista de géneros
genérica em vez da do site). O *Check* avisa quando falta.

```js
exports.meta = {
  id: 'meu-site', name: 'Meu Site', version: '1.0.0', author: 'scraper',
  ui: {
    filters: {
      // true = a app mostra o filtro; false = esconde-o (decorativo neste site). `orderBy` pode ser uma lista com os
      // valores que o site tem de verdade (vocabulário da secção 3) e, se quiseres, o rótulo a mostrar.
      orderBy: [{ value: 'relevance', label: 'Newest' }, { value: 'followedCount', label: 'Popular All Time' }],
      publicationStatus: false,
      contentRating: false,
      format: true,
      genres: true,
    },
    genres: ['Action', 'Comedy', 'Ecchi'],    // os nomes que byGenres() aceita; implica filters.genres
    nsfwGenres: ['Ecchi'],                    // quais deles a app trata como adultos (têm de estar em genres)
    adultOnly: true,                          // todos os títulos do site são conteúdo adulto
    nativeDates: true,                        // as datas dos capítulos são reais (calendário)
    imageReferers: [{ host: 'cdn.exemplo.com', referer: 'https://exemplo.com' }], // CDN que exige este Referer
  },
};
```

**Escreve a declaração como um literal simples** (objetos, listas, texto, números, `true`/`false`, comentários): o *Check*
**não corre o ficheiro**, por isso só consegue mostrar-ta e validá-la assim. Se for calculada (`[...OUTRA_LISTA]`, uma chamada
de função), o *Check* diz que só se lê depois de instalar; é validada outra vez nessa altura, na mesma.

**O que a app faz com cada campo**
- `filters`: sobrepõe-se à tabela antiga `ADV_SOURCE_CAPABILITIES` (que fica só para as sources que já lá têm entrada).
  `orderBy` em lista também define as opções de ordenação mostradas. Os nove valores do vocabulário da secção 3 têm rótulo
  por omissão; um valor próprio da source (uma source de galerias ordena por `favorites`) é uma palavra simples e tem de levar rótulo:
  `{ value: 'favorites', label: 'Popular' }`. No máximo 12 opções.
- `genres` / `nsfwGenres`: a grelha de géneros da Pesquisa avançada passa a ser esta (e entra na lista combinada de «todas as
  fontes»). Nomes simples (letras, números, pontuação normal, até 40 caracteres), no máximo 200, sem repetidos.
  **Nunca ofereças uma categoria que a source não lista** (regra 1.6): um nome que comece uma palavra por `loli`, `shota` ou
  `toddler` é um **erro** que impede a instalação.
- `adultOnly`: o Hide NSFW esconde a source toda. Só a pode tornar **mais** restritiva; a escolha manual da pessoa («Add to
  NSFW» / «Remove from NSFW») continua a mandar nos dois sentidos.
- `nativeDates`: o calendário usa as datas reais dos capítulos (substitui a entrada em `NATIVE_DATE_SOURCES`). Só se foram
  medidas (secção 4.6); uma obra de um só capítulo não faz sentido (sites de galerias).
- `imageReferers`: o proxy de imagens envia este `Referer` para esse *host* (`*.exemplo.com` cobre os subdomínios, não o
  domínio em si; um curinga sobre um sufixo público ou um CDN partilhado, como `*.co.uk` ou `*.cloudfront.net`, é recusado).
  **Só aceita uma origem `https` simples cujo *host* o código da source nomeie fora da própria declaração e fora dos
  comentários** (a declaração não pode «abonar-se» citando o endereço que pede), e nunca por cima de uma regra que a app já
  tenha. É um **endurecimento, não uma fronteira**: a regra vale para qualquer pedido de imagem a esse *host*, venha de que
  source vier, e o código da própria source já corre com acesso total. O *Check* mostra as regras para as veres antes de
  instalar. Antes de acrescentares uma, mede se o site a exige de verdade (secção 4.7).
- **O *Check* lê a declaração como o servidor a vai ler:** comentários e textos são ignorados, só conta uma propriedade do
  próprio `meta` (ou uma atribuição a `meta.ui`), e uma declaração feita **duas vezes** ou **calculada** aparece como «só se lê
  depois de instalar», nunca como «não declara nada». Um nome de género que se pareça com um proibido (acentos, letras
  parecidas, hífenes) também é erro.
- O que não é compreendido é **descartado com um aviso** (o *Check* e a instalação mostram-nos): campos desconhecidos, valores
  de tipo errado, rótulos com marcação.

**Ensaio da declaração antes de instalar** (sem rede): `readDeclaredUiLiteral(texto)` devolve `{ found, readable, value, range }` (o
valor está em `.value`) e `collectHostsOutsideDeclaration(texto)` devolve um `Set` de *hosts* em minúsculas:

```js
const text = require('fs').readFileSync('mangafire.js', 'utf8');
const ui = require(process.env.SCROLLSCAPE_REPO + '/server/modules/common/source-ui');
const { collectHostsOutsideDeclaration } = require(process.env.SCROLLSCAPE_REPO + '/server/modules/source-import/static-report');
const read = ui.readDeclaredUiLiteral(text);
console.log('declaration found:', read.found, 'readable:', read.readable, read.reason || '');
console.log(ui.sanitizeSourceUi(read.value, { knownHosts: collectHostsOutsideDeclaration(text) }).problems); // [] = nada a corrigir
```

Um site com **duas taxonomias** (géneros e temas, por exemplo) só tem uma lista em `meta.ui.genres`: junta-as, sem os nomes
que nunca se oferecem, e faz a `byGenres` perceber de qual vem cada nome.

**O *Check* mostra «Como a app a vai usar»**: os filtros reais e escondidos, as opções de ordenação, a lista de géneros, se é
só para adultos, se tem datas reais, e os problemas. Sem declaração mostra um aviso a dizer que os filtros e os géneros
ficam genéricos. Um erro (um género proibido) desativa o botão *Install*.

**Ainda é preciso fazer à mão** (não são declaráveis, e por isso o *Check* não as vê):
1. **Sources do repositório** (as que vêm no `.exe`): continuam com as tabelas antigas (`ADV_SOURCE_CAPABILITIES`,
   `PER_SOURCE_GENRES`, `CUSTOM_ORDER_BY_OPTIONS` em `ui-advanced-search.js`, o `?v=` de `index.html`); a declaração, se
   existir, ganha-lhes.
2. **Referer que a app já conhece** ou **uma regra de proxy mais complexa**: `inferRefererForUrl` em
   `server/modules/network/fetch-utils.js` (procura primeiro se já existe: `*.2xstorage.com` e `*.waitst.com` já têm a sua).
3. **Edição geral.** O exe SFW só leva os ids de `build-assets/light-sources.json` (validado por `tools/build-light.js`); o exe
   completo (`build:win`) leva todos os ficheiros de `data/sources/`. Por defeito uma source nova **não** entra na lista.
   Nomes e código de sources adultas ficam só na `complete`.
4. **Códigos de erro** próprios, só se a source tiver erros que a app deva registar: `server/modules/errors/error-codes.js`
   (próximo livre depois de `ERROR-021`).

## 7. Instalar

- **Copiar** o ficheiro para `data/sources/`: regista-se sozinho. Não há validação prévia.
- **Definições → Sources → Import a source** (ferramenta de importação): escolhes o ficheiro (ou colas o código), carregas
  em *Check* (lê e **não corre**; mostra id, tamanho, SHA-256, os `require`, os endereços citados e chamadas de risco), e em
  *Install* (corre uma vez, confere o contrato e só então põe o ficheiro em `data/sources/`; repõe tudo se algo falhar). Só
  responde a partir do próprio computador. Substituir uma source importada pede confirmação e guarda o `.bak`.
  Limite de 512 KB. Não funciona atrás do Docker (copia o ficheiro à mão).
- **Testar** (o botão *Test* de cada source importada, na mesma ferramenta): corre no **site real**, a teu pedido, a lista de
  verificação da secção 8: lista, página 2, uma página além do fim, pesquisa por texto, detalhes, capítulos (ordem e datas),
  páginas (que **não** sejam todas a mesma imagem nem um «loading»: um capítulo cujo HTML só tem marcadores e cujas imagens verdadeiras vêm de um
  pedido que a própria página faz falha aqui, mesmo que as imagens «carreguem») e **as imagens** (até 5: a primeira, a última, a do meio e mais duas, com as regras de `Referer` e o *fetch* de imagens
  da app, mas **sem os cookies de sessão do leitor**: uma CDN que os exija pode falhar aqui e funcionar ao ler; uma CDN que limita algumas com um 429 dá só um aviso), um título
  inexistente (404), ids com
  caminho (400), as categorias que nunca se listam (têm de dar 0) e os géneros que declaraste. *Test in full* mede também se a
  ordenação e os filtros que declaraste mudam mesmo a lista (os decorativos falham; uma ordenação que só muda a lista depois de
  escolheres um formato, porque o site não ordena entre categorias, é só um aviso) e as listas de trending, últimas e
  recentes. Tem um orçamento (45 chamadas à source, 5 imagens, 5 minutos no total, pausas entre pedidos), **para ao fim de 3 falhas
  seguidas** (um 503 ou um bloqueio conta, mesmo numa chamada que era para ser recusada) e só uma corre de cada vez. Para
  verificar as categorias proibidas envia ao site pesquisas por «Loli», «Shota», «Lolicon» e «Shotacon» e só conta as respostas
  (os resultados são deitados fora). O botão aceita qualquer source instalada, não só as importadas. Uma chamada pode fazer vários pedidos (uma source que verifica cada cartão faz dezenas): por isso é
  a pedido, e a versão básica deixa de fora as medições extra. Só fica «Verified» se nada falhou e a leitura (lista, detalhes,
  capítulos, páginas, imagens) passou; o resultado fica guardado na source e **esquece-se se o ficheiro for substituído** (diz o
  que se passou com o ficheiro instalado: uma edição à mão em `data/sources/` não é notada, e um teste a decorrer enquanto o
  ficheiro é substituído não é guardado no novo).
  Os avisos (amarelos) não impedem, mas lê-os.
- O contrato que a ferramenta exige é mais estrito do que o do carregador: `meta.id` igual ao id, `meta.name` presente,
  as 4 funções, e qualquer função opcional presente tem de ser função. Corre-o **antes**, mesmo que copies à mão.

## 8. Lista de verificação ("está pronto quando")

- [ ] Investigação escrita (secção 4), incluindo os filtros medidos com dois valores.
- [ ] `search`, `mangaDetails`, `chapters` (datas reais, mais novo primeiro) e `pages` funcionam no site real.
- [ ] Casos de erro com mensagem clara (inexistente = 404; id inválido recusado).
- [ ] Paginação testada de verdade, incluindo além do fim.
- [ ] Resultados etiquetados com o que o servidor filtrou (`status`, `format`, `genres`).
- [ ] `meta.ui` escrito como literal simples, e o *Check* mostra «Como a app a vai usar» sem avisos nem erros (filtros medidos, géneros do site, só-adultos se for o caso).
- [ ] Conteúdo: categorias adultas tratadas e as que nunca se listam excluídas.
- [ ] Decisão de edição tomada e dita ao utilizador (secção 6, «ainda é preciso fazer à mão», ponto 3); id fora do `light-sources.json` por defeito.
- [ ] A source passa o lint **a sério**: `tools\node\node.exe node_modules\eslint\bin\eslint.js --no-ignore data/sources/<id>.js`.
      Antes de a instalares (ficheiro na tua pasta de trabalho) usa a forma por stdin:
      `cat ficheiro.js | tools\node\node.exe node_modules\eslint\bin\eslint.js --no-ignore --stdin --stdin-filename data/sources/<id>.js`.
      Um aviso "File ignored because outside of base path" com saída 0 **não** é uma aprovação.
      O `npm run lint` e o `smoke` **não cobrem `data/sources`** (a configuração ignora `data/**`), e o lint recusa
      argumentos sem uso que não comecem por `_` (por isso `_orderBy`, `_filters` no modelo).
- [ ] Os caminhos de que a source depende não estão em `Disallow` no `robots.txt` (secção 4.1); se algum estiver, ou
      a source é **parcial** (declarada e autorizada pelo utilizador) ou não se entrega.
- [ ] `checkSourceContract` e `analyzeSourceCode` (secção 5) sem bloqueios, e o relatório do *Check* só mostra os hosts do site.
- [ ] Depois de instalada: o botão **Test** (e *Test in full* se declaraste ordenação ou filtros) dá «Verified», sem falhas. É a
  lista desta secção medida no site real e dispensa repeti-la à mão, mas não substitui a leitura dos avisos.
- [ ] `npm test` (inclui os testes do FlareSolverr, que usam um falso: não arrancam o real) e `tools/smoke-check.js` a passar.
      Só dizem alguma coisa sobre a source **depois de instalada** em `data/sources/`; antes, não a cobrem.
- [ ] Documentação no mesmo commit: README (tabela de funcionalidades, se a source é novidade), este guia se mudou o processo.
- [ ] Nada arrancado sem proteção, nada contornado.

## 9. Armadilhas que já custaram horas

- **Título inexistente → 200 com a home** (MangaFreak). Verifica o bloco esperado.
- **Paginação do paginador errada** (MangaFreak, `/Find/x?page=2` ignora a página).
- **Dois sistemas de géneros** que não concordam; "Act"=Action, "Ancients"=Historical.
- **Entidades HTML duplas** na sinopse (`&amp;quot;`): o `.text()` do cheerio deixa `&quot;`. Faz um segundo `cheerio.load(...).text()`
  quando o resultado ainda tem entidades (`plainText()` do modelo, secção 5).
- **`fetchText` repete um 404 três vezes** e lança um erro sem `statusCode`: usa `fetchText(url, 0)` e põe tu o 404 (secção 3).
- **Desafio só em alguns caminhos, servido com 200**: confirma o `<title>`/bloco esperado em cada pedido (secção 4.1).
- **Lista de capítulos paginada**: `limit` grande demais dá 403; pagina, e uma falha a meio lança erro (secção 4.6).
- **Datas de importação em massa** (muitos capítulos com a mesma hora): `null`, não essa hora (`cleanPublishDates`).
- **Id de capítulo com `..`** ou `/` à cabeça atravessa o caminho do pedido: usa o `CHAPTER_ID_RE` do modelo, não `^[\w\-./]+$`.
- **Categorias escondidas** (loli/shota) que o menu do site não mostra: procura-as pelo URL (secção 4.10).
- **Argumentos sem uso** (`orderBy`, `filters`) falham o lint a sério: `_orderBy`, `_filters`.
- **O mesmo endereço, dois formatos** (HTML ou JSON consoante o texto pesquisado): olha para o início da resposta antes de a
  tratar como HTML, e testa vários textos (secção 5).
- **Um id inválido tem de dar 400, não 500**: um `throw new Error(…)` simples sai como 500 e enche o registo de erros da app; usa
  `httpError(msg, 400)`.
- **`\d` dentro de um template literal** vira `d`: o regex `` `(\d+)` `` está errado. Usa literais `/(\d+)/`.
- **A última linha do ranking vazia** (`/Manga/` sem id): ignora entradas sem id.
- **Estado nas listagens de ranking**: lê a linha "N Published. (Estado)", não "qualquer linha com parênteses" (o autor
  pode ter "(Story & Art)"); o site abrevia ("Ong", "C").
- **Listas sem géneros** (home, últimos, ranking) não deixam o Hide NSFW julgar: filtra-as por ids que o site te dê.
- **Mais de um género com um que só existe numa das listas**: responde vazio, não parcial.
- **Página de detalhes enorme**: cache curta para não pedir duas vezes.
- **Datas**: `YYYY/MM/DD` sem hora; converte com `Date.UTC`, não com `new Date(string)` (fuso).
- **Ids opacos**: nunca partas do princípio de que um id é seguro num caminho: `encodeURIComponent`, e valida os ids de capítulo com um regex.
- **Filtros decorativos**: o que não filtra a sério tem de estar a `false`.
- **Etiquetar resultados** com o que foi filtrado no servidor, senão o filtro do cliente apaga tudo.
- **Git no disco de rede**: `git worktree`/`git clone` falham ("dubious ownership"). Não mudes o `safe.directory` global.
- **Dois trabalhos em paralelo a criar o mesmo ficheiro** apagam-se um ao outro: combina os nomes antes.

## 10. Exemplo real: MangaFreak (2026-10-27)

- Site: `mangafreak.me` → `ww3.mangafreak.me`. HTML estático, sem Cloudflare, imagens sem hotlink **(medido)**.
- Pesquisa e filtros num só sítio: `/Find?search=&genre=&status=&type=&page=` (género = um dígito por género, pela ordem da lista
  do site: 0 ignorar, 1 incluir, 2 excluir; estado 0/1/2 = ambos/concluído/em curso; tipo 0/1/2 = ambos/manga/manhwa).
  Sem ordenação (alfabética).
- Géneros: quase todos passam pela pesquisa avançada (os itens trazem todas as etiquetas, por isso o Hide NSFW funciona).
  Só "Sci-Fi" e "Slice Of Life" usam `/Genre/<Nome>/<página>` (15 por página, sem etiquetas por título) e, por isso, só
  funcionam sozinhos (combinados com outro género ou filtro a resposta é vazia, nunca parcial).
- Exclusão de conteúdo em **camadas**, porque nenhuma chega sozinha: (1) dígito "excluir" em todas as consultas `/Find`;
  (2) o nome da categoria é reconhecido por prefixo (`loli*`, `shota*`), para apanhar uma renomeação; (3) os itens da
  pesquisa e do autor com essa etiqueta são descartados; (4) as listas sem géneros (home, últimos, ranking) são filtradas
  com um conjunto de ids pedido ao próprio site (`/Find` incluindo só essa categoria), em cache 6 h; (5) `mangaDetails` e
  `chapters` devolvem 404 se a página do título tiver essa etiqueta. Ficou de fora, de propósito: a pesquisa por texto
  só com símbolos (devolve vazio, o site tirava os símbolos e listava tudo).
- Detalhes em `/Manga/<Id>` (a tabela de capítulos vem na mesma página, do mais antigo ao mais novo, com datas reais).
  Leitor em `/Read1_<Id>_<n>`; todas as imagens em `img#gohere`.
- Decisões: `Lolicon` e `Shotacon` nunca listadas (enviadas como "excluir" em todas as consultas); só na edição completa;
  capacidades: `orderBy:false`, `publicationStatus:true`, `format:true`, `genres:true`, `contentRating:false`.
- Código: `data/sources/mangafreak.js`; tabelas (anteriores ao `meta.ui`): `ui-advanced-search.js` (`mangafreak` em `ADV_SOURCE_CAPABILITIES`,
  `MANGAFREAK_GENRES`, `NSFW_MANGAFREAK_GENRES`).

### Segundo exemplo: Mangakakalot (2026-10-27, escrito só com este guia)

- Site: `mangakakalot.gg` → `kakamanga.com` **(medido)**; duas rotas de listagem têm desafio do Cloudflare e a source usa
  outras (`/home/search/json` para a pesquisa, `/manga-list/*` e `/genre/<slug>` para as listas). Imagens sem hotlink.
- Capítulos por API paginada (`limit` 400, com recuo para 50 se o site recusar); a data é o carimbo de «guardado», com lotes
  de importação: `cleanPublishDates` (4 ou mais capítulos na mesma hora UTC → `null`).
- Categorias que nunca se listam (`/genre/loli`, `/genre/lolicon`, `/genre/shota`, escondidas do menu): os ids são lidos do próprio
  site, em cache, e a source **falha fechada** se não os conseguir ler. Itens da pesquisa não trazem géneros, por isso o Hide
  NSFW só julga os resultados de `byGenres`.
- Capacidades: `orderBy:true` (só nas listagens sem texto nem género), `genres:true`, `publicationStatus:false` e `format:false`
  (medido: a mesma lista com valores diferentes). Código: `data/sources/mangakakalot.js`; tabelas em `ui-advanced-search.js`
  (`mangakakalot`, `MANGAKAKALOT_GENRES`, `MANGAKAKALOT_ORDER_BY_OPTIONS`) e `NATIVE_DATE_SOURCES`.

### Terceiro exemplo: ManhuaPlus (2026-10-28, escrito por um agente que só seguiu a skill `add-source`)

- Sonda: `open` (Cloudflare presente, não desafia; sem anúncios), `robots.txt` com `Disallow: /panel/`; cada caminho que a source usa
  foi confirmado com `probe --path`.
- A pesquisa por texto (`/search?keyword=`, páginas em `/search/<n>/`) **não combina** com filtros nem ordenação; as listagens com filtros
  vivem noutro caminho (`/filter/<n>/?genres=<ids>&notGenres=<ids>&status=&sort=`): os géneros são **ids numéricos lidos da própria
  página** (em cache), o «formato» do site é um género (Manhua/Manhwa) e a exclusão é um parâmetro (`notGenres`), que é por onde a
  categoria que nunca se lista é sempre excluída (e a source falha fechada se não conseguir ler os ids).
- Um título que não existe responde **200 com a página inicial**: deteta-se pela falta do bloco de detalhes (`h1.title-detail`) e
  lança 404 (o mesmo para um capítulo). Uma listagem com a mesma armadilha confirma-se pela forma (`.items`/paginação).
- As datas dos capítulos são **relativas** («14m ago», «3d ago», «10M ago», «3y ago»). Converte-se só o que é exato (minutos, horas,
  dias; `M` maiúsculo são meses e `m` minúsculo são minutos); semanas, meses e anos ficam `null` e `nativeDates` fica `false`.
- `new` e `old` davam a mesma lista que «latest»: não se oferecem na ordenação (uma ordenação decorativa falha o Test) e
  `supportsRecentlyAdded` fica `false`. Uma sinopse que é só o marcador do site («Updating») fica vazia.
- **As imagens dos capítulos nem sempre estão no HTML.** Em alguns capítulos a página só tem `Loading.gif` e é o JavaScript do site que
  pede `/ajax/image/list/chap/<CHAPTER_ID>` (o `CHAPTER_ID` é uma constante num `<script>` da página) e preenche o contentor com a
  resposta; o capítulo 1 de um título tinha 3 marcadores e 146 páginas. A source passou o Test e a leitura falhou na app, porque o Test
  só via que as «imagens» eram imagens. Por isso a source usa essa lista primeiro (e as imagens do HTML só como recurso) e o Test
  passou a falhar páginas que são todas a mesma imagem ou um «loading». **Lê o JavaScript da página do capítulo, não só o HTML.**
- O Test avisou que o filtro de formato só foi medido com um valor (o site não tem «manga»): um valor que devolve vazio **não** conta
  como medição, é um aviso.
- Decisão de edição: tem géneros Adult/Mature (o Ecchi não conta como adulto), o que a deixava só na edição completa até o utilizador
  decidir; decidiu (2026-10-28) que vai também na geral: está em `build-assets/light-sources.json`, e o Hide NSFW esconde os géneros Adult e Mature.

## 11. Mapa de ficheiros

| O quê | Onde |
|---|---|
| Sources (locais, fora do git) | `data/sources/*.js` |
| Carregador e contrato mínimo | `server/modules/source-loader/core.js`, `server/sourceLoader.js` |
| Despachante (métodos permitidos) | `server/modules/sources/dispatch-service.js` |
| Ferramenta de importação (o teste ao vivo está em `test-run.js`, `live-test.js` e `live-test-*.js`) | `server/modules/source-import/`, `server/routes/source-import.js`, `public/modules/ui-settings-source-import*.js` |
| Catálogo de sites de um repositório compatível com o Mihon (a lista, o tema, a Cloudflare por DNS) | `server/modules/source-catalog/`, `server/routes/source-catalog.js`, `server/config/catalog.js`, `public/modules/ui-settings-source-catalog.js` |
| Olhar para um site antes de escrever (Cloudflare, CAPTCHA, login, `robots.txt`, anúncios) | `server/modules/source-import/site-probe.js`, `site-signatures.js`, `site-verdict.js` |
| Linha de comandos (`probe`, `check`, `test`, `install`) e a skill `add-source` | `tools/source-lab.js`, `.claude/skills/add-source/SKILL.md` |
| Ajudantes de rede | `server/modules/network/fetch-utils.js` |
| Estado, capas | `server/modules/common/manga-status.js`, `server/modules/common/image-proxy.js` |
| Declaração da source (`meta.ui`): validação, registo, leitura para o *Check* | `server/modules/common/source-ui.js` |
| Tabelas por id (só sources do repositório) | `public/modules/ui-advanced-search.js`, `server/modules/calendar/service.js`, `fetch-utils.js` (Referer) |
| Edição geral | `build-assets/light-sources.json`, `tools/build-light.js` |
| Regras escritas | `GUIDELINES.md` §10 e §11, README «Adding a Source» |
| Manual técnico (local, fora do git) | `manual-tecnico/04-sistema-de-sources.md` |
