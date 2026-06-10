#!/usr/bin/env node
// pje-download.js
// Bulk-download all documents (incl. nested attachments) of a PJe (TRF1) process.
//
// WHY Playwright and not plain fetch:
//   The endpoint /documento/download/{id} only serves a document AFTER it has been
//   "selected" in the viewer during the session (unselected IDs return HTTP 404).
//   Driving the real viewer guarantees access and reuses your logged-in session,
//   Keycloak SSO, sticky-session cookie and Imperva/Incapsula bot cookies.
//
// SETUP (one-time):
//   npm i playwright && npx playwright install chromium   # browser binaries
//   sudo npx playwright install-deps chromium             # Linux system libs (NSS, GTK, ...)
//   # On WSL2, headed mode needs WSLg (Win11); DISPLAY is set for you automatically.
//
// USAGE:
//   1) bun run pje-download.js          (or node pje-download.js)
//   2) A browser opens using a persistent profile (.pje-profile/). On the FIRST run,
//      log in yourself; later runs reuse the saved session. Open the target process so
//      the timeline + document viewer are visible, then press ENTER in the terminal.
//      The script re-selects whichever tab holds the viewer, so opening it in a new
//      tab is fine.
//
// OUTPUT (filenames: "<seq> - ID <id> <YYYY.MM.DD> - <type> - <desc>.<ext>"):
//   ./downloads/<process>/0001 - ID <id> 2021.08.03 - Petição Inicial.pdf        (PDF & HTML docs)
//   ./downloads/<process>/0004 - ID <id> 2021.08.03 - Arquivo de vídeo - ....md   (video/binary: reference stub)
//   ./downloads/<process>/_manifest.csv      (seq,id,type,description,status,bytes,contentType,file)
//   ./downloads/<process>/_failures.csv      (only PDF/HTML captures that failed after retries)

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DOWNLOAD_BASE = '/pje/seam/resource/rest/pje-legacy/documento/download/';
const THROTTLE_MS   = 600;   // pause between documents — be gentle with the court server
const NAV_TIMEOUT   = 20000; // max wait for a navigation step to settle
const MAX_RETRIES   = 3;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ask   = (q) => new Promise(res => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, a => { rl.close(); res(a); });
});

