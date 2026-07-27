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
const styleBlock = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
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
`;

const CSS_HREF = d => `${'../'.repeat(d)}assets/kb-pages.css`;

function jsonld(o) { return JSON.stringify(o).replace(/</g, '\\u003c'); }

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
<!-- Google tag (gtag.js) — same property as index.html, so organic landings
     on these static pages show up instead of being invisible to Analytics -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-LR7TGXJLS9"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
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
    <a href="${BASE}">Full site →</a>
  </nav>
</header>
<main class="kbp-wrap">
  <div class="kbp-crumb"><a href="${BASE}">Home</a> ${crumb}</div>
  ${main}
</main>
<footer class="kbp-footer">
  <div>Z&amp;Z STROTEC · 萬洋國際有限公司 — CNC machine-tool export &amp; knowledge hub</div>
  <div style="margin-top:8px">
    <a href="${BASE}">Full interactive site</a>·
    <a href="${BASE}knowledge/">Knowledge Library</a>·
    <a href="${BASE}column/">Expert Columns</a>·
    <a href="${BASE}markets/">Markets</a>
  </div>
</footer>
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
for (const d of ['knowledge', 'column', 'markets']) {
  fs.rmSync(path.join(ROOT, d), { recursive: true, force: true });
}

const urls = [];   // for sitemap: {loc, priority}

/* ---------------------------------------------------------- render an entry */
const ORG = { '@type': 'Organization', name: 'Z&Z STROTEC', url: SITE };
const PUBLISHER = { '@type': 'Organization', name: 'Z&Z STROTEC', url: SITE,
                    logo: { '@type': 'ImageObject', url: SITE + LOGO } };
function renderEntry({ depth, url, title, seoTitle, titleZh, titleKo, desc, ogImage, bodyHtml,
                       published, updated, tags, crumb, deeplink, section,
                       schemaType, articleSection, suppressHeader, track }) {
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
  const main = `${header}
  <a class="kbp-cta" href="${deeplink}">${deeplink.includes('#') ? 'View interactive version' : 'Open full site'} · 完整互動版 · 인터랙티브 버전 →</a>
  <div class="kbp-body">${rewriteAssets(rewriteNav(bodyHtml))}</div>
  ${tagHtml}`;
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
    track: {
      name: 'view_knowledge',
      params: { item_key: key, item_title: item.title,
                site_language: 'en', landing: true }
    }
  });
}

/* ----------------------------------------------------------------- MARKETS */
for (const [key, item] of Object.entries(MARKETS)) {
  const url = `${SITE}markets/${key}/`;
  const desc = SEO_DESC['market:' + key] || clip(stripTags(item.body || ''), 155);
  const bodyHtml = [
    item.body ? `<section lang="en">${item.body}</section>` : '',
    item.body_zh ? `<section lang="zh-Hant" style="margin-top:34px;padding-top:24px;border-top:1px solid var(--border)"><div style="font-size:11px;letter-spacing:2px;color:var(--gold);margin-bottom:14px">繁體中文</div>${item.body_zh}</section>` : '',
    item.body_ko ? `<section lang="ko" style="margin-top:34px;padding-top:24px;border-top:1px solid var(--border)"><div style="font-size:11px;letter-spacing:2px;color:var(--gold);margin-bottom:14px">한국어</div>${item.body_ko}</section>` : ''
  ].join('');
  renderEntry({
    depth: 2, url, title: item.title, seoTitle: SEO_TITLE['market:' + key],
    titleZh: item.title_zh, titleKo: item.title_ko,
    desc, ogImage: '', bodyHtml,
    published: item.published, updated: item.updated, tags: item.tags || ['Market', key],
    schemaType: 'WebPage',
    crumb: `› <a href="${BASE}markets/">Markets</a> › ${attrEsc(item.title)}`,
    deeplink: `${BASE}`, section: 'markets',
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
