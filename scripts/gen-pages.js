#!/usr/bin/env node
/*
 * gen-pages.js — Static SEO page generator for Z&Z STROTEC
 * ---------------------------------------------------------
 * index.html is the SINGLE SOURCE OF TRUTH. This script parses it and emits a
 * real, crawlable standalone HTML page for every Knowledge entry, Expert Column
 * and Market, plus section hub pages and a full sitemap.xml.
 *
 * Run:  node scripts/gen-pages.js
 * Output (repo-root relative, all regenerated each run):
 *   knowledge/<key>/index.html
 *   column/<slug>/index.html
 *   markets/<key>/index.html
 *   knowledge/index.html  column/index.html  markets/index.html   (hubs)
 *   assets/kb-pages.css   (site style block, shared)
 *   sitemap.xml
 *
 * Nothing else in the repo is touched. Safe to re-run.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'index.html');

const ORIGIN = 'https://zz-strotec.com';
const BASE = '/';                            // custom domain — site served at root
const SITE = ORIGIN + BASE;                  // full canonical base
const TODAY = new Date().toISOString().slice(0, 10);

const html = fs.readFileSync(SRC, 'utf8');

/* ------------------------------------------------------------------ helpers */
function slugify(s) {
  return s.toLowerCase()
    .replace(/&amp;/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-').slice(0, 8).join('-')       // cap length, word-boundary
    .replace(/^-+|-+$/g, '');
}
function stripTags(s) {
  return s.replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}
function attrEsc(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// First N chars ending on a word boundary, for meta descriptions.
function clip(s, n) {
  s = s.trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).trim() + '…';
}

/* --- JS-aware brace matcher: returns the {...} literal after `marker` ------ */
function extractBraces(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('marker not found: ' + marker);
  let i = src.indexOf('{', start);
  const open = i;
  // mode stack: 'code' counts braces; strings/templates are transparent
  const stack = [{ mode: 'code', depth: 0 }];
  for (; i < src.length; i++) {
    const c = src[i], top = stack[stack.length - 1];
    if (top.mode === 'code') {
      if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) i = src.length; continue; }
      if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 1; continue; }
      if (c === "'" || c === '"') { stack.push({ mode: 'str', q: c }); continue; }
      if (c === '`') { stack.push({ mode: 'tmpl' }); continue; }
      if (c === '{') { top.depth++; continue; }
      if (c === '}') {
        top.depth--;
        if (stack.length === 1 && top.depth === 0) return src.slice(open, i + 1);
        if (top.depth < 0) { stack.pop(); continue; }   // close ${...}
        continue;
      }
    } else if (top.mode === 'str') {
      if (c === '\\') { i++; continue; }
      if (c === top.q) stack.pop();
    } else if (top.mode === 'tmpl') {
      if (c === '\\') { i++; continue; }
      if (c === '`') { stack.pop(); continue; }
      if (c === '$' && src[i + 1] === '{') { stack.push({ mode: 'code', depth: 0 }); i++; continue; }
    }
  }
  throw new Error('unbalanced braces for ' + marker);
}

/* --- same matcher, for a [...] array literal after `marker` ---------------- */
function extractBrackets(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('marker not found: ' + marker);
  let i = src.indexOf('[', start);
  const open = i;
  let depth = 0, quote = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) i = src.length; continue; }
    if (c === '[') { depth++; continue; }
    if (c === ']') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  throw new Error('unbalanced brackets for ' + marker);
}

/* --- balanced <div>…</div> block starting at an id="..." attribute -------- */
function extractDivBlock(src, idAttr) {
  const at = src.indexOf(idAttr);
  if (at < 0) throw new Error('id not found: ' + idAttr);
  const start = src.lastIndexOf('<div', at);
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  let depth = 0, m;
  while ((m = re.exec(src))) {
    if (m[0] === '</div>') { depth--; if (depth === 0) return src.slice(start, re.lastIndex); }
    else depth++;
  }
  throw new Error('unbalanced div for ' + idAttr);
}

