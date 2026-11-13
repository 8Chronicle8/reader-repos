// Run an LNReader plugin outside the app, against the live site.
//
// usage: node harness.js <plugin.js> [searchTerm] [options]
//   --hide-locked        also parse the novel with the "Hide locked chapters"
//                        setting on, and check that no 🔒 chapter survives
//   --filters '<json>'   override filter values for the browse call,
//                        e.g. '{"status":"completed","genre":["action"]}'
//   --novel <path>       parse this novel instead of the first browse result
//   --json               print one machine-readable result line at the end
//
// The shims below mirror what the LNReader app injects at runtime (see the
// plugin API in the LNReader plugins repository, src/libs and src/types), so a
// plugin that passes here sees the same values it would in the app. In
// particular FilterTypes carries its real string values and `filters` is passed
// to popularNovels with the plugin's own defaults, exactly as the app does.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cheerio = require('cheerio');

const FilterTypes = {
  TextInput: 'Text',
  Picker: 'Picker',
  CheckboxGroup: 'Checkbox',
  Switch: 'Switch',
  ExcludableCheckboxGroup: 'XCheckbox',
};

class Storage {
  constructor() { this.db = {}; }
  set(key, value, expires) {
    this.db[key] = { created: new Date(), value,
      expires: expires instanceof Date ? expires.getTime() : expires };
  }
  get(key, raw) {
    const item = this.db[key];
    if (item && item.expires && Date.now() > item.expires) { delete this.db[key]; return undefined; }
    return raw ? item : item && item.value;
  }
  getAllKeys() { return Object.keys(this.db); }
  delete(key) { delete this.db[key]; }
  clearAll() { this.db = {}; }
}

// @noble/ciphers' gcm(key, iv).decrypt(ciphertext || tag), on node:crypto.
function gcm(key, iv) {
  const k = Buffer.from(key), n = Buffer.from(iv);
  const algo = 'aes-' + k.length * 8 + '-gcm';
  return {
    decrypt(data) {
      const d = Buffer.from(data);
      const dec = crypto.createDecipheriv(algo, k, n);
      dec.setAuthTag(d.subarray(d.length - 16));
      return new Uint8Array(Buffer.concat([dec.update(d.subarray(0, d.length - 16)), dec.final()]));
    },
    encrypt(data) {
      const enc = crypto.createCipheriv(algo, k, n);
      const out = Buffer.concat([enc.update(Buffer.from(data)), enc.final()]);
      return new Uint8Array(Buffer.concat([out, enc.getAuthTag()]));
    },
  };
}

const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

function makeLibs(storage) {
  return {
    '@libs/fetch': {
      fetchApi: (url, opts) => {
        const o = Object.assign({}, opts || {});
        o.headers = Object.assign({ 'User-Agent': UA }, o.headers || {});
        return fetch(url, o);
      },
      fetchText: (url, opts) => fetch(url, opts).then(r => r.text()),
    },
    '@libs/defaultCover': { defaultCover: 'https://github.com/LNReader/lnreader-plugins/blob/main/icons/src/coverNotAvailable.jpg?raw=true' },
    '@libs/filterInputs': { FilterTypes },
    '@libs/novelStatus': { NovelStatus: { Unknown: 'Unknown', Ongoing: 'Ongoing', Completed: 'Completed',
      Licensed: 'Licensed', PublishingFinished: 'Publishing Finished', Cancelled: 'Cancelled',
      OnHiatus: 'On Hiatus' } },
    '@libs/storage': { storage, localStorage: { get: () => ({}) }, sessionStorage: { get: () => ({}) } },
    '@libs/isAbsoluteUrl': { isUrlAbsolute: u => /^[a-z][a-z0-9+.-]*:/i.test(u) },
    '@libs/aes': { gcm },
    'cheerio': cheerio,
    'htmlparser2': require('htmlparser2'),
    'dayjs': require('dayjs'),
  };
}

function loadPlugin(file, storage) {
  const code = fs.readFileSync(file, 'utf8');
  const libs = makeLibs(storage);
  const exports = {}, module = { exports };
  new Function('require', 'exports', 'module', code)(
    n => { if (n in libs) return libs[n]; throw new Error('plugin requires a lib the app does not provide: ' + n); },
    exports, module);
  return exports.default || module.exports.default;
}

// The app hands popularNovels the plugin's own filter object (each entry with
// its current value), so a plugin may dereference filters.<key>.value freely.
function filterValues(filters, overrides) {
  const out = {};
  for (const [k, f] of Object.entries(filters || {})) {
    out[k] = { type: f.type, value: overrides && k in overrides ? overrides[k] : f.value };
  }
  return out;
}

// Schema check: a filter the app cannot render is a broken filter sheet.
function checkFilters(filters) {
  const problems = [];
  const valid = new Set(Object.values(FilterTypes));
  for (const [k, f] of Object.entries(filters || {})) {
    if (!valid.has(f.type)) problems.push(`${k}: type ${JSON.stringify(f.type)} is not a FilterTypes value`);
    if (!f.label) problems.push(`${k}: no label`);
    if (f.type === 'Picker') {
      if (!Array.isArray(f.options) || !f.options.length) problems.push(`${k}: picker without options`);
      else if (!f.options.some(o => o.value === f.value)) problems.push(`${k}: default ${JSON.stringify(f.value)} is not one of its options`);
    }
    if (f.type === 'Checkbox' || f.type === 'XCheckbox') {
      if (!Array.isArray(f.options) || !f.options.length) problems.push(`${k}: checkbox group without options`);
      if (f.type === 'Checkbox' && !Array.isArray(f.value)) problems.push(`${k}: checkbox default must be an array`);
    }
    if (f.type === 'Switch' && typeof f.value !== 'boolean') problems.push(`${k}: switch default must be boolean`);
  }
  return problems;
}

