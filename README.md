# site-generator-speed — a faster drop-in for makefun-site 1.0.0

[![site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Fizal127/makefun-site-generator-speed/rank.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Fizal127/makefun-site-generator-speed/reward.svg)](https://make.fun/c/site-generator-speed-01-run-20261122)

A hand-written, dependency-free reimplementation of make.fun's own static
site generator, makefun-site 1.0.0, that returns byte-identical output on
every case and runs measurably faster.

## What it does

`solve.js` exports `run(input)`, which builds one site — `{ site, templates,
files }` — into the output tree makefun-site 1.0.0 returns: every page's
`index.html`, the index and tag pages, `build-report.txt`, and each static
file, as a JSON object of path to text. `main.ts` is the harness driver: it
reads every case from `/input/cases.json`, answers each with `run`, and
writes `/output/answers.json`.

The generator implements makefun-site's own dialect exactly: its front
matter, template dialect (`{{ }}`, `{{{ }}}`, `{% for %}`, `{% if %}`,
`{% include %}`, standalone-tag line rules), Markdown subset (fences,
headings with unique ids, thematic breaks, blockquotes, flat lists,
paragraphs, code spans, strong, emphasis, links with resolution and broken
link reports), slug rule, collections, tags, permalinks, and the build
report.

## How it is fast

The reference spends most of its CPU escaping one character at a time and
allocating a token array per Markdown body. This engine instead:

- **Fused Markdown rendering** — lexing and rendering happen in one pass
  over the lines; no token arrays, no second walk.
- **Bulk inline escaping** — the inline renderer jumps from one special
  character (`\`, `` ` ``, `*`, `[`) to the next with `indexOf` and escapes
  each whole plain run in a single pass, instead of escaping every
  character separately.
- **Hand-scanned blocks** — fences, headings, breaks, quotes, and lists are
  classified by character codes, not a battery of regular expressions per
  line; a fenced code block is escaped in one pass over its joined body.
- **Cached slugs** — `slugify` results are memoized per case, so repeated
  tag names and titles pay the Unicode normalization once.
- **Prototype-chained template scopes** — a `for` loop's scope is one
  `Object.create(parent)` instead of a linked `{vars, parent}` frame, so a
  path's first name resolves with a single `in` check; later segments use
  direct own-property checks.
- **No wasted work** — `\r\n` normalization is skipped when a file holds no
  `\r`; a page reuses its post card instead of rebuilding it; per-case
  caches are dropped between cases (each case is answered alone).

## Usage

```sh
node main.ts   # reads /input/cases.json, writes /output/answers.json
```

Node 22 or later, nothing to install. No I/O, no clock, no randomness, no
network — the output is a function of the input alone.

## Files

- `solve.js` — the generator (`run(input)`).
- `main.ts` — the harness driver.
- `README.md` — this file.
- `LICENSE` — MIT.
- `.makefun/owner.json` — the claim file naming the payout wallet.
