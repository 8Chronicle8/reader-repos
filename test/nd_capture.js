// Load a noveldex chapter in a real browser, capture every script it pulls,
// find the one that references the XOR decrypt, and read the decrypted DOM.
const { chromium } = require('playwright');
const fs = require('fs');

const URL = process.argv[2] ||
  'https://noveldex.io/series/novel/starting-with-13-hidden-traits/chapter/1';
const OUT = require('path').join(require('os').tmpdir(), 'nd_scripts');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  });

  const scripts = [];
  const xhr = [];
  page.on('response', async resp => {
    const url = resp.url();
    const ct = (resp.headers()['content-type'] || '');
    try {
      if (url.endsWith('.js') || ct.includes('javascript')) {
        const body = await resp.text();
        scripts.push({ url, body });
      } else if (ct.includes('json') || resp.request().resourceType() === 'fetch' || resp.request().resourceType() === 'xhr') {
        const body = await resp.text().catch(() => '');
        xhr.push({ url, method: resp.request().method(), status: resp.status(), preview: body.slice(0, 200) });
      }
    } catch (e) {}
  });

  console.error('[*] loading', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);

  // Find the decrypt chunk
  const hits = scripts.filter(s => /partialKeyHint|xorEncryption|encryptedBase64|clientNonce|enableDomScrambling/.test(s.body));
  console.log('\n=== scripts referencing XOR crypto:', hits.length, '===');
  for (const h of hits) {
    const fn = OUT + '/' + h.url.split('/').pop().split('?')[0];
    fs.writeFileSync(fn, h.body);
    console.log('  SAVED', fn, '(' + h.body.length + 'b)');
  }
  console.log('total scripts captured:', scripts.length);

  // XHR/fetch calls (in case content comes from an API)
  console.log('\n=== fetch/xhr/json responses ===');
  for (const x of xhr) console.log(`  [${x.status}] ${x.method} ${x.url}\n    ${x.preview.replace(/\n/g,' ')}`);

  // Read the decrypted chapter text from the DOM
  const domText = await page.evaluate(() => {
    const sel = ['.reader-content', '.chapter-content', 'article',
      '[class*="prose"]', '[class*="reader"]', '[class*="chapter"]', 'main'];
    for (const s of sel) {
      const el = document.querySelector(s);
      if (el && el.innerText && el.innerText.length > 300) {
        return { sel: s, len: el.innerText.length, text: el.innerText.slice(0, 500), html: el.innerHTML.slice(0, 800) };
      }
    }
    return { sel: null, bodyLen: document.body.innerText.length, text: document.body.innerText.slice(0, 500) };
  });
  console.log('\n=== decrypted DOM content ===');
  console.log(JSON.stringify(domText, null, 2));

  await browser.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