const LOCK = /^🔒/;

function parseArgs(argv) {
  const a = { file: null, term: null, hideLocked: false, filters: null, novel: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--hide-locked') a.hideLocked = true;
    else if (v === '--json') a.json = true;
    else if (v === '--filters') a.filters = JSON.parse(argv[++i]);
    else if (v === '--novel') a.novel = argv[++i];
    else if (!a.file) a.file = v;
    else if (!a.term) a.term = v;
    else throw new Error('unexpected argument: ' + v);
  }
  if (!a.file) throw new Error('usage: node harness.js <plugin.js> [searchTerm] [--hide-locked] [--filters JSON] [--novel PATH] [--json]');
  return a;
}

async function run(args) {
  const result = { plugin: path.basename(args.file), steps: {} };
  const storage = new Storage();
  const plugin = loadPlugin(args.file, storage);
  result.id = plugin.id; result.name = plugin.name; result.version = plugin.version;
  console.log(`### ${plugin.name} (${plugin.id}) v${plugin.version}`);

  const filterProblems = checkFilters(plugin.filters);
  result.filters = Object.keys(plugin.filters || {});
  result.settings = Object.keys(plugin.pluginSettings || {});
  console.log('filters:', result.filters.join(', ') || '-', '| settings:', result.settings.join(', ') || '-');
  if (filterProblems.length) throw new Error('filter schema: ' + filterProblems.join('; '));

  const pop = await plugin.popularNovels(1, { showLatestNovels: false, filters: filterValues(plugin.filters, args.filters) });
  result.steps.popular = pop.length;
  console.log('popularNovels:', pop.length, args.filters ? 'with filters ' + JSON.stringify(args.filters) : '');
  pop.slice(0, 3).forEach(n => console.log('  -', n.name, '|', n.path));
  if (!pop.length) throw new Error('no novels from popularNovels');

  const latest = await plugin.popularNovels(1, { showLatestNovels: true, filters: filterValues(plugin.filters) });
  result.steps.latest = latest.length;
  console.log('latest:', latest.length);

  const q = args.term || pop[0].name.split(/\s+/).find(w => w.length > 3) || pop[0].name.split(' ')[0];
  const sr = await plugin.searchNovels(q, 1);
  result.steps.search = sr.length;
  console.log(`search("${q}"):`, sr.length, sr[0] ? '-> ' + sr[0].name : '');
  if (!sr.length) throw new Error(`search("${q}") returned nothing`);

  const novelPath = args.novel || pop[0].path;
  const t0 = Date.now();
  const nov = await plugin.parseNovel(novelPath);
  const locked = nov.chapters.filter(c => LOCK.test(c.name)).length;
  result.steps.chapters = nov.chapters.length; result.steps.locked = locked;
  console.log('parseNovel:', nov.name, '|', nov.chapters.length, 'chapters,', locked, 'locked',
    '(' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');
  console.log('  cover:', (nov.cover || '').slice(0, 70));
  console.log('  summary:', (nov.summary || '').replace(/\s+/g, ' ').slice(0, 80));
  console.log('  first:', JSON.stringify(nov.chapters[0]));
  console.log('  last :', JSON.stringify(nov.chapters[nov.chapters.length - 1]));
  if (!nov.chapters.length) throw new Error('parseNovel returned no chapters');

  if (args.hideLocked) {
    if (!plugin.pluginSettings || !plugin.pluginSettings.hideLocked) throw new Error('--hide-locked given but the plugin has no hideLocked setting');
    // A fresh instance with the setting already stored, as the app has it on
    // start-up: some plugins read the setting once, in their constructor.
    const onStorage = new Storage();
    onStorage.set('hideLocked', true);
    const hidden = await loadPlugin(args.file, onStorage).parseNovel(novelPath);
    const stillLocked = hidden.chapters.filter(c => LOCK.test(c.name)).length;
    result.steps.hiddenChapters = hidden.chapters.length;
    console.log('hideLocked on:', hidden.chapters.length, 'chapters,', stillLocked, 'locked');
    if (stillLocked) throw new Error('hideLocked left ' + stillLocked + ' locked chapter(s) in the list');
    if (hidden.chapters.length !== nov.chapters.length - locked) {
      throw new Error(`hideLocked removed ${nov.chapters.length - hidden.chapters.length} chapters, expected ${locked}`);
    }
  }

  const ch = nov.chapters.find(c => !LOCK.test(c.name)) || nov.chapters[0];
  const html = await plugin.parseChapter(ch.path);
  const txt = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  result.steps.chapterText = txt.length;
  console.log('parseChapter:', ch.name, '->', html.length, 'html /', txt.length, 'text chars');
  console.log('  preview:', txt.slice(0, 140));
  if (txt.length < 400) throw new Error('chapter content too short (' + txt.length + ' chars)');
  result.ok = true;
  return result;
}

(async () => {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  try {
    const r = await run(args);
    console.log('PASS');
    if (args.json) console.log('RESULT ' + JSON.stringify(r));
  } catch (e) {
    console.error('FAIL:', e.message);
    if (args.json) console.log('RESULT ' + JSON.stringify({ plugin: path.basename(args.file), ok: false, error: e.message }));
    process.exit(1);
  }
})();
