// A faster drop-in for makefun-site 1.0.0, written by hand in this session.
//
// run(input) returns exactly the output tree makefun-site 1.0.0's build()
// returns for the same input: every path it writes and that file's text, byte
// for byte. Same semantics, different engine: the Markdown renderer is fused
// (lex + render in one pass, no token arrays), inline markup is rendered by
// scanning for the next special character and escaping whole plain runs at
// once, front matter is scanned by hand, slugs are cached per case, and the
// template interpreter walks prototype-chained scopes instead of linked
// {vars, parent} frames.
//
// Dependency-free ES module. No I/O, no clock, no randomness.

const ESC_RE = /[&<>"']/g;
const ESCMAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/**
 * `text` with & < > " and ' escaped. One regex scan for the next special,
 * slices between them; no per-match callback, and the input back untouched
 * when it holds no special. (esc never calls itself, so the shared regex's
 * lastIndex, reset on entry, is safe.)
 */
function esc(s) {
  ESC_RE.lastIndex = 0;
  let m = ESC_RE.exec(s);
  if (m === null) return s;
  const parts = [];
  let last = 0;
  do {
    parts.push(s.slice(last, m.index), ESCMAP[m[0]]);
    last = m.index + 1;
  } while ((m = ESC_RE.exec(s)) !== null);
  parts.push(s.slice(last));
  return parts.join('');
}

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 */
function slugifyRaw(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// --------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
        if (ok) {
          y = Number(raw.slice(0, 4)); mo = Number(raw.slice(5, 7)); d = Number(raw.slice(8, 10));
          if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
        }
      }
      return ok ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        tags[i] = tags[i].trim();
        const t = tags[i];
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return /^[a-z0-9-]+$/.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing line: a line exactly '---'.
  let closeStart = -1;
  let pos = nl === -1 ? text.length : nl + 1;
  while (pos < text.length) {
    const e = text.indexOf('\n', pos);
    const end = e === -1 ? text.length : e;
    if (end - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeStart = pos;
      break;
    }
    pos = end + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let p = nl === -1 ? text.length : nl + 1;
  let lineNo = 2;
  while (p < closeStart) {
    const e = text.indexOf('\n', p);
    const lineEnd = e === -1 || e > closeStart ? closeStart : e;
    const line = text.slice(p, lineEnd);
    if (!isBlankLine(line) && line.charCodeAt(0) !== 35) {
      // key: value — a key of a-z and _, a colon, one space and the value.
      let k = 0;
      while (k < line.length) {
        const c = line.charCodeAt(k);
        if ((c >= 97 && c <= 122) || c === 95) k++;
        else break;
      }
      if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${lineNo} is not "key: value"` };
      const key = line.slice(0, k);
      let raw;
      if (k + 1 === line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
      else return { error: `line ${lineNo} is not "key: value"` };
      raw = raw.replace(/[ \t]+$/, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    p = lineEnd + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const closeNl = text.indexOf('\n', closeStart);
  const body = closeNl === -1 ? '' : text.slice(closeNl + 1);
  return { data, body };
}

// ------------------------------------------------------------------- Markdown

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A fence-open line's language, or null when the line is no fence open. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  const L = line.length;
  while (j < L) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  let k = j;
  while (k < L && (line.charCodeAt(k) === 32 || line.charCodeAt(k) === 9)) k++;
  return k === L ? line.slice(3, j) : null;
}

/** Whether the line closes a fence: three backticks, spaces or tabs after. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's depth and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < line.length && line.charCodeAt(h) === 35) h++;
  if (h < 1 || h > 6 || h >= line.length) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let j = h;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  let e = line.length;
  while (e > j && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e <= j) return null;
  return { depth: h, text: line.slice(j, e) };
}

/** Whether the line is a thematic break: `---` or `***`, spaces or tabs after. */
function isHr(line) {
  const a = line.charCodeAt(0);
  if (!((a === 45 && line.charCodeAt(1) === 45 && line.charCodeAt(2) === 45) ||
        (a === 42 && line.charCodeAt(1) === 42 && line.charCodeAt(2) === 42))) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: blank, fence, heading or thematic break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

/** Whether a line continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let j = 2;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  if (j >= line.length) return false;
  const c = line.charCodeAt(j);
  return c !== 32 && c !== 9 && c !== 11 && c !== 12 && c !== 13;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnesc(s, what, from) {
  let p = s.indexOf(what, from);
  while (p !== -1) {
    // A run of backslashes immediately before p, counted from `from`: an odd
    // run means the last backslash escapes what's first character.
    let b = 0;
    let q = p - 1;
    while (q >= from && s.charCodeAt(q) === 92) { b++; q--; }
    if (b % 2 === 0) return p;
    p = s.indexOf(what, p + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let p = s.indexOf('*', from);
  while (p !== -1) {
    let b = 0;
    let q = p - 1;
    while (q >= from && s.charCodeAt(q) === 92) { b++; q--; }
    if (b % 2 === 1) { p = s.indexOf('*', p + 1); continue; }
    if (s.charCodeAt(p + 1) === 42) { p = s.indexOf('*', p + 2); continue; }
    return p;
  }
  return -1;
}

const SPECIAL_TEST = /[\\`*\[]/;

/** `s` rendered inline; `link(target)` is a link's href. */
function inline(s, link) {
  if (!SPECIAL_TEST.test(s)) return esc(s);
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    // The next special character: plain text before it escapes in one go.
    let j = n;
    let k = s.indexOf('\\', i); if (k !== -1 && k < j) j = k;
    k = s.indexOf('`', i); if (k !== -1 && k < j) j = k;
    k = s.indexOf('*', i); if (k !== -1 && k < j) j = k;
    k = s.indexOf('[', i); if (k !== -1 && k < j) j = k;
    if (j > i) {
      out.push(esc(s.slice(i, j)));
      i = j;
    }
    if (i >= n) break;
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        out.push(esc(s[i + 1]));
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
      continue;
    }
    if (c === '`') {
      const m = s.indexOf('`', i + 1);
      if (m > i + 1) {
        out.push(`<code>${esc(s.slice(i + 1, m))}</code>`);
        i = m + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s.charCodeAt(i + 1) === 42) {
        const m = findUnesc(s, '**', i + 2);
        if (m > i + 2) {
          out.push(`<strong>${inline(s.slice(i + 2, m), link)}</strong>`);
          i = m + 2;
        } else {
          out.push('**');
          i += 2;
        }
      } else {
        const m = findSingleStar(s, i + 1);
        if (m > i + 1) {
          out.push(`<em>${inline(s.slice(i + 1, m), link)}</em>`);
          i = m + 1;
        } else {
          out.push('*');
          i++;
        }
      }
      continue;
    }
    // A link: `[text](target)`, target with no whitespace.
    const k2 = findUnesc(s, ']', i + 1);
    let m = -1;
    let target = '';
    if (k2 !== -1 && s.charCodeAt(k2 + 1) === 40) m = s.indexOf(')', k2 + 2);
    if (m !== -1) target = s.slice(k2 + 2, m);
    if (target !== '' && !/\s/.test(target)) {
      out.push(`<a href="${esc(link(target))}">${inline(s.slice(i + 1, k2), link)}</a>`);
      i = m + 1;
    } else {
      out.push('[');
      i++;
    }
  }
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading) and its excerpt
 * (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, link, slugCache) {
  const lines = src.split('\n');
  const n = lines.length;
  const parts = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      if (i < n) i++;
      const cls = lang === '' ? '' : ` class="language-${lang}"`;
      const code = body.length === 0 ? '' : `${esc(body.join('\n'))}\n`;
      parts.push(`<pre><code${cls}>${code}</code></pre>\n`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(slugCache, heading.text), ids);
      const h = inline(heading.text, link);
      parts.push(`<h${heading.depth} id="${id}">${h}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: h });
      i++;
      continue;
    }
    if (isHr(line)) {
      parts.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const q = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        l = trimLine(l);
        if (l !== '') q.push(l);
      }
      parts.push(q.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(q.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    }
    // A list: `- ` / `* ` bullets or `digits. ` ordered; continuation lines
    // of two or more spaces then a non-space extend the last item.
    let ordered = false;
    let startNum = 1;
    let itemText = null;
    if ((line.charCodeAt(0) === 45 || line.charCodeAt(0) === 42) && line.charCodeAt(1) === 32) {
      itemText = line.slice(2);
    } else {
      let d = 0;
      while (d < line.length && d < 9 && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
      if (d >= 1 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
        ordered = true;
        startNum = Number(line.slice(0, d));
        itemText = line.slice(d + 2);
      }
    }
    if (itemText !== null) {
      const items = [[trimLine(itemText)]];
      i++;
      while (i < n) {
        const l2 = lines[i];
        let next = null;
        if (ordered) {
          let d = 0;
          while (d < l2.length && d < 9 && l2.charCodeAt(d) >= 48 && l2.charCodeAt(d) <= 57) d++;
          if (d >= 1 && l2.charCodeAt(d) === 46 && l2.charCodeAt(d + 1) === 32) next = l2.slice(d + 2);
        } else if ((l2.charCodeAt(0) === 45 || l2.charCodeAt(0) === 42) && l2.charCodeAt(1) === 32) {
          next = l2.slice(2);
        }
        if (next !== null) {
          items.push([trimLine(next)]);
          i++;
        } else if (isContinued(l2)) {
          items[items.length - 1].push(trimLine(l2));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
      parts.push(`${open}\n`);
      for (const item of items) parts.push(`<li>${inline(item.join('\n'), link)}</li>\n`);
      parts.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const p = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = p;
    parts.push(`<p>${p}</p>\n`);
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------------ templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(text)) {
    throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  }
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    let beforeOk = true;
    for (let p = lineStart; p < open; p++) {
      const c = src.charCodeAt(p);
      if (c !== 32 && c !== 9) { beforeOk = false; break; }
    }
    let afterOk = true;
    for (let p = end; p < lineEnd; p++) {
      const c = src.charCodeAt(p);
      if (c !== 32 && c !== 9) { afterOk = false; break; }
    }
    const standalone = beforeOk && afterOk;
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = /^if (not )?(\S+)$/.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = /^include "([a-z0-9-]+)"$/.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain (prototype-chained, null-proto root). */
function lk(sc, path) {
  if (!(path[0] in sc)) return undefined;
  let v = sc[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/**
 * Compile a parsed template into a function (sc, T, D) => string, or null
 * when code generation is unavailable. The generated code inlines path
 * lookups and drops the interpreter's per-node dispatch, while keeping the
 * reference semantics exactly (scope chain, truthiness, include depth).
 * A template whose compilation fails is rendered by the interpreter instead.
 */
function compileTemplate(nodes) {
  try {
    let tmp = 0;
    const parts = ['const O=[];'];
    const emitLookup = (path, scVar) => {
      const t = `_v${tmp++}`;
      parts.push(`let ${t}=${JSON.stringify(path[0])} in ${scVar}?${scVar}.${path[0]}:undefined;`);
      for (let k = 1; k < path.length; k++) {
        parts.push(`${t}=${t}!==null&&typeof ${t}==='object'&&Object.hasOwn(${t},${JSON.stringify(path[k])})?${t}.${path[k]}:undefined;`);
      }
      return t;
    };
    const gen = (nds, scVar) => {
      for (const nd of nds) {
        switch (nd.kind) {
          case 'text':
            parts.push(`O.push(${JSON.stringify(nd.text)});`);
            break;
          case 'var': {
            const v = emitLookup(nd.path, scVar);
            parts.push(`O.push(esc(txt(${v})));`);
            break;
          }
          case 'raw': {
            const v = emitLookup(nd.path, scVar);
            parts.push(`O.push(txt(${v}));`);
            break;
          }
          case 'if': {
            const v = emitLookup(nd.path, scVar);
            parts.push(`if(tru(${v})!==${nd.not}){`);
            gen(nd.then, scVar);
            parts.push('}');
            if (nd.else !== null) {
              parts.push('else{');
              gen(nd.else, scVar);
              parts.push('}');
            }
            break;
          }
          case 'for': {
            const xs = emitLookup(nd.path, scVar);
            const sc2 = `_s${tmp++}`;
            const kk = `_k${tmp++}`;
            parts.push(`if(Array.isArray(${xs})){for(let ${kk}=0;${kk}<${xs}.length;${kk}++){const ${sc2}=Object.create(${scVar});${sc2}[${JSON.stringify(nd.name)}]=${xs}[${kk}];${sc2}.loop={index:${kk}+1,first:${kk}===0,last:${kk}===${xs}.length-1,length:${xs}.length};`);
            gen(nd.body, sc2);
            parts.push('}}');
            break;
          }
          case 'include': {
            parts.push(`O.push(INC(T,${JSON.stringify(nd.name)},${scVar},D));`);
            break;
          }
        }
      }
    };
    gen(nodes, 'sc');
    parts.push('return O.join(\'\');');
    return new Function('esc', 'txt', 'tru', 'INC', `return function(sc,T,D){${parts.join('')}}`)(esc, textOf, truthy, incRender);
  } catch {
    return null;
  }
}

/**
 * One include, rendered: `T` is the case's compiled-template map. A template
 * whose every free name is one of site, tags, recent renders the same for
 * every page of the case at a given depth, so its output is cached per
 * (name, depth) and reused.
 */
function incRender(T, name, sc, D) {
  const f = T.get(name);
  if (f === undefined || f === null || D >= INCLUDE_DEPTH) return '';
  if (T.constSet.has(name)) {
    const key = `${name}#${D}`;
    let s = T.constCache.get(key);
    if (s === undefined) {
      s = f(sc, T, D + 1);
      T.constCache.set(key, s);
    }
    return s;
  }
  return f(sc, T, D + 1);
}

/**
 * Whether template `name` (and everything it includes) reads nothing but
 * site, tags and recent: its output is then the same for every page of the
 * case at a given include depth. Names bound by an enclosing for (its loop
 * variable and `loop`) do not count as free; includes share the caller's
 * scope, so the walk follows them with the caller's bound names.
 */
function templateIsConstant(name, templates) {
  const free = new Set();
  const seen = new Set();
  const walkNodes = (nds, bound, stack) => {
    for (const nd of nds) {
      switch (nd.kind) {
        case 'var':
        case 'raw':
        case 'if':
          if (!bound.has(nd.path[0])) free.add(nd.path[0]);
          if (nd.kind === 'if') {
            walkNodes(nd.then, bound, stack);
            if (nd.else !== null) walkNodes(nd.else, bound, stack);
          }
          break;
        case 'for': {
          if (!bound.has(nd.path[0])) free.add(nd.path[0]);
          const b2 = new Set(bound);
          b2.add(nd.name);
          b2.add('loop');
          walkNodes(nd.body, b2, stack);
          break;
        }
        case 'include':
          walkTemplate(nd.name, bound, stack);
          break;
      }
    }
  };
  const walkTemplate = (tname, bound, stack) => {
    const key = `${tname}|${[...bound].sort().join(',')}`;
    if (seen.has(key) || stack.has(tname)) return;
    seen.add(key);
    const nodes = templates.get(tname);
    if (nodes === undefined) return;
    stack.add(tname);
    walkNodes(nodes, bound, stack);
    stack.delete(tname);
  };
  walkTemplate(name, new Set(), new Set());
  for (const f of free) if (f !== 'site' && f !== 'tags' && f !== 'recent') return false;
  return true;
}

/** `nodes` rendered in the scope `sc`; `templates` maps names to node trees. */
function renderNodes(nodes, sc, templates, depth) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.kind) {
      case 'text':
        out += nd.text;
        break;
      case 'var':
        out += esc(textOf(lk(sc, nd.path)));
        break;
      case 'raw':
        out += textOf(lk(sc, nd.path));
        break;
      case 'if': {
        const v = truthy(lk(sc, nd.path));
        const branch = v !== nd.not ? nd.then : nd.else;
        if (branch !== null) out += renderNodes(branch, sc, templates, depth);
        break;
      }
      case 'for': {
        const xs = lk(sc, nd.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const sc2 = Object.create(sc);
          sc2[nd.name] = xs[k];
          sc2.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          out += renderNodes(nd.body, sc2, templates, depth);
        }
        break;
      }
      case 'include': {
        const t = templates.get(nd.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, sc, templates, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------- build

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 128) {
      // ASCII whitespace: space, tab, LF, VT, FF, CR.
      const ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
      if (ws) inWord = false;
      else if (!inWord) { inWord = true; n++; }
    } else {
      // The rest of JavaScript's WhiteSpace + LineTerminator set.
      const ws = c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
      if (ws) inWord = false;
      else if (!inWord) { inWord = true; n++; }
    }
  }
  return n;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A slug, cached for this case (titles and tag names repeat across sources). */
function slugify(cache, text) {
  let s = cache.get(text);
  if (s === undefined) {
    s = slugifyRaw(text);
    cache.set(text, s);
  }
  return s;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  const slugCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};

  // Each parsed template is compiled once per case; any failure falls back
  // to the interpreter for the whole case.
  const compiled = new Map();
  let useCompiled = true;
  for (const [name, nodes] of templates) {
    const fn = compileTemplate(nodes);
    if (fn === null) useCompiled = false;
    compiled.set(name, fn);
  }
  compiled.constSet = new Set();
  compiled.constCache = new Map();
  for (const name of templates.keys()) {
    if (templateIsConstant(name, templates)) compiled.constSet.add(name);
  }

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter, in the checks' order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let ownDir;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { ownDir = d; break; }
    }
    if (ownDir !== undefined) {
      report.push(`refused ${s.path}: ${ownDir}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(slugCache, s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const linkCache = new Map();
    const link = (target) => {
      const hit = linkCache.get(target);
      if (hit !== undefined) return hit;
      let href;
      if ((target.charCodeAt(0) >= 65 && target.charCodeAt(0) <= 90) || (target.charCodeAt(0) >= 97 && target.charCodeAt(0) <= 122)) {
        // A scheme (`https:`, `mailto:` ...) keeps the target as written.
        let j = 1;
        while (j < target.length) {
          const c = target.charCodeAt(j);
          if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) j++;
          else break;
        }
        if (target.charCodeAt(j) === 58) {
          linkCache.set(target, target);
          return target;
        }
      }
      if (target.startsWith('/') || target.startsWith('#')) {
        linkCache.set(target, target);
        return target;
      }
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) href = `${bySource.get(path).url}${frag}`;
      else if (path !== null && staticPaths.has(path)) href = `${base}/${path}${frag}`;
      else {
        broken.add(`broken-link ${s.path} -> ${target}`);
        href = target;
      }
      linkCache.set(target, href);
      return href;
    };
    const md = renderMarkdown(s.body, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags, grouped by slug, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(slugCache, name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(slugCache, name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(slugCache, name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));

  // 7. Every page through its layout, the index pages and the tag pages.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const fn = compiled.get(name);
    if (fn === undefined) return null;
    const sc = Object.create(null);
    sc.site = site;
    sc.tags = allTags;
    sc.recent = recent;
    for (const k of Object.keys(vars)) sc[k] = vars[k];
    if (fn !== null && useCompiled) return fn(sc, compiled, 0);
    return renderNodes(templates.get(name), sc, templates, 0);
  };
  for (const s of kept) {
    const c = s.post ? cards.get(s) : cardOf(s);
    const page = {
      ...c,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did
  // not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
