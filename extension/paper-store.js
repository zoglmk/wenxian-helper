/* Service Worker 内串行合并，保留原有 cnkiPapers 数组格式。 */
const PaperStore = (() => {
  let pending = Promise.resolve();
  const samePaper = (a, b) => (a.provider === "proquest" && b.provider === "proquest" && a.proquestId && a.proquestId === b.proquestId) ||
    (a.detailUrl && a.detailUrl === b.detailUrl) ||
    (a.doi && b.doi && a.doi.toLowerCase() === b.doi.toLowerCase());
  async function apply({ action, epoch, items = [], paper, id }) {
    const data = await chrome.storage.local.get(["cnkiPapers", "cnkiPapersEpoch", "cnkiPapersRevision"]);
    let papers = Array.isArray(data.cnkiPapers) ? data.cnkiPapers : [];
    let currentEpoch = data.cnkiPapersEpoch || 0;
    if (action !== "clear" && epoch !== currentEpoch) return { ok: false, code: "stale", error: "清单已清空，旧任务已停止" };
    let added = 0, updated = 0, collected;
    const append = (item) => {
      if (!item?.detailUrl || typeof item.title !== "string") throw new Error("文献信息不完整");
      if (papers.some((p) => samePaper(p, item))) return;
      let nextId = item.id;
      while (!Number.isSafeInteger(nextId) || papers.some((p) => p.id === nextId)) nextId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
      papers.push({ ...item, id: nextId, _instance: crypto.randomUUID() });
      added++;
    };
    if (action === "clear") { papers = []; currentEpoch++; }
    else if (action === "add") items.forEach(append);
    else if (action === "toggle") {
      const index = papers.findIndex((p) => samePaper(p, paper));
      if (index >= 0) { papers.splice(index, 1); collected = false; }
      else { append(paper); collected = true; }
    } else if (action === "patch") {
      for (const item of items) {
        const target = papers.find((p) => p.id === item.id && p._instance === item.instance);
        if (!target) continue; // 已删除/重新收藏的记录不能被旧请求覆盖。
        updated++;
        for (const [key, value] of Object.entries(item.changes || {})) {
          if (["id", "_instance", "detailUrl", "__proto__", "constructor", "prototype"].includes(key)) continue;
          target[key] = value;
        }
      }
    } else throw new Error("未知清单操作");
    const revision = (data.cnkiPapersRevision || 0) + 1;
    await chrome.storage.local.set({ cnkiPapers: papers, cnkiPapersEpoch: currentEpoch, cnkiPapersRevision: revision });
    return { ok: true, added, updated, collected, papers, epoch: currentEpoch, revision };
  }
  function update(message) {
    const operation = pending.then(() => apply(message));
    pending = operation.catch(() => {});
    return operation;
  }
  return { update };
})();
