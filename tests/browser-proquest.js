// 在独立测试配置内执行。依赖 browser-fixture.py，不访问真实 ProQuest。
async panel => {
  const context = panel.context(), results = [];
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const control = async query => {
    const r = await context.request.get(`http://127.0.0.1:18580/control?${query}`);
    assert(r.ok(), 'fixture control');
  };
  const until = async predicate => {
    const deadline = Date.now() + 15000;
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error('Browser operation timed out');
      await panel.waitForTimeout(100);
    }
  };
  const origin = 'https://www.proquest.com:18543';
  for (const tab of context.pages()) {
    if (tab.url().startsWith(origin)) await tab.close();
  }
  await control('pqMode=%22open%22&fail=false&delay=0');
  if (await panel.locator('#btn-clear').isVisible()) await panel.locator('#btn-clear').click();
  await panel.waitForFunction(() => papers.length === 0);
  if (!await panel.locator('#input-folder').isVisible()) await panel.locator('.folder-settings summary').click();
  await panel.locator('#input-folder').fill('proquest-fixture');
  await panel.locator('#btn-save-folder').click();
  await panel.locator('#input-folder').dispatchEvent('change');
  // 保持用户曾开启的 WebVPN，确认它不会改写 ProQuest 媒体链接。
  await panel.evaluate(async () => {
    settings.useWebVPN = true;
    settings.fetchLevels = false;
    await chrome.storage.local.set({ useWebVPN: true, fetchLevels: false });
  });
  const sample = await context.newPage();
  await sample.goto(`${origin}/resultsol/fixture/1`);
  await sample.locator('.pq-helper-button').waitFor();
  assert(await sample.locator('.pq-helper-button').count() === 1, 'only open thesis receives collection button');
  const sampleId = await panel.evaluate(async root => (await chrome.tabs.query({})).find(t => t.url?.startsWith(root))?.id, origin);
  const addPage = () => panel.evaluate(id => chrome.tabs.sendMessage(id, { type: 'ADD_ALL_PAGE', useWebVPN: true }), sampleId);
  const first = await addPage();
  assert(first.added === 1 && first.skipped === 2, 'first page filters preview and abstract-only entries');
  await panel.bringToFront();
  await panel.waitForFunction(() => papers.length === 1);
  await panel.locator('.paper-card .check').click();
  await panel.waitForFunction(() => papers[0].selected === false);
  await sample.bringToFront();
  await sample.locator('#next-page').click();
  await until(async () => await sample.locator('.pq-helper-button').count() === 2);
  const second = await addPage();
  assert(second.added === 1, 'second page adds new ID only');
  await panel.bringToFront();
  await panel.waitForFunction(() => papers.length === 2);
  await sample.bringToFront();
  await sample.locator('#next-page').click();
  await until(async () => await sample.locator('.pq-helper-button').count() === 1);
  assert((await addPage()).added === 0, 'returning to previous page deduplicates');
  await panel.bringToFront();
  await panel.reload();
  await panel.waitForFunction(() => papers.length === 2);
  assert(await panel.locator('.paper-check:checked').count() === 1, 'cross-page deselection survives reload');
  results.push({ case: 'cross-page-selection', first, second });

  await panel.getByRole('button', { name: '获取链接', exact: true }).click();
  await panel.waitForFunction(() => !fetchingLinks && papers.every(canDownloadPaper));
  const parsed = await panel.evaluate(() => papers.map(p => ({ id: p.id, author: p.author, source: p.source, date: p.date, provider: p.provider, pdfLink: p.pdfLink, pdfReady: p.pdfReady })));
  assert(parsed.every(p => p.author === 'John R. Hammer' && p.source === 'Fixture University' && p.date === '2026' && p.pdfLink === ''), 'both detail layouts parse clean metadata without signatures');
  results.push({ case: 'both-detail-layouts', parsed });

  const downloads = () => panel.evaluate(async () => (await chrome.downloads.search({})).map(d => ({ id: d.id, state: d.state, filename: d.filename, url: d.url, mime: d.mime })));
  const before = Math.max(0, ...(await downloads()).map(d => d.id));
  await panel.locator('#btn-batch-dl').click();
  await panel.waitForFunction(() => !downloadQueueBusy && downloadState[900002]?.status === 'success');
  const saved = (await downloads()).filter(d => d.id > before);
  assert(saved.length === 1 && saved[0].url.startsWith('https://media.proquest.com:18543/media/900002?_s=fixture'), 'only checked record uses original media host and port');
  assert(/\/proquest-fixture\/Public thesis 900002(?: \(\d+\))?\.pdf$/.test(saved[0].filename), 'title and folder retained, including Chrome duplicate suffix');
  results.push({ case: 'selected-native-download', downloads: saved });

  // 重试必须重新请求详情，不复用上一次媒体签名。
  assert(await panel.evaluate(() => downloadPaper(900002)) === 'success', 'repeat download');
  const repeated = (await downloads()).filter(d => d.id > before).sort((a, b) => a.id - b.id);
  assert(repeated.length === 2 && repeated[0].url !== repeated[1].url, 'refresh signed link before every download');
  results.push({ case: 'fresh-signature', ids: repeated.map(d => d.id) });

  await control('pqMode=%22preview%22');
  const priorCount = (await downloads()).length;
  assert(await panel.evaluate(() => downloadPaper(900001)) === 'skipped', 'changed access must skip');
  assert((await downloads()).length === priorCount, 'preview must not start any download');
  assert(await panel.evaluate(() => !canDownloadPaper(papers.find(p => p.id === 900001))), 'clear stale ready state');
  results.push({ case: 'preview-refused' });
  await control('pqMode=%22html%22');
  assert(await panel.evaluate(() => downloadPaper(900002)) === 'fail', 'non-PDF is refused');
  assert((await downloads()).length === priorCount, 'HTML never starts download');
  results.push({ case: 'html-refused' });

  const negative = await panel.evaluate(() => {
    const html = '<h1 class="documentTitle">Preview</h1><span class="dissertpub">University ProQuest Dissertations &amp; Theses, 2026.</span><strong>Open access</strong><a class="pdf-download" title="Download preview" href="https://media.proquest.com/media/file?_s=fixture">Download preview</a>';
    const parsed = ProQuest.parseDetail(new DOMParser().parseFromString(html, 'text/html'), 'https://www.proquest.com/docview/900003');
    return { access: parsed.paper.proquestAccess, ready: parsed.paper.pdfReady, url: parsed.pdfUrl };
  });
  assert(negative.access === 'preview' && !negative.ready && !negative.url, 'same PDF selector with preview text is refused');
  results.push({ case: 'preview-same-selector', ...negative });
  await control('pqMode=%22open%22');
  await sample.close();
  await panel.screenshot({ path: 'output/playwright/proquest-fixture-panel.png' });
  await panel.evaluate(value => { window.proquestResults = value; }, results);
  return results;
}