// ---- filesystem-safe filename builder -------------------------------------
function sanitize(s, max = 120) {
  return (s || '')
    .normalize('NFC')
    .replace(/[\/\\:*?"<>|\u0000-\u001F]/g, ' ') // illegal FS chars
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/[ .]+$/, '');                       // no trailing dot/space (Windows)
}

// Splits "Documentos Diversos (1 AIDF Nº ... fiscais)" -> {type, desc}
// Keeps the parenthetical text as the description, per requirement.
function splitTitle(fullTitle) {
  // fullTitle is already "<type> (<desc>)" or just "<type>"
  const m = fullTitle.match(/^(.*?)\s*\((.*)\)\s*$/s);
  if (m) return { type: m[1].trim(), desc: m[2].trim() };
  return { type: fullTitle.trim(), desc: '' };
}

// Builds "0003 - ID 123456789 2021.08.03 - Type - Desc.ext" (date/desc omitted when
// absent, so a doc with no description has no trailing " - " before the extension).
function buildName(seq, id, date, type, desc, ext) {
  const seqStr = String(seq).padStart(4, '0');
  const datePart = date ? ' ' + date : '';
  let base = `${seqStr} - ID ${id}${datePart} - ${sanitize(type, 60)}`;
  if (desc) base += ` - ${sanitize(desc, 90)}`;
  return base + '.' + ext;
}

// Markdown reference stub for non-renderable docs (videos/binary). Records title, id,
// juntada date and the authenticated download link — no large media is fetched.
function buildStubMd(seq, total, cur, type, desc) {
  const link = cur.contentId ? DOWNLOAD_BASE + cur.contentId : '';
  return [
    `# ${cur.id} - ${type}${desc ? ' (' + desc + ')' : ''}`,
    ``,
    `- **ID:** ${cur.id}`,
    `- **Tipo:** ${type}`,
    desc ? `- **Descrição:** ${desc}` : null,
    cur.juntada ? `- **${cur.juntada}**` : (cur.date ? `- **Data de juntada:** ${cur.date}` : null),
    `- **Sequência:** ${seq} de ${total}`,
    link ? `- **Download:** ${link}` : null,
    ``,
    `> Arquivo de vídeo/mídia — não renderizável para PDF. Baixar manualmente pelo link acima dentro da sessão autenticada.`,
    ``,
  ].filter(v => v !== null).join('\n');
}

// ---------------------------------------------------------------------------
async function main() {
  // Persistent profile: log in to PJe ONCE; cookies (incl. the Imperva/Incapsula
  // bot cookies and Keycloak session) persist across runs. Everything stays inside
  // WSLg — no cross-OS DevTools networking needed.
  const profileDir = path.join(__dirname, '.pje-profile');
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    acceptDownloads: false,
    args: ['--no-sandbox'],
  });
  let page = context.pages()[0] || await context.newPage();

  console.log('\nOpening PJe. Log in (first run only) and open the target process (timeline + viewer visible).');
  await page.goto('https://pje1g.trf1.jus.br/pje/login.seam', { waitUntil: 'domcontentloaded' }).catch(()=>{});
  await ask('\n>> When the process is fully open in the viewer, press ENTER to begin... ');

  // PJe opens the process viewer in a (possibly new) tab, and the original login tab
  // may be closed by then. Re-select the live tab that actually hosts the viewer,
  // rather than trusting the page captured at launch.
  page = await findViewerPage(context);
  if (!page) {
    console.error('No open tab contains the document viewer (framePdf). Open the process autos and retry.');
    await context.close();
    return;
  }
  await page.bringToFront();

  // Read process number + total count from the page
  const meta = await page.evaluate(() => {
    let pager = null;
    document.querySelectorAll('*').forEach(el => {
      if (el.children.length === 0 && /^\d+\s+de\s+\d+$/.test((el.textContent||'').trim()))
        pager = el.textContent.trim();
    });
    const total = pager ? parseInt(pager.split('de')[1].trim(), 10) : null;
    const proc = (document.title.match(/[\d.-]{20,}/) || [])[0] || 'processo';
    return { total, proc };
  });
  if (!meta.total) { console.error('Could not read document count. Is a document open in the viewer?'); await context.close(); return; }

  const outDir = path.join('downloads', sanitize(meta.proc, 60));
  fs.mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, '_manifest.csv');
  // Decide on the header BEFORE opening the append stream — createWriteStream opens
  // the file lazily, so statSync here would ENOENT on a brand-new case directory.
  const needHeader = !fs.existsSync(manifestPath) || fs.statSync(manifestPath).size === 0;
  const manifest = fs.createWriteStream(manifestPath, { flags: 'a' });
  const failures = fs.createWriteStream(path.join(outDir, '_failures.csv'), { flags: 'a' });
  if (needHeader)
    manifest.write('seq,id,type,description,status,bytes,contentType,file\n');

  const csv = (v) => `"${String(v).replace(/"/g,'""')}"`;

  console.log(`\nProcess: ${meta.proc}\nTotal documents (incl. attachments): ${meta.total}\nSaving to: ${outDir}\n`);

  // Resume: _state.json stores the frontier (lowest position not yet captured).
  // downloadAll is position-authoritative, so resume is robust — we re-position near
  // the frontier, then capture every remaining position exactly once, skipping
  // anything already on disk.
  const statePath = path.join(outDir, '_state.json');
  let resumeFrom = 1;
  let st = readState(statePath);
  if (!st) { const d = deriveResumeFromManifest(manifestPath); if (d) st = { proc: meta.proc, total: meta.total, ...d }; }
  if (st && st.proc === meta.proc && meta.total >= (st.total || 0)) {
    const f = Number.isInteger(st.frontier) ? st.frontier
            : (Number.isInteger(st.lastSeq) ? st.lastSeq + 1 : 1); // back-compat with old checkpoints
    resumeFrom = Math.min(Math.max(f, 1), meta.total);
  }

  // Best-effort initial positioning near the frontier (downloadAll self-corrects if
  // this doesn't land exactly).
  await fastForward(page, resumeFrom, meta.total);
  if (resumeFrom > 1) console.log(`Resuming at ${resumeFrom}/${meta.total} — skipping ${resumeFrom - 1} completed docs.`);

  // Position-authoritative download: drives off the live pager position, so a 502
  // that drops the viewer elsewhere is handled by capturing whatever we land on and
  // walking toward the frontier — never a silent skip. (See downloadAll.)
  const io = { outDir, statePath, manifest, failures, csv };
  const result = await downloadAll(page, context, meta, resumeFrom, io);
  page = result.page;
  const { downloaded, skipped } = result;

  console.log(`\nDone. Downloaded: ${downloaded}, skipped/failed: ${skipped}.`);
  console.log(`Manifest: ${path.join(outDir,'_manifest.csv')}\nFailures: ${path.join(outDir,'_failures.csv')}`);
  manifest.end(); failures.end();
  await ask('Press ENTER to close the browser... ');
  await context.close();
  await closeHtmlRenderer();
}

