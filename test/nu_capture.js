const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' });
  try {
    await page.goto('https://www.novelupdates.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(8000);
    const title = await page.title();
    const bodyLen = (await page.evaluate(() => document.body.innerText)).length;
    const challenged = /just a moment|verify you are human|checking your browser/i.test(await page.content());
    console.log('title:', title, '| bodyLen:', bodyLen, '| challenged:', challenged);
    // extract group/series/release links
    const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map(a=>a.href));
    const groups = [...new Set(links.filter(h=>/novelupdates\.com\/(group|series)\//.test(h)))];
    console.log('group/series links:', groups.length);
    groups.slice(0,10).forEach(g=>console.log('  ',g));
  } catch(e) { console.log('ERR', e.message); }
  await browser.close();
})();
