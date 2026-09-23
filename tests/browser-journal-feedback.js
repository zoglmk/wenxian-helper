// 仅在独立测试配置 + browser-fixture.py 运行；会清空测试清单。
async panel => {
  const context = panel.context(), results = [];
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  await context.request.get('http://127.0.0.1:18580/control?pqMode=%22open%22&pqDelay=0&fail=false&delay=0');
  for (const tab of context.pages()) if (tab !== panel) await tab.close();
  const clear = async () => {
    await panel.bringToFront();
    if (await panel.locator('#btn-clear').isVisible()) await panel.locator('#btn-clear').click();
    await panel.waitForFunction(() => papers.length === 0);
  };
  const addPage = async (sample, total, added) => {
    await sample.bringToFront();
    // 模拟侧边栏按钮；不能把扩展页激活成主标签页，否则 getActiveTab 指向测试面板。
    await panel.evaluate(() => document.querySelector('#btn-add-page').click());
    await panel.waitForFunction(({ total, added }) => papers.length === total &&
      document.querySelector('#footer-status').textContent.includes(`共 ${total} 篇 · 本次新增 ${added} 篇`), { total, added }, { polling: 100, timeout: 15000 });
    return panel.locator('#footer-status').textContent();
  };
  await clear();
  await panel.evaluate(() => { settings.fetchLevels = false; });
  const cnki = await context.newPage();
  await cnki.goto('https://kns.cnki.net:18543/counts/1/search');
  await cnki.locator('.cnki-h-btn').first().waitFor();
  const first = await addPage(cnki, 20, 20);
  await cnki.goto('https://kns.cnki.net:18543/counts/2/search');
  await cnki.locator('.cnki-h-btn').first().waitFor();
  const second = await addPage(cnki, 40, 20);
  const repeated = await addPage(cnki, 40, 0);
  assert((await panel.locator('#list-count').textContent()) === '40 篇', 'header and footer totals agree');
  results.push({ case: 'cnki-two-pages-20-40-repeat', first, second, repeated });
  await cnki.close(); await clear();

  const sample = await context.newPage();
  await sample.goto('https://www.proquest.com:18543/resultsol/journals/1');
  await sample.locator('.pq-helper-button').first().waitFor();
  assert(await sample.locator('.pq-helper-button').count() === 2, 'full-text candidates only; preview and abstract excluded');
  const firstJournal = await addPage(sample, 2, 2);
  assert(!firstJournal.includes('公开论文'), 'candidate collection does not promise public access');
  assert(await panel.evaluate(() => papers.every(p => p.docType === 'J' && p.proquestAccess === 'unknown' && !canDownloadPaper(p))), 'search full-text label is not download permission');
  await panel.bringToFront();
  await panel.locator('.paper-card[data-id="910001"] .check').click();
  await panel.waitForFunction(() => papers.find(p=>p.id===910001)?.selected === false);
  await sample.bringToFront(); await sample.locator('#next-page').click();
  await sample.locator('.pq-helper-button').first().waitFor();
  await addPage(sample, 3, 1);
  await sample.locator('#next-page').click();
  await sample.locator('.pq-helper-button').first().waitFor();
  await addPage(sample, 3, 0);
  await panel.bringToFront(); await panel.reload();
  await panel.waitForFunction(() => papers.length === 3);
  assert(await panel.evaluate(() => papers.find(p=>p.id===910001)?.selected === false), 'journal selection survives pages and reload');
  results.push({ case: 'journal-cross-page-collection-selection' });

  await panel.locator('#btn-fetch-links').click();
  await panel.waitForFunction(() => !fetchingLinks && papers.filter(canDownloadPaper).length === 2);
  const parsed = await panel.evaluate(() => papers.map(p=>({id:p.id,source:p.source,author:p.author,docType:p.docType,access:p.proquestAccess,ready:p.pdfReady,volume:p.volume,issue:p.issue,pages:p.pages})));
  assert(parsed.every(p=>p.source==='Fixture Journal' && p.docType==='J' && p.author==='Zhuo Cheng;Xiaoping Lu;Chunlin Long' && p.pages==='2700-2713'), 'journal metadata and full authors');
  assert(parsed.find(p=>p.id===910004).access === 'unknown', 'full-text label without a valid media entry is rejected');
  const bib = await panel.evaluate(() => papersToBibTeX(papers));
  assert(bib.match(/@article/g)?.length === 3 && !bib.includes('Thesis') && !bib.includes('school ='), 'journals exported as articles');
  results.push({ case: 'journal-detail-access-metadata-export', parsed });

  if (!await panel.locator('#input-folder').isVisible()) await panel.locator('.folder-settings summary').click();
  await panel.locator('#input-folder').fill('journal-fixture');
  await panel.locator('#btn-save-folder').click();
  const downloads = () => panel.evaluate(() => chrome.downloads.search({}));
  const before = Math.max(0, ...(await downloads()).map(d=>d.id));
  await panel.locator('#btn-batch-dl').click();
  await panel.waitForFunction(() => !downloadQueueBusy && downloadState[910002]?.status === 'success');
  const saved = (await downloads()).filter(d=>d.id>before).map(d=>({id:d.id,state:d.state,filename:d.filename}));
  assert(saved.length===1 && saved[0].state==='complete' && /\/journal-fixture\/Public journal 910002(?: \(\d+\))?\.pdf$/.test(saved[0].filename), 'only selected confirmed public journal downloaded into folder');
  assert(await panel.evaluate(() => downloadPaper(910004)) === 'skipped', 'unknown access remains blocked by download-time validation');
  assert((await downloads()).filter(d=>d.id>before).length===1, 'no unknown-access file');
  results.push({ case: 'journal-selected-native-download', downloads: saved });

  const detail = await context.newPage();
  await detail.goto('https://www.proquest.com:18543/docview/910003');
  assert(await detail.locator('.pq-helper-button').count()===0, 'preview detail has no collection button');
  await detail.goto('https://www.proquest.com:18543/docview/910001');
  await detail.locator('.pq-helper-button').waitFor();
  assert(await detail.locator('.pq-helper-button').textContent()==='已收藏', 'public journal detail recognizes saved identity');
  results.push({ case: 'journal-public-and-preview-detail-buttons' });
  await detail.close(); await sample.close(); await panel.bringToFront();
  await panel.evaluate(value=>{window.journalFeedbackResults=value;},results);
  await panel.screenshot({path:'output/playwright/journal-fixture-success.png'});
  return results;
}