// Pick the live tab that hosts the PJe document viewer (framePdf). Opening a case
// opens a NEW tab, so scan newest-first — the most recently opened viewer wins over
// any stale case tab left open from before.
async function findViewerPage(context) {
  const open = context.pages().filter(p => !p.isClosed()).reverse();
  for (const p of open) {
    try { if (await p.evaluate(() => !!document.getElementById('framePdf'))) return p; } catch (e) {}
  }
  return open.find(p => p.url().includes('pje1g.trf1.jus.br')) || open[0] || null;
}

// Step the viewer one document in `dir` ('next'|'prev') and wait until the header ID
// *or* pager position changes. We can't watch framePdf: HTML docs never touch it.
async function step(page, dir) {
  const sel = dir === 'prev' ? 'documentoAnterior' : 'proximoDocumento';
  const before = await readCurrent(page);
  await page.locator(`[id$='${sel}']`).click({ timeout: 5000 }).catch(()=>{});
  for (let i = 0; i < NAV_TIMEOUT/400; i++) {
    await sleep(400);
    const now = await readCurrent(page);
    if (now && (now.id !== before.id || now.pos !== before.pos)) return;
  }
}
async function advance(page) { return step(page, 'next'); }

// Fast-forward (resume): the viewer has no jump-to-N control, so reach `target` by
// stepping — approaching from primeiro/ultimo (whichever is closer) and driving off
// the pager position, which self-corrects for a missed step. Does NONE of the per-doc
// capture work (no fetch/throttle/write). Returns true iff it lands exactly on target.
async function fastForward(page, target, total) {
  const backward = target > total / 2;
  await page.locator(backward ? "[id$='ultimoDocumento']" : "[id$='primeiroDocumento']").click({ timeout: 5000 }).catch(() => {});
  await sleep(1500);
  return seekTo(page, target, total);
}

// Step from the CURRENT position to `target` (no end-reset), driven by the pager so a
// missed step self-corrects. Tolerant of transient blank reads (waits within a budget,
// then gives up). Used by both fastForward and post-502 recovery.
async function seekTo(page, target, total) {
  let c = await readCurrent(page);
  let guard = 0, blanks = 0;
  while (guard <= total + 8) {
    if (!c || c.pos == null) { if (++blanks > 12) break; await sleep(500); c = await readCurrent(page); continue; }
    if (c.pos === target) return true;
    blanks = 0;
    await step(page, c.pos < target ? 'next' : 'prev');
    c = await readCurrent(page);
    guard++;
  }
  return !!(c && c.pos === target);
}

// Recover after a context loss (transient 502/navigation): let the page settle and
// re-acquire the viewer tab. It deliberately does NOT seek to a position — the
// position-authoritative loop captures whatever the reload left us on and walks to the
// frontier, so a blind silent seek (which would skip undownloaded docs) is wrong here.
// Returns the live page, or null if the tab is truly lost.
async function recoverViewer(context, page) {
  await sleep(2000);
  let p = page;
  try { if (p && !p.isClosed()) await p.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }); } catch (e) {}
  if (!p || p.isClosed() || !(await readCurrent(p))) {
    const fresh = await findViewerPage(context);
    if (fresh) p = fresh;
  }
  if (!p || p.isClosed()) return null;
  await p.bringToFront().catch(() => {});
  return p;
}

