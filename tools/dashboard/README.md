# ScrollScape Dashboard

Uma consola de monitorização em modo terminal para uma instância do ScrollScape a
correr — saúde das sources de manga e anime, o estado do FlareSolverr e da API da
AniList, um catálogo de erros recentes agrupados por tipo (com sugestão de ação),
resumo da biblioteca, downloads em massa em curso, e uso de recursos (CPU, RAM —
incluindo o heap do V8 separado do RSS total, rede) do próprio processo do
servidor. Feita em Python com [Textual](https://github.com/Textualize/textual).

É um cliente **só de leitura**: liga-se pela API REST já existente do ScrollScape
(`/api/system/health`, `/api/library`, `/api/download/bulk/jobs`, etc.), sem tocar
no `store.json` nem no processo Node — corre em paralelo com o servidor normal e
com a interface web, sem interferir com nenhum dos dois.

## Instalar

```bash
pip install -r requirements.txt
```

## Correr

Com o ScrollScape já a correr (ex. via `Launch-ScrollScape.bat` ou `npm start`):

```bash
python dashboard.py
```

Por defeito liga a `http://localhost:4000`. Para apontar a outra instância/porta:

```bash
python dashboard.py --url http://192.168.1.50:4000
```

Se a instância tiver uma password definida (Settings → proteção de acesso):

```bash
python dashboard.py --password "a-tua-password"
```

ou define `SCROLLSCAPE_PASSWORD` no ambiente em vez de passar em texto simples na
linha de comandos.

## Teclas

- `r` — reinicia o servidor ScrollScape (só funciona quando lançado a partir do
  `Launch-ScrollScape.bat` — ver abaixo; os dados dos painéis já atualizam
  sozinhos a cada 8s, `--interval` muda isto)
- `q` — sair

### Como funciona o restart

Esta app é um cliente HTTP só de leitura — não tem autoridade nenhuma sobre o
processo Node por si só. Ao premir `r`, sai de si mesma com um código de saída
especial (42); é o **`Launch-ScrollScape.bat`** (que já sabe matar e voltar a
lançar o `server.js`, e é quem lança este dashboard) que reconhece esse código
e faz o restart de verdade, voltando a abrir o dashboard automaticamente assim
que o servidor estiver outra vez no ar. Se correres `python dashboard.py`
diretamente (fora do `.bat`), `r` ainda sai com esse código, mas não há nada do
outro lado a fazer o restart — a consola simplesmente fecha.

## "Could not reach http://localhost:4000" com o servidor a correr

Se este painel aparecer a vermelho enquanto os outros três painéis mostram dados
reais (Library Snapshot, Active Downloads, Resource Usage) — o servidor está de
facto no ar, o problema é só o painel **Server & Sources**. `/api/system/health`
sonda todas as sources instaladas e serviços externos (FlareSolverr, AniList) em
paralelo, e pode legitimamente demorar vários segundos, sobretudo com várias
sources atrás da mesma instância do FlareSolverr em fila. Este dashboard já dá a
este pedido específico um timeout próprio, mais largo do que os outros endpoints
(rápidos, <1s) — se mesmo assim continuares a ver isto persistentemente, confirma
primeiro que o FlareSolverr está mesmo a responder (o próprio painel mostra o
estado dele, "Reachable vX.X.X" ou um erro) antes de assumir que é o servidor
Node que está em baixo.

## Nota sobre Windows

Mensagens de erro de sources com acentos (ex. "indisponível") podem aparecer
corrompidas na consola `cmd.exe` clássica devido à codepage por defeito. Usa o
Windows Terminal (ou PowerShell 7+) para Unicode correto — ou corre
`chcp 65001` antes de `python dashboard.py` na `cmd.exe` antiga.

## O que NÃO mostra (ainda)

O progresso em tempo real de um import do AniList não é visível aqui — esse
pipeline corre inteiramente no browser (`public/modules/anilist.js`), não no
servidor, por isso não há nada para este dashboard consultar durante um import a
decorrer. O que dá para ver é o resumo da **última** sincronização já concluída
(`GET /api/anilist/sync-meta`).
