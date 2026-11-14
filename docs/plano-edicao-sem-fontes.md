# Plano: edição sem fontes, com repositórios à escolha do utilizador

Estado (2026-11-14): **o mecanismo está construído e testado na `complete`; falta portar para a `main`, a versão, o exe e a release.** Decidido em 2026-11-11.

## O que é

Uma edição como o Light, mas **sem nenhuma fonte instalada**. Em vez delas, o utilizador adiciona repositórios de extensões (o formato Mihon: um `index.json` e o `index.pb` que o Suwayomi lê) e escolhe os sites no catálogo. Os nomes dos sites vêm dos repositórios em tempo de execução: nenhum nome de site fica no código nem nos ficheiros do projeto.

Decisões já tomadas:

- **Opção A:** só modelos nativos (Madara e MangaThemesia), sem o Suwayomi nesta edição. O Suwayomi pode ser acrescentado depois (opção B).
- **Conteúdo adulto:** o limite que a `main` tem hoje sobre o que o catálogo pode listar sai. O `Hide NSFW` fica **ligado por omissão** (nada de adulto aparece); se o utilizador o desligar, aparece o que o repositório marca como adulto. Nenhum nome nem endereço de repositório adulto entra em ficheiros, commits ou documentação: é o utilizador que o escreve na caixa.
- O Light e o Complete continuam a ser as edições desenvolvidas. Esta é a mesma base de código, construída com uma lista de fontes vazia.
- Não há repo público separado nem exportação: ficou de lado.

## O problema a resolver

O catálogo só sabe escrever uma fonte sozinho quando sabe em que modelo o site é feito (o "tema"). Lê-o no ficheiro `build.gradle.kts` de cada extensão, no GitHub do projeto de extensões, e essa pasta está fixa para um único repositório (`themeBaseUrl` em `server/config/catalog.js`). Num repositório de outra pessoa, todos os sites ficariam "tema desconhecido" e só apareceriam na lista.

## Passos

1. **Vários repositórios.** Lista `extensionRepos` nas definições, com o repositório por omissão já lá, e uma caixa "Adicionar repositório" em Sources (adicionar, remover, ligar e desligar). O catálogo junta os repositórios todos. Aceitar o endereço-base (`…/raw/repo/`) e derivar `index.json` e `index.pb`; guardar o nome do repositório em cada linha.
2. **Validação do endereço** (vem do utilizador, por isso não é de confiança): só `https`; recusar endereços de redes privadas e redirecionamentos para elas (o controlo que já existe noutros sítios); limite de tamanho; limite de repositórios; um índice que não tem o formato esperado é recusado com uma frase clara. Os ícones só de uma lista de hosts permitidos.
3. **Pasta de código de cada repositório.** Descobrir por convenção (`extensions` → `extensions-source`) e, se não existir, tratar como tema desconhecido. Guardar o que se descobriu por repositório.
4. **"Verificar este site"** para as linhas de tema desconhecido: depois de o utilizador escolher, a app olha para o próprio site, com o detetor de "adicionar a partir de um link", e vê se é Madara ou MangaThemesia. Se for, escreve a fonte como as outras (passa pela verificação e o utilizador confirma); se não, diz que precisa do Suwayomi. Um site só é contactado depois de escolhido, um de cada vez.
5. **Conteúdo adulto.** Retirar o limite do catálogo na `main` e confirmar que o `Hide NSFW` vem ligado por omissão e que filtra o catálogo (e a pesquisa segura). Testes que garantam as duas coisas.
6. **Edição sem fontes.** Um ficheiro de lista vazio em `build-assets/` e confirmar que o `tools/build-light.js` aceita uma lista vazia. Ecrã inicial para quando não há fontes: "adiciona um repositório e escolhe sites no catálogo".
7. **Documentação e versão.** README, GUIDELINES e a página de ajuda no mesmo commit; versão nova; construir o exe; lançamento com notas sem nomes de sites.

Ordem de trabalho: desenvolver na `complete`, portar para a `main` num worktree temporário. Na `complete`, o Suwayomi passa também a registar cada repositório novo no servidor (o registo já existe para um repositório; passa a ser uma lista).

## Antes de construir o passo 4: calibrar o detetor

O detetor de "adicionar a partir de um link" ainda não foi medido contra sites de modelo conhecido. O próprio catálogo dá a resposta certa para muitos: para os sites do repositório por omissão, o tema vem escrito. Daí a medição:

