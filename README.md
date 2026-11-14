# ScapeScroll

A self-hosted manga and anime reader that comes with **no sources at all**. You bring the sites.

ScapeScroll reads your own files (CBZ, CBR, ZIP, PDF, EPUB), keeps your library and reading progress, syncs with AniList, and can read from online sites through source files you add yourself. This edition ships **none**: the catalog starts empty, nothing adult is listed until you turn that on, and every site in your library is one you chose.

> This project does not host, index or distribute any content. A source is a small script that reads a public site the way a browser would. What you add, and whether you are allowed to read it, is up to you.

## What is in it

| | |
|---|---|
| **Empty catalog** | Nothing is bundled. The home page tells you what to do. Not even the usual extension repository is listed until you paste its address. |
| **Extension repositories** | **Settings → Advanced → Source catalog**: paste the address of a repository of Mihon-compatible extensions (the project address, or its `index.min.json`). The catalog lists its sites; you pick the ones you want. Several repositories can be added and each can be removed. |
| **Sources from a link** | For a site built on a theme the app knows (Madara, MangaThemesia, Iken, Keyoapp, VineTheme) it writes the source itself. The site is looked at first (Cloudflare and other anti-bot services, a login, `robots.txt`, an empty JavaScript shell) and a site that cannot work is refused with the reason. What is written goes through a check before anything is installed. |
| **Hide NSFW on from the start** | The catalog lists nothing adult until you turn it off in **Settings → Filters**. A genre blacklist and a per-title override are there too. |
| **AniList** | Reading progress and scores sync up; "You might also like" on a title's page comes from AniList's own recommendations; the home page's *Recommended For You* learns from your AniList statistics. A title is only matched to an AniList entry when it is clearly the same one (name, year, author). |
| **Local files** | CBZ, CBR, ZIP, PDF and EPUB through the same reader, with a reflowable view for EPUB. |
| **Library** | Favourites, custom lists, reading status, display modes, release calendar, reviews and ratings, achievements and themes, an OPDS feed for e-reader apps. |
| **Anime** | The same library, history and AniList tracking for anime, through anime source files you add. |
| **Backup** | Export and import of the whole library. |

There is **no Suwayomi engine** in this edition, and so no Suwayomi tab.

## Running it

### The portable `.exe` (Windows)

Download `ScapeScroll-<version>-win.exe` from [Releases](../../releases), put it in a folder of its own (for example `Documents\ScrollScape`) and run it. Nothing is installed in Windows; the library lives in that folder. To remove it, close the app and delete the folder.

Windows may say the publisher is unknown the first time (the app is not signed): *More info* → *Run anyway*.

### From source

Needs Node.js 24.

```bash
npm ci
SCROLLSCAPE_EDITION=sourceless npm start
```

Then open `http://localhost:4000`. (On Windows the npm scripts expect the portable Node in `tools/node/`; without it, run `node server.js` directly.)

### Docker

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

The compose file publishes the port on `127.0.0.1` only. Behind the port mapping every client looks remote to the app, so settings, installs and backup answer 403 until you set an **Access Password** once, from inside the container. To let a phone on your own network in, change the port mapping **and** set the password.

Installing a source or adding a repository is refused from another device even with the password, because it installs code. A container can never be "this computer", so there is an opt-in: **Settings → Security → Allow installing sources from other devices**, or start the app with `SCROLLSCAPE_ALLOW_REMOTE_IMPORT=1`. Either way the request must carry a valid login.

## The edition

The code is one code base with editions. `edition.json` (written by the build) or the `SCROLLSCAPE_EDITION` environment variable names the edition; `sourceless` empties the catalog and turns Hide NSFW on. Building the `.exe`:

```bash
node tools/build-light.js --edition sourceless --allow-list build-assets/sourceless-sources.json --output dist/ScrollScapeSourceless-win.exe --icon
```

## Safety

- The server listens on loopback by default.
- Privileged routes (settings, installing a source, backup) are refused from another device until an Access Password is set.
- Every page a source reads goes through the app's own address check (no private network addresses, no redirects into them).
- A source file is checked before it is installed, and a host on your own list of dangerous sites is never contacted.

## Development

```bash
npm test        # the unit tests
npm run lint
npm run smoke
```

`GUIDELINES.md` holds the rules the code follows, and `docs/` explains how a source is written.