/* --------------------------------------------- evaluate KB & MARKETS objects */
const imgDefs = (html.match(/const IMG_[A-Z]+ = (?:'[^']*'|"[^"]*");/g) || []).join('\n');
function evalObj(marker) {
  const lit = extractBraces(html, marker);
  // eslint-disable-next-line no-new-func
  return new Function(imgDefs + '\nreturn (' + lit + ');')();
}
const KB = evalObj('const KB = {');
const MARKETS = evalObj('const MARKETS = {');
// Columns were moved out of the DOM into an inline COLUMNS object (id -> inner HTML)
// so their full text is no longer duplicate crawlable content on the homepage.
const COLUMNS = evalObj('const COLUMNS = {');
// Hand-written meta descriptions pinned in index.html (kb:/market:/col: keys).
// Falls back to auto-derived body text when a key is absent.
let SEO_DESC = {};
try { SEO_DESC = evalObj('const SEO_DESC = {'); } catch (e) { /* not pinned yet */ }
// Optional SEO overrides, same kb:/market:/col: key shape. SEO_TITLE replaces the
// <title> and og:title only — the on-page H1 and the schema headline stay as the
// article's own heading, which is the usual "SEO title ≠ H1" split. SEO_SLUG pins
// a column's URL instead of deriving it from the title (columns only; knowledge
// and market URLs already come from their object key).
let SEO_TITLE = {}, SEO_SLUG = {};
try { SEO_TITLE = evalObj('const SEO_TITLE = {'); } catch (e) { /* none pinned */ }
try { SEO_SLUG = evalObj('const SEO_SLUG = {'); } catch (e) { /* none pinned */ }
// The glossary. In the SPA these 196 rows are built by JS from this array, so a
// crawler that does not run scripts sees an empty table — which is why they get
// a real static page of their own.
const TERMS = new Function('return (' + extractBrackets(html, 'const TERMS = [') + ');')();

/* ------------------------------------------------------------ column parsing */
const columns = [];
function absImg(src) {
  if (!src || src.startsWith('data:')) return '';
  return src.startsWith('http') ? src : SITE + src.replace(/^\//, '');
}
for (const [id, rawInner] of Object.entries(COLUMNS)) {
  const num = id.replace('col-', '');
  // drop the "← EXPERT COLUMN" back button for the standalone page
  const inner = rawInner.replace(/<button[^>]*openColumn\('column'\)[^>]*>[\s\S]*?<\/button>/, '');
  const h2 = (rawInner.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || [, ''])[1];
  const title = stripTags(h2);
  // metadata for richer Article schema
  const published = (rawInner.match(/Published:\s*(\d{4}-\d{2}-\d{2})/) || [, ''])[1];
  const updated = (rawInner.match(/Updated:\s*(\d{4}-\d{2}-\d{2})/) || [, ''])[1];
  const eyebrow = (rawInner.match(/text-transform:\s*uppercase[^>]*>([\s\S]*?)<\/span>/) || [, ''])[1];
  const sectionName = stripTags(eyebrow);      // e.g. "Logistics · Sea Freight"
  const image = absImg((rawInner.match(/<img[^>]+src="([^"$][^"]*)"/) || [])[1]);
  // English intro = first <p> after the byline (which contains "Written by")
  const afterByline = inner.split(/Written by[\s\S]*?<\/div>/)[1] || inner;
  const firstP = (afterByline.match(/<p\b[^>]*>([\s\S]*?)<\/p>/) || [, ''])[1];
  columns.push({ id, num, title, inner, desc: SEO_DESC['col:' + id] || clip(stripTags(firstP), 155),
                 seoTitle: SEO_TITLE['col:' + id] || '',
                 published, updated, sectionName, image });
}
// unique slugs from titles, unless pinned in SEO_SLUG
const seen = {};
for (const c of columns) {
  let s = SEO_SLUG['col:' + c.id] || slugify(c.title) || c.id;
  if (seen[s]) s = s + '-' + c.num;
  seen[s] = 1;
  c.slug = s;
}

/* ------------------------------------------------ neutralise SPA-only onclicks
 * On a static page openColumn()/openKnowledge()/showPage() don't exist. Rewrite
 * onclick nav to a real location.href pointing at the generated URL or the SPA. */
const colUrlById = Object.fromEntries(columns.map(c => [c.id, `${BASE}column/${c.slug}/`]));
// Relative asset paths (src/href="photo/…") break on nested /section/key/ pages
// because they resolve against the deep URL. Prefix them with the site base.
function rewriteAssets(s) {
  return s.replace(/(\b(?:src|href)=")(?!https?:|\/\/|\/|#|data:|mailto:|tel:)([^"]*)"/g,
    (m, p, u) => `${p}${BASE}${u}"`);
}
function rewriteNav(s) {
  return s
    .replace(/onclick="openKnowledge\('([^']+)'\)"/g, (m, k) => `onclick="location.href='${BASE}knowledge/${k}/'"`)
    .replace(/onclick="openColumn\('(col-\d+)'\)"/g, (m, id) => `onclick="location.href='${colUrlById[id] || BASE}'"`)
    .replace(/onclick="openColumn\('column'\)"/g, `onclick="location.href='${BASE}column/'"`)
    .replace(/onclick="showPage\('([^']+)'\)"/g, (m, p) => `onclick="location.href='${BASE}#${p}'"`)
    .replace(/onclick="openMarket\('([^']+)'\)"/g, (m, k) => `onclick="location.href='${BASE}markets/${k}/'"`);
}

/* -------------------------------------------------------------- style bundle */
// The site stylesheet is by far the biggest <style> in index.html. Match on
// size rather than position: the frame guard puts two one-line <style> blocks
// in <head> ahead of it, and "first block wins" silently shipped one of those
// as the entire stylesheet for every generated page.
const styleBlock = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
  .map(m => m[1])
  .reduce((longest, s) => (s.length > longest.length ? s : longest), '');
if (styleBlock.length < 10000) {
  throw new Error(`Stylesheet extraction looks wrong — got ${styleBlock.length} chars. Aborting rather than writing a broken kb-pages.css.`);
}
fs.mkdirSync(path.join(ROOT, 'assets'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'assets', 'kb-pages.css'), styleBlock.trim() + '\n');

// The SPA logo is an inline base64 data-URI (root logo.png is gitignored / not
// deployed). Decode it to a real, deployed file so pages + og:image + JSON-LD
// can reference a working URL.
const logoData = (html.match(/class="logo"[\s\S]{0,400}?src="data:image\/png;base64,([^"]+)"/) || [])[1];
if (logoData) fs.writeFileSync(path.join(ROOT, 'assets', 'brand-logo.png'), Buffer.from(logoData, 'base64'));
const LOGO = 'assets/brand-logo.png';        // deployed logo path (relative to site base)

/* --------------------------------------------------------------- page shell */
const CHROME = `
/* --- standalone SEO page chrome --- */
body{margin:0}
.kbp-header{display:flex;align-items:center;justify-content:space-between;gap:16px;
  padding:14px 20px;border-bottom:1px solid var(--border);background:var(--surface)}
.kbp-header a{color:var(--text);text-decoration:none}
.kbp-brand{display:flex;align-items:center;gap:10px;font-weight:600;letter-spacing:1px}
.kbp-brand img{height:28px;width:auto}
.kbp-nav a{color:var(--text-dim);font-size:12px;letter-spacing:1px;margin-left:18px;text-decoration:none}
.kbp-nav a:hover{color:var(--gold)}
.kbp-wrap{max-width:860px;margin:0 auto;padding:28px 20px 60px}
.kbp-crumb{font-size:12px;color:var(--text-dim);margin-bottom:18px}
.kbp-crumb a{color:var(--text-dim);text-decoration:none}
.kbp-crumb a:hover{color:var(--gold)}
.kbp-h1{color:var(--text);font-size:1.7rem;line-height:1.35;margin:0 0 6px}
.kbp-byline{color:var(--text-dim);font-size:.8rem;margin:0 0 22px}
.kbp-cta{display:inline-block;margin:0 0 26px;padding:9px 20px;border:1px solid var(--gold);
  border-radius:6px;color:var(--gold);font-size:13px;text-decoration:none}
.kbp-cta:hover{background:var(--gold);color:#0d0d0d}
.kbp-tags{margin-top:26px;display:flex;flex-wrap:wrap;gap:8px}
.kbp-next{margin-top:32px;padding:22px 24px;background:var(--surface2);
  border:1px solid var(--gold);border-radius:8px}
.kbp-next .eb{font-size:10px;letter-spacing:2px;color:var(--gold);
  text-transform:uppercase;margin-bottom:9px}
.kbp-next .hd{color:var(--text);font-size:1.02rem;font-weight:600;line-height:1.5}
.kbp-next .sub{color:var(--text-dim);font-size:.86rem;line-height:1.6;margin-top:3px}
.kbp-next .bd{color:var(--text-dim);font-size:.9rem;line-height:1.8;margin-top:12px}
.kbp-next .row{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
.kbp-next a{display:inline-block;padding:10px 22px;border-radius:5px;font-size:12px;
  letter-spacing:1.5px;text-decoration:none}
.kbp-next .gold{background:var(--gold);border:1px solid var(--gold);color:#0d0d0d;font-weight:600}
.kbp-next .blue{background:transparent;border:1px solid #5bbcff;color:#5bbcff}
.kbp-body img{max-width:100%;height:auto}
.kbp-footer{border-top:1px solid var(--border);padding:26px 20px;text-align:center;
  color:var(--text-dim);font-size:12px;line-height:1.9}
.kbp-footer a{color:var(--text-dim);text-decoration:none;margin:0 8px}
.kbp-footer a:hover{color:var(--gold)}
.kbp-hublist{list-style:none;padding:0;margin:18px 0 0;display:grid;
  grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
.kbp-hublist a{display:block;padding:16px;border:1px solid var(--border);border-radius:8px;
  background:var(--surface);color:var(--text);text-decoration:none;transition:border-color .15s}
.kbp-hublist a:hover{border-color:var(--gold)}
.kbp-hublist .t{font-weight:600;font-size:.98rem;margin-bottom:4px}
.kbp-hublist .s{color:var(--text-dim);font-size:.82rem;line-height:1.5}
.kbp-rel{margin-top:34px;padding-top:22px;border-top:1px solid var(--border)}
.kbp-rel h2{font-size:.78rem;letter-spacing:2px;color:var(--gold);font-weight:600;
  margin:0 0 14px;text-transform:uppercase}
.kbp-rel ul{list-style:none;padding:0;margin:0;display:grid;
  grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}
.kbp-rel a{display:block;padding:11px 14px;border:1px solid var(--border);border-radius:6px;
  color:var(--text);text-decoration:none;font-size:.9rem;line-height:1.5;
  transition:border-color .15s}
.kbp-rel a:hover{border-color:var(--gold)}
.kbp-rel .s{display:block;color:var(--text-dim);font-size:.78rem;margin-top:3px}
`;

const CSS_HREF = d => `${'../'.repeat(d)}assets/kb-pages.css`;

function jsonld(o) { return JSON.stringify(o).replace(/</g, '\\u003c'); }

/* ------------------------------------------------- shared security / privacy
 * These three blocks are byte-for-byte the same as the ones in index.html.
 * They live here too because the generated pages are real landing pages —
 * organic traffic arrives on them directly, so they need the same frame
 * refusal and the same consent gate as the front page. If you change one
 * side, change the other.
 */
const FRAME_GUARD = `<!-- ── Frame guard ──────────────────────────────────────────────────────
     GitHub Pages cannot send X-Frame-Options or a CSP frame-ancestors
     header, and <meta http-equiv> cannot set frame-ancestors either, so the
     only place left to refuse embedding is the page itself. The document is
     hidden by the stylesheet and revealed again only when this script finds
     itself in the top-level window. <noscript> restores the page for
     visitors and crawlers running without JS.
     Keep in sync with index.html. -->
<style id="frame-guard">html{display:none !important}</style>
<noscript><style>html{display:block !important}</style></noscript>
<script>
(function () {
  if (window.self === window.top) {
    var g = document.getElementById('frame-guard');
    if (g) g.parentNode.removeChild(g);
    return;
  }
  try { window.top.location.replace(window.self.location.href); }
  catch (e) { /* Cross-origin parent: the escape is blocked, so the page
                 simply stays hidden — which is the intended outcome. */ }
})();
</script>`;

const CONSENT_DEFAULTS = `<!-- ── Google Consent Mode v2 ───────────────────────────────────────────
     Denied by default in the EEA, the UK and Switzerland; granted in the
     markets that do not require prior consent. Must run before gtag.js.
     Keep in sync with index.html. -->
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}

  gtag('consent', 'default', {
    ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied',
    analytics_storage: 'denied', wait_for_update: 500,
    region: ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU',
             'IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES',
             'SE','IS','LI','NO','GB','CH']
  });
  gtag('consent', 'default', {
    ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied',
    analytics_storage: 'granted'
  });

  try {
    var zzConsent = localStorage.getItem('zz-consent');
    if (zzConsent === 'granted' || zzConsent === 'denied') {
      gtag('consent', 'update', { analytics_storage: zzConsent });
    }
  } catch (e) { /* storage blocked (private mode) → the defaults stand */ }
</script>`;

const CONSENT_BANNER = `<!-- ── Analytics consent banner ─────────────────────────────────────────
     Keep in sync with index.html. -->
<script>
(function () {
  var KEY = 'zz-consent';
  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) { return; }
  if (stored === 'granted' || stored === 'denied') return;

  var L = (navigator.language || 'en').toLowerCase();
  var t = L.indexOf('zh') === 0
    ? { msg: '本站使用 Google Analytics 了解訪客如何閱讀這些內容，以便持續改善。是否同意由您決定。', ok: '同意', no: '拒絕' }
    : L.indexOf('ko') === 0
    ? { msg: '본 사이트는 Google Analytics로 방문 통계를 수집해 콘텐츠를 개선합니다. 동의 여부는 직접 선택하실 수 있습니다.', ok: '동의', no: '거부' }
    : { msg: 'We use Google Analytics to see how visitors read this knowledge hub, so we can keep improving it. It is your choice whether we may.',
        ok: 'Accept', no: 'Decline' };

  function build() {
    var bar = document.createElement('div');
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Analytics consent');
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;' +
      'background:#0e1419;border-top:1px solid #1e2d3d;color:#93acc4;' +
      'font-size:13px;line-height:1.7;padding:14px 18px;display:flex;' +
      'flex-wrap:wrap;gap:12px;align-items:center;justify-content:center';

    var msg = document.createElement('span');
    msg.textContent = t.msg;
    msg.style.cssText = 'flex:1 1 260px;max-width:640px';

    function button(label, bg, fg, border) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.style.cssText = 'cursor:pointer;padding:7px 20px;font-size:12px;' +
        'font-weight:600;letter-spacing:0.5px;border-radius:2px;' +
        'background:' + bg + ';color:' + fg + ';border:1px solid ' + border;
      return b;
    }

    var accept = button(t.ok, '#c9a84c', '#080c10', '#c9a84c');
    var decline = button(t.no, 'transparent', '#93acc4', '#1e2d3d');

    function choose(value) {
      try { localStorage.setItem(KEY, value); } catch (e) {}
      gtag('consent', 'update', { analytics_storage: value });
      bar.parentNode.removeChild(bar);
    }
    accept.addEventListener('click', function () { choose('granted'); });
    decline.addEventListener('click', function () { choose('denied'); });

    bar.appendChild(msg);
    bar.appendChild(accept);
    bar.appendChild(decline);
    document.body.appendChild(bar);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
</script>`;

function pageShell({ depth, url, title, desc, ogImage, ld, crumb, main, track }) {
  const t = attrEsc(title), d = attrEsc(desc);
  // A content event alongside the page_view, so a landing on this static page
  // is identifiable in the same reports as the in-app view of the same entry.
  const trackJs = track
    ? `\n  gtag('event', ${jsonld(track.name)}, ${jsonld(track.params)});`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
${FRAME_GUARD}

${CONSENT_DEFAULTS}

<!-- Google tag (gtag.js) — same property as index.html, so organic landings
     on these static pages show up instead of being invisible to Analytics -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-LR7TGXJLS9"></script>
<script>
  gtag('js', new Date());
  gtag('config', 'G-LR7TGXJLS9');${trackJs}
</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t} | Z&amp;Z STROTEC</title>
<meta name="description" content="${d}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index,follow,max-image-preview:large">
<meta property="og:type" content="article">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${url}">
<meta property="og:site_name" content="Z&amp;Z STROTEC">
<meta property="og:image" content="${ogImage}">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${ld}</script>
<link rel="stylesheet" href="${CSS_HREF(depth)}">
<style>${CHROME}</style>
</head>
<body>
<header class="kbp-header">
  <a class="kbp-brand" href="${BASE}"><img src="${'../'.repeat(depth)}assets/brand-logo.png" alt="Z&amp;Z STROTEC">Z&amp;Z STROTEC</a>
  <nav class="kbp-nav">
    <a href="${BASE}knowledge/">Knowledge</a>
    <a href="${BASE}column/">Columns</a>
    <a href="${BASE}markets/">Markets</a>
    <a href="${BASE}terminology/">Terminology</a>
    <a href="${BASE}">Full site →</a>
  </nav>
</header>
<main class="kbp-wrap">
  <div class="kbp-crumb"><a href="${BASE}">Home</a> ${crumb}</div>
  ${main}
</main>
<footer class="kbp-footer">
  <div>Z&amp;Z STROTEC CO., LTD. · 萬洋國際有限公司 — CNC machine-tool export &amp; knowledge hub</div>
  <div style="margin-top:6px">Company Reg. No. / 統一編號 80235084 · <a href="tel:+886425341660">+886-4-2534-1660</a> · <a href="mailto:info@zz-strotec.com">info@zz-strotec.com</a></div>
  <div>13F.-2, No. 135, Sec. 2, Zhongshan Rd., Tanzi Dist., Taichung City 42755, Taiwan (R.O.C.)</div>
  <div style="margin-top:8px">
    <a href="${BASE}">Full interactive site</a>·
    <a href="${BASE}knowledge/">Knowledge Library</a>·
    <a href="${BASE}column/">Expert Columns</a>·
    <a href="${BASE}markets/">Markets</a>·
    <a href="${BASE}terminology/">Terminology</a>·
    <a href="${BASE}privacy/">Privacy Policy</a>
  </div>
  <div style="margin-top:10px;max-width:640px;margin-left:auto;margin-right:auto;line-height:1.8">Sponsored placements are clearly labelled and do not influence editorial content. · 贊助刊登一律明確標示，不影響內容編輯判斷.</div>
</footer>
${CONSENT_BANNER}
</body>
</html>
`;
}

/* --------------------------------------------------------------- write util */
const written = [];
function emit(relDir, urlPath, contentHtml) {
  const dir = path.join(ROOT, relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), contentHtml);
  written.push({ url: SITE + urlPath, loc: urlPath });
}
// clean previously generated dirs so renamed slugs don't leave orphans
for (const d of ['knowledge', 'column', 'markets', 'terminology', 'privacy']) {
  fs.rmSync(path.join(ROOT, d), { recursive: true, force: true });
}

const urls = [];   // for sitemap: {loc, priority}

/* --------------------------------------------------------- related linking
 * Every generated page used to be a leaf: reachable only from its section hub
 * and the footer, with no link to any sibling. Google crawled the hubs, then
 * left a fifth of the leaves in "Discovered — currently not indexed" without
 * ever fetching them, because nothing on the site said one leaf was worth
 * reaching from another. These blocks give each page real contextual outbound
 * links — and, symmetrically, inbound links from pages Google already has.
 *
 * Relations are derived, not hand-listed, so they stay correct as entries are
 * added: knowledge pairs by shared tags, markets by region plus the trade
 * topics every market guide leans on, columns by the knowledge entries whose
 * subject they actually name.
 */
const REL_MAX = 6;

function relatedHtml(items) {
  if (!items || !items.length) return '';
  const lis = items.map(it =>
    `<li><a href="${it.href}">${attrEsc(it.title)}${it.sub ? `<span class="s">${attrEsc(it.sub)}</span>` : ''}</a></li>`
  ).join('');
  return `<nav class="kbp-rel" aria-label="Related pages">
    <h2>Related · 延伸閱讀 · 관련 자료</h2>
    <ul>${lis}</ul>
  </nav>`;
}

const TERMINOLOGY_LINK = {
  href: `${BASE}terminology/`,
  title: 'CNC Machine Tool Terminology',
  sub: '術語對照表 · 용어집 — EN · 中文 · 한국어'
};

const kbLink = k => ({
  href: `${BASE}knowledge/${k}/`, title: KB[k].title,
  sub: [KB[k].title_zh, KB[k].title_ko].filter(Boolean).join(' · ')
});
const marketLink = k => ({
  href: `${BASE}markets/${k}/`, title: MARKETS[k].title,
  sub: [MARKETS[k].title_zh, MARKETS[k].title_ko].filter(Boolean).join(' · ')
});

/* --- knowledge ↔ knowledge: shared tags ---------------------------------- */
const normTag = t => String(t).toLowerCase().trim();
const kbTags = Object.fromEntries(
  Object.entries(KB).map(([k, v]) => [k, new Set((v.tags || []).map(normTag))]));
const kbKeys = Object.keys(KB);

// A handful of entries carry tags no sibling repeats verbatim — "spindle
// cooling" never equals "spindle" — so a second, weaker signal tops the list
// up: significant words shared between the two titles.
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'your', 'what', 'when',
                      'how', 'guide', 'quick', 'reference', 'cnc', 'machine',
                      'machines', 'tool', 'tools', 'checklist', 'explained']);
const titleWords = k => new Set(
  stripTags(KB[k].title).toLowerCase().match(/[a-z]{4,}/g) ?.filter(w => !STOP.has(w)) || []);
const kbWords = Object.fromEntries(kbKeys.map(k => [k, titleWords(k)]));

function relatedKnowledge(key) {
  const mine = kbTags[key], myWords = kbWords[key];
  return kbKeys
    .filter(k => k !== key)
    .map(k => {
      let shared = 0;
      for (const t of kbTags[k]) if (mine.has(t)) shared++;
      let words = 0;
      for (const w of kbWords[k]) if (myWords.has(w)) words++;
      // a shared tag is the stronger claim; a shared title word only breaks
      // in when tags alone would leave the block half empty
      return { k, score: shared * 10 + words };
    })
    .filter(x => x.score > 0)
    // best match first; alphabetical key breaks ties so a re-run of the
    // generator produces byte-identical pages
    .sort((a, b) => b.score - a.score || a.k.localeCompare(b.k))
    .slice(0, REL_MAX)
    .map(x => kbLink(x.k));
}

/* --- markets ↔ markets: same region -------------------------------------- */
// Neighbouring markets are the ones a buyer or an agent actually compares. Any
// market added to index.html that is missing here still gets the trade-topic
// links below, so the block never comes out empty.
const MARKET_REGIONS = {
  americas: ['argentina', 'brazil', 'canada', 'colombia', 'mexico', 'usa'],
  europe: ['czech', 'germany', 'italy', 'poland', 'switzerland'],
  mideast: ['israel', 'saudi', 'turkey', 'uae'],
  apac: ['australia', 'india', 'indonesia', 'korea', 'malaysia', 'thailand', 'vietnam']
};
const regionOf = {};
for (const [r, ks] of Object.entries(MARKET_REGIONS)) for (const k of ks) regionOf[k] = r;

// The trade topics a market guide leans on. Rotating the tail means the
// twenty-odd market pages spread their links across the whole set instead of
// piling every one of them onto the same four entries.
const MARKET_TOPICS_CORE = ['import-duty', 'customs', 'export-docs', 'payment-terms'];
const MARKET_TOPICS_ROTATING = ['container-cbm', 'air-freight-guide', 'export-process-flow',
                                'marine-insurance', 'installation-sat', 'power-supply'];

function relatedMarket(key, idx) {
  const out = [];
  const peers = MARKET_REGIONS[regionOf[key]] || [];
  // start just after this market and wrap, so inbound links spread evenly
  // around the region rather than all landing on its first member
  const at = peers.indexOf(key);
  for (let i = 1; i < peers.length && out.length < 3; i++) {
    const p = peers[(at + i) % peers.length];
    if (p !== key && MARKETS[p]) out.push(marketLink(p));
  }
  const topics = MARKET_TOPICS_CORE.concat(
    MARKET_TOPICS_ROTATING[idx % MARKET_TOPICS_ROTATING.length],
    MARKET_TOPICS_ROTATING[(idx + 3) % MARKET_TOPICS_ROTATING.length]);
  for (const t of topics) if (KB[t] && out.length < REL_MAX + 3) out.push(kbLink(t));
  out.push(TERMINOLOGY_LINK);
  return out;
}

/* --- knowledge → markets: the trade entries a market guide points back at -
 * Without this the market pages are reachable only from each other and their
 * hub, which is the corner of the site Google is slowest to reach. The trade
 * and logistics entries are the ones where naming a destination is genuinely
 * useful, so they carry the return links, dealt round-robin so every market
 * gets a share rather than the first few taking them all.
 */
const TRADE_KB = ['customs', 'export-docs', 'export-process-flow', 'payment-terms',
                  'container-cbm', 'air-freight-guide', 'marine-insurance',
                  'import-duty', 'shtc-export-control', 'trade-services',
                  'installation-sat', 'power-supply'];
const marketKeys = Object.keys(MARKETS);
const tradeMarkets = {};   // kb key -> market keys
TRADE_KB.forEach((k, i) => {
  const per = 4;
  tradeMarkets[k] = Array.from({ length: per },
    (_, j) => marketKeys[(i * per + j) % marketKeys.length]);
});

/* --- columns ↔ knowledge: entries the article actually talks about --------
 * Scored on the entry's own title and tags appearing in the column text, on
 * word boundaries. Requiring the full title was too strict — an article on
 * bar-feeder retrofits says "bar feeder" a dozen times and never once says
 * "Bar Feeder Selection Guide" — so tags carry most of the matching and the
 * title, when it does appear, counts for more.
 */
const columnMentions = new Map();   // column -> [kb key], best match first
const kbMentionedBy = {};           // kb key -> [column]
// Tags too generic to identify a subject: they appear in nearly every article.
const WEAK_TAG = new Set(['export', 'customs', 'quotation', 'turning', 'milling',
                          'shipping', 'packing', 'maintenance', 'automation',
                          'drive', 'coating', 'material', 'accuracy', 'service']);
const wordRe = s => new RegExp('(?:^|[^a-z0-9])' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                               + '(?:$|[^a-z0-9])', 'i');
for (const c of columns) {
  const text = stripTags(c.inner).toLowerCase();
  const scored = kbKeys.map(k => {
    const title = stripTags(KB[k].title).toLowerCase();
    let score = title.length >= 5 && text.includes(title) ? 5 : 0;
    for (const t of KB[k].tags || []) {
      const tag = normTag(t);
      // latin tags only — the Chinese and Korean tags would match against the
      // article's own translated sections and make every column match every entry
      if (tag.length >= 5 && /^[a-z0-9 /-]+$/.test(tag) && !WEAK_TAG.has(tag)
          && wordRe(tag).test(text)) score++;
    }
    return { k, score };
  }).filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.k.localeCompare(b.k));
  const hits = scored.map(x => x.k);
  columnMentions.set(c, hits);
  for (const k of hits.slice(0, REL_MAX)) (kbMentionedBy[k] = kbMentionedBy[k] || []).push(c);
}
const columnLink = c => ({
  href: `${BASE}column/${c.slug}/`, title: c.title,
  sub: c.sectionName || 'Expert Column'
});

function relatedColumn(c) {
  const out = (columnMentions.get(c) || []).slice(0, REL_MAX).map(kbLink);
  out.push(TERMINOLOGY_LINK);
  return out;
}

/* ---------------------------------------------------------- render an entry */
const ORG = { '@type': 'Organization', name: 'Z&Z STROTEC', url: SITE };
const PUBLISHER = { '@type': 'Organization', name: 'Z&Z STROTEC', url: SITE,
                    logo: { '@type': 'ImageObject', url: SITE + LOGO } };
/* ------------------------------------------------------------- foot CTA
 * The generated pages are where organic and shared traffic actually lands,
 * and they used to end on a tag row and a list of related links. Analytics
 * for 2026-07-22..08-18 showed 350 knowledge views and 210 column views
 * against one inquiry attempt, so every article now closes on a next step.
 * Trilingual in one block, matching the rest of the generated chrome, since
 * these pages have no language switcher.
 */
function footCta(section, key) {
  const k = String(key || '').replace(/'/g, '');
  const ev = (name) => `gtag('event','${name}',{cta_source:'${section}',item_key:'${k}',site_language:'en'})`;
  return `
  <div class="kbp-next">
    <div class="eb">Next step &nbsp;·&nbsp; 下一步 &nbsp;·&nbsp; 다음 단계</div>
    <div class="hd">Have a specification in hand?</div>
    <div class="sub">手上已經有規格了嗎？ &nbsp;·&nbsp; 사양이 이미 정해져 있으십니까?</div>
    <div class="bd">Send us the machine model, the part number or a photo from the floor. We will come back on what is available and what it costs.</div>
    <div class="bd">把機台型號、零件料號或現場照片寄給我們，我們會回覆供貨狀況與價格。<br>장비 모델명, 부품 번호 또는 현장 사진을 보내주시면 공급 가능 여부와 가격을 회신드립니다.</div>
    <div class="row">
      <a class="gold" href="${BASE}#inquiry" onclick="${ev('cta_inquiry_click')}">Send an inquiry &nbsp;/&nbsp; 立即洽詢 →</a>
      <a class="blue" href="${BASE}#subscribe" onclick="${ev('cta_subscribe_click')}">Get new articles by email &nbsp;/&nbsp; 訂閱新文章通知</a>
    </div>
  </div>`;
}

function renderEntry({ depth, url, title, seoTitle, titleZh, titleKo, desc, ogImage, bodyHtml,
                       published, updated, tags, crumb, deeplink, section,
                       schemaType, articleSection, suppressHeader, track, related }) {
  let ld;
  if (schemaType === 'WebPage') {
    // Markets are informational location/market pages, not articles.
    ld = jsonld({
      '@context': 'https://schema.org', '@type': 'WebPage',
      name: title, description: desc, url, inLanguage: ['en', 'zh-Hant', 'ko'],
      ...(ogImage ? { primaryImageOfPage: { '@type': 'ImageObject', url: ogImage } } : {}),
      isPartOf: { '@type': 'WebSite', name: 'Z&Z STROTEC', url: SITE },
      ...(updated || published ? { dateModified: updated || published } : {}),
      about: { '@type': 'Thing', name: title },
      publisher: PUBLISHER
    });
  } else {
    // schemaType: 'TechArticle' (knowledge) | 'Article' (columns)
    ld = jsonld({
      '@context': 'https://schema.org', '@type': schemaType || 'Article',
      headline: title, description: desc, inLanguage: ['en', 'zh-Hant', 'ko'],
      ...(ogImage ? { image: ogImage } : {}),
      ...(articleSection ? { articleSection } : {}),
      ...(published ? { datePublished: published } : {}),
      ...(updated || published ? { dateModified: updated || published } : {}),
      author: ORG,
      publisher: PUBLISHER,
      mainEntityOfPage: url
    });
  }
  const subtitle = [titleZh, titleKo].filter(Boolean)
    .map(s => `<span style="color:var(--text-dim);font-size:1rem;font-weight:400">${s}</span>`)
    .join('<span style="color:var(--border)"> · </span>');
  let byline = '';
  if (published) {
    byline = `<p class="kbp-byline">Published: ${published}`
      + (updated && updated !== published ? ` · Updated: ${updated}` : '')
      + ` · Written by Z&amp;Z STROTEC</p>`;
  }
  const tagHtml = (tags && tags.length)
    ? `<div class="kbp-tags">${tags.map(t => `<span class="tag-pill">${t}</span>`).join('')}</div>` : '';
  // Columns carry their own header (eyebrow + title + trilingual byline) inside
  // the body, so suppress the generated one to avoid duplicate title/byline.
  const header = suppressHeader ? '' : `
  <h1 class="kbp-h1">${title}</h1>
  ${subtitle ? `<p style="margin:0 0 12px">${subtitle}</p>` : ''}
  ${byline}`;
  // Hubs and the privacy page pass no section and get no CTA.
  const ctaKey = url.replace(SITE, '').replace(/\/$/, '').split('/').pop();
  const ctaHtml = ['knowledge', 'column', 'markets'].includes(section)
    ? footCta(section, ctaKey) : '';
  const main = `${header}
  <a class="kbp-cta" href="${deeplink}">${deeplink.includes('#') ? 'View interactive version' : 'Open full site'} · 完整互動版 · 인터랙티브 버전 →</a>
  <div class="kbp-body">${rewriteAssets(rewriteNav(bodyHtml))}</div>
  ${tagHtml}
  ${ctaHtml}
  ${relatedHtml(related)}`;
  emit(url.replace(SITE, ''), url.replace(SITE, ''),
    pageShell({ depth, url, title: seoTitle || title, desc,
                ogImage: ogImage || SITE + LOGO, ld, crumb, main, track }));
  urls.push({ loc: url, priority: '0.8', lastmod: updated || published || TODAY });
}

/* ---------------------------------------------------------------------- KB */
for (const [key, item] of Object.entries(KB)) {
  const url = `${SITE}knowledge/${key}/`;
  const desc = SEO_DESC['kb:' + key] || clip(stripTags(item.body || ''), 155);
  const ogImg = (item.body.match(/<img[^>]+src="([^"$][^"]*)"/) || [])[1]; // skip ${..} refs
  // stack the three language bodies with dividers
  const bodyHtml = [
    item.body ? `<section lang="en">${item.body}</section>` : '',
    item.body_zh ? `<section lang="zh-Hant" style="margin-top:34px;padding-top:24px;border-top:1px solid var(--border)"><div style="font-size:11px;letter-spacing:2px;color:var(--gold);margin-bottom:14px">繁體中文</div>${item.body_zh}</section>` : '',
    item.body_ko ? `<section lang="ko" style="margin-top:34px;padding-top:24px;border-top:1px solid var(--border)"><div style="font-size:11px;letter-spacing:2px;color:var(--gold);margin-bottom:14px">한국어</div>${item.body_ko}</section>` : ''
  ].join('');
  renderEntry({
    depth: 2, url, title: item.title, seoTitle: SEO_TITLE['kb:' + key],
    titleZh: item.title_zh, titleKo: item.title_ko,
    desc, ogImage: absImg(ogImg), bodyHtml,
    published: item.published, updated: item.updated, tags: item.tags,
    schemaType: 'TechArticle', articleSection: item.articleSection || (item.tags && item.tags[0]) || 'Knowledge',
    crumb: `› <a href="${BASE}knowledge/">Knowledge</a> › ${attrEsc(item.title)}`,
    deeplink: `${BASE}#kb-${key}`, section: 'knowledge',
    related: relatedKnowledge(key)
      .concat((kbMentionedBy[key] || []).slice(0, 2).map(columnLink))
      .concat((tradeMarkets[key] || []).filter(m => MARKETS[m]).map(marketLink))
      .concat(TERMINOLOGY_LINK),
    track: {
      name: 'view_knowledge',
      params: { item_key: key, item_title: item.title,
                site_language: 'en', landing: true }
    }
  });
}