// Capture the document currently shown (`cur`) under sequence number `seq` (== its
// pager position). Skips when already on disk; else fetches/renders by type and writes
// the manifest on success. Returns { ok, already, status } — the caller decides whether
// a failure is transient (retry) or permanent (log). Pure capture — no navigation.
async function captureCurrent(page, cur, seq, io, meta) {
  const { outDir, manifest, csv } = io;
  const rawTitle = (cur.title || '').replace(/^\d+\s*-\s*/, '');
  const { type, desc } = splitTitle(rawTitle);
  const renderable = cur.kind === 'pdf' || cur.kind === 'html';
  const fileName = buildName(seq, cur.id, cur.date, type, desc, renderable ? 'pdf' : 'md');
  const filePath = path.join(outDir, fileName);

  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
    console.log(`[${seq}/${meta.total}] have ${cur.id}  ${type}`);
    return { ok: true, already: true, status: 200 };
  }

  let ok = false, lastStatus = 0, bytes = 0, contentType = cur.kind;
  if (cur.kind === 'pdf') {
    for (let attempt = 1; attempt <= MAX_RETRIES && !ok; attempt++) {
      const res = await fetchBytes(page, DOWNLOAD_BASE + cur.contentId);
      lastStatus = res.status; bytes = res.len;
      if (res.status === 200 && res.isPdf && res.b64) {
        fs.writeFileSync(filePath, Buffer.from(res.b64, 'base64'));
        ok = true; contentType = 'application/pdf';
      } else if (attempt < MAX_RETRIES) { await sleep(1000 * attempt); }
    }
  } else if (cur.kind === 'html') {
    for (let attempt = 1; attempt <= MAX_RETRIES && !ok; attempt++) {
      const res = await fetchText(page, DOWNLOAD_BASE + cur.contentId);
      lastStatus = res.status; bytes = res.len;
      if (res.status === 200 && res.html) {
        try {
          const pdfBuf = await htmlToPdf(await htmlRenderer(), res.html, page.url());
          fs.writeFileSync(filePath, pdfBuf);
          ok = true; bytes = pdfBuf.length; contentType = 'text/html→pdf';
        } catch (e) { if (attempt < MAX_RETRIES) await sleep(1000 * attempt); }
      } else if (attempt < MAX_RETRIES) { await sleep(1000 * attempt); }
    }
  } else {
    const md = buildStubMd(seq, meta.total, cur, type, desc);
    fs.writeFileSync(filePath, md, 'utf8');
    ok = true; bytes = Buffer.byteLength(md); contentType = cur.contentId ? 'video/md-stub' : 'media/md-stub';
  }

  if (ok) {
    manifest.write([seq, cur.id, csv(type), csv(desc), 200, bytes, csv(contentType), csv(fileName)].join(',')+'\n');
    console.log(`[${seq}/${meta.total}] OK  ${cur.id}  ${type}${desc?' ('+desc.slice(0,40)+'…)':''}  [${contentType}]`);
  }
  // Failure is NOT logged here: the caller distinguishes a transient 502 (retry) from a
  // permanent failure (log + move on), so it owns the failures.csv write.
  return { ok, already: false, status: lastStatus };
}