- Escolher, num ambiente isolado e descartável, uma pequena amostra de sites **que o utilizador indicar** (ou que já usa), de modelo conhecido pelo catálogo.
- Correr o detetor em cada um e comparar o resultado com o modelo conhecido.
- Registar só **factos derivados**: quantos acertos, quantos falhos, e que sinais distinguem cada modelo. Nunca guardar a página de um site em disco, nem nomes de sites em ficheiros do projeto, nem em notas.
- Ajustar o detetor onde falhar e só depois ligá-lo ao botão.

Ambiente: um contentor descartável no servidor de casa (ou no Docker deste computador), sem a biblioteca do utilizador e sem nada que valha a pena proteger, que se apaga no fim. Detalhes a combinar quando chegarmos lá.

## Riscos e pontos em aberto

- O formato dos índices de repositórios de terceiros pode variar um pouco: tratar tudo como texto não confiável e testar com índices de exemplo.
- Cada extensão de terceiros continua a correr no Suwayomi com a confirmação que já temos; nesta edição (A) não há Suwayomi, por isso o risco é só o de contactar um site.
- A edição sem fontes depende dos mantenedores dos repositórios e do formato dos índices; se o formato mudar, a app tem de ser atualizada.
- Decidir se o repositório por omissão vem ligado ou se o utilizador tem de o adicionar (propõe-se que venha ligado, por ser o da comunidade).

## Descoberta de modelos novos (leitura do código público, 2026-11-11)

O objetivo da amostra é **descobrir modelos que a app ainda não sabe escrever**, e não só medir os dois que já conhece. No catálogo, dos 120 sites seguros em inglês sem modelo próprio, 70 têm cada um um scraper próprio (sem padrão partilhado: só o Suwayomi os abre) e os outros estão em poucos modelos.

O código de cada modelo é público (pasta `lib-multisrc` do projeto de extensões, Apache-2.0) e diz os endereços, os campos e os seletores: o padrão sai da leitura, sem visitar sites. Cinco leitores estudaram os cinco modelos maiores. Contagens no repositório inteiro (todas as línguas e avisos de conteúdo; são mais do que as do catálogo seguro em inglês):

| Modelo | Sites | Como funciona | Veredicto |
|---|---|---|---|
| **iken** | 9 (6 sem nenhuma diferença do modelo base) | API JSON limpa num host `api.<site>`: `/api/query` (lista, pesquisa, filtros), `/api/post`, `/api/chapters`, `/api/chapter`, `/api/genres`; só JSON, sem HTML | médio-baixo; **o melhor primeiro modelo** |
| **keyoapp** | 16 | três formas: V1 em HTML (10 sites: `/series`, `#chapters`, `#pages` com a CDN tirada de um script; a pesquisa filtra no cliente uma página com todas as séries), V2 com respostas AJAX `{html}` (3 sites), e uma variante Livewire (3 sites, com `x-data` JSON) | V1 fácil-médio; as três formas juntas difíceis |
| **vinetheme** | 6, clones quase idênticos | lista em JSON (`/api/series`); detalhes, capítulos e páginas vêm de respostas Next.js RSC (cabeçalho `rsc: 1`), que se leem com um analisador de cerca de 150 linhas de JS, sem dependências | médio-alto; falha silenciosa se o site mudar o nome de um campo |
| **guya** | 4 | API JSON simples (`get_all_series`, `series/<slug>`); sem géneros, sem estado e sem pesquisa no servidor (filtra-se no cliente) | fácil-médio, mas poucos sites |
| **heancms** | **2** | API JSON, com login em alguns sites | **não compensa**: os sites estão a sair deste modelo |

Dados que valem para os modelos de API (iken, vinetheme, heancms): pedem cabeçalhos de navegador (`Origin`, `Referer`, `Accept`), os identificadores têm de levar o slug e um id numérico (`slug#id`), e os capítulos pagos ou bloqueados têm de ser marcados em vez de falhar. O detetor atual tem só um sinal genérico `nextjs`, por isso precisa de um passo novo que faça um pedido de teste à API (por exemplo `api.<site>/api/query` para o iken). O guya colide com o sinal `/reader/series/` do foolslide: o teste do guya tem de correr primeiro.

Ordem sugerida: **iken**, depois **keyoapp V1**, depois **vinetheme**. Keyoapp V2 e Livewire, guya e heancms ficam para mais tarde (ou nunca).

