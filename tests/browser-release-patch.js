// 仅在独立测试配置 + browser-fixture.py 中运行，会清空测试清单。
async panel => {
  const context = panel.context(), results = [];
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const control = async query => {
    const response = await context.request.get(`http://127.0.0.1:18580/control?${query}`);
    assert(response.ok(), 'fixture control');
  };
  const until = async predicate => {
    const deadline = Date.now() + 15000;
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error('patch regression timed out');
      await panel.waitForTimeout(50);
    }
  };
  const downloads = () => panel.evaluate(() => chrome.downloads.search({}));
  const detailCount = async () => {
    const response = await context.request.get('http://127.0.0.1:18580/requests');
    return (await response.json()).filter(r => r.path.startsWith('/docview/900001')).length;
  };
  const idle = () => panel.waitForFunction(() => !downloadQueueBusy && !downloadBusy && !fetchingLinks);
  const clear = async () => {
    await panel.bringToFront();
    if (await panel.locator('#btn-clear').isVisible()) await panel.locator('#btn-clear').click();
    await panel.waitForFunction(() => papers.length === 0);
  };
  const seed = async () => {
    await clear();
    await panel.evaluate(() => mutatePapers('add', { items: [{ id: 900001, provider: 'proquest', proquestId: '900001',
      title: 'Public thesis 900001', detailUrl: 'https://www.proquest.com:18543/docview/900001',
      proquestAccess: 'open', pdfReady: true, pdfLink: '', selected: true }] }));
    await panel.locator('.dl-btn').waitFor();
  };
  const failFirst = async () => {
    await control('pqMode=%22missing%22&pqDelay=0');
    await seed();
    await panel.locator('.dl-btn').click();
    await idle();
    assert(await panel.evaluate(() => papers[0].pdfReady === false && downloadState[900001]?.status === 'error'), 'public missing PDF must fail');
    await panel.locator('.retry-btn').waitFor();
  };
  // 当前所用配置必须是测试配置。关闭旧样例标签，避免影响候选顺序。
  for (const tab of context.pages()) if (tab !== panel) await tab.close();
  await panel.bringToFront();
  if (!await panel.locator('#input-folder').isVisible()) await panel.locator('.folder-settings summary').click();
  await panel.locator('#input-folder').fill('release-patch');
  await panel.locator('#btn-save-folder').click();
  const baseline = Math.max(0, ...(await downloads()).map(d => d.id));

  const beforeDetail = await detailCount();
  await failFirst();
  await control('pqMode=%22open%22');
  await panel.locator('.retry-btn').click();
  await idle();
  assert(await detailCount() === beforeDetail + 2, 'initial attempt and card retry each fetch detail once');
  assert(await panel.evaluate(() => downloadState[900001]?.status === 'success' && papers[0].pdfReady), 'card retry finishes');
  let saved = (await downloads()).filter(d => d.id > baseline);
  assert(saved.length === 1 && saved[0].state === 'complete' && /\/release-patch\/Public thesis 900001(?: \(\d+\))?\.pdf$/.test(saved[0].filename), 'native download and folder');
  results.push({ case: 'card-retry-fresh-detail-native-download', id: saved[0].id });

  for (const mode of ['preview', 'unknown']) {
    await failFirst(); const before = (await downloads()).length, parses = await detailCount();
    await control(`pqMode=%22${mode}%22`);
    await panel.locator('.retry-btn').click(); await idle();
    assert(await detailCount() === parses + 1, `${mode}: refresh detail`);
    assert(await panel.evaluate(() => downloadState[900001]?.status === 'skipped' && !papers[0].pdfReady), `${mode}: explicit skip`);
    assert((await downloads()).length === before, `${mode}: no file`);
    results.push({ case: `retry-${mode}-excluded` });
  }

  await failFirst();
  await panel.locator('.retry-btn').click(); await idle();
  assert(await panel.evaluate(() => downloadState[900001]?.status === 'error'), 'another missing link remains retryable');
  await control('pqMode=%22open%22');
  await panel.locator('#btn-retry-failed').click(); await idle();
  assert(await panel.evaluate(() => downloadState[900001]?.status === 'success'), 'batch retry uses same recovery');
  results.push({ case: 'repeated-failure-then-batch-retry' });

  await failFirst();
  await control('pqMode=%22open%22&pqDelay=0.6');
  const duplicateCount = await detailCount(), beforeDuplicate = (await downloads()).length;
  await panel.locator('.retry-btn').click();
  await panel.locator('#btn-retry-failed').click();
  await panel.locator('#btn-retry-failed').click();
  await idle();
  assert(await detailCount() === duplicateCount + 1 && (await downloads()).length === beforeDuplicate + 1, 'repeated retry clicks are mutually exclusive');
  results.push({ case: 'retry-clicks-no-duplicate' });

  await failFirst();
  await control('pqMode=%22open%22&pqDelay=0.6');
  const clearCount = await detailCount(), beforeClear = (await downloads()).length;
  await panel.locator('.retry-btn').click();
  await until(async () => await detailCount() > clearCount);
  await clear(); await idle();
  assert(await panel.evaluate(async () => papers.length === 0 && (await chrome.storage.local.get('cnkiPapers')).cnkiPapers.length === 0), 'late retry does not restore papers');
  assert((await downloads()).length === beforeClear, 'late retry does not start a file');
  results.push({ case: 'clear-during-retry' });
  await control('pqMode=%22open%22&pqDelay=0');

  const university = await context.newPage();
  await university.goto('https://cnki.school.edu.cn:18543/portal');
  const proxy = await context.newPage();
  await proxy.goto('https://library.hb.cn:18543/patch/search');
  await proxy.locator('.cnki-h-btn').waitFor();
  const choose = () => panel.evaluate(async () => (await getCnkiTab())?.url ?? null);
  await university.bringToFront();
  assert(await choose() === proxy.url(), 'active ordinary university must not beat proxy');
  const pq = await context.newPage();
  await pq.goto('https://www.proquest.com:18543/resultsol/fixture/1');
  await pq.locator('.pq-helper-button').waitFor();
  assert(await choose() === proxy.url(), 'active ProQuest must not let ordinary university beat proxy');
  results.push({ case: 'university-and-proquest-prefer-confirmed-proxy' });

  await proxy.bringToFront(); await proxy.locator('.cnki-h-btn').click();
  await panel.bringToFront(); await panel.waitForFunction(() => papers.length === 1);
  await panel.evaluate(() => fetchPdfLinks());
  await university.bringToFront();
  assert(await panel.evaluate(() => downloadPaper(papers[0].id)) === 'success', 'selected proxy runs original CNKI iframe download');
  results.push({ case: 'verified-proxy-original-download' });

  const cnki = await context.newPage();
  await cnki.goto('https://kns.cnki.net:18543/patch/search');
  await cnki.locator('.cnki-h-btn').waitFor();
  assert(await choose() === cnki.url(), 'actual active CNKI wins');
  await cnki.close(); await proxy.close(); await pq.close();
  await university.bringToFront();
  assert(await choose() === null, 'only university page returns null, including cnki in hostname');
  await university.close();
  results.push({ case: 'active-cnki-priority-and-no-valid-candidate' });
  await panel.bringToFront();
  saved = (await downloads()).filter(d => d.id > baseline).map(d => ({ id: d.id, state: d.state, filename: d.filename }));
  assert(saved.every(d => d.state === 'complete'), 'all created files completed');
  const result = { results, downloads: saved };
  await panel.evaluate(value => { window.releasePatchResults = value; }, result);
  await panel.screenshot({ path: 'output/playwright/release-patch-panel.png' });
  return result;
}
