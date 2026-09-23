/* ProQuest 公开学位论文适配。只读取页面已经提供的开放获取标记和链接。 */
var ProQuest = (() => {
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const openLabel = /^(?:公开论文|公開論文|开放获取|開放獲取|Open access|Open access dissertation|Open access thesis)$/i;
  const previewLabel = /^(?:提供预览|提供預覽|文档预览|文檔預覽|下载预览|下載預覽|Preview available|Document preview|Download preview)(?:\s|$)/i;

  function isSite(value) {
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) && /^(?:www\.)?proquest\.com$/i.test(url.hostname) && !url.username && !url.password;
    } catch { return false; }
  }
  function documentUrl(value, base) {
    try {
      const url = new URL(value, base);
      const id = url.pathname.match(/(?:^|\/)docview\/(\d+)(?:[\/;]|$)/)?.[1];
      return isSite(url.href) && id ? `${url.origin}/docview/${id}` : "";
    } catch { return ""; }
  }
  function mediaUrl(value, base) {
    try {
      const url = new URL(value, base);
      return /^https?:$/.test(url.protocol) && url.hostname === "media.proquest.com" &&
        url.pathname.startsWith("/media/") && !url.username && !url.password ? url.href : "";
    } catch { return ""; }
  }
  function access(root) {
    const labels = Array.from(root.querySelectorAll(".format-display, li, strong, .title-nav-container .h1, a[title], a.pdf-download, a.wt-download-pdf, [aria-label]"));
    const values = labels.flatMap(el => [clean(el.textContent), clean(el.getAttribute("title")), clean(el.getAttribute("aria-label"))]);
    // 预览也是 PDF；下载按钮、文件后缀和媒体 URL 参数均不能证明是全文。
    if (values.some(value => previewLabel.test(value))) return "preview";
    if (values.some(value => openLabel.test(value) || /^(?:此研究生作品已出版并开放阅览|此研究生作品已出版並開放閱覽|This graduate work has been published as open access)/i.test(value))) return "open";
    return "unknown";
  }
  function metadata(root, detailUrl, title) {
    const publication = clean(root.querySelector(".dissertpub")?.textContent);
    const authors = Array.from(root.querySelectorAll(".scholUnivAuthors .truncatedAuthor"), el => {
      const value = clean(el.textContent);
      const inverted = value.match(/^([^,]+),\s*([^,]+)$/);
      // 引用条目末尾的句号不是姓名的一部分；保留 R. 等单字母缩写。
      return inverted ? `${inverted[2].replace(/(\p{L}{2,})\.$/u, "$1")} ${inverted[1]}` : value;
    }).filter(Boolean);
    const source = publication.split(/ProQuest Dissertations\s*&\s*Theses/i)[0].trim();
    const year = publication.match(/ProQuest Dissertations\s*&\s*Theses,?\s*((?:19|20)\d{2})/i)?.[1] || "";
    return {
      provider: "proquest", proquestId: detailUrl.split("/").pop(), detailUrl,
      title: clean(title), author: authors.join(";"), source, date: year, docType: "D",
      pdfLink: "", pdfReady: false, level: "无", keywords: "",
    };
  }
  function parseDetail(doc, url) {
    const detailUrl = documentUrl(url);
    const heading = doc.querySelector("h1.documentTitle, h2.unauthdocheader");
    if (!detailUrl || !heading || !doc.querySelector(".dissertpub")) {
      throw new Error("未识别到 ProQuest 学位论文详情，请打开详情页确认后重试");
    }
    const paper = metadata(doc, detailUrl, heading.textContent);
    paper.proquestAccess = access(doc);
    let pdfUrl = "";
    if (paper.proquestAccess === "open") {
      for (const link of doc.querySelectorAll("a.pdf-download, a.wt-download-pdf")) {
        const label = `${clean(link.textContent)} ${clean(link.getAttribute("title"))}`;
        if (/preview|预览|預覽/i.test(label) || !/(?:download\s*PDF|下[载載]\s*PDF|PDF\s*下[载載])/i.test(label)) continue;
        pdfUrl = mediaUrl(link.getAttribute("href"), detailUrl);
        if (pdfUrl) break;
      }
    }
    paper.pdfReady = !!pdfUrl;
    paper.pdfFailed = !pdfUrl && paper.proquestAccess === "open";
    paper.proquestReason = paper.proquestAccess === "preview" ? "仅提供预览，本版跳过" :
      paper.proquestAccess !== "open" ? "未确认公开全文，本版跳过" :
      !pdfUrl ? "公开论文暂未找到 PDF 链接，请重试" : "";
    return { paper, pdfUrl }; // 签名链接仅用于当前操作，不写入清单或日志。
  }
  function collect(doc, url) {
    if (!isSite(url)) return { entries: [], total: 0, skipped: 0 };
    if (documentUrl(url)) {
      const { paper } = parseDetail(doc, url);
      return { entries: paper.proquestAccess === "open" ? [{ paper, anchor: doc.querySelector("h1.documentTitle, h2.unauthdocheader") }] : [], total: 1, skipped: paper.proquestAccess === "open" ? 0 : 1 };
    }
    const entries = [], seen = new Set();
    let total = 0, skipped = 0;
    for (const row of doc.querySelectorAll("li.resultItem")) {
      const anchor = row.querySelector('.resultHeader h3 a[href*="/docview/"]');
      const detailUrl = documentUrl(anchor?.getAttribute("href"), url);
      if (!detailUrl || seen.has(detailUrl)) continue;
      seen.add(detailUrl);
      total++;
      if (!row.querySelector(".dissertpub") || access(row) !== "open") { skipped++; continue; }
      const paper = metadata(row, detailUrl, anchor.textContent);
      paper.proquestAccess = "open";
      entries.push({ paper, anchor });
    }
    return { entries, total, skipped };
  }
  return { isSite, documentUrl, mediaUrl, access, parseDetail, collect };
})();
