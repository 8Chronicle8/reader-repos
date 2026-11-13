// Print the browse filters an official LNReader plugin declares, as JSON.
// usage: node tools/official_filters.js <compiled-official-plugin.js>
// Loads the plugin with inert stand-ins for the app libraries: only the
// constructor runs, nothing is fetched.
const fs = require('fs');
const path = require('path');
const testModules = path.join(__dirname, '..', 'test', 'node_modules');
const FilterTypes = { TextInput: 'Text', Picker: 'Picker', CheckboxGroup: 'Checkbox', Switch: 'Switch', ExcludableCheckboxGroup: 'XCheckbox' };
const libs = {
  '@libs/fetch': { fetchApi: () => { throw new Error('no network while reading filters'); } },
  '@libs/storage': { storage: { get: () => undefined } },
  '@libs/filterInputs': { FilterTypes },
  '@libs/novelStatus': { NovelStatus: {} },
  '@libs/defaultCover': { defaultCover: '' },
  '@libs/isAbsoluteUrl': { isUrlAbsolute: () => true },
  '@libs/aes': { gcm: () => ({}) },
};
for (const m of ['cheerio', 'dayjs', 'htmlparser2']) libs[m] = require(path.join(testModules, m));
const file = process.argv[2];
if (!file) { console.error('usage: node tools/official_filters.js <plugin.js>'); process.exit(2); }
const ex = {}, mod = { exports: ex };
new Function('require', 'exports', 'module', fs.readFileSync(file, 'utf8'))(n => {
  if (!(n in libs)) throw new Error('unknown lib ' + n);
  return libs[n];
}, ex, mod);
const plugin = ex.default || mod.exports.default;
if (!plugin || !plugin.filters) { console.error(file + ': declares no filters'); process.exit(1); }
process.stdout.write(JSON.stringify(plugin.filters, null, 2) + '\n');
