// A deliberately small text-to-data parser. Never interpret HTML or fetch resources.
// Work budgets and depth limits turn pathological/unclosed inline markup into text.
const MAX_INLINE_DEPTH = 4;
const MAX_BLOCKS = 10000;
const MAX_INLINE_NODES = 20000;
const ESCAPABLE = '\\`*_{}[]()#+-.!>';
const asText = value => typeof value === 'string' ? value : String(value ?? '');

export function safeHttpUrl(value) {
  if (!/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f\\]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname ? url.href : null;
  } catch { return null; }
}

function findMarker(text, marker, from, work) {
  for (let i = from; i < text.length; i++) {
    if (--work.remaining < 0) return -1;
    if (text[i] === '\\') { i++; continue; }
    if (marker[0] === '`' && text[i] === '`') {
      const start = i;
      while (i + 1 < text.length && text[i + 1] === '`') { i++; if (--work.remaining < 0) return -1; }
      if (i - start + 1 === marker.length) return start;
    } else if (marker[0] !== '`' && text.startsWith(marker, i)) return i;
  }
  return -1;
}

function linkEnd(text, from, work) {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (--work.remaining < 0) return -1;
    const char = text[i];
    if (/\s/u.test(char) || char === '\\' || char === '<' || char === '>') return -1;
    if (char === '(' && ++depth > 4) return -1;
    if (char === ')') { if (!depth) return i; depth--; }
  }
  return -1;
}

function inline(text, work, depth = 0, allowLinks = true) {
  if (depth >= MAX_INLINE_DEPTH || work.remaining <= 0 || work.nodes <= 0) return [{ type: 'text', text }];
  const nodes = [];
  let pending = '', i = 0;
  const flush = () => { if (pending) { nodes.push({ type: 'text', text: pending }); pending = ''; } };
  const add = node => { flush(); nodes.push(node); work.nodes--; };
  while (i < text.length) {
    if (--work.remaining < 0 || work.nodes <= 0) { pending += text.slice(i); break; }
    const char = text[i];
    if (char === '\\' && ESCAPABLE.includes(text[i + 1]) && i + 1 < text.length) {
      pending += text[i + 1]; i += 2; continue;
    }
    if (char === '`') {
      let endRun = i + 1;
      while (text[endRun] === '`') endRun++;
      const marker = text.slice(i, endRun);
      const end = findMarker(text, marker, endRun, work);
      if (end >= 0) { add({ type: 'code', text: text.slice(endRun, end) }); i = end + marker.length; continue; }
      pending += marker; i = endRun; continue;
    }
    const strong = text.startsWith('**', i) ? '**' : text.startsWith('__', i) ? '__' : null;
    if (strong) {
      const end = findMarker(text, strong, i + 2, work);
      if (end > i + 2) { add({ type: 'strong', children: inline(text.slice(i + 2, end), work, depth + 1, allowLinks) }); i = end + 2; continue; }
      pending += strong; i += 2; continue;
    }
    if (allowLinks && char === '[' && text[i - 1] !== '!') {
      const labelEnd = findMarker(text, '](', i + 1, work);
      const end = labelEnd >= 0 ? linkEnd(text, labelEnd + 2, work) : -1;
      const href = end >= 0 ? safeHttpUrl(text.slice(labelEnd + 2, end)) : null;
      if (href) {
        add({ type: 'link', href, children: inline(text.slice(i + 1, labelEnd), work, depth + 1, false) }); i = end + 1; continue;
      }
      // Unsafe/unsupported destinations stay literal, including their label.
      if (end >= 0) { pending += text.slice(i, end + 1); i = end + 1; continue; }
    }
    if (allowLinks && (text.startsWith('https://', i) || text.startsWith('http://', i))) {
      let end = i;
      while (end < text.length && !/[\s<>"`]/u.test(text[end])) end++;
      let urlEnd = end;
      while (urlEnd > i && /[.,;:!?。，；！？)\]}]/u.test(text[urlEnd - 1])) urlEnd--;
      const value = text.slice(i, urlEnd), href = safeHttpUrl(value);
      if (href) { add({ type: 'link', href, children: [{ type: 'text', text: value }] }); i = urlEnd; continue; }
      pending += text.slice(i, end); i = end; continue;
    }
    pending += char; i++;
  }
  flush();
  return nodes;
}