Amostra do teste ao vivo: 10 sites escolhidos por segurança (DNS de segurança sem bloqueio), popularidade (ranking público Tranco) e variedade de modelos. **A lista de nomes fica só na pasta temporária da sessão**, nunca neste repositório nem nas notas. O teste: num contentor descartável, sem a biblioteca do utilizador, pedir só os endereços que o código do modelo indica e guardar apenas factos derivados (códigos de resposta, nomes dos campos do JSON, se há Cloudflare ou login), nunca o conteúdo de uma página. Perguntas que só o teste responde:

- A API (`api.<site>`) responde a um cliente que não é um navegador? Que cabeçalhos exige? Tem Cloudflare à frente?
- As imagens e as capas são endereços absolutos? Precisam de `Referer`?
- No keyoapp: que variante é cada site, e a lista `/series` traz mesmo todos os títulos numa página?
- No vinetheme: `rsc: 1` chega, ou o site exige mais cabeçalhos? Qual é a forma real da resposta?
- Como se comporta um capítulo bloqueado?

## Todos os modelos e o detetor universal (leitura do código público, 2026-11-11)

Contagem das 1575 extensões do repositório principal (todas as línguas): **841 (53%) têm scraper próprio**, sem padrão partilhado. O Madara tem 240 e o MangaThemesia 112 (22% juntos, já temos modelo). Os restantes cerca de 380 espalham-se por cerca de 60 modelos pequenos; 11 deles são só de conteúdo adulto e não foram estudados (ficam para a edição que o permita). As contagens por modelo vêm de pesquisa de código e têm uma margem de cerca de ±3.

### O que mais vale: tornar o Madara e o MangaThemesia mais robustos
O modelo atual trata cerca de **40-50% dos sites Madara e 55-60% dos MangaThemesia** (amostra de 189 e 100 extensões). Subir isso para cerca de 80% daria mais ~115 sites, mais do que todos os modelos novos juntos. Os oito desvios que mais falham, por ordem:

1. **Caminho-base que não é `manga`** (28% dos Madara, 21% dos MangaThemesia): hoje o `/manga/` está fixo nos endereços e nas expressões. Detetar lendo o primeiro segmento do endereço de um título; parâmetro `__SUBPATH__`.
2. **Formatos de data** (56% e 15%): cerca de 40 padrões (dd/MM, MM/dd, nomes de meses noutras línguas); hoje só inglês relativo e `Date.parse`, por isso as datas saem erradas. Classificar uma amostra (um valor acima de 12 decide dd/MM contra MM/dd) e usar um analisador geral.
3. **Lista de capítulos** (cerca de 9% usam AdminAjax ou paginação): vem vazia ou cortada. Tentar por ordem `POST /ajax/chapters/`, depois `admin-ajax` (`manga_get_chapters`) e seguir as páginas.
4. **Marcação refeita sobre o motor normal** (32 Madara com 2 ou mais seletores diferentes): o teste de encaixe só olha para o título e para os cartões; alargar aos capítulos e às imagens do leitor.
5. **Entrega das imagens** (18%): atributos `data-lzl-src`, `srcset`, JS empacotado, JSON num script, e o bloco cifrado `#chapter-protector-data`.
6. **Diretório de géneros** (10%) e 7. **parâmetros de pesquisa e de ordenação** (a pesquisa dos formulários já é encontrada pelo detetor).
8. **Limite de pedidos** (30%) e capítulos bloqueados (esconder em vez de listar).

Incerteza principal: se a ordenação e a pesquisa atuais funcionam nos sites Madara que carregam mais por AJAX (144 de 189). Só um teste ao vivo diz.