/* ----------------------------------------------------------------- MARKETS */
// Market guides quote duty rates, certification regimes and payment customs, so
// each page states when it was last gone through. Keep MARKET_REVIEWED in step
// with the constant of the same name in index.html; a per-market `reviewed`
// field overrides it once an individual guide is revised.
const MARKET_REVIEWED = '2026-06';
let marketIdx = 0;
for (const [key, item] of Object.entries(MARKETS)) {
  const url = `${SITE}markets/${key}/`;
  const desc = SEO_DESC['market:' + key] || clip(stripTags(item.body || ''), 155);
  const reviewed = item.reviewed || MARKET_REVIEWED;
  const reviewedHtml = `<div style="color:var(--text-dim);font-size:.78rem;margin-top:28px;padding-top:14px;border-top:1px solid var(--border)">Last reviewed / 最後查核 / 최종 확인: ${reviewed}</div>`;
  const bodyHtml = [
    item.body ? `<section lang="en">${item.body}</section>` : '',
    item.body_zh ? `<section lang="zh-Hant" style="margin-top:34px;padding-top:24px;border-top:1px solid var(--border)"><div style="font-size:11px;letter-spacing:2px;color:var(--gold);margin-bottom:14px">繁體中文</div>${item.body_zh}</section>` : '',
    item.body_ko ? `<section lang="ko" style="margin-top:34px;padding-top:24px;border-top:1px solid var(--border)"><div style="font-size:11px;letter-spacing:2px;color:var(--gold);margin-bottom:14px">한국어</div>${item.body_ko}</section>` : '',
    reviewedHtml
  ].join('');
  renderEntry({
    depth: 2, url, title: item.title, seoTitle: SEO_TITLE['market:' + key],
    titleZh: item.title_zh, titleKo: item.title_ko,
    desc, ogImage: '', bodyHtml,
    published: item.published, updated: item.updated, tags: item.tags || ['Market', key],
    schemaType: 'WebPage',
    crumb: `› <a href="${BASE}markets/">Markets</a> › ${attrEsc(item.title)}`,
    deeplink: `${BASE}`, section: 'markets',
    related: relatedMarket(key, marketIdx++),
    track: {
      name: 'view_market',
      params: { market_key: key, item_key: key, item_title: item.title,
                site_language: 'en', landing: true }
    }
  });
}

