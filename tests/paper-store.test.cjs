const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const clone=v=>JSON.parse(JSON.stringify(v));
function harness(initial=[]) {
 const data={cnkiPapers:clone(initial),cnkiPapersEpoch:0};let fail=false;
 const chrome={storage:{local:{get:async()=>clone(data),set:async changes=>{if(fail)throw new Error('storage full');Object.assign(data,clone(changes));}}}};
 const ctx=vm.createContext({chrome,crypto:require('node:crypto').webcrypto});
 vm.runInContext(fs.readFileSync('extension/paper-store.js','utf8'),ctx);
 const store=vm.runInContext('PaperStore',ctx);
 return {data,send:m=>store.update({epoch:0,...m}),fail:v=>fail=v};
}
const paper=(id)=>({id,title:`paper ${id}`,detailUrl:`https://kns.cnki.net/kcms/${id}`,author:'既有作者',selected:false});
test('并发收藏不丢记录，重复 URL/大小写 DOI 去重，ID 碰撞不复用',async()=>{
 const h=harness();
 await Promise.all(Array.from({length:20},(_,id)=>h.send({action:'add',items:[paper(id)]})));
 assert.equal(h.data.cnkiPapers.length,20);
 await h.send({action:'add',items:[paper(1),{...paper(1),detailUrl:'https://doi.org/new',doi:'10.1234/ABC'}]});
 await h.send({action:'add',items:[{...paper(90),doi:'10.1234/abc'}]});
 assert.equal(h.data.cnkiPapers.length,21);assert.equal(new Set(h.data.cnkiPapers.map(p=>p.id)).size,21);
});
test('元数据增量与收藏、勾选并发不互相覆盖，旧数组格式和字段完整保留',async()=>{
 const h=harness([paper(1)]);
 await Promise.all([
 h.send({action:'patch',items:[{id:1,changes:{pdfLink:'https://pdf',author:'补全作者'}}]}),
 h.send({action:'add',items:[paper(2)]}),
 h.send({action:'patch',items:[{id:1,changes:{selected:true}}]})]);
 assert.equal(h.data.cnkiPapers.length,2);assert.equal(h.data.cnkiPapers[0].selected,true);assert.equal(h.data.cnkiPapers[0].pdfLink,'https://pdf');assert.equal(h.data.cnkiPapers[0].author,'补全作者');
});
test('清空后过期解析/导入/收藏被拒绝，新任务仍可正常保存',async()=>{
 const h=harness([paper(1)]);await h.send({action:'clear'});
 for(const m of [{action:'add',items:[paper(2)]},{action:'patch',items:[{id:1,changes:{pdfLink:'stale'}}]}])assert.equal((await h.send(m)).code,'stale');
 assert.deepEqual(h.data.cnkiPapers,[]);
 await h.send({action:'add',epoch:1,items:[paper(3)]});assert.equal(h.data.cnkiPapers.length,1);
});
test('删除后重新收藏的同一条目不会接收旧解析结果',async()=>{
 const h=harness();await h.send({action:'add',items:[paper(1)]});const old=h.data.cnkiPapers[0];
 await h.send({action:'toggle',paper:old});await h.send({action:'toggle',paper:old});
 await h.send({action:'patch',items:[{id:old.id,instance:old._instance,changes:{pdfLink:'stale'}}]});
 assert.equal(h.data.cnkiPapers[0].pdfLink,undefined);assert.notEqual(h.data.cnkiPapers[0]._instance,old._instance);
});
test('存储失败明确报错，后续操作不被失败队列锁死',async()=>{
 const h=harness();h.fail(true);await assert.rejects(h.send({action:'add',items:[paper(1)]}),/storage full/);
 assert.equal(h.data.cnkiPapers.length,0);h.fail(false);await h.send({action:'add',items:[paper(2)]});assert.equal(h.data.cnkiPapers.length,1);
});