export function parseInline(value) {
  const text = asText(value);
  return inline(text, { remaining: text.length * 8 + 64, nodes: MAX_INLINE_NODES });
}

function fenceStart(text) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  const label = match[2].trim().split(/\s+/, 1)[0];
  return { marker: match[1], language: /^[\w.+#-]{1,32}$/.test(label) ? label : '' };
}
function fenceEnd(text, marker) {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(text);
  return !!match && match[1][0] === marker[0] && match[1].length >= marker.length;
}
const heading = text => /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(text);
function headingText(value) {
  const text = value.trimEnd();
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end--;
  return end < text.length && (end === 0 || /[ \t]/.test(text[end - 1])) ? text.slice(0, end).trimEnd() : text;
}
const listItem = text => /^ {0,3}(?:([-+*])|([0-9]{1,9})[.)])[ \t]+(.*)$/.exec(text);
const quote = text => /^ {0,3}>[ \t]?(.*)$/.exec(text);
const blank = text => /^[ \t]*$/.test(text);
const special = text => fenceStart(text) || heading(text) || listItem(text) || quote(text);

export function parseMessage(value) {
  const text = asText(value);
  if (!text) return [];
  const lines = [];
  let position = 0;
  while (position < text.length) {
    const newline = text.indexOf('\n', position), end = newline < 0 ? text.length : newline + 1;
    const raw = text.slice(position, end);
    lines.push({ start: position, end, text: raw.replace(/\r?\n$/, '') });
    position = end;
  }
  const blocks = [], work = { remaining: text.length * 8 + 64, nodes: MAX_INLINE_NODES };
  const content = value => inline(value, work);
  let i = 0;
  while (i < lines.length) {
    if (blocks.length >= MAX_BLOCKS) {
      blocks.push({ type: 'paragraph', children: [{ type: 'text', text: text.slice(lines[i].start) }] }); break;
    }
    const line = lines[i];
    if (blank(line.text)) { i++; continue; }
    const fence = fenceStart(line.text);
    if (fence) {
      const start = line.end;
      i++;
      while (i < lines.length && !fenceEnd(lines[i].text, fence.marker)) i++;
      blocks.push({ type: 'code', text: text.slice(start, i < lines.length ? lines[i].start : text.length), language: fence.language, closed: i < lines.length });
      if (i < lines.length) i++;
      continue;
    }
    const title = heading(line.text);
    if (title) { blocks.push({ type: 'heading', level: title[1].length, children: content(headingText(title[2])) }); i++; continue; }
    const item = listItem(line.text);
    if (item) {
      const ordered = !!item[2], items = [];
      let next = item;
      while (i < lines.length && next && !!next[2] === ordered) {
        items.push({ ...(ordered ? { value: Number(next[2]) } : {}), children: content(next[3]) });
        i++; next = i < lines.length ? listItem(lines[i].text) : null;
      }
      blocks.push({ type: 'list', ordered, ...(ordered ? { start: items[0].value } : {}), items }); continue;
    }
    if (quote(line.text)) {
      const parts = [];
      while (i < lines.length) { const next = quote(lines[i].text); if (!next) break; parts.push(next[1]); i++; }
      blocks.push({ type: 'quote', children: content(parts.join('\n')) }); continue;
    }
    const parts = [line.text]; i++;
    while (i < lines.length && !blank(lines[i].text) && !special(lines[i].text)) { parts.push(lines[i].text); i++; }
    blocks.push({ type: 'paragraph', children: content(parts.join('\n')) });
  }
  return blocks;
}