/* ----------------------------------------------------------------- COLUMNS */
for (const c of columns) {
  const url = `${SITE}column/${c.slug}/`;
  // promote the column's own <h2> title to <h1> for a proper article heading
  const colBody = c.inner.replace(/<h2\b([^>]*)>([\s\S]*?)<\/h2>/, '<h1$1>$2</h1>');
  renderEntry({
    depth: 2, url, title: c.title, seoTitle: c.seoTitle, titleZh: '', titleKo: '',
    desc: c.desc, ogImage: c.image, bodyHtml: colBody, suppressHeader: true,
    published: c.published, updated: c.updated,
    tags: ['Expert Column', ...(c.sectionName ? [c.sectionName] : [])],
    schemaType: 'Article', articleSection: c.sectionName || 'Expert Column',
    crumb: `› <a href="${BASE}column/">Columns</a> › ${attrEsc(c.title)}`,
    deeplink: `${BASE}#${c.id}`, section: 'column',
    related: relatedColumn(c),
    track: {
      name: 'view_column',
      // c.id is the same col-N the in-app event sends, so the two views of a
      // column aggregate into one row. item_title keeps that row readable.
      params: { column_id: c.id, item_title: c.title,
                site_language: 'en', landing: true }
    }
  });
}

/* -------------------------------------------------------------- hub pages */
function hub({ dir, urlPath, title, intro, items }) {
  const list = items.map(it =>
    `<li><a href="${it.href}"><div class="t">${attrEsc(it.title)}</div><div class="s">${attrEsc(it.sub)}</div></a></li>`
  ).join('\n');
  const url = SITE + urlPath;
  const ld = jsonld({
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    name: title, description: intro, url, inLanguage: ['en', 'zh-Hant', 'ko'],
    isPartOf: { '@type': 'WebSite', name: 'Z&Z STROTEC', url: SITE }
  });
  const main = `<h1 class="kbp-h1">${title}</h1>
  <p style="color:var(--text-dim);max-width:640px">${intro}</p>
  <ul class="kbp-hublist">${list}</ul>`;
  const dirRel = urlPath.replace(/\/$/, '');
  emit(dirRel, urlPath, pageShell({
    depth: 1, url, title, desc: intro, ogImage: SITE + LOGO, ld,
    crumb: `› ${title}`, main
  }));
  urls.push({ loc: url, priority: '0.9', lastmod: TODAY });
}

