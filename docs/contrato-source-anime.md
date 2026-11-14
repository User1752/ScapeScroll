# Contrato de uma source de anime

Uma source de anime é um módulo que diz **como encontrar o vídeo de um episódio**. O registo (`server/modules/anime-sources/`) guarda
as que existem; as rotas, o leitor e o System Health perguntam-lhe em vez de nomearem cada uma. Hoje o registo tem as cinco que vêm com
a app (AniZone, AnimePahe, zokoanime, Miruro, AnimeParadise); este contrato é o que uma sexta, escrita ou importada, tem de cumprir.

A importação pela interface existe (Definições → Sources → Import a source, interruptor **Anime**): ver «Importar uma source» e «O Test ao vivo» mais abaixo.

## O que o módulo exporta

```js
module.exports = {
  meta: {
    id: 'mysite',        // 2 a 40 caracteres: minúsculas, dígitos, "_" e "-"
    name: 'My Site',     // o nome que aparece na lista
    keyedBy: 'title',    // 'mal' (acha o título pelo id do MyAnimeList) ou 'title' (pelo título)
    features: { dub: false, quality: false, format: false }, // o que entende do pedido; o que não entende nunca lhe chega
    warning: '',         // opcional: um risco que a pessoa deve ler antes de a ligar
    health: true,        // opcional: false tira-a do System Health (precisa do browser escondido, por exemplo)
    stream: { hosts: ['cdn.example'], referer: 'https://site.example/', refererFromLink: false }, // ver abaixo
  },
  getStreamSources({ malId, title, episode, dub, quality, format }) {
    // devolve { src, subtitles?: [{ lang, label, default, src }], availableQualities?: [], quality?: '', referer?: '' }
  },
  fetchHlsResource(url, referer) { /* devolve { contentType, body } */ },  // o relay próprio, ou meta.stream
  healthCheck() { /* devolve { ok, error? } */ },                         // opcional
};
```

`checkAnimeSource(mod)` (`contract.js`) julga o módulo **sem o correr** e diz um problema de cada vez.

## Quem leva o vídeo ao leitor: o relay

O leitor (hls.js) não pode ler as playlists e os segmentos do servidor de vídeo (CORS, um `Referer` que o servidor exige), por isso
passam pela app. Há dois caminhos, e uma source tem **exatamente um**:

1. **`fetchHlsResource`: o relay é da própria source.** É o que as cinco que vêm com a app fazem (cada uma sabe os seus cabeçalhos,
   as suas sessões). A source confia-se a si própria.
2. **`meta.stream`: o relay é o da app (`relay.js`).** A source só declara os **anfitriões** de onde vem o vídeo
   (`hosts`, até 12, nomes e não endereços) e, se for preciso, o `Referer` (um fixo, ou `refererFromLink` para o levar de cada
   ligação). A source devolve os **endereços reais** (https) e a app:
   - recusa o vídeo se o endereço não está nos anfitriões declarados, e deixa cair as legendas que não estão;
   - reescreve-os para `/api/anime/<id>/hls-proxy?url=…` (e, nas playlists, também as linhas `URI="…"` das chaves, dos ficheiros
     de inicialização e das legendas);
   - em **cada pedido** (a playlist e cada segmento) volta a verificar o anfitrião, e verifica **cada redirecionamento**: um
     redirecionamento para um anfitrião que a source não declarou pára aí; só vai para endereços públicos (`safeFetch`);
   - só passa `https`, até 64 MB por recurso e 2 MB de playlist, e o que chega ao leitor leva os cabeçalhos de conteúdo não
     confiável de sempre (só tipos de média, `nosniff`, CSP com `sandbox`).

Isto é o que torna possível uma source importada sem lhe dar um relay que ela própria escreve: ela diz **onde**, a app decide **como**.

## O pedido e a resposta

`registry.resolveStream(id, { malId, title, episode, dub, quality, format })`:

- falta o `episode`, ou o `malId` (source `mal`), ou o `title` (source `title`): 400 com a frase que o cliente sempre recebeu
  (`title is required for the animepahe provider`);
- um id que o registo não conhece: 404 (antes, um nome de provider desconhecido caía no zokoanime);
- só os campos que `meta.features` declara chegam à source; os outros são `undefined`/`false`;
- a resposta tem sempre `subtitles` e `availableQualities` como listas, e mantém o que a source acrescentou (`quality`, …).

