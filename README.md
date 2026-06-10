# pje-downloader

Bulk-download every document of a process in Brazil's **PJe** (Processo Judicial Eletrônico) — specifically the **TRF1** deployment — by driving the court's own document viewer with [Playwright](https://playwright.dev/).

A single process, especially an old one, can carry hundreds or thousands of documents: petitions, decisions, certificates, appended cases (*apensos*), bound volumes, plus attached media. PJe lets you read them one at a time in a viewer. There is no "download everything" button. This is that button.

## Why it has to drive the viewer

The obvious approach — loop over document ids and hit the download URL — doesn't work. `/documento/download/{id}` only serves a document **after it has been selected in the viewer during your session**. Ask for an id you haven't opened and you get a 404. Access is gated by the viewer's session state on top of the usual layers: Keycloak SSO, a sticky-session cookie, and Imperva/Incapsula bot cookies.

So the only dependable way to get the bytes is to actually drive the real, logged-in viewer. You log in yourself (automating the login is a losing fight against the bot protection), open the process, and the script walks the timeline document by document, pulling each file with the access the viewer just granted it.

## What you get

- Every **PDF** saved with a readable, sortable filename.
- **HTML-bodied documents** (the "migração" / "seguem mídias" manifestations) rendered to PDF.
- **Video / binary attachments** recorded as a small Markdown stub containing the direct download link — it does *not* pull gigabytes of media on your behalf.
- A **manifest** CSV of everything captured and a **failures** CSV for anything that genuinely couldn't be fetched.
- **Resumable** runs: stop it whenever, start it again, and it continues where it left off.

## How it works

A few things are worth explaining, because PJe's viewer makes you earn it.

**Position is the source of truth.** The viewer has no "go to document N" field — only *first / previous / next / last* buttons. So each document is identified by its pager position (`N de TOTAL`), and its real id, title and *juntada* (filing) date are read straight from the detail-panel header. The loop never assumes where it is; it reads where it is, every step. That's also what makes it survivable when the page reloads under you.

**Three kinds of document, told apart by the live iframe.** PJe shows a PDF in `framePdf`, an HTML body in `frameHtml`, and media in `frameBinario`. The script branches on whichever is present:

- **PDF** → fetch the bytes with an in-page `fetch()` (which carries your session) and check the `%PDF` header.
- **HTML** → fetch the body and render it to a PDF in a second, *headless* browser. (Chromium's `page.pdf()` only works headless, and the main viewer has to stay headed so you can log in.)
- **video / binary** → write a `.md` stub with the title, id, date and the authenticated download link, so you can grab the media by hand if you need it.

**Readable filenames.** Output looks like:

```
0003 - ID 123456789 2021.08.03 - Decisão - <short description>.pdf
```

The zero-padded number is the document's position in the timeline (so files sort in order), and the date is the juntada date.

**Built for a flaky server.** Court infrastructure throws intermittent **502 Bad Gateway**s, and a 502 can reload the viewer out from under you. The download loop is written around that: it reads the live position every step, and when a fetch or the page itself fails with a *transient* error it **waits and retries the same document** with escalating backoff (2s → 4s → 8s → 15s → 30s). It never marches past a document it hasn't actually saved — which was the whole point. A genuinely unrecoverable document goes to the failures file; a long outage stops the run cleanly with progress saved.

**Resume.** After each saved document it records the *frontier* — the lowest position not yet captured — in `_state.json`. On the next run it fast-forwards back to there and carries on; anything already on disk is skipped without re-downloading. If the checkpoint is missing it reconstructs the frontier from the manifest (the first gap in the sequence).

## Requirements

- **Node 18+** (or Bun) — it's a single plain CommonJS script, no build step.
- **Playwright** and a Chromium build.
- A **headed display**. It must run headed so you can log in, so on Linux/WSL2 you need a working X / WSLg display.

## Setup

```bash
git clone https://github.com/oscaromsn/pje-downloader.git
cd pje-downloader

npm install
npx playwright install chromium             # browser binary
sudo npx playwright install-deps chromium   # Linux system libraries (NSS, GTK, …)
```

## Usage

```bash
node pje-download.js        # or:  npm start  /  bun run pje-download.js
```

1. A Chromium window opens on the PJe login page (first run only — the profile is saved for next time). **Log in.**
2. Open the process you want, and make sure its timeline and document viewer are visible. Opening it in a new tab is fine — the script finds the right one.
3. Switch back to the terminal and press **ENTER**.
4. It reads the process number and document count, then works through everything. Leave it running. Press **Ctrl-C** at any point and re-run to resume.

## Output layout

```
downloads/<process-number>/
  0001 - ID 123456789 2021.08.03 - Petição Inicial.pdf
  0002 - ID 123456790 2021.08.03 - Documentos Diversos - ....pdf
  0004 - ID 123456792 2021.08.03 - Arquivo de vídeo - ....md     # media: reference stub
  _manifest.csv     # seq,id,type,description,status,bytes,contentType,file
  _failures.csv     # documents that couldn't be captured after retries
  _state.json       # resume checkpoint
```

`downloads/`, the run CSVs, the checkpoint, and `.pje-profile/` (your saved session) are all git-ignored — they hold case data and your login, and never belong in version control.

## Caveats & scope

- It targets **TRF1** (`pje1g.trf1.jus.br`). The approach carries over to other PJe deployments, but the selectors and iframe names will likely need adjusting.
- **You log in yourself.** The script never sees or stores your password; the only thing persisted is the browser profile on your own disk.
- It's deliberately gentle — a short pause between documents, and it backs off instead of hammering when the server is unhappy. Please keep it that way, and only run it on cases you're authorized to access.
- The HTML→PDF renderer is unauthenticated, so any session-gated images embedded in an HTML body won't load. The text still renders, which is what these particular manifestations actually contain.

## License

[MIT](LICENSE)
