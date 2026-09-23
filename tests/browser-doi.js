async (panel) => {
 const context=panel.context();let validPdf=false;
 await context.route('https://api.unpaywall.org/v2/**',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({title:'<b>DOI fixture</b>',journal_name:'Fixture journal',year:2026,z_authors:[{given:'John Q.',family:'Smith'}]})}));
 await context.route('https://sci.bban.top/pdf/**',route=>route.fulfill({contentType:validPdf?'application/pdf':'application/json',body:validPdf?'%PDF-1.7\nfixture\n%%EOF':'{"error":"not found"}'}));
 if(await panel.locator('#btn-clear').isVisible())await panel.locator('#btn-clear').click();await panel.waitForFunction(()=>papers.length===0);
 await panel.getByRole('button',{name:'DOI导入',exact:true}).click();await panel.locator('#doi-input').fill('10.1234/browserfixture');
 await panel.locator('#btn-doi-import').click();await panel.waitForFunction(()=>!importingDois && papers.length===1);
 let result=await panel.evaluate(()=>papers[0]);if(!result.pdfFailed||result.pdfLink||result.author!=='John Q. Smith')throw new Error('Invalid header accepted or author lost '+JSON.stringify(result));
 await panel.getByRole('button',{name:'批量下载',exact:true}).click();
 if(await panel.locator('.paper-title b').count())throw new Error('Metadata rendered as markup');
 if(await panel.locator('.paper-title').textContent()!=='<b>DOI fixture</b>')throw new Error('Text changed');
 await panel.locator('.paper-card label.check').click();await panel.waitForFunction(()=>papers[0]?.selected===false);
 validPdf=true;await panel.getByRole('button',{name:'DOI导入',exact:true}).click();await panel.locator('#btn-doi-import').click();
 await panel.waitForFunction(()=>!importingDois && !!papers[0]?.pdfLink);
 result=await panel.evaluate(()=>({papers,count:document.querySelector('#doi-count').textContent,progress:document.querySelector('#doi-progress-text').textContent}));
 if(result.papers.length!==1||result.papers[0].selected!==false||!result.count.includes('更新 1 篇'))throw new Error('Retry duplicated/reset '+JSON.stringify(result));
 await panel.getByRole('button',{name:'批量下载',exact:true}).click();await panel.locator('.proxy-settings summary').click();
 await panel.setViewportSize({width:430,height:930});await panel.screenshot({path:'output/playwright/final-panel.png'});
 await panel.evaluate(result=>window.doiBrowserResult={retryWithoutDuplicate:true,pdfHeaderRejectedJson:true,pdfHeaderAcceptedPdf:true,author:result.papers[0].author,escapedText:true,count:result.count},result);
}