// Position-authoritative download loop. A document's identity is its pager position,
// never a private counter — so after a 502 reload that drops the viewer at a different
// document, we capture whatever position we're on (if still needed) and SINGLE-STEP
// toward the frontier (lowest not-yet-done position). That makes the post-502 backward
// walk *productive* (it downloads on the way) rather than a silent skip, and guarantees
// every position in [resumeFrom..total] is captured exactly once. Already-on-disk docs
// are skipped via existsSync; recovery only re-acquires the tab (no blind seek).
async function downloadAll(page, context, meta, resumeFrom, io) {
  const total = meta.total;
  const done = new Set();
  for (let p = 1; p < resumeFrom; p++) done.add(p); // checkpoint trusts everything below the frontier
  let frontier = resumeFrom;
  const advanceFrontier = () => {
    const before = frontier;
    while (frontier <= total && done.has(frontier)) frontier++;
    if (frontier !== before) saveState(io.statePath, meta, frontier);
  };
  advanceFrontier();

  let downloaded = 0, skipped = 0;
  // Outage handling. A 502 fails BOTH the document fetch and navigation, so we must
  // NEVER march past undownloaded docs — we wait (escalating backoff) and retry the
  // SAME position until the server recovers. Only a genuinely permanent failure (e.g. a
  // non-PDF body) is logged and skipped; a sustained outage stops the run with progress
  // saved, so nothing is lost.
  const BACKOFFS = [2000, 4000, 8000, 15000, 30000, 30000];
  const MAX_OUTAGE_MS = 6 * 60 * 1000;
  const transient = (s) => s === -1 || s === 0 || s === 408 || s === 429 || (typeof s === 'number' && s >= 500 && s <= 599);
  let outageSpent = 0, outageStreak = 0, lastSize = -1, stall = 0;
  const STALL_LIMIT = 60;
  const backoff = async () => {
    const ms = BACKOFFS[Math.min(outageStreak, BACKOFFS.length - 1)];
    console.warn(`  ...server hiccup near doc ${frontier}; waiting ${Math.round(ms/1000)}s then retrying (nothing skipped)`);
    await sleep(ms);
    outageSpent += ms; outageStreak++; stall = 0;
    page = await recoverViewer(context, page) || page; // a 502 may have reloaded the viewer
  };

  while (done.size < total) {
    // Backstop for a genuinely stuck navigation (server outages are covered by the time
    // budget below): if nothing is marked done for many spins, stop.
    if (done.size !== lastSize) { lastSize = done.size; stall = 0; }
    else if (++stall > STALL_LIMIT) { console.error(`No progress near doc ${frontier}; stopping. Progress saved -- re-run to resume.`); break; }

    try {
      // settle-read whatever document the viewer currently shows
      let cur = null;
      for (let w = 0; w < NAV_TIMEOUT/500; w++) {
        cur = await readCurrent(page);
        if (cur && cur.id && cur.pos != null && cur.contentId) break;
        await sleep(500);
      }
      if (!cur || !cur.id || cur.pos == null) cur = await readCurrent(page);

      // Viewer unreadable -> mid-reload / outage. Wait & retry; never skip the doc.
      if (!cur || !cur.id || cur.pos == null) {
        if (outageSpent > MAX_OUTAGE_MS) { console.error(`Viewer unreadable too long near doc ${frontier}; stopping. Progress saved -- re-run to resume.`); break; }
        await backoff();
        if (!page) { console.error('Lost the viewer tab; aborting. Progress saved -- re-run to resume.'); break; }
        continue;
      }
      const P = cur.pos;

      // Capture this position if it's in range and still needed.
      if (P >= 1 && P <= total && !done.has(P)) {
        const res = await captureCurrent(page, cur, P, io, meta);
        if (res.ok) {
          downloaded++; done.add(P); advanceFrontier();
          outageStreak = 0; outageSpent = 0;
          if (!res.already) await sleep(THROTTLE_MS);
        } else if (transient(res.status)) {
          // 502/503/network on THIS doc -> wait and retry it; do NOT mark it done or step
          // past it (that was the bug: a backward "skip" of undownloaded docs).
          if (outageSpent > MAX_OUTAGE_MS) { console.error(`Server unavailable too long at doc ${P}; stopping. Progress saved -- re-run to resume.`); break; }
          await backoff();
          if (!page) break;
          continue;
        } else {
          // permanent failure (e.g. a genuine non-PDF) -> log once and move on
          skipped++; done.add(P); advanceFrontier();
          outageStreak = 0; outageSpent = 0;
          io.failures.write([P, cur.id, '', '', res.status, io.csv(cur.kind)].join(',')+'\n');
          console.warn(`[${P}/${total}] FAIL ${cur.id} (${cur.kind}, status ${res.status}) -- permanent; see _failures.csv`);
        }
      }
      if (done.size >= total) break;

      // single-step toward the frontier (productive: downloads whatever undone doc we land on)
      await step(page, P > frontier ? 'prev' : 'next');
    } catch (e) {
      const msg = String((e && e.message) || e).split('\n')[0];
      console.warn(`recovering after error near doc ${frontier}: ${msg}`);
      if (outageSpent > MAX_OUTAGE_MS) { console.error('Persistent errors; stopping. Progress saved -- re-run to resume.'); break; }
      await backoff();
      if (!page) { console.error('Lost the viewer tab; aborting. Progress saved -- re-run to resume.'); break; }
    }
  }
  return { downloaded, skipped, page };
}

