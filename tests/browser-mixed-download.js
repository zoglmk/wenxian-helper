// 独立测试浏览器 + browser-fixture.py：知网、ProQuest、DOI 共用队列。
async panel => {
  const context = panel.context();
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  await context.request.get('http://127.0.0.1:18580/control?pqMode=%22open%22&fail=false&delay=0&validPdf=true');
  if (await panel.locator('#btn-clear').isVisible()) await panel.locator('#btn-clear').click();
  await panel.waitForFunction(() => papers.length === 0);
  if (!await panel.locator('#input-folder').isVisible()) await panel.locator('.folder-settings summary').click();
  await panel.locator('#input-folder').fill('mixed-sources');
  await panel.locator('#btn-save-folder').click();
  await panel.locator('#input-folder').dispatchEvent('change');
  const cnki = await context.newPage();
  await cnki.goto('https://kns.cnki.net:18543/mixed/search');
  await cnki.locator('.cnki-h-btn').click();
  const proquest = await context.newPage();
  await proquest.goto('https://www.proquest.com:18543/docview/900001');
  await proquest.locator('.pq-helper-button').click();
  await panel.bringToFront();
  await panel.waitForFunction(() => papers.length === 2);
  await panel.evaluate(() => mutatePapers('add', { items: [{ id: 987654, doiImport: true, pdfSource: 'Unpaywall',
    detailUrl: 'https://doi.org/10.1234/mixed', title: 'DOI mixed fixture', author: 'Test Author', pdfLink: 'https://kns.cnki.net:18543/pdf/mixed' }] }));
  await panel.getByRole('button', { name: '获取链接', exact: true }).click();
  await panel.waitForFunction(() => !fetchingLinks && papers.length === 3 && papers.every(canDownloadPaper));
  const before = await panel.evaluate(async () => Math.max(0, ...(await chrome.downloads.search({})).map(d => d.id)));
  await panel.locator('#btn-batch-dl').click();
  await panel.waitForFunction(() => !downloadQueueBusy && papers.every(p => downloadState[p.id]?.status === 'success'), null, { timeout: 30000 });
  const result = await panel.evaluate(async after => ({
    sources: papers.map(p => ({ provider: p.provider || (p.doiImport ? 'doi' : 'cnki'), status: downloadState[p.id].status })),
    downloads: (await chrome.downloads.search({})).filter(d => d.id > after).map(d => ({ id: d.id, state: d.state, filename: d.filename, mime: d.mime })),
  }), before);
  assert(result.downloads.length === 3 && result.downloads.every(d => d.state === 'complete' && d.filename.includes('/mixed-sources/')), 'mixed queue and folder');
  assert(result.sources.map(p => p.provider).join(',') === 'cnki,proquest,doi', 'independent source routing');
  const exported = await panel.evaluate(() => papersToRIS(papers));
  assert(exported.includes('TY  - THES') && exported.includes('DOI mixed fixture'), 'mixed export');
  await cnki.close();
  await proquest.close();
  await panel.evaluate(value => { window.mixedResults = value; }, result);
  await panel.screenshot({ path: 'output/playwright/proquest-mixed-panel.png' });
  return result;
}
