// Worker for test/md-render.test.js (not a test file itself): renders Markdown with
// md-render.js against a minimal DOM and posts back each block's tag and text.
import { parentPort, workerData } from 'node:worker_threads';

class Text {
  constructor(data) { this.data = String(data); this.parentNode = null; this.nodeType = 3; }
  get textContent() { return this.data; }
}
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.childNodes = []; this.parentNode = null; this.nodeType = 1;
    this.attributes = {}; this.className = ''; this.dataset = {}; this.style = {};
  }
  append(...xs) {
    for (const x of xs) {
      const n = typeof x === 'string' ? new Text(x) : x;
      if (n.parentNode) n.parentNode.childNodes.splice(n.parentNode.childNodes.indexOf(n), 1);
      n.parentNode = this;
      this.childNodes.push(n);
    }
  }
  prepend(...xs) {
    const kids = this.childNodes;
    this.childNodes = [];
    this.append(...xs);
    this.childNodes.push(...kids);
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get lastElementChild() { for (let i = this.childNodes.length - 1; i >= 0; i--) if (this.childNodes[i].nodeType === 1) return this.childNodes[i]; return null; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.childNodes = []; if (v !== '' && v != null) this.append(String(v)); }
  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c) => names().includes(c),
      add: (...c) => { this.className = [...new Set([...names(), ...c])].join(' '); },
      remove: (...c) => { this.className = names().filter((x) => !c.includes(x)).join(' '); },
    };
  }
}
globalThis.document = { createElement: (t) => new El(t), createDocumentFragment: () => new El('#fragment'), createTextNode: (d) => new Text(d) };

const { renderBlocks } = await import('../public/js/md-render.js');
const { footnotes } = await import('../public/js/footnotes.js');
const { text, opts } = workerData;
const r = renderBlocks(text, { ...opts, notes: footnotes(text) });
parentPort.postMessage(r.blocks.map((b) => ({ tag: b.el.tagName, text: b.el.textContent })));