### Modelos novos, por classe de adaptador
| Classe | Modelos (sites) | Notas |
|---|---|---|
| API JSON com mapeamento | iken (9), mangadventure (2), monochrome (2), pizzareader (10), loneseal (5), greenshit (3), fansubscat (2), ezmanhwa (2), mangak (3) | um adaptador genérico "REST + mapa de campos" cobre vários; muitos têm o host da API em `api.<site>` |
| Feed do Blogger | zeistmanga (33; 9 em português) | JSON em `/feeds/posts/default?alt=json`; o rótulo da série lê-se de um script; fácil-médio |
| HTML com seletores | keyoapp V1 (10 dos 16), wpcomics (7), fuzzydoodle, zmanga (5), foolslide (8), mmrcms (6), mangareader/liliana (AJAX com `{html}`), goda | cada um tem um vocabulário próprio de classes |
| Respostas Next.js (RSC) | vinetheme (6) | analisador de cerca de 150 linhas |
| SvelteKit `__data.json` | uzaymanga (7, turco) | descodificador de índices |
| Visualizadores com baralhamento de imagem | comiciviewer (27), gigaviewer (19), ambos japonês | o baralhamento é uma grelha 4x4 fixa e determinística, mas precisa de uma biblioteca de imagem |
| Cifras reversas determinísticas | mangahub (11, inglês): chave rotativa mais AES-GCM | médio-difícil; um adaptador serve os 11 |
| **Não automatizáveis** | pam, aurora (português, 4), imperiomanhwa, oyst, inkstory, mangotheme, mangataro, crunchyscanst (Turnstile), initmanga (capítulos cifrados), dm5/mmlook (JS empacotado e XOR), grouple (SSO), mangacatalog (um só título) | o detetor deve classificá-los cedo como "não adaptável" e parar |

### Desenho do detetor universal (sem navegador)
Uma escada de testes, do mais barato ao mais caro, que para assim que tem certeza:

1. **Página inicial** (um pedido): impressões digitais de estrutura: `wp-manga`/`admin-ajax` (família Madara), `.bsx` e `ts_reader` (MangaThemesia), `__NEXT_DATA__` ou `self.__next_f` (Next.js), `wire:` (Livewire), `hx-get` (HTMX), `data-page` (Inertia), `.cf-turnstile` (bloqueado).
2. **Testes de API baratos**, só os que o passo 1 sugere: `/wp-json/` (lista de espaços de nomes), `api.<site>/api/query` e `/api/series`, `/api/comics`, `/api/get_all_series/`, `/api/v2/series`, `/__data.json`, `/feeds/posts/default?alt=json`, `/graphql`, `/api/trpc/auth.me`, `/api/constants`, `/filterList`, `/directory/`.
3. **Ordenar os motores pelos marcadores que encaixam**, e não só pelos scripts: um Madara refeito com outras classes mostra o motor WordPress mas falha os marcadores.
4. **Descobrir os parâmetros do site** (caminho-base, diretório de géneros, nome do parâmetro de pesquisa, classe do formato de data, modo de carregar capítulos, host da API, host da CDN) e só depois escrever a fonte.
5. **Marcar o que não dá**: Turnstile, URLs assinados, XOR ou AES, login, e dizer "precisa do Suwayomi" ou "não adaptável".

Em vez de um modelo de código por cada tema, cada tema passa a ser um **descritor** (dados: assinaturas, caminhos, mapa de campos, seletores), interpretado por poucos adaptadores genéricos: HTML com seletores, REST JSON, feed, Next.js RSC, SvelteKit. Acrescentar um tema novo passa a ser escrever um descritor e não código.

### Ordem de trabalho sugerida
1. Vários repositórios + validação do endereço (passos 1 e 2 acima): sem isto a edição sem fontes não existe.
2. **Detetor universal e botão "Verificar este site"**: a escada de testes, com os adaptadores que já temos (Madara e MangaThemesia).
3. **Tornar o Madara e o MangaThemesia mais robustos** (os oito desvios), medindo antes e depois num ambiente descartável.
4. Descritores novos por valor: iken, zeistmanga (por causa do português), keyoapp V1, vinetheme; depois pizzareader, mangadventure, monochrome (baratos, com API padrão).
5. Mais tarde, se compensar: mangahub, os visualizadores, keyoapp V2.

### Medição real do Madara e do MangaThemesia (2026-11-11, contentor descartável)

Teste do fluxo completo da app (colar o endereço, detetar, escrever a fonte, verificar, instalar, teste completo, desinstalar) em 12 sites seguros em inglês (8 Madara e 4 MangaThemesia, escolhidos pelos desvios que o código de cada extensão declara), dentro de um contentor com biblioteca vazia, sem portas publicadas e sem FlareSolverr. Só se guardaram factos (veredictos, contagens, nomes dos testes que falharam); os nomes dos sites ficaram só na pasta temporária da sessão.