// Resume checkpoint: the frontier (lowest position not yet captured), persisted so a
// restart skips re-downloading. Position-based (stable), not filename-based.
function readState(statePath) {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (e) { return null; }
}
function saveState(statePath, meta, frontier) {
  try { fs.writeFileSync(statePath, JSON.stringify({ proc: meta.proc, total: meta.total, frontier, ts: Date.now() })); } catch (e) {}
}
// Fallback when _state.json is absent (e.g. first run after adding checkpoints): derive
// the frontier from the manifest as the lowest position NOT yet captured (the first
// gap). seq is the first unquoted integer column, so it parses safely even though
// later columns are quoted. Bidirectional capture can write rows out of order, so we
// scan for the first gap rather than trusting the max.
function deriveResumeFromManifest(manifestPath) {
  try {
    const have = new Set();
    let max = 0;
    for (const line of fs.readFileSync(manifestPath, 'utf8').split('\n')) {
      const m = line.match(/^(\d+),/);
      if (m) { const s = parseInt(m[1], 10); have.add(s); if (s > max) max = s; }
    }
    if (!max) return null;
    let f = 1; while (have.has(f)) f++; // first gap = frontier
    return { frontier: f };
  } catch (e) { return null; }
}

// Retry a page.evaluate through a transient navigation / context teardown (e.g. a 502
// that briefly reloads the viewer). Non-transient errors surface immediately; throws
// only if still failing after `tries` transient retries.
const TRANSIENT_RE = /Execution context was destroyed|because of a navigation|frame (?:was )?detached|Target closed|Target page, context or browser has been closed|the page has been closed|net::ERR|502|Bad Gateway/i;
async function safeEval(page, fn, arg, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await page.evaluate(fn, arg); }
    catch (e) {
      lastErr = e;
      if (!TRANSIENT_RE.test(String((e && e.message) || e))) throw e;
      try { await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }); } catch (_) {}
      await sleep(600 * (i + 1));
    }
  }
  throw lastErr;
}

// Authoritative current-document signal: the detail-panel header (the document's own
// ID + full title) and the "N de TOTAL" pager. Render type is classified by which
// iframe is live — framePdf → PDF, frameHtml → HTML, neither → media. The HTML body's
// content id (which differs from the document's own id) is read off the iframe src.
// Tolerant: a transient 502/navigation yields null (callers re-read), never a throw.
async function readCurrent(page) {
  try { return await safeEval(page, () => {
    const h = document.querySelector("[id^='detalheDocumento'] .titulo-documento h3.media-heading")
           || document.querySelector(".detalhe-documento .titulo-documento h3.media-heading")
           || document.querySelector(".titulo-documento h3.media-heading")
           || document.querySelector("h3.media-heading");
    // PDF/media docs inject a PDF.js bootstrap <script> as the first child of the
    // heading, so h.textContent prepends that script source and breaks the ID regex.
    // Prefer the inner <a> (it never holds the script); else read text with <script>
    // stripped. HTML docs have no anchor/script and fall through to the clone path.
    let title = '';
    if (h) {
      const a = h.querySelector('a');
      if (a && /^\s*\d+\s*-/.test((a.textContent || '').trim())) {
        title = (a.textContent || '').replace(/\s+/g, ' ').trim();
      } else {
        const clone = h.cloneNode(true);
        clone.querySelectorAll('script').forEach(s => s.remove());
        title = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      }
    }
    const idm = title.match(/^\s*(\d+)\s*-/);          // "123456789 - Documentos Diversos..."
    const id = idm ? idm[1] : '';

    // Juntada date: a leaf <div> in the same titulo-documento panel, e.g.
    // "Juntado por … em 03/08/2021 09:16:34" → date "2021.08.03".
    let juntada = '';
    const tdoc = h ? h.closest('.titulo-documento') : document.querySelector('.titulo-documento');
    if (tdoc) {
      for (const el of tdoc.querySelectorAll('div')) {
        const x = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (el.children.length === 0 && /Juntad[oa].*em\s+\d{2}\/\d{2}\/\d{4}/.test(x)) { juntada = x; break; }
      }
    }
    const dm = juntada.match(/em\s+(\d{2})\/(\d{2})\/(\d{4})/);
    const date = dm ? `${dm[3]}.${dm[2]}.${dm[1]}` : '';

    let pager = '';
    document.querySelectorAll('*').forEach(el => {
      if (pager) return;
      if (el.children.length === 0 && /^\d+\s+de\s+\d+$/.test((el.textContent || '').trim()))
        pager = el.textContent.trim();
    });
    const pos = pager ? parseInt(pager.split('de')[0].trim(), 10) : null;

    const idFromSrc = (src) => {
      let cid = '';
      (((src || '').split('?')[1]) || '').split('&').forEach(p => {
        if (p.indexOf('file=') === 0) {
          try { const v = decodeURIComponent(p.slice(5)); const m = v.match(/download\/(\d+)/); if (m) cid = m[1]; } catch (e) {}
        }
      });
      if (!cid) { const m = (src || '').match(/download\/(\d+)/); if (m) cid = m[1]; } // frameHtml: bare download/{id}
      return cid;
    };
    const fp = document.getElementById('framePdf');
    const fh = document.getElementById('frameHtml');
    const fb = document.getElementById('frameBinario');
    let kind = 'media', contentId = '';
    if (fp)      { kind = 'pdf';     contentId = idFromSrc(fp.getAttribute('src')); }
    else if (fh) { kind = 'html';    contentId = idFromSrc(fh.getAttribute('src')); }
    else if (fb) { kind = 'binario'; contentId = idFromSrc(fb.getAttribute('src')); } // videos/binary: stub only

    return { id, title, pager, pos, kind, contentId, date, juntada };
  }); } catch (e) { return null; }
}

