// Dev-time only: writes public/vendor/LICENSES.txt with the license of every
// package bundled into public/vendor/*.js (run by build.sh).
import fs from 'node:fs';
import path from 'node:path';
const NM = new URL('./node_modules/', import.meta.url).pathname;
const groups = {
  'cm.js (CodeMirror 6 + Markdown)': ['@codemirror/state', '@codemirror/view', '@codemirror/commands', '@codemirror/language', '@codemirror/lang-markdown', '@codemirror/search', '@codemirror/autocomplete', '@codemirror/lang-css', '@codemirror/lang-html', '@codemirror/lang-javascript', '@lezer/common', '@lezer/highlight', '@lezer/lr', '@lezer/markdown', '@lezer/css', '@lezer/html', '@lezer/javascript', '@marijn/find-cluster-break', 'crelt', 'style-mod', 'w3c-keyname'],
  'interop.js (export helpers)': ['marked', 'fflate'],
};
// mammoth.js is mammoth's own prebuilt browser bundle (mammoth.browser.min.js, build.sh): what it
// holds is what mammoth's build put in it, at that build's versions, not what npm installs here.
// Its browserify build names the packages it bundled in the header of mammoth.browser.js (checked
// below). JSZip is in it as JSZip's own prebuilt dist (dist/jszip.min.js of 3.7.1, as published),
// which carries pako, lie, immediate and set-immediate-shim at the versions of JSZip 3.7.1's
// package-lock.json. The license files of these versions, as published, are in ./licenses/. Two
// ship none: isarray's is the License section of its README; set-immediate-shim 1.0.1's is the MIT
// license file its author added in 2.0.0 (the file's own note says so).
const MAMMOTH_VERSION = '1.13.0';
const MAMMOTH_BUILD = [ // [package, version, license as declared]: mammoth's browserify build
  ['mammoth', '1.13.0', 'BSD-2-Clause'], ['@xmldom/xmldom', '0.8.6', 'MIT'], ['base64-js', '1.5.1', 'MIT'],
  ['buffer', '4.9.1', 'MIT'], ['dingbat-to-unicode', '1.0.2', 'BSD-2-Clause'], ['ieee754', '1.1.8', 'BSD-3-Clause'],
  ['isarray', '1.0.0', 'MIT'], ['jszip', '3.7.1', '(MIT OR GPL-3.0-or-later)'], ['lop', '0.4.2', 'BSD-2-Clause'],
  ['option', '0.2.4', 'BSD-2-Clause'], ['process', '0.11.9', 'MIT'], ['underscore', '1.13.1', 'MIT'],
  ['xmlbuilder', '10.0.0', 'MIT'],
];
const JSZIP_DIST = [ // inside JSZip 3.7.1's own dist
  ['pako', '1.0.5', 'MIT'], ['lie', '3.3.0', 'MIT'], ['immediate', '3.0.6', 'MIT'], ['set-immediate-shim', '1.0.1', 'MIT'],
];
{
  const installed = JSON.parse(fs.readFileSync(path.join(NM, 'mammoth', 'package.json'), 'utf8')).version;
  const header = fs.readFileSync(path.join(NM, 'mammoth', 'mammoth.browser.js'), 'utf8').split('\n')
    .map((l) => /^\/\/ Module: (.+)$/.exec(l)?.[1]).filter(Boolean).sort();
  const listed = MAMMOTH_BUILD.map(([n, v]) => `${n}@${v}`).sort();
  if (installed !== MAMMOTH_VERSION || header.join() !== listed.join()) {
    throw new Error(`mammoth's browser build changed (${installed}: ${header.join(', ')}): update MAMMOTH_BUILD, JSZIP_DIST and ./licenses/`);
  }
}
const QRCODE_GENERATOR_LICENSE = `MIT License

Copyright (c) 2009 Kazuhiko Arase

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
let out = 'Third-party software bundled in /vendor/*.js, with the license of each package.\n';
for (const [title, pkgs] of Object.entries(groups)) {
  out += `\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}\n`;
  for (const name of pkgs) {
    const dir = path.join(NM, name);
    if (!fs.existsSync(dir)) continue;
    const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const lic = fs.readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.|$)/i.test(f));
    out += `\n--- ${pj.name} ${pj.version} (${typeof pj.license === 'string' ? pj.license : JSON.stringify(pj.license || pj.licenses || 'see package')})\n`;
    out += lic ? `${fs.readFileSync(path.join(dir, lic), 'utf8').trim()}\n` : '(no license file in the package; license as declared above)\n';
  }
}
out += `\n${'='.repeat(78)}\nmammoth.js (.docx import, prebuilt by its authors)\n${'='.repeat(78)}\n`;
out += '\nThe packages in mammoth\'s browser build, at the versions in it. pako, lie, immediate and\nset-immediate-shim come inside JSZip 3.7.1\'s own prebuilt dist.\n';
for (const [name, version, license] of [...MAMMOTH_BUILD, ...JSZIP_DIST]) {
  const text = fs.readFileSync(new URL(`./licenses/${name.replace('/', '__')}@${version}.txt`, import.meta.url), 'utf8');
  out += `\n--- ${name} ${version} (${license})\n${text.trim()}\n`;
}
// qrcode.js is vendored by hand (qrcode-generator's dist/qrcode.mjs, minified; see its header).
// Its npm package carries no license file: this is the LICENSE of its repository.
out += `\n${'='.repeat(78)}\nqrcode.js (QR codes)\n${'='.repeat(78)}\n`;
out += `\n--- qrcode-generator 2.0.4 (MIT)\n${QRCODE_GENERATOR_LICENSE}\n`;
fs.writeFileSync(new URL('../../public/vendor/LICENSES.txt', import.meta.url), out);
console.log(`LICENSES.txt: ${out.length} bytes`);
