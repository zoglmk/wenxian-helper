async (panel) => {
 const context=panel.context(),origin='https://kns.cnki.net';
 let fail=true,release=null,entered=null;
 await context.unrouteAll({behavior:'ignoreErrors'});
 await context.route(origin+'/state/**',async route=>{
  const url=route.request().url();
  if(url.endsWith('/kcms/detail')) {
   if(entered){entered();await new Promise(r=>release=r);}
   if(fail) await route.fulfill({status:503,contentType:'text/html',body:'temporarily unavailable'});
   else await route.fulfill({contentType:'text/html; charset=utf-8',body:'<div class="operate-btn"><a href="/state/pdf">Download PDF</a></div><div class="author"><a>First Author</a></div>'});
  }else await route.fulfill({contentType:'text/html; charset=utf-8',body:'<table class="result-table-list"><tr><td class="name"><a class="fz14" href="/state/kcms/detail">State regression</a></td><td class="author">Original Author</td></tr></table>'});
 });
 await panel.locator('#btn-clear').click();
 const sample=await context.newPage();await sample.goto(origin+'/state/search');await sample.locator('.cnki-h-btn').click();
 await panel.locator('.paper-card').waitFor();
 let record=await panel.evaluate(()=>papers[0]);
 if(record.author!=='Original Author')throw new Error('Author lost');
 const id=record.id;
 await panel.locator('.paper-card label.check').click();
 await panel.waitForFunction(()=>papers[0]?.selected===false);
 await panel.getByRole('button',{name:'时间',exact:true}).click();
 if(await panel.locator('.paper-check').isChecked())throw new Error('Sort reset selection');
 await panel.reload();await panel.locator('.paper-card').waitFor();
 if(await panel.locator('.paper-check').isChecked())throw new Error('Reload reset selection');
 await panel.locator('.paper-card label.check').click();await panel.waitForFunction(()=>papers[0]?.selected===true);
 // 无 PDF 仍可导出，真实触发浏览器文件下载。
 const exportDone=panel.waitForEvent('download');await panel.evaluate(()=>doExport('csv'));const exported=await exportDone;
 await exported.saveAs('output/playwright/metadata-only.csv');
 await panel.evaluate(()=>fetchPdfLinks());await panel.waitForFunction(()=>papers[0]?.pdfFailed===true);
 fail=false;await panel.evaluate(()=>fetchPdfLinks());await panel.waitForFunction(()=>!!papers[0]?.pdfLink);
 record=await panel.evaluate(()=>papers[0]);if(record.pdfLink!==origin+'/state/pdf'||record.pdfFailed)throw new Error('Retry failed');
 // 清空之后旧解析仍返回时，后台也拒绝旧结果。
 await panel.evaluate(async()=>{await patchPaper(papers[0],{pdfLink:'',pdfFailed:true});});
 await panel.waitForFunction(()=>!papers[0]?.pdfLink);
 const requested=new Promise(r=>entered=r);const fetching=panel.evaluate(()=>fetchPdfLinks());await requested;
 await panel.locator('#btn-clear').click();release();await fetching;
 const empty=await panel.evaluate(async()=>({papers,stored:(await chrome.storage.local.get('cnkiPapers')).cnkiPapers}));
 if(empty.papers.length||empty.stored.length)throw new Error('Stale write resurrected papers');
 await sample.close();await panel.bringToFront();
 await panel.evaluate(()=>window.stateRegression={selectionSortReload:true,metadataOnlyExport:true,failedLinkRetry:true,clearDuringFetch:true});
}