| Resultado | Sites | Causa |
|---|---|---|
| Verificado (0 falhas) | 5 (4 Madara, 1 MangaThemesia) | inclui sites com capítulos por AJAX e com seletores das páginas diferentes: esses desvios já são tratados |
| Gerado, com falhas | 1 (Madara) | a pesquisa por texto é proibida pelo `robots.txt` do site (a fonte não a pode usar), os capítulos não foram encontrados e as imagens exigem o `Referer` do site |
| Recusado no encaixe | 3 (1 Madara, 2 MangaThemesia) | falta "os cartões da lista (`/manga/`)": o caminho-base fixo `/manga/` (desvio nº 1); num deles também o título da página do título |
| Recusado: precisa de solver | 2 (Madara) | a Cloudflare serve um desafio de JavaScript; sem FlareSolverr não passa (não é uma falha do modelo) |
| Inacessível | 1 (MangaThemesia) | o DNS do contentor resolveu o site para um endereço privado; é do ambiente de teste, a repetir |

Verificado em 5 de 12 (42%), em linha com a estimativa de 40-50% para o Madara (4 de 8). O MangaThemesia deu 1 de 4, mas é uma amostra pequena e escolhida com desvios. **A causa que mais recusa, por si só, é o caminho-base fixo `/manga/`** (3 de 12): um parâmetro `__SUBPATH__`, descoberto a partir do primeiro endereço de um título, valia cerca de mais 25 pontos nesta amostra. As avisos do detetor para o MangaThemesia mostram também capítulos que se carregam por `admin-ajax` ou por script, que o modelo de MangaThemesia só trata em parte.

### Segunda medição, depois do caminho-base (2026-11-11)

Implementado o `__SUBPATH__` (o caminho-base lido do endereço da página de título que a sondagem encontra, usado nos endereços e padrões dos dois modelos, e o teste de encaixe procura os cartões nessa pasta). Mesma amostra de 12 sites, mesmo contentor descartável: **7 de 12 verificados (58%)**, contra 5 de 12 (42%) antes; os dois MangaThemesia recusados por esta causa passaram a verificar (16 testes aprovados, 0 falhas). Os restantes:

- 1 Madara continua recusado no encaixe: falta o título na página de título *e* os cartões, ou seja, o tema está mesmo refeito (desvio nº 4, marcação refeita), não é só o caminho.
- 1 Madara gerado com 2 falhas (pesquisa proibida pelo `robots.txt` do site, capítulos não encontrados, imagens com `Referer`).
- 2 Madara com desafio de JavaScript da Cloudflare: precisam do FlareSolverr.
- 1 MangaThemesia "inacessível": o site publica um registo IPv6 `::` (o endereço não especificado) ao lado do IPv4 público. A verificação de endereços da app, por segurança, recusa qualquer endereço que não seja público; um navegador ignora o `::` e usa o IPv4. **Não se alterou** (é código de segurança); uma melhoria possível é descartar os registos não especificados e ligar só ao IPv4 já verificado, ligando por esse endereço verificado.

### Teste ao vivo dos modelos novos (2026-11-11, contentor descartável)

Oito sites seguros (2 iken, 2 keyoapp, 2 vinetheme, 1 heancms, 1 guya), só com Node num contentor sem biblioteca e sem portas, com 1,4 s entre pedidos. Pediram-se apenas os endereços que o código público de cada modelo indica; guardaram-se só factos (códigos, nomes de campos, contagens). **Nenhum dos endereços de API ou de dados teve desafio da Cloudflare**, mesmo com os sites atrás dela: respondem a um cliente que não é um navegador (os sites Madara com desafio são outro caso).