## As rotas

- `GET /api/anime/providers`: a lista (`id`, `name`, `keyedBy`, `features`, `warning`, `origin`), pela ordem em que são oferecidas.
  **Nada** sobre de onde cada uma tira o vídeo. O leitor e as Definições → Sources → Anime Sources constroem a lista a partir daqui, e guardam
  uma cópia (`ANIME_PROVIDERS` em `ui-anime-test.js`) para quando o servidor não responde; um teste garante que a cópia é igual ao que o
  servidor regista.
- `POST /api/anime/stream` (`provider` omitido = zokoanime, como sempre).
- `GET /api/anime/<id>/hls-proxy` (e `GET /api/anime/hls-proxy`, o do zokoanime, mantido porque os endereços já entregues o usam).

## Acrescentar ou tirar uma source

`registry.register(mod, { origin: 'imported', replace })` e `registry.unregister(id)`. O id de uma que vem com a app nunca é tomado
nem removido. Uma source acrescentada fica no fim da lista (a ordem é a ordem de **fallback** do leitor). Quem as acrescenta é a importação
(abaixo), e o arranque da app (`loader.js`) para as que já estavam instaladas.

## Importar uma source (a interface)

Definições → Sources → **Import a source**, com o interruptor **Anime** ligado:

1. cola o texto do ficheiro e carrega em **Check**: a app lê-o **sem o correr**, mostra o que o ficheiro contém e o que declara, e guarda-o
   em staging com o nome do sha256;
2. **Install** instala exatamente esse ficheiro (nunca texto enviado no pedido) em `data/anime-sources/<id>.js`, com `.bak` se
   substituir uma importada. Uma importada **tem** de declarar `meta.stream`, não pode trazer relay e nunca substitui nem remove uma das
   cinco que vêm com a app. No arranque, `loader.js` carrega as instaladas; um ficheiro mau é saltado com aviso, nunca é fatal;
3. a source instalada liga-se sozinha em Definições → Sources → Anime Sources, no **fim** da lista (a ordem é a de fallback do leitor);
   **Uninstall** tira-a da lista guardada.

As quatro rotas (`/api/anime/sources/import/preview`, `.../install`, `.../test`, `/api/anime/sources/uninstall`) são locais
(`PRIVILEGED_ROUTES` e `requireThisComputer`), com limite de pedidos, e o corpo é trocado por um resumo antes de poder ser registado.

## O Test ao vivo

O botão **Test** da linha de cada source importada corre, **quando a pessoa o pede**, a lista do que faz um episódio tocar, contra o site
real e **a seguir o vídeo pelo relay da app**: o stream, a playlist, uma variante, o primeiro segmento, as legendas, um título que não
existe e um episódio além do fim. **Não toca nem descodifica nada: nunca há som.** Tem orçamento (24 chamadas, 600 ms entre elas, 60 s por
chamada, para à 3.ª falha seguida ou aos 4 min), nunca resolve um desafio nem faz login, e num stream cifrado vai buscar a chave pela app
e exige 16 bytes. "Verificada" quer dizer que nada falhou e que o stream, a playlist e o segmento passaram. Se a corrida pára porque a
proteção anti-bot do site recusou o browser da app, o relatório di-lo claramente (não é necessariamente um banimento do teu IP).
Enquanto corre, as verificações de saúde em segundo plano não pedem nada a ninguém.

## Estudar um site de anime antes de escrever a source

`source-lab probe <url> --data "/caminho/dos/dados"`: o caminho de onde vêm os dados (a API) é pedido uma vez, porque um site pode abrir as
páginas a um pedido simples e guardar os dados atrás de uma proteção própria (o `probe` só às páginas diria `open`). Um caminho de dados
recusado é *not-viable*, e a app não imita um browser para o contornar. Não há gerador por motor para anime: a source escreve-se à mão
(ou com a skill `add-source`), cumprindo este contrato.

## O que ainda falta

Um gerador por motor (os sites de anime não partilham um) e guardar o resultado do último Test (o de manga guarda). As escolhas de
visibilidade por defeito (`visibleAnimeProviders`, em `ui-settings.js`) continuam a ser da pessoa: uma source nova aparece nas Definições
e, ao instalar, liga-se no fim da lista.