// In-page fetch — carries the viewer's authenticated, just-granted access to the doc.
async function fetchBytes(page, url) {
  try {
    return await safeEval(page, async (u) => {
      try {
        const r = await fetch(u, { credentials: 'same-origin' });
        const buf = await r.arrayBuffer(); const a = new Uint8Array(buf);
        const isPdf = a[0]===0x25 && a[1]===0x50 && a[2]===0x44 && a[3]===0x46; // %PDF
        let bin = ''; for (let i = 0; i < a.length; i++) bin += String.fromCharCode(a[i]);
        return { status: r.status, isPdf, b64: isPdf ? btoa(bin) : '', len: buf.byteLength };
      } catch (e) { return { status: -1, isPdf: false, b64: '', len: 0 }; }
    }, url);
  } catch (e) { return { status: -1, isPdf: false, b64: '', len: 0 }; } // context lost mid-fetch → retryable
}
async function fetchText(page, url) {
  try {
    return await safeEval(page, async (u) => {
      try {
        const r = await fetch(u, { credentials: 'same-origin' });
        const t = await r.text();
        return { status: r.status, html: t, len: t.length, ct: r.headers.get('content-type') || '' };
      } catch (e) { return { status: -1, html: '', len: 0, ct: '' }; }
    }, url);
  } catch (e) { return { status: -1, html: '', len: 0, ct: '' }; }
}

// HTML → PDF via a SEPARATE headless page (page.pdf() requires headless; the main
// authenticated viewer must stay headed). A <base> tag lets same-origin relative
// assets resolve; assets needing the session won't load in this unauthenticated
// context, but the document text still renders — adequate for the text-only
// "seguem mídias" manifestations. Launched lazily on the first HTML doc.
let _htmlBrowser = null, _htmlPage = null;
async function htmlRenderer() {
  if (_htmlPage) return _htmlPage;
  _htmlBrowser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  _htmlPage = await (await _htmlBrowser.newContext()).newPage();
  return _htmlPage;
}
async function closeHtmlRenderer() {
  if (_htmlBrowser) { await _htmlBrowser.close().catch(() => {}); _htmlBrowser = null; _htmlPage = null; }
}
async function htmlToPdf(htmlPage, html, baseURL) {
  const baseTag = `<base href="${baseURL}">`;
  const doc = /<head[^>]*>/i.test(html)
    ? html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`)
    : `<!doctype html><html><head><meta charset="utf-8">${baseTag}</head><body>${html}</body></html>`;
  await htmlPage.setContent(doc, { waitUntil: 'load', timeout: NAV_TIMEOUT }).catch(() => {});
  return htmlPage.pdf({ format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
}

// Run only when invoked directly; exported for tests when require()'d.
if (require.main === module) main();

module.exports = {
  readCurrent, fetchBytes, fetchText, htmlToPdf, htmlRenderer, closeHtmlRenderer,
  findViewerPage, advance, step, fastForward, seekTo, recoverViewer, safeEval,
  readState, saveState, deriveResumeFromManifest, captureCurrent, downloadAll,
  sanitize, splitTitle, buildName, buildStubMd,
};