| Modelo | Resultado |
|---|---|
| **iken** (2 de 2) | confirmado. A API está em `api.<site>` e responde sem navegador. `/api/query` devolve `{posts, totalCount}` (capas em endereço absoluto). **Diferença do código lido:** `/api/post` não traz a lista de capítulos; vem só de `/api/chapters?postId=` (109 e 63 capítulos), com `number` numérico, `createdAt` ISO com milissegundos, `price`, `isLocked`. `/api/chapter?chapterId=` devolve `images[{id,url,width,height,order}]` com endereços absolutos num host `storage.<site>`; `order` é um número. Fácil-médio: o melhor primeiro modelo. |
| **keyoapp** | as variantes distinguem-se bem pelos marcadores. V1 confirmada (um site): `/series` traz os 263 títulos numa só página (`#searched_series_page`, `initializeDropdownMenu`), a página do título tem `#chapters`, `#expand_content`, a do capítulo tem `#pages`, `uid=` e o `realUrl` num script. V2 confirmada (outro site): `?_ajax=search` devolve `{html, has_more}` com 20 cartões, `?_chapters_html=1&series_slug=` devolve `{rows_html, chapter_count, ...}` com datas e bloqueios; **a página do leitor V2 não mostrou `#strip-reader` nem imagens `data-src`**: a estrutura do leitor V2 fica por apurar. |
| **vinetheme** (2 de 2) | confirmado. A lista JSON (`data`, `meta.hasMore`, `meta.totalPages`) e as páginas RSC (`text/x-component`, com `series`, `chapters`, `totalPages` e `pages`/`imageUrl`) respondem com o cabeçalho `rsc: 1`. As imagens vêm como caminho relativo (juntar ao endereço do site); alguns capítulos vêm com `isLocked: true`. `slug` e `urlSlug` eram iguais nos dois sites. |
| **guya** | confirmado exatamente como o código lido: `/api/get_all_series/` (objeto por título, capas relativas), `/api/series/<slug>/` com o mapa de capítulos (`volume, title, folder, groups, release_date`). Poucos sites. |
| **heancms** | **a API mudou**: `/tags` vem vazio, `/query` responde com `data` e `meta` (paginação), mas `/series/<slug>` traz agora um campo `seasons` e já não bate com o código lido. Confirma que o modelo está a ser abandonado: fora do plano. |

Conclusão: iken, keyoapp V1 e vinetheme são viáveis sem navegador; falta apurar o leitor da V2 do keyoapp antes de lhe fazer um descritor. Ordem confirmada: iken, keyoapp V1, vinetheme.

### Estado (2026-11-11): feito

- **Caminho-base** (`__SUBPATH__`) nos modelos Madara e MangaThemesia: 5 para 7 de 12 sites verificados.
- **Iken**: modelo (`generator/iken.template.txt`, só JSON), deteção pela forma de uma resposta da API (`api-engines.js`, com o `robots.txt` do host da API a decidir), descoberta de nome e géneros, testes. Ao vivo: os 2 sites Iken da amostra gerados e verificados (15-16 testes aprovados, 0 falhas). O catálogo passa a marcar os sites Iken como automáticos, porque o nome do tema coincide com um modelo existente.
- Sem regressões na amostra de 12: 9 de 14 verificados no total.

- **Keyoapp V1** (HTML): modelo, deteção pela forma da página `/series` (a V2 é nomeada e recusada pela resposta AJAX `{html, has_more}`), descoberta de géneros, testes. Ao vivo: um site V1 gerado e verificado (16 aprovados, 0 falhas); um site V2 recusado com uma frase clara. Duas falhas de deteção apanhadas ao vivo e corrigidas: a página "título" que a sondagem escolhe é, neste tema, uma página de capítulo; e o `tags` dos cartões vem com aspas simples. Um teste apanhou ainda um `uid` com `..` que entraria no endereço da imagem.

- **VineTheme** (Next.js, respostas RSC): leitor partilhado das respostas (`rsc-reader.js`: linhas `<id>:<valor>`, texto lido por bytes, referências `$id`), modelo, deteção pela página `/series` (a lista e a paginação que a acompanham), descoberta de géneros, testes. A primeira versão pedia `/api/series`, que o `robots.txt` destes sites fecha: o detetor recusou e **ficou assim** (a regra é nossa); o modelo passou a ler a lista da própria página `/series` (que aceita `page`, `q` e `genre`), que é permitida. Ao vivo: os 2 sites VineTheme gerados e verificados (15 aprovados, 0 falhas). Páginas com sinalizadores de proteção (ocultas, cifradas, em tiles, tiras ou fragmentos) são recusadas (403), nunca mostradas. A sondagem passou a ler o `robots.txt` do host **antes** de pedir qualquer caminho, mesmo só para identificar o site.