hub({
  urlPath: 'knowledge/', title: 'Knowledge Library',
  intro: 'In-depth technical guides on CNC machine tools, bar feeders, tooling, spindles and export logistics — in English, 繁體中文 and 한국어.',
  items: Object.entries(KB).map(([k, i]) => ({
    href: `${BASE}knowledge/${k}/`, title: i.title,
    sub: [i.title_zh, i.title_ko].filter(Boolean).join(' · ')
  }))
});
hub({
  urlPath: 'column/', title: 'Expert Columns',
  intro: 'Practical, trilingual articles from Z&Z STROTEC on machine-tool selection, logistics, ROI and export best practice.',
  items: columns.map(c => ({ href: `${BASE}column/${c.slug}/`, title: c.title, sub: c.desc }))
});
hub({
  urlPath: 'markets/', title: 'Markets We Serve',
  intro: 'CNC machine-tool and precision-component export guides for markets worldwide — Korea, Brazil, the EU, the Gulf and more.',
  items: Object.entries(MARKETS).map(([k, i]) => ({
    href: `${BASE}markets/${k}/`, title: i.title,
    sub: [i.title_zh, i.title_ko].filter(Boolean).join(' · ')
  }))
});

/* ------------------------------------------------------------ TERMINOLOGY
 * One comprehensive page rather than fifteen category pages: several categories
 * hold only one to three terms, which would make thin pages, and splitting the
 * table would put the same rows on two URLs. Grouped by category with a jump
 * list, so it still reads as a reference rather than a wall.
 */
{
  const catOrder = [];
  const byCat = new Map();
  for (const t of TERMS) {
    if (!byCat.has(t.cat)) { byCat.set(t.cat, []); catOrder.push(t.cat); }
    byCat.get(t.cat).push(t);
  }
  const catSlug = c => slugify(c.replace(/&/g, ' and '));
  const termId = t => 'term-' + slugify(t.en);

  const jump = catOrder.map(c =>
    `<a href="#cat-${catSlug(c)}" style="display:inline-block;padding:5px 12px;border:1px solid var(--border);border-radius:20px;color:var(--text-dim);font-size:12px;text-decoration:none;margin:0 6px 6px 0">${attrEsc(c)} <span style="color:var(--gold)">${byCat.get(c).length}</span></a>`
  ).join('');

  const sections = catOrder.map(c => {
    const rows = byCat.get(c).map(t => {
      const note = t.note_en || '';
      return `<tr id="${termId(t)}">
        <td style="padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:top"><strong style="color:var(--text)">${attrEsc(t.en)}</strong>${note ? `<div style="color:var(--text-dim);font-size:.82rem;line-height:1.6;margin-top:4px">${attrEsc(note)}</div>` : ''}</td>
        <td lang="zh-Hant" style="padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:top;color:var(--text-dim)">${attrEsc(t.zh || '')}${t.note ? `<div style="font-size:.82rem;line-height:1.6;margin-top:4px;opacity:.8">${attrEsc(t.note)}</div>` : ''}</td>
        <td lang="ko" style="padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:top;color:var(--text-dim)">${attrEsc(t.ko || '')}${t.note_ko ? `<div style="font-size:.82rem;line-height:1.6;margin-top:4px;opacity:.8">${attrEsc(t.note_ko)}</div>` : ''}</td>
      </tr>`;
    }).join('\n');
    return `<h2 id="cat-${catSlug(c)}" style="color:var(--text);font-size:1.15rem;margin:34px 0 10px;padding-top:8px">${attrEsc(c)} <span style="color:var(--text-dim);font-size:.8rem;font-weight:400">· ${byCat.get(c).length} terms</span></h2>
    <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.9rem;min-width:560px">
      <thead><tr>
        <th style="text-align:left;padding:8px 12px;border-bottom:1px solid var(--gold);color:var(--gold);font-size:.78rem;letter-spacing:1px;font-weight:600">ENGLISH</th>
        <th style="text-align:left;padding:8px 12px;border-bottom:1px solid var(--gold);color:var(--gold);font-size:.78rem;letter-spacing:1px;font-weight:600">繁體中文</th>
        <th style="text-align:left;padding:8px 12px;border-bottom:1px solid var(--gold);color:var(--gold);font-size:.78rem;letter-spacing:1px;font-weight:600">한국어</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  }).join('\n');

  const url = `${SITE}terminology/`;
  const title = 'CNC Machine Tool Terminology — English · 繁體中文 · 한국어';
  const desc = `A ${TERMS.length}-term trilingual glossary of CNC machine-tool vocabulary — machines, spindles, bar feeders, tooling, workholding, metrology, hydraulics and export terms — in English, Traditional Chinese and Korean.`;
  const ld = jsonld({
    '@context': 'https://schema.org', '@type': 'DefinedTermSet',
    name: 'CNC Machine Tool Terminology', description: desc, url,
    inLanguage: ['en', 'zh-Hant', 'ko'],
    publisher: PUBLISHER,
    hasDefinedTerm: TERMS.map(t => ({
      '@type': 'DefinedTerm', name: t.en, inDefinedTermSet: url,
      termCode: t.cat, '@id': url + '#' + termId(t),
      ...(t.note_en ? { description: t.note_en } : {})
    }))
  });
  const main = `<h1 class="kbp-h1">${title}</h1>
  <p style="color:var(--text-dim);line-height:1.8;max-width:720px">Machine-tool vocabulary does not translate cleanly. The same part is a 動力刀座 in a Taiwanese quotation, a <em>live tool holder</em> in an English specification and a 라이브 툴 홀더 in a Korean purchase order — and a mismatch between those three is how the wrong part gets shipped. These are the ${TERMS.length} terms we most often have to reconcile across a quotation, a drawing and a packing list.</p>
  <a class="kbp-cta" href="${BASE}#terminology">Searchable version · 可搜尋版本 · 검색 가능한 버전 →</a>
  <div style="margin:0 0 8px">${jump}</div>
  <div class="kbp-body">${sections}</div>`;
  emit('terminology', 'terminology/', pageShell({
    depth: 1, url, title: 'CNC Machine Tool Terminology (EN · 中文 · 한국어)',
    desc: clip(desc, 155), ogImage: SITE + LOGO, ld,
    crumb: '› Terminology', main,
    track: { name: 'view_terminology', params: { site_language: 'en', landing: true } }
  }));
  urls.push({ loc: url, priority: '0.9', lastmod: TODAY });
  console.log(`Generated terminology page: ${TERMS.length} terms in ${catOrder.length} categories`);
}

/* --------------------------------------------------------------- PRIVACY
 * Lifted straight out of the SPA page so the two can never drift apart. It
 * needs a real URL because the consent checkboxes and the footer link to it,
 * and because a policy behind a JS route is not much of a policy. */
{
  const block = extractDivBlock(html, 'id="page-privacy"');
  // drop the SPA section-title; the generated shell supplies its own <h1>
  const inner = block
    .replace(/^<div[^>]*id="page-privacy"[^>]*>/, '')
    .replace(/<\/div>\s*$/, '')
    .replace(/<div class="section-title"[\s\S]*?<\/div>/, '');
  const url = `${SITE}privacy/`;
  const title = 'Privacy Policy · 隱私權政策 · 개인정보 처리방침';
  const desc = 'What personal data Z&Z STROTEC collects through this site, why, how long it is kept, which processors are involved, and how to have it removed.';
  const ld = jsonld({
    '@context': 'https://schema.org', '@type': 'WebPage',
    name: title, description: desc, url, inLanguage: ['en', 'zh-Hant', 'ko'],
    isPartOf: { '@type': 'WebSite', name: 'Z&Z STROTEC', url: SITE },
    publisher: PUBLISHER
  });
  const main = `<h1 class="kbp-h1">${title}</h1>
  <div class="kbp-body">${rewriteAssets(rewriteNav(inner))}</div>`;
  emit('privacy', 'privacy/', pageShell({
    depth: 1, url, title: 'Privacy Policy', desc, ogImage: SITE + LOGO, ld,
    crumb: '› Privacy Policy', main
  }));
  urls.push({ loc: url, priority: '0.3', lastmod: TODAY });
}

/* ---------------------------------------------------------------- sitemap */
const homeEntry = `  <url>\n    <loc>${SITE}</loc>\n    <lastmod>${TODAY}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>`;
const body = urls.map(u =>
  `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
).join('\n');
fs.writeFileSync(path.join(ROOT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${homeEntry}\n${body}\n</urlset>\n`);

console.log(`Generated ${Object.keys(KB).length} knowledge + ${columns.length} columns + ${Object.keys(MARKETS).length} markets`);
console.log(`Total URLs in sitemap: ${urls.length + 1} (incl. homepage)`);
console.log('Wrote: knowledge/, column/, markets/, assets/kb-pages.css, sitemap.xml');