- **Datas e lista de capítulos dos Madara/MangaThemesia:** módulo partilhado `chapter-dates.js` (relativas e absolutas em inglês, português, espanhol, francês, alemão, italiano, indonésio e turco; uma semana ou mais atrás não é uma data; a ordem dia/mês é medida no site; nunca inventa). O teste de encaixe do Madara exige agora uma **lista de capítulos legível** (na página do título ou na resposta da chamada do próprio tema) e experimenta **até quatro títulos** (um título novo ainda não tem capítulos), com o seletor real e não uma palavra no texto (uma página que só menciona a classe num estilo ou script não conta: foi um falso negativo apanhado ao vivo). Ao vivo: 2 sites em espanhol (um com datas `d/m/aaaa`) gerados e verificados (16 aprovados, 0 falhas); o site cuja lista um script próprio preenche é recusado no encaixe, em vez de gerado para falhar. Sites em português: um recusado por tema refeito (sem título na página) e outro por cartões da pesquisa; as datas por extenso em português só estão cobertas por testes unitários, não ao vivo. **Por fazer neste ponto:** os modos de lista por `admin-ajax` e paginados, que nenhum site da amostra usou.

- **Vários repositórios + "Verificar este site":** módulo do endereço (`repo-url.js`: https, sem login, sem porta, sem query, nome público; formas aceites: o ficheiro, a pasta, o `index.pb` ao lado, ou um projeto do GitHub no ramo `repo`; o mesmo repositório escrito de duas maneiras é um só), registo (`repos.js`, `settings.catalogRepos`, no máximo 8, relido com a mesma rigidez com que foi aceite, e só guardado se uma lista de extensões existir mesmo), catálogo que junta a lista por omissão com as acrescentadas (uma extensão em duas listas conta uma vez, a da primeira), rotas `/api/sources/catalog/repos` (listar, acrescentar, remover; só neste computador, limitadas). Os sites de um repositório acrescentado não têm tema para ler: aparecem com **"Verificar este site"** (o gerador olha para o próprio site) e com o nome do repositório; o limite de conteúdo da edição e a lista de sites perigosos aplicam-se-lhes. O Suwayomi só serve o repositório por omissão, por agora. Interface: bloco "Repositórios" dentro do catálogo (inglês e português), verificado no ecrã real. O repositório por omissão aparece na lista como os outros (nome, endereço, contagem, etiqueta "por omissão") e **pode ser removido** (`settings.catalogDefaultOff`); colar o endereço dele outra vez volta a pô-lo, e sem nenhum repositório o catálogo fica vazio. É a base da edição sem fontes: lá o repositório por omissão arranca desligado. O catálogo mudou do separador Suwayomi para o **Advanced** (cartão próprio, ranhura `advancedCatalogSlot`), e o cartão antigo "Source Repositories" do separador Sources (os "Official Extras" e repositórios `jsrepo`, com o botão de instalar o Suwayomi Bridge) foi retirado; as rotas `/api/repos` e o carregador ficam no servidor.

### Edição sem fontes: feito na `complete` (2026-11-14)
`server/config/edition.js` + `edition.json` (a edição é a que o ficheiro da pasta empacotada diz; `SCROLLSCAPE_EDITION` para experimentar; um nome desconhecido é a edição normal), `/edition.js`
para a página, repositório por omissão desligado até a pessoa o acrescentar (escolha de três estados), limite de conteúdo do catálogo da edição, `Hide NSFW` ligado por omissão, sem o motor do
Suwayomi, aviso na página inicial sem fontes (`ui-empty-sources.js`), `tools/build-light.js --edition sourceless` com lista vazia (`build-assets/sourceless-sources.json`). Testado numa cópia
descartável com a pasta de dados vazia: o servidor arranca, `/edition.js` diz `sourceless`, `Hide NSFW` vem ligado, não há repositórios nem fontes, o aviso aparece, o botão abre
Definições → Advanced → catálogo, e acrescentar o repositório conhecido pelo endereço do projeto lista 563 sites em inglês (216 gerais com o filtro ligado). **Achado ao vivo:** o repositório
conhecido responde `index.min.json` com um índice de duas entradas que mandam uma app antiga atualizar, e guarda a lista verdadeira em `index.json`; acrescentar um repositório passou a
escolher a MAIOR lista das formas do endereço. **Por fazer:** portar para a `main` (o gerador e o catálogo têm de chegar lá primeiro), versão, exe, release com notas sem nomes de sites.

### Por fazer, por ordem
1. Apurar o leitor da V2 do keyoapp (e a variante Livewire), para lhes fazer descritor.
4. Vários repositórios com caixa e validação do endereço; botão "Verificar este site" para linhas de tema desconhecido.
5. Edição sem fontes (lista vazia, ecrã inicial), documentação, versão e lançamento.
