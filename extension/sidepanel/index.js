/* 文献助手 - Side Panel Application */

// ── State ──
let papers = [];
let paperEpoch = 0;
let paperRevision = 0;
let taskGeneration = 0;
let activeDownloadWait = null;
let fetchingLinks = false;
let loadingLevels = false;
let importingDois = false;
function taskCurrent(generation, epoch = paperEpoch) {
  return generation === taskGeneration && epoch === paperEpoch;
}
function cancelTasks() {
  taskGeneration++;
  doiImportCancelled = true;
  activeDownloadWait?.cancel?.();
  pendingResumeIds = [];
  hideProgress();
}
async function mutatePapers(action, extra = {}, epoch = paperEpoch) {
  const result = await sendToBackground({ type: "PAPER_STORE", action, epoch, ...extra });
  if (!result?.ok) {
    if (result?.code === "stale") return false;
    throw new Error(result?.error || "保存清单失败");
  }
  acceptPaperSnapshot(result);
  return result;
}
function acceptPaperSnapshot({ papers: nextPapers, epoch = paperEpoch, revision = paperRevision }) {
  if (revision < paperRevision) return false;
  paperRevision = revision;
  if (epoch !== paperEpoch) {
    paperEpoch = epoch;
    cancelTasks();
    Object.keys(downloadState).forEach((id) => delete downloadState[id]);
    updateResumeButton();
  }
  papers = nextPapers || [];
  return true;
}
function isDoiPaper(paper) {
  if (isProquestPaper(paper)) return false;
  return paper.doiImport || !!paper.pdfSource || /^https?:\/\/doi\.org\//i.test(paper.detailUrl || "");
}
function isProquestPaper(paper) { return paper?.provider === "proquest"; }
function canDownloadPaper(paper) {
  return isProquestPaper(paper) ? paper.proquestAccess === "open" && !!paper.pdfReady : !!paper?.pdfLink;
}
function patchPaper(paper, changes, epoch) {
  return mutatePapers("patch", { items: [{ id: paper.id, instance: paper._instance, changes }] }, epoch);
}
let settings = { useWebVPN: false, fetchLevels: true, autoOpenOnVerify: true, downloadFolder: "" };
let sortField = "";
let sortDir = "desc";
const downloadState = {};
const logs = [];
const levelCache = new Map();
const levelPending = new Map();

// ── DOM ──
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ── API Helpers ──
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}


async function sendToContent(msg) {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("无活动标签页");
  return chrome.tabs.sendMessage(tab.id, msg);
}

async function sendToBackground(msg) {
  return chrome.runtime.sendMessage(msg);
}

async function ensureContentScript(tab = null) {
  tab = tab || await getActiveTab();
  if (!tab?.id) return false;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "PING" });
    return true;
  } catch {
    try {
      const files = ProQuest.isSite(tab.url) ? ["proquest.js", "content/proquest.js"] : ["content/main.js"];
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
      return true;
    } catch { return false; }
  }
}

// ── Custom Library / Proxy Domains ──
async function renderProxyDomains() {
  const list = $("#proxy-domain-list");
  const domains = await ProxyDomains.list();
  list.replaceChildren();
  for (const domain of domains) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = domain;
    const remove = document.createElement("button");
    remove.className = "btn btn-ghost btn-sm";
    remove.textContent = "移除";
    remove.setAttribute("aria-label", `移除 ${domain}`);
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        const result = await sendToBackground({ type: "UPDATE_PROXY_DOMAIN", action: "remove", domain });
        if (!result?.ok) throw new Error(result?.error || "移除失败");
        await renderProxyDomains();
        $("#proxy-status").textContent = "已移除域名及访问权限，已打开的页面刷新后生效";
      } catch (err) {
        $("#proxy-status").textContent = `移除失败：${err.message}`;
      } finally {
        remove.disabled = false;
      }
    });
    item.append(label, remove);
    list.appendChild(item);
  }
}

async function addProxyDomain() {
  const status = $("#proxy-status");
  const button = $("#btn-add-proxy");
  button.disabled = true;
  try {
    const domain = ProxyDomains.normalize($("#input-proxy-domain").value);
    // 必须直接在点击回调中申请权限，不能先等待网络或 storage 操作。
    const granted = await chrome.permissions.request({ origins: [ProxyDomains.pattern(domain)] });
    if (!granted) {
      status.textContent = "未获得授权，域名未添加；已有下载功能不受影响";
      return;
    }
    const result = await sendToBackground({ type: "UPDATE_PROXY_DOMAIN", action: "add", domain });
    if (!result?.ok) throw new Error(result?.error || "保存失败");
    $("#input-proxy-domain").value = "";
    await renderProxyDomains();
    status.textContent = "已添加。请在该域名下的知网搜索结果页点击「添加本页」";
    const tab = await getActiveTab();
    if (tab?.url && ProxyDomains.matchesHost(new URL(tab.url).hostname, domain)) {
      const ready = await ensureContentScript(tab);
      if (!ready) status.textContent = "域名已保存，请刷新知网页面后点击「添加本页」";
    }
  } catch (err) {
    status.textContent = `设置失败：${err.message}`;
  } finally {
    button.disabled = false;
  }
}

// ── Storage ──
async function loadSettings() {
  const data = await chrome.storage.local.get(["useWebVPN", "fetchLevels", "autoOpenOnVerify", "downloadFolder", "cnkiPapers", "cnkiPapersEpoch", "cnkiPapersRevision", "cnkiSort"]);
  settings.useWebVPN = data.useWebVPN ?? false;
  settings.fetchLevels = data.fetchLevels ?? true;
  settings.autoOpenOnVerify = data.autoOpenOnVerify ?? true;
  settings.downloadFolder = data.downloadFolder ?? "";
  papers = Array.isArray(data.cnkiPapers) ? data.cnkiPapers : [];
  paperEpoch = data.cnkiPapersEpoch || 0;
  paperRevision = data.cnkiPapersRevision || 0;
  if (data.cnkiSort) { sortField = data.cnkiSort.field || ""; sortDir = data.cnkiSort.dir || "desc"; }
}

async function saveSort() {
  await chrome.storage.local.set({ cnkiSort: { field: sortField, dir: sortDir } });
}

// ── Logging (errors only in UI) ──
function addLog(level, title, detail = "") {
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  logs.push({ time, level, title, detail });
  if (level === "error") {
    renderLogEntry({ time, level, title, detail });
    updateLogBadge();
    $("#log-panel").hidden = false;
  }
}

function renderLogEntry(entry) {
  const list = $("#log-list");
  if (!list) return;
  const escaped = escapeHtml(entry.detail);
  const el = document.createElement("div");
  el.className = "log-entry log-error";
  el.innerHTML = `
    <div class="log-entry-header">
      <span class="log-time">${escapeHtml(entry.time)}</span>
      <span class="log-msg">${escapeHtml(entry.title)}</span>
      <button class="log-copy-btn" title="复制详情">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
      </button>
    </div>
    ${escaped ? `<div class="log-detail">${escaped}</div>` : ""}
  `;
  el.querySelector(".log-copy-btn").addEventListener("click", () => {
    navigator.clipboard.writeText(`[${entry.time}] ${entry.title}\n${entry.detail}`);
  });
  list.appendChild(el);
  list.scrollTop = list.scrollHeight;
}

function updateLogBadge() {
  const n = logs.filter((l) => l.level === "error").length;
  $("#log-badge").textContent = n;
  $("#log-badge").hidden = n === 0;
  $("#log-badge-footer").textContent = n;
  $("#log-badge-footer").hidden = n === 0;
}

// ── Utils ──
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function safeHttpUrl(value) {
  try { return /^https?:$/.test(new URL(value).protocol) ? String(value) : ""; }
  catch { return ""; }
}

function createSafeFilename(name, maxLen = 200) {
  let s = name.replace(/[\/:*?"<>|\\]/g, "_").replace(/\s+/g, " ").trim();
  return (s.length > maxLen ? s.substring(0, maxLen) : s) + ".pdf";
}

// ── Citation Formatting & Export ──

function parseYear(dateStr) {
  if (!dateStr) return "";
  const m = String(dateStr).match(/(\d{4})/);
  return m ? m[1] : "";
}

function detectDocType(paper) {
  if (isProquestPaper(paper) && paper.docType === "D") return "D";
  const text = (paper.source || "") + " " + (paper.title || "");
  if (/学位论文|博士论文|硕士论文/.test(text)) return "D";
  if (/会议|proceedings/i.test(text)) return "C";
  if (/报纸|日报|晚报/.test(text)) return "N";
  return "J";
}

function cleanAuthorName(name) {
  if (!name) return "";
  return String(name)
    .replace(/\d+/g, "")
    .replace(/[\s　 ]+/g, " ")
    .replace(/[,，;；、。]+$/, "")
    .trim();
}

// Robust author list parser: handles "李秀秀1 查艳2; 1.大学; 2.大学" etc.
function splitAuthors(authorStr) {
  if (!authorStr) return [];
  const segments = String(authorStr).split(/[;；]/).filter((s) => {
    // Drop institution-like segments and "1.机构" entries
    return !/(大学|学院|医院|研究所|公司|中心|实验室)/.test(s)
      && !/^\s*\d+\s*[.\.]/.test(s);
  });
  const names = [];
  for (const seg of segments) {
    if (/[,，、]/.test(seg)) {
      seg.split(/[,，、]/).forEach((s) => {
        const n = cleanAuthorName(s);
        if (n) names.push(n);
      });
      continue;
    }
    if (/[\s　]/.test(seg)) {
      // Multiple CJK names separated by spaces (e.g. "李秀秀1 查艳2")
      const tokens = seg.split(/[\s　]+/)
        .map((s) => cleanAuthorName(s)).filter(Boolean);
      const allCjk = tokens.length > 1
        && tokens.every((t) => /^[一-龥]{2,4}$/.test(t));
      if (allCjk) {
        names.push(...tokens);
      } else {
        const n = cleanAuthorName(seg);
        if (n) names.push(n);
      }
      continue;
    }
    const n = cleanAuthorName(seg);
    if (n) names.push(n);
  }
  return names;
}

function formatAuthors(authorStr, style = "gb7714") {
  const authors = splitAuthors(authorStr);
  if (authors.length === 0) return "";

  if (style === "apa") {
    if (authors.length === 1) return authors[0];
    if (authors.length === 2) return authors.join(" & ");
    if (authors.length > 6) {
      return authors.slice(0, 6).join(",") + ",..." + authors[authors.length - 1];
    }
    return authors.slice(0, -1).join(",") + " & " + authors[authors.length - 1];
  }

  if (style === "mla") {
    if (authors.length === 1) return authors[0];
    if (authors.length === 2) return authors[0] + ",and " + authors[1];
    return authors[0] + ",et al.";
  }

  // gb7714: 三人以内全列, 超过取前三+等
  if (authors.length <= 3) return authors.join(",");
  return authors.slice(0, 3).join(",") + ",等";
}

function formatCitation(paper, style = "gb7714") {
  const year = parseYear(paper.date);
  const docType = detectDocType(paper);
  const volume = paper.volume || "";
  const issue = paper.issue || "";
  const pages = paper.pages || "";
  const title = paper.title || "";

  if (style === "gb7714") {
    const authors = formatAuthors(paper.author, "gb7714");
    let s = "";
    if (authors) s += authors + ".";
    s += title + `[${docType}].`;
    if (paper.source) {
      s += paper.source;
      if (year) s += "," + year;
      if (volume) s += "," + volume + (issue ? `(${issue})` : "");
      else if (issue) s += `(${issue})`;
      if (pages) s += ":" + pages;
      s += ".";
    } else if (year) {
      s += year + ".";
    }
    if (paper.doi) s += "DOI:" + paper.doi + ".";
    return s;
  }

  if (style === "apa") {
    const authors = formatAuthors(paper.author, "apa");
    let s = "";
    if (authors) s += authors + ".";
    if (year) s += `(${year}).`;
    s += title + ".";
    if (paper.source) {
      s += paper.source;
      if (volume) {
        s += "," + volume;
        if (issue) s += `(${issue})`;
      } else if (issue) {
        s += "(" + issue + ")";
      }
      if (pages) s += "," + pages;
      s += ".";
    }
    if (paper.doi) s += "https://doi.org/" + paper.doi + ".";
    return s;
  }

  if (style === "mla") {
    const authors = formatAuthors(paper.author, "mla");
    let s = "";
    if (authors) s += authors + ".";
    s += `"${title}."`;
    if (paper.source) {
      s += paper.source;
      if (volume && issue) s += " " + volume + "." + issue;
      else if (volume) s += " " + volume;
      if (year) s += `(${year})`;
      if (pages) s += ":" + pages;
      s += ".";
    }
    if (paper.doi) s += "doi:" + paper.doi + ".";
    return s;
  }

  // plain - cleaned legacy format
  const cleanedAuthor = splitAuthors(paper.author).join(";");
  const parts = [title];
  if (cleanedAuthor) parts.push(cleanedAuthor);
  if (paper.source) parts.push(paper.source);
  if (paper.date) parts.push(paper.date);
  return parts.join(". ");
}

function formatBibTeX(paper) {
  const year = parseYear(paper.date);
  const docType = detectDocType(paper);
  // ProQuest 公开页未必提供学位种类，不能把所有学位论文都标为博士论文。
  const entryType = isProquestPaper(paper) ? "misc" : docType === "D" ? "phdthesis" :
                    docType === "C" ? "inproceedings" :
                    "article";
  const firstAuthor = (paper.author || "").split(/[;；、,,，]/)[0]?.trim() || "Anon";
  const firstWord = (paper.title || "untitled").split(/\s+/)[0]
    .replace(/[^A-Za-z0-9一-龥]/g, "");
  const key = (firstAuthor + (year || "") + firstWord)
    .replace(/[^A-Za-z0-9一-龥]/g, "") || "ref";

  const escape = (s) => String(s || "").replace(/[{}\\]/g, "");
  const lines = [`@${entryType}{${key},`];
  if (paper.title) lines.push(`  title = {${escape(paper.title)}},`);
  if (paper.author) {
    const auths = splitAuthors(paper.author).map(escape).join(" and ");
    if (auths) lines.push(`  author = {${auths}},`);
  }
  if (isProquestPaper(paper)) {
    lines.push("  type = {Thesis},");
    if (paper.source) lines.push(`  school = {${escape(paper.source)}},`);
  } else if (paper.source) lines.push(`  journal = {${escape(paper.source)}},`);
  if (year) lines.push(`  year = {${year}},`);
  if (paper.volume) lines.push(`  volume = {${escape(paper.volume)}},`);
  if (paper.issue) lines.push(`  number = {${escape(paper.issue)}},`);
  if (paper.pages) lines.push(`  pages = {${escape(paper.pages)}},`);
  if (paper.keywords) lines.push(`  keywords = {${escape(paper.keywords)}},`);
  if (paper.abstract) lines.push(`  abstract = {${escape(paper.abstract)}},`);
  if (paper.doi) lines.push(`  doi = {${paper.doi}},`);
  if (paper.detailUrl) lines.push(`  url = {${paper.detailUrl}},`);
  // Strip trailing comma from last entry
  const last = lines.pop();
  lines.push(last.replace(/,$/, ""));
  lines.push("}");
  return lines.join("\n");
}

function formatRIS(paper) {
  const year = parseYear(paper.date);
  const docType = detectDocType(paper);
  const tyCode = docType === "D" ? "THES" :
                 docType === "C" ? "CONF" :
                 docType === "N" ? "NEWS" :
                 "JOUR";

  const lines = [`TY  - ${tyCode}`];
  if (paper.title) lines.push(`TI  - ${paper.title}`);
  if (paper.author) {
    splitAuthors(paper.author).forEach((a) => lines.push(`AU  - ${a}`));
  }
  if (paper.source) lines.push(`T2  - ${paper.source}`);
  if (year) lines.push(`PY  - ${year}`);
  if (paper.volume) lines.push(`VL  - ${paper.volume}`);
  if (paper.issue) lines.push(`IS  - ${paper.issue}`);
  if (paper.pages) lines.push(`SP  - ${paper.pages}`);
  if (paper.keywords) {
    paper.keywords.split(/[,，;；]/).map((k) => k.trim()).filter(Boolean)
      .forEach((k) => lines.push(`KW  - ${k}`));
  }
  if (paper.abstract) lines.push(`AB  - ${paper.abstract}`);
  if (paper.doi) lines.push(`DO  - ${paper.doi}`);
  if (paper.detailUrl) lines.push(`UR  - ${paper.detailUrl}`);
  lines.push("ER  - ");
  return lines.join("\n");
}

function csvEscape(value) {
  const s = String(value == null ? "" : value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function papersToCSV(papers) {
  const headers = ["标题", "作者", "来源", "日期", "卷", "期", "页码", "DOI", "被引", "下载", "等级", "关键词", "摘要", "详情链接"];
  const rows = [headers.map(csvEscape).join(",")];
  papers.forEach((p) => {
    const cleanedAuthor = splitAuthors(p.author).join(";");
    rows.push([
      p.title, cleanedAuthor, p.source, p.date, p.volume, p.issue, p.pages,
      p.doi || "", p.quote, p.download, p.level, p.keywords, p.abstract, p.detailUrl,
    ].map(csvEscape).join(","));
  });
  // UTF-8 BOM for Excel compatibility
  return "﻿" + rows.join("\n");
}

function papersToBibTeX(papers) {
  return papers.map(formatBibTeX).join("\n\n");
}

function papersToRIS(papers) {
  return papers.map(formatRIS).join("\n\n");
}

// ── CNKI Official Citation API (ShowExport) ──
//
// citationCache[paperId][mode] = "已格式化的引用文本"
const citationCache = {};
const STYLE_TO_DISPLAY_MODE = { gb7714: "GBTREFER", apa: "APA", mla: "MLA" };

// CNKI's export endpoints reject requests whose Origin is the chrome-extension://
// scheme. Run fetch from a CNKI page tab (MAIN world) so Origin is kns.cnki.net.
function isCnkiLikeUrl(url = "") {
  try {
    const { protocol, hostname } = new URL(url);
    return /^https?:$/.test(protocol) && /(^|\.)(cnki\.net|edu\.cn)$/i.test(hostname);
  } catch {
    return false;
  }
}

async function getCnkiTab() {
  const active = await getActiveTab();
  if (active?.id && isCnkiLikeUrl(active.url)) return active;
  // 公共图书馆代理未必使用 cnki.net / edu.cn。只检查当前页，使用用户
  // 点击扩展图标时授予的 activeTab 权限，不扩大永久网站访问权限。
  if (active?.id && await ensureContentScript(active)) {
    try {
      const status = await chrome.tabs.sendMessage(active.id, { type: "PING" });
      if (status?.isCnki) return active;
    } catch {
      // 标签页已跳转或关闭时，继续查找原有的知网 / 学校代理标签页。
    }
  }
  // 当前激活页不是知网/WebVPN，搜索所有已打开的相关标签页
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => t.id && isCnkiLikeUrl(t.url));
  if (existing) return existing;
  const domains = await ProxyDomains.list();
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    if (!domains.some((domain) => ProxyDomains.matchesHost(new URL(tab.url).hostname, domain))) continue;
    try {
      const status = await chrome.tabs.sendMessage(tab.id, { type: "PING" });
      if (status?.isCnki) return tab;
    } catch {
      // 该代理页尚未加载或已失去权限，继续查找可用页面。
    }
  }
  return null;
}

async function postViaCnkiPage(url, body) {
  const targetTab = await getCnkiTab();
  if (!targetTab) throw new Error("请在打开的知网页面上使用（接口需要从知网域调用）");
  const result = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    world: "MAIN",
    func: async (u, b) => {
      try {
        const r = await fetch(u, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: b,
        });
        return { ok: r.ok, status: r.status, text: await r.text() };
      } catch (e) {
        return { ok: false, status: 0, error: e.message };
      }
    },
    args: [url, body],
  });
  return result?.[0]?.result || { ok: false };
}

// GET via cnki tab MAIN-world fetch — returns response as text (or "" if request errored).
// Used to probe download endpoints when the iframe redirects to an HTML notice page.
async function getViaCnkiPage(url) {
  const targetTab = await getCnkiTab();
  if (!targetTab) return { ok: false };
  const result = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    world: "MAIN",
    func: async (u) => {
      try {
        const r = await fetch(u, { credentials: "include" });
        return { ok: r.ok, status: r.status, finalUrl: r.url, text: await r.text() };
      } catch (e) {
        return { ok: false, status: 0, error: e.message };
      }
    },
    args: [url],
  });
  return result?.[0]?.result || { ok: false };
}

// Heuristics on a CNKI response page (HTML body text) to classify why a
// download didn't return a PDF. Returns: "verify" | "quota" | "auth" | "unknown".
function classifyDownloadPage(href, text) {
  if (/\/(bar\/)?verify\/|\/captcha\//i.test(href)) return "verify";
  // settlementHtml = 结算页（额度耗尽时知网弹出的提示页路径），htmlread 也常带这个 marker
  if (/settlementHtml|\/orderpay\/|\/buy\//i.test(href)) return "quota";
  if (text) {
    if (/下载量已满|漫游下载量|当日下载量|下载额度|下载次数已|超出.*下载次数|已达.*下载.*上限|继续阅读|个人账号下载阅读|绑定账户/.test(text)) return "quota";
    if (/拼图校验|滑块|安全验证|verify|captcha/i.test(text)) return "verify";
    if (/请登录|未登录|登录后下载|未授权/.test(text)) return "auth";
  }
  return "unknown";
}

function citeHtmlToText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const items = doc.querySelectorAll(".literature-list > li");
  return Array.from(items).map((li) => {
    li.querySelectorAll(".index").forEach((s) => s.remove());
    return li.textContent.replace(/\s+/g, " ").trim();
  });
}

async function fetchOfficialCitations(targets, mode) {
  const displayMode = STYLE_TO_DISPLAY_MODE[mode];
  if (!displayMode) return new Map();

  const result = new Map();
  const need = [];
  for (const p of targets) {
    if (citationCache[p.id]?.[mode]) {
      result.set(p.id, citationCache[p.id][mode]);
    } else if (p.cookieName) {
      need.push(p);
    }
  }
  if (need.length === 0) return result;

  // Batch by 20 (CNKI default page size)
  const BATCH = 20;
  for (let i = 0; i < need.length; i += BATCH) {
    const batch = need.slice(i, i + BATCH);
    const fileNames = batch.map((p) => p.cookieName).join(",");
    const body = new URLSearchParams({
      FileName: fileNames,
      DisplayMode: displayMode,
      OrderParam: "0",
      OrderType: "desc",
      SelectField: "",
      PageIndex: "1",
      PageSize: String(batch.length),
      language: "CHS",
      uniplatform: "NZKPT",
      subject: "",
      random: String(Math.random()),
    }).toString();

    let texts = [];
    try {
      const res = await postViaCnkiPage("https://kns.cnki.net/dm8/api/ShowExport", body);
      if (res?.ok && res.text) texts = citeHtmlToText(res.text);
      else if (res?.error) addLog("error", "调用知网官方引用接口失败", `${res.error}\n模式: ${displayMode}`);
    } catch (err) {
      addLog("error", "调用知网官方引用接口失败", `${err.message}\n模式: ${displayMode}`);
    }

    // Pair returned texts with the batch input order; if mismatch, give up on this batch
    if (texts.length === batch.length) {
      batch.forEach((p, idx) => {
        if (!citationCache[p.id]) citationCache[p.id] = {};
        citationCache[p.id][mode] = texts[idx];
        result.set(p.id, texts[idx]);
      });
    } else if (texts.length > 0) {
      addLog("error", "知网引用接口返回数量不匹配", `期望 ${batch.length} 条，实际 ${texts.length} 条，已回退本地拼装`);
    }
  }
  return result;
}

// Single-paper endpoint — returns all three formats in one call. Used when a
// user clicks the per-card copy button. The batch ShowExport endpoint refuses
// single-row requests with 403, hence this separate path.
async function fetchSingleCitation(paper) {
  if (!paper.cookieName) return null;
  const body = new URLSearchParams({
    filename: paper.cookieName,
    displaymode: "GBTREFER,MLA,APA",
    uniplatform: "NZKPT",
    language: "CHS",
  }).toString();
  let res;
  try {
    res = await postViaCnkiPage("https://kns.cnki.net/dm8/API/GetExport", body);
  } catch (err) {
    addLog("error", "调用知网引用接口失败", err.message || String(err));
    return null;
  }
  if (!res?.ok || !res.text) {
    if (res?.error) addLog("error", "调用知网引用接口失败", res.error);
    return null;
  }
  let data;
  try { data = JSON.parse(res.text); } catch { return null; }
  if (data?.code !== 1 || !Array.isArray(data.data)) return null;
  const out = {};
  for (const entry of data.data) {
    const raw = entry.value?.[0] || "";
    const text = raw.replace(/<br\s*\/?>/gi, "").replace(/^\s*\[\d+\]\s*/, "").trim();
    if (entry.mode === "GBTREFER") out.gb7714 = text;
    else if (entry.mode === "APA") out.apa = text;
    else if (entry.mode === "MLA") out.mla = text;
  }
  return out;
}

async function getCitation(paper, style) {
  // Plain mode and styles without official equivalent → local format
  if (!STYLE_TO_DISPLAY_MODE[style]) return formatCitation(paper, style);
  // Already cached?
  if (citationCache[paper.id]?.[style]) return citationCache[paper.id][style];
  // No cookieName → fall back to local
  if (!paper.cookieName) return formatCitation(paper, style);
  // Single-paper: GetExport returns all 3 formats; cache them all.
  const all = await fetchSingleCitation(paper);
  if (all) {
    citationCache[paper.id] = { ...(citationCache[paper.id] || {}), ...all };
    if (all[style]) return all[style];
  }
  return formatCitation(paper, style);
}

async function downloadAsFile(filename, content, mimeType = "text/plain") {
  const blob = new Blob([content], { type: mimeType + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const result = await sendToBackground({ type: "SAVE_DOWNLOAD", url, filename, saveAs: true });
    if (!result?.ok) throw new Error(result?.error || "导出下载未能启动");
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

// ── Fetch PDF Links (enriches papers with pdfLink, author, keywords) ──
async function resolveProquestPaper(paper) {
  const res = await sendToBackground({ type: "FETCH_PROQUEST_DOCUMENT", url: paper.detailUrl });
  if (!res?.ok) throw new Error(`ProQuest 详情获取失败 (${res?.status || "网络异常"})，请稍后重试`);
  const expected = ProQuest.documentUrl(paper.detailUrl);
  const finalDocument = ProQuest.documentUrl(res.finalUrl);
  if (!finalDocument || finalDocument.split("/").pop() !== expected.split("/").pop()) throw new Error("ProQuest 返回了其他页面，请打开论文详情确认后重试");
  return ProQuest.parseDetail(new DOMParser().parseFromString(res.text, "text/html"), expected);
}

async function fetchProquestPaper(paper, generation, epoch) {
  let changes;
  try {
    ({ paper: changes } = await resolveProquestPaper(paper));
  } catch (err) {
    changes = { pdfReady: false, pdfLink: "", pdfFailed: true, proquestReason: err.message };
    if (taskCurrent(generation, epoch)) addLog("error", `获取公开全文失败: ${paper.title}`, err.message);
  }
  if (taskCurrent(generation, epoch)) await patchPaper(paper, changes, epoch);
}

async function fetchPdfLinks(ids = null) {
  if (fetchingLinks) { $("#footer-status").textContent = "正在获取链接，请稍候"; return; }
  fetchingLinks = true;
  try { await performFetchPdfLinks(Array.isArray(ids) ? ids : null); }
  catch (err) { addLog("error", "保存链接失败", err.message); }
  finally { fetchingLinks = false; }
}
async function performFetchPdfLinks(ids) {
  const generation = taskGeneration, epoch = paperEpoch;
  const pending = papers.filter((p) => !canDownloadPaper(p) && !isDoiPaper(p) && (!ids || ids.includes(p.id))).map((p) => ({ ...p }));
  if (pending.length === 0) {
    $("#footer-status").textContent = papers.length ? "没有待解析的文献；DOI 文献请到 DOI 导入页重试" : "请先添加文献";
    return;
  }

  let done = 0;
  setProgress(0, `获取链接 0/${pending.length}`);

  async function fetchOne(paper) {
    if (isProquestPaper(paper)) {
      await fetchProquestPaper(paper, generation, epoch);
      if (taskCurrent(generation, epoch)) {
        done++;
        setProgress(Math.round((done / pending.length) * 100), `获取链接 ${done}/${pending.length}`);
      }
      return;
    }
    const before = { ...paper };
    try {
      const res = await sendToBackground({ type: "FETCH_TEXT", url: paper.detailUrl, timeoutMs: 20000 });
      if (!taskCurrent(generation, epoch)) return;
      if (!res?.ok) throw new Error(res?.error || `请求失败 (${res?.status || "未知状态"})`);
      if (res?.text) {
        const doc = new DOMParser().parseFromString(res.text, "text/html");

        // Try multiple strategies to find PDF download link
        let pdfLink = "";

        // Helper: extract href attribute directly (not resolved .href which may mangle relative URLs)
        const getHref = (el) => el?.getAttribute("href") || el?.href || "";

        // Strategy 1: .operate-btn container (domestic CNKI)
        const operateBtn = doc.querySelector(".operate-btn");
        if (operateBtn) {
          const el = Array.from(operateBtn.querySelectorAll("a")).find(
            (a) => /PDF下[载載]|整本下[载載]|Download\s*PDF/i.test(a.textContent)
          );
          if (el) pdfLink = getHref(el);
        }

        // Strategy 2: overseas CNKI (.btn-download-pdf #pdfDown)
        if (!pdfLink) {
          const dlEl = doc.querySelector(".btn-download-pdf a, a#pdfDown, a#cajDown");
          if (dlEl) {
            // Prefer PDF over CAJ
            const pdfEl = doc.querySelector(".btn-download-pdf a, a#pdfDown");
            pdfLink = getHref(pdfEl || dlEl);
          }
        }

        // Strategy 3: common selectors (btn-dlpdf, download.aspx, etc.)
        if (!pdfLink) {
          const dlEl = doc.querySelector("a.btn-dlpdf, a[href*='download.aspx']");
          if (dlEl) pdfLink = getHref(dlEl);
        }

        // Strategy 4: any link containing PDF download text on the page
        if (!pdfLink) {
          const allLinks = Array.from(doc.querySelectorAll("a[href]"));
          const dlLink = allLinks.find((a) => /PDF下[载載]|整本下[载載]|Download\s*PDF/i.test(a.textContent));
          if (dlLink) pdfLink = getHref(dlLink);
        }

        // Resolve relative URL to absolute based on detail page
        if (pdfLink && !pdfLink.startsWith("http")) {
          try {
            pdfLink = new URL(pdfLink, paper.detailUrl).href;
          } catch {}
        }

        pdfLink = safeHttpUrl(pdfLink);
        if (pdfLink) { paper.pdfLink = pdfLink; paper.pdfFailed = false; }

        // Author extraction. Prefer per-anchor iteration: detail pages render
        // each author as a separate <a> inside the .author wrapper; using the
        // wrapper's textContent collapses adjacent names without delimiters.
        // Run unconditionally so older stored entries with collision artifacts
        // get repaired on the next "获取链接".
        const authorAs = doc.querySelectorAll(".author a, .author span");
        let extracted = Array.from(authorAs)
          .map((el) => cleanAuthorName(el.textContent))
          .filter(Boolean);
        if (extracted.length === 0) {
          const raw = Array.from(doc.querySelectorAll(".author"))
            .map((a) => a.textContent.trim()).join(";");
          extracted = splitAuthors(raw);
        }
        if (extracted.length > 0) paper.author = extracted.join(";");
        if (!paper.keywords) {
          paper.keywords = Array.from(doc.querySelectorAll(".keywords a"))
            .map((k) => k.textContent.replace(/;/g, "").trim()).filter(Boolean).join(",");
        }
        if (!paper.abstract) {
          const absEl = doc.querySelector("#ChDivSummary") || doc.querySelector(".abstract-text");
          if (absEl) paper.abstract = absEl.textContent.trim();
        }

        // Volume / Issue / Pages — try unified pattern first, then per-field fallback
        if (!paper.volume || !paper.issue || !paper.pages) {
          let infoText = "";
          for (const sel of [".top-tip", ".top-space", ".doc-top", ".wx-tit", ".sourinfo", ".doc-detail-info", ".doc-info"]) {
            const el = doc.querySelector(sel);
            if (el) infoText += " " + el.textContent;
          }
          // Unified pattern: "YYYY,VOL(ISS):PAGES" with optional spaces between any tokens
          const unified = infoText.match(/(\d{4})\s*[,，]?\s*(\d+)\s*\(\s*(\d+)\s*\)\s*[:：]\s*([\d\-–~]+)/);
          if (unified) {
            if (!paper.volume) paper.volume = unified[2];
            if (!paper.issue) paper.issue = unified[3];
            if (!paper.pages) paper.pages = unified[4].replace(/\s/g, "");
          }
          // Per-field fallbacks (handles "卷"/"期"/"P xx-xx" patterns)
          if (!paper.volume) {
            const m = infoText.match(/(\d+)\s*卷/) || infoText.match(/Vol\.?\s*(\d+)/i);
            if (m) paper.volume = m[1];
          }
          if (!paper.issue) {
            const m = infoText.match(/第\s*(\d+)\s*期/) || infoText.match(/No\.?\s*(\d+)/i);
            if (m) paper.issue = m[1];
          }
          if (!paper.pages) {
            const m = infoText.match(/(?:页码|Pages?)\s*[:：]?\s*(\d+\s*[-–~]\s*\d+|\d+)/i)
              || infoText.match(/\sP\s*(\d+\s*[-–~]\s*\d+)/i);
            if (m) paper.pages = m[1].replace(/\s/g, "");
          }
        }

        // DOI extraction — try dedicated element / link, then fallback to body text scan
        if (!paper.doi) {
          const doiPattern = /10\.[0-9]{4,9}\/[-._;()/:a-zA-Z0-9]+/;
          const doiEl = doc.querySelector("[class*='doi'] a, [class*='doi']")
            || doc.querySelector("a[href*='doi.org']");
          if (doiEl) {
            const m = (doiEl.textContent || "").match(doiPattern)
              || (doiEl.getAttribute("href") || "").match(doiPattern);
            if (m) paper.doi = m[0];
          }
          if (!paper.doi) {
            const bodyText = doc.body?.textContent || "";
            const m = bodyText.match(/DOI[\s:：]+\s*(10\.[0-9]{4,9}\/[-._;()/:a-zA-Z0-9]+)/i);
            if (m) paper.doi = m[1];
          }
        }

        const h1 = doc.querySelector(".wx-tit h1");
        if (h1) { h1.querySelectorAll("span").forEach((s) => s.remove()); paper.title = h1.textContent.trim() || paper.title; }
      }

      if (!paper.pdfLink) {
        paper.pdfFailed = true;
        addLog("error", `未找到下载链接: ${paper.title}`, `详情页: ${paper.detailUrl}`);
      }
    } catch (err) {
      paper.pdfFailed = true;
      addLog("error", `获取链接失败: ${paper.title}`, `${err.message}\n详情页: ${paper.detailUrl}`);
    }
    if (!taskCurrent(generation, epoch)) return;
    const changes = Object.fromEntries(Object.entries(paper).filter(([key, value]) => before[key] !== value));
    await patchPaper(paper, changes, epoch);
    if (!taskCurrent(generation, epoch)) return;
    done++;
    setProgress(Math.round((done / pending.length) * 100), `获取链接 ${done}/${pending.length}`);
  }

  // Concurrent fetch with limit of 3
  const CONCURRENCY = 3;
  const queue = [...pending];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0 && taskCurrent(generation, epoch)) {
      const paper = queue.shift();
      await fetchOne(paper);
      await new Promise((r) => setTimeout(r, 300));
    }
  });
  const outcomes = await Promise.allSettled(workers);
  const rejected = outcomes.find((r) => r.status === "rejected");
  if (rejected) throw rejected.reason;

  if (!taskCurrent(generation, epoch)) return;
  hideProgress();
  renderList();
  restoreChecks();
  updateFooter();
  if (settings.fetchLevels) loadAllLevels();
}

// ── Download Logic (via hidden iframe in page context — same as user clicking a link) ──
let consecutiveFails = 0;
let pendingResumeIds = [];
// URL the queue's auto-open should jump to. Set by downloadPaper when it
// returns verify/quota/blocked. For verify we use the webNav-captured URL
// directly (verify pages don't check Referer); for quota/blocked we use the
// detail page since the raw download URL bounces to "来源不正确" without a
// valid Referer (which a fresh tab can't supply).
let lastBlockOpenUrl = "";

// Returns: "success" | "verify" | "quota" | "fail"
let downloadBusy = false;
let downloadQueueBusy = false;
async function downloadPaper(id) {
  if (downloadBusy) return "busy";
  downloadBusy = true;
  try { return await performDownload(id, taskGeneration); }
  finally { downloadBusy = false; }
}

async function performDownload(id, generation) {
  const setState = (...args) => { if (taskCurrent(generation)) setDownloadState(...args); };
  const paper = papers.find((p) => p.id === id);
  if (isProquestPaper(paper)) return downloadProquestPaper(paper, generation);
  if (!paper?.pdfLink) return "fail";
  if (!safeHttpUrl(paper.pdfLink)) { setState(id, "error", "下载地址必须为 HTTP / HTTPS"); return "fail"; }

  setState(id, "downloading");

  // DOI 来源（Unpaywall / Sci-Hub 直链）：直接用 chrome.downloads 下载，不需要知网页面
  if (paper.pdfSource) {
    try {
      const filename = createSafeFilename(paper.title || paper.doi || "paper");
      const res = await sendToBackground({ type: "SAVE_DOWNLOAD", url: paper.pdfLink, filename, useFolder: true });
      if (!taskCurrent(generation)) return "cancelled";
      if (res?.ok && res.downloadId != null) {
        activeDownloadWait = waitForDownloadById(res.downloadId);
        const result = await activeDownloadWait;
        activeDownloadWait = null;
        if (!taskCurrent(generation)) return "cancelled";
        if (result === "success") {
          setState(id, "success");
          consecutiveFails = 0;
          return "success";
        } else {
          setState(id, "error", result);
          addLog("error", `下载失败: ${paper.title}`, `原因: ${result}\nURL: ${paper.pdfLink}`);
          // DOI 下载失败属于正常情况（Sci-Hub 可能不可用），不计入连续失败次数
        }
      } else {
        throw new Error(res?.error || "下载失败");
      }
    } catch (err) {
      setState(id, "error", err.message);
      addLog("error", `下载失败: ${paper.title}`, `${err.message}\nURL: ${paper.pdfLink}`);
      // DOI 下载失败不计入连续失败次数
    }
    return "fail";
  }

  // Listen for sub-frame navigations on the download tab so we can capture the
  // iframe's final URL even when it lives on a different CNKI/WebVPN origin
  // (cross-origin reads inside the iframe are opaque to us).
  let frameFinalUrl = "";
  let navListener = null;
  let downloadResultPromise = null;
  let downloadToken = null;

  try {
    // Trigger iframe in a CNKI/WebVPN tab so cookies and Referer are correct.
    // Also recognizes the active library proxy page by its CNKI content.
    const tab = await getCnkiTab();
    if (!taskCurrent(generation)) return "cancelled";
    if (!tab?.id) throw new Error("请打开知网页面后再下载");

    const marked = await sendToBackground({ type: "MARK_DOWNLOAD", url: paper.pdfLink });
    if (!marked?.ok) throw new Error(marked?.error || "无法登记下载任务");
    downloadToken = marked.token;
    if (!taskCurrent(generation)) return "cancelled";

    navListener = (details) => {
      if (details.tabId !== tab.id || details.frameId === 0) return;
      frameFinalUrl = details.url;
    };
    chrome.webNavigation.onCommitted.addListener(navListener);

    // Pre-subscribe before iframe load to avoid race.
    // 启动最多等待 15 秒，完成最多等待 120 秒；超时不会当作完成。
    downloadResultPromise = waitForDownload(paper.pdfLink, 15000, 120000);
    activeDownloadWait = downloadResultPromise;

    // Trigger download via hidden iframe in page's MAIN world.
    // Inject promise resolves once the frame fires onload (so we can sniff
    // the final URL/body — non-PDF responses cause navigation), or after a
    // short timeout (real PDF downloads suppress onload entirely).
    const inject = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: (url) => new Promise((resolve) => {
        let frame = document.getElementById("__cnki_dl_frame__");
        if (!frame) {
          frame = document.createElement("iframe");
          frame.id = "__cnki_dl_frame__";
          frame.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
          document.body.appendChild(frame);
        }
        let done = false;
        const fin = (v) => { if (!done) { done = true; resolve(v); } };
        frame.onload = () => {
          // onload firing means the frame navigated to an HTML page — NOT a real
          // download. Try to read URL/body (may fail across cnki.net subdomains).
          let href = "", text = "";
          try { href = frame.contentWindow.location.href || ""; } catch {}
          try { text = frame.contentDocument?.body?.textContent || ""; } catch {}
          fin({ kind: "navigated", href, text: text.slice(0, 600) });
        };
        setTimeout(() => fin({ kind: "no_onload" }), 3000);
        frame.src = url;
      }),
      args: [paper.pdfLink],
    });
    if (!taskCurrent(generation)) return "cancelled";
    const result = inject?.[0]?.result || { kind: "no_onload" };

    if (result.kind === "navigated") {
      // iframe navigated to HTML → definitely not a real download.
      // Prefer webNavigation-captured URL (works across subdomains) over the
      // cross-origin opaque href we tried to read inside the inject script.
      const finalUrl = frameFinalUrl || result.href || "";
      let category = classifyDownloadPage(finalUrl, result.text || "");
      let probeText = "", probeUrl = "", probeErr = "";
      if (category === "unknown") {
        // Body content unknown — try background fetch as a fallback. May fail
        // (knsi often bounces foreign-Origin requests to ErrorMsg.html).
        try {
          const probe = await sendToBackground({ type: "FETCH_TEXT", url: paper.pdfLink });
          if (probe?.ok && probe.text) {
            probeText = probe.text;
            probeUrl = probe.finalUrl || "";
            category = classifyDownloadPage(probeUrl, probeText);
          } else {
            probeErr = probe?.error || `status=${probe?.status || "?"}`;
          }
        } catch (e) { probeErr = e.message || String(e); }
      }

      if (category === "verify") {
        lastBlockOpenUrl = finalUrl || paper.detailUrl;
        setState(id, "error", "触发知网验证码，已暂停");
        addLog("error", `触发验证码: ${paper.title}`, `URL: ${paper.pdfLink}\n验证页: ${finalUrl}\n请在浏览器中完成验证后点「继续下载」`);
        return "verify";
      }
      if (category === "quota") {
        lastBlockOpenUrl = paper.detailUrl;
        setState(id, "error", "下载额度已用完");
        addLog("error", `下载额度已用完: ${paper.title}`, `URL: ${paper.pdfLink}\n知网当日漫游下载量已达上限，可换账号或明日再试`);
        return "quota";
      }
      if (category === "auth") {
        setState(id, "error", "需要登录或权限不足");
        addLog("error", `权限不足: ${paper.title}`, `URL: ${paper.pdfLink}\n请检查登录状态或文献访问权限`);
        consecutiveFails++;
        return "fail";
      }
      // unknown — needs user intervention. Pause the queue and auto-open the
      // detail page (raw download URL bounces to ErrorMsg.html without a
      // valid Referer, so we send the user somewhere they can act on).
      lastBlockOpenUrl = paper.detailUrl;
      setState(id, "error", "下载页异常，已暂停");
      const detail = [
        `URL: ${paper.pdfLink}`,
        finalUrl ? `跳转到: ${finalUrl}` : "无法读取最终 URL",
        probeErr ? `探测失败: ${probeErr}` : probeUrl ? `探测最终 URL: ${probeUrl}` : "",
        `页面摘要: ${((probeText || result.text || "").replace(/\s+/g, " ").trim().slice(0, 300)) || "(空)"}`,
      ].filter(Boolean).join("\n");
      addLog("error", `下载受阻: ${paper.title}`, detail);
      return "blocked";
    }

    // kind === "no_onload" → frame didn't navigate, real download likely
    const downloadResult = await downloadResultPromise;
    if (!taskCurrent(generation)) return "cancelled";
    if (downloadResult === "success") {
      setState(id, "success");
      consecutiveFails = 0;
      return "success";
    }
    if (downloadResult === "timeout") {
      setState(id, "error", "下载超时未启动");
      addLog("error", `下载超时: ${paper.title}`, `URL: ${paper.pdfLink}\n15 秒内未触发下载，可能是网络较慢或需要登录验证，可重试`);
      consecutiveFails++;
      return "fail";
    }
    setState(id, "error", downloadResult);
    addLog("error", `下载失败: ${paper.title}`, `原因: ${downloadResult}\nURL: ${paper.pdfLink}`);
    consecutiveFails++;
    return "fail";
  } catch (err) {
    setState(id, "error", err.message || "网络错误");
    addLog("error", `下载失败: ${paper.title}`, `${err.message}\nURL: ${paper.pdfLink}`);
    consecutiveFails++;
    return "fail";
  } finally {
    downloadResultPromise?.cancel?.();
    activeDownloadWait = null;
    if (downloadToken) {
      try { await sendToBackground({ type: "UNMARK_DOWNLOAD", token: downloadToken }); }
      catch (err) { addLog("error", "下载标记清理失败", err.message); }
    }
    if (navListener) {
      try { chrome.webNavigation.onCommitted.removeListener(navListener); } catch {}
    }
  }
}

// ProQuest 单独刷新公开详情和媒体签名，不改写 URL，不进入知网 iframe 路径。
async function downloadProquestPaper(paper, generation) {
  const epoch = paperEpoch;
  const current = () => taskCurrent(generation, epoch) && papers.some(p => p.id === paper.id && p._instance === paper._instance);
  if (!current()) return "cancelled";
  setDownloadState(paper.id, "downloading");
  try {
    const resolved = await resolveProquestPaper(paper);
    if (!current()) return "cancelled";
    await patchPaper(paper, resolved.paper, epoch);
    if (!current()) return "cancelled";
    if (!resolved.pdfUrl && resolved.paper.proquestAccess !== "open") {
      setDownloadState(paper.id, "skipped", resolved.paper.proquestReason);
      return "skipped";
    }
    if (!resolved.pdfUrl) throw new Error(resolved.paper.proquestReason);
    const probe = await sendToBackground({ type: "FETCH_PDF_INFO", url: resolved.pdfUrl, timeoutMs: 15000 });
    if (!current()) return "cancelled";
    if (!probe?.ok || !probe.isPdf) throw new Error("ProQuest 未返回有效 PDF，请稍后重试");
    const result = await sendToBackground({ type: "SAVE_DOWNLOAD", url: resolved.pdfUrl,
      filename: createSafeFilename(resolved.paper.title || paper.title), useFolder: true });
    if (!current()) return "cancelled";
    if (!result?.ok || result.downloadId == null) throw new Error("ProQuest 下载未启动，请检查浏览器下载设置后重试");
    activeDownloadWait = waitForDownloadById(result.downloadId);
    const outcome = await activeDownloadWait;
    activeDownloadWait = null;
    if (!current()) return "cancelled";
    if (outcome !== "success") throw new Error(outcome);
    const [download] = await chrome.downloads.search({ id: result.downloadId });
    if (!current()) return "cancelled";
    if (!download || /(?:html|json|xml)/i.test(download.mime || "")) throw new Error("下载内容不是 PDF，请检查 Chrome 下载列表后重试");
    setDownloadState(paper.id, "success");
    consecutiveFails = 0;
    return "success";
  } catch (err) {
    if (!current()) return "cancelled";
    setDownloadState(paper.id, "error", err.message);
    // 不记录媒体签名、Cookie 或用户会话参数。
    addLog("error", `ProQuest 下载失败: ${paper.title}`, `${err.message}\n详情页: ${paper.detailUrl}`);
    consecutiveFails++;
    return "fail";
  } finally { activeDownloadWait = null; }
}

// 两种下载方式使用同一完成判定；监听器在任何结束分支都会清理。
function waitForDownloadById(downloadId, timeoutMs = 120000) {
  return DownloadTracking.wait({ id: downloadId, completeTimeout: timeoutMs });
}
function waitForDownload(expectedUrl, startTimeoutMs = 15000, completeTimeoutMs = 120000) {
  return DownloadTracking.wait({ url: expectedUrl, startTimeout: startTimeoutMs, completeTimeout: completeTimeoutMs });
}

async function runDownloadQueue(ids) {
  if (downloadQueueBusy || downloadBusy) {
    $("#footer-status").textContent = "已有下载任务进行中，请等待当前任务结束";
    return;
  }
  downloadQueueBusy = true;
  try { await processDownloadQueue([...new Set(ids)]); }
  finally { downloadQueueBusy = false; }
}

async function processDownloadQueue(ids) {
  const generation = taskGeneration;
  consecutiveFails = 0;
  pendingResumeIds = [];
  updateResumeButton();
  for (let i = 0; i < ids.length && taskCurrent(generation); i++) {
    const id = ids[i];
    if (consecutiveFails >= 2) {
      addLog("error", "已连续失败2次，已暂停批量下载", "请检查网络或手动尝试普通下载");
      $("#footer-status").textContent = "已连续失败2次，已暂停";
      pendingResumeIds = ids.slice(i);
      break;
    }
    if (downloadState[id]?.status === "success") continue;
    const paper = papers.find((p) => p.id === id);
    if (!canDownloadPaper(paper)) continue;
    const r = await downloadPaper(id);
    if (!taskCurrent(generation)) break;
    if (r === "verify" || r === "quota" || r === "blocked") {
      pendingResumeIds = ids.slice(i);
      if (r === "verify") {
        $("#footer-status").textContent = "⚠️ 触发知网验证码，已暂停。完成验证后点「继续下载」";
      } else if (r === "quota") {
        $("#footer-status").textContent = "⚠️ 当日下载额度已用完，已暂停（可换账号或次日再试）";
      } else {
        $("#footer-status").textContent = "⚠️ 下载受阻，已自动打开详情页，处理后点「继续下载」";
      }
      if (settings.autoOpenOnVerify && lastBlockOpenUrl) {
        try { await chrome.tabs.create({ url: lastBlockOpenUrl, active: true }); } catch {}
      }
      break;
    }
    // DOI 直链下载不需要间隔，知网下载保留间隔避免风控
    if (!paper.pdfSource) {
      await new Promise((r) => setTimeout(r, 1000 + Math.random() * 1000));
    }
  }
  updateResumeButton();
}

async function downloadSelected() {
  const selected = getSelectedIds();
  const ready = papers.filter((p) => selected.includes(p.id) && canDownloadPaper(p)).map((p) => p.id);
  const skipped = selected.length - ready.length;
  if (skipped) addLog("info", `跳过 ${skipped} 篇无下载链接的文献`, "这些文献仍可勾选导出");
  if (!ready.length) { $("#footer-status").textContent = "所选文献暂无下载链接，可先获取链接或直接导出"; return; }
  await runDownloadQueue(ready);
}

async function retryFailed() {
  const failed = papers.filter((p) => p.pdfFailed || downloadState[p.id]?.status === "error");
  const parseIds = failed.filter((p) => !canDownloadPaper(p) && !isDoiPaper(p)).map((p) => p.id);
  if (parseIds.length) await fetchPdfLinks(parseIds);
  const failedIds = papers.filter((p) => canDownloadPaper(p) && failed.some((f) => f.id === p.id)).map((p) => p.id);
  if (failedIds.length) await runDownloadQueue(failedIds);
  else if (failed.some((p) => isDoiPaper(p))) $("#footer-status").textContent = "请在 DOI 导入页再次提交失败 DOI 以重试";
}

async function resumeDownload() {
  if (downloadQueueBusy || downloadBusy || pendingResumeIds.length === 0) return;
  const ids = [...pendingResumeIds];
  pendingResumeIds = [];
  $("#footer-status").textContent = "继续下载中...";
  await runDownloadQueue(ids);
}

function updateResumeButton() {
  const btn = $("#btn-resume");
  if (!btn) return;
  btn.hidden = pendingResumeIds.length === 0;
  if (pendingResumeIds.length > 0) {
    btn.textContent = `继续下载 (${pendingResumeIds.length})`;
  }
}

function setDownloadState(id, status, error = "") {
  if (!papers.some((p) => p.id === id)) return;
  downloadState[id] = { status, error };
  updateCardState(id);
  updateFooter();
}

// ── Journal Levels ──
async function fetchLevel(url) {
  if (!url) return "无";
  if (levelCache.has(url)) return levelCache.get(url);
  if (levelPending.has(url)) return levelPending.get(url);
  const promise = (async () => {
    try {
      const res = await sendToBackground({ type: "FETCH_TEXT", url });
      if (!res?.text) return "无";
      const doc = new DOMParser().parseFromString(res.text, "text/html");
      const spans = Array.from(doc.querySelectorAll(".journalType.journalType2 > span"));
      return spans.map((s) => s.textContent.trim()).filter(Boolean).join("/") || "无";
    } catch { return "无"; }
  })();
  levelPending.set(url, promise);
  const result = await promise;
  levelCache.set(url, result);
  levelPending.delete(url);
  return result;
}

async function loadAllLevels() {
  if (!settings.fetchLevels || loadingLevels) return;
  loadingLevels = true;
  const generation = taskGeneration, epoch = paperEpoch;
  try {
    for (const paper of [...papers]) {
      if (!taskCurrent(generation, epoch) || !settings.fetchLevels) break;
      if (!paper.sourceUrl || paper.level !== "Wait") continue;
      const level = await fetchLevel(paper.sourceUrl);
      if (!taskCurrent(generation, epoch)) break;
      await patchPaper(paper, { level }, epoch);
    }
  } catch (err) { addLog("error", "保存期刊等级失败", err.message); }
  finally { loadingLevels = false; }
}

// ── Rendering ──
function getSortedPapers() {
  if (!sortField) return [...papers];
  return [...papers].sort((a, b) => {
    let va = a[sortField] || "", vb = b[sortField] || "";
    if (sortField !== "date") { va = parseInt(va) || 0; vb = parseInt(vb) || 0; }
    return va < vb ? (sortDir === "asc" ? -1 : 1) : va > vb ? (sortDir === "asc" ? 1 : -1) : 0;
  });
}

function renderList() {
  const list = $("#paper-list");
  const header = $("#list-header");
  list.innerHTML = "";

  if (papers.length === 0) {
    header.hidden = true;
    list.innerHTML = `
      <div class="empty">
        <svg class="empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
        </svg>
        <div class="empty-title">使用说明</div>
        <div class="empty-tip">温馨提示：建议每次下载不超过 20 篇，下载完成后间隔一段时间再继续，避免触发知网访问限制。</div>
        <div class="empty-steps">
          <div class="empty-step"><span class="step-num">1</span>在知网或 ProQuest 结果页点击「添加本页」，可翻页继续收藏</div>
          <div class="empty-step"><span class="step-num">2</span>点击「获取链接」解析 PDF 下载地址</div>
          <div class="empty-step"><span class="step-num">3</span>勾选文献后点击「下载」批量下载 PDF</div>
        </div>
        <div class="empty-new">
          <div class="empty-new-title">功能提示</div>
          <div class="empty-new-item"><span class="empty-new-tag">ProQuest</span>支持公开学位论文全文、跨页收藏和批量下载，预览及购买项跳过</div>
          <div class="empty-new-item"><span class="empty-new-tag">DOI</span>切到「DOI导入」标签页，粘贴 DOI 列表自动获取英文文献下载链接</div>
          <div class="empty-new-item"><span class="empty-new-tag">文件夹</span>指定下载子文件夹，所有文献自动归类保存</div>
          <div class="empty-new-item"><span class="empty-new-tag">稳定性</span>修复批量下载中途失败、支持学校 WebVPN 代理下载</div>
        </div>
      </div>`;
    updateFooter();
    return;
  }

  header.hidden = false;
  getSortedPapers().forEach((paper, idx) => list.appendChild(createPaperCard(paper, idx)));
  updateFooter();
  updateSortPills();
}

function createPaperCard(paper) {
  const card = document.createElement("div");
  card.className = "paper-card";
  card.dataset.id = paper.id;

  const state = downloadState[paper.id];
  if (state) card.dataset.status = state.status;
  const hasPdf = canDownloadPaper(paper);
  if (!hasPdf && !state) card.dataset.status = "pending";

  const levelHtml = renderLevel(paper.level);
  const kwHtml = paper.keywords ? String(paper.keywords).split(",").map((k) => `<span class="kw-tag">${escapeHtml(k)}</span>`).join("") : "";

  const abstractHtml = paper.abstract ? `<div class="paper-abstract" hidden>${escapeHtml(paper.abstract)}</div>` : "";
  const hasAbstract = !!paper.abstract;

  card.innerHTML = `
    <label class="check">
      <input type="checkbox" class="paper-check" data-id="${escapeHtml(paper.id)}" ${paper.selected === false ? "" : "checked"}>
      <span class="check-box"></span>
    </label>
    <div class="paper-body">
      <div class="paper-title-row">
        <div class="paper-title" title="${escapeHtml(paper.title)}">${escapeHtml(paper.title)}</div>
        <div class="paper-title-actions">
          ${hasAbstract ? `<button class="icon-btn abstract-toggle-btn" data-id="${escapeHtml(paper.id)}" title="查看摘要"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></button>` : ""}
          <button class="icon-btn copy-info-btn" data-id="${escapeHtml(paper.id)}" title="复制文献信息"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button>
        </div>
      </div>
      <div class="paper-meta">
        ${paper.author ? `<span class="author">${escapeHtml(splitAuthors(paper.author).join(";"))}</span><span class="dot">&middot;</span>` : ""}
        ${paper.source ? `<span>${escapeHtml(paper.source)}</span><span class="dot">&middot;</span>` : ""}
        <span>${escapeHtml(paper.date || "无日期")}</span>
      </div>
      ${paper.doi && paper.pdfSource
        ? `<div class="paper-doi">DOI: <a href="https://doi.org/${escapeHtml(encodeURI(paper.doi))}" target="_blank" rel="noopener noreferrer">${escapeHtml(paper.doi)}</a></div>`
        : safeHttpUrl(paper.detailUrl) ? `<div class="paper-doi"><a href="${escapeHtml(safeHttpUrl(paper.detailUrl))}" target="_blank" rel="noopener noreferrer">查看详情 →</a></div>` : ""}
      ${abstractHtml}
      <div class="paper-bottom">
        <div class="paper-stats">
          ${isProquestPaper(paper) ? `<span class="pdf-source-tag pdf-source-proquest">ProQuest · ${paper.proquestAccess === "open" ? "公开全文" : "未确认公开全文"}</span>` : paper.pdfSource ? `<span class="pdf-source-tag pdf-source-${paper.pdfSource === "Unpaywall" ? "unpaywall" : "sci-hub"}">${escapeHtml(paper.pdfSource)}</span>` : `<span>被引 <strong>${escapeHtml(paper.quote || 0)}</strong></span><span>下载 <strong>${escapeHtml(paper.download || 0)}</strong></span>`}
          ${levelHtml}
        </div>
        <div class="paper-action" data-id="${escapeHtml(paper.id)}">
          ${renderAction(paper.id, paper.pdfLink)}
        </div>
      </div>
      ${kwHtml ? `<div class="keyword-tags">${kwHtml}</div>` : ""}
    </div>
  `;
  return card;
}

function renderLevel(level) {
  if (!settings.fetchLevels || !level || level === "Wait" || level === "无") return "";
  return String(level).split("/").map((l) => `<span class="level-tag">${escapeHtml(l)}</span>`).join(" ");
}

function renderAction(id, pdfLink) {
  const state = downloadState[id];
  if (!state) {
    const paper = papers.find((p) => p.id === id);
    if (canDownloadPaper(paper)) return `<button class="dl-btn" data-id="${escapeHtml(id)}">PDF</button>`;
    if (isProquestPaper(paper) && paper.proquestReason) return `<span class="failed-tag" title="${escapeHtml(paper.proquestReason)}">${paper.pdfFailed ? "获取失败" : "本版跳过"}</span>${paper.pdfFailed ? `<button class="fetch-retry-btn" data-id="${escapeHtml(id)}">重试解析</button>` : ""}`;
    if (paper?.pdfFailed) return `<span class="failed-tag">未找到链接</span>${isDoiPaper(paper) ? "" : `<button class="fetch-retry-btn" data-id="${escapeHtml(id)}">重试解析</button>`}`;
    return `<span class="pending-tag">待获取链接</span>`;
  }
  if (state.status === "downloading") return `<span class="status status-downloading"><span class="spinner"></span>下载中</span>`;
  if (state.status === "success") return `<span class="status status-success">&#10003; 完成</span>`;
  if (state.status === "skipped") return `<span class="pending-tag" title="${escapeHtml(state.error)}">本版跳过</span>`;
  if (state.status === "error") return `<span class="status status-error" title="${escapeHtml(state.error)}">&#10007; 失败</span><button class="retry-btn" data-id="${escapeHtml(id)}">重试</button>`;
  return "";
}

function updateCardState(id) {
  const card = document.querySelector(`.paper-card[data-id="${id}"]`);
  if (!card) return;
  card.dataset.status = downloadState[id]?.status || "";
  const el = card.querySelector(".paper-action");
  if (el) el.innerHTML = renderAction(id, papers.find((p) => p.id === id)?.pdfLink);
}

function updateCardLevel(id, level) {
  const card = document.querySelector(`.paper-card[data-id="${id}"]`);
  if (!card) return;
  const stats = card.querySelector(".paper-stats");
  if (!stats) return;
  stats.querySelectorAll(".level-tag").forEach((el) => el.remove());
  const html = renderLevel(level);
  if (html) stats.insertAdjacentHTML("beforeend", html);
}

function updateSortPills() {
  $$(".sort-pill").forEach((p) => p.classList.toggle("active", p.dataset.sort === sortField));
}

function getSelectedIds() {
  return papers.filter((p) => p.selected !== false).map((p) => p.id);
}

function restoreChecks() {
  $$(".paper-check").forEach((cb) => { cb.checked = papers.find((p) => p.id === Number(cb.dataset.id))?.selected !== false; });
}

function updateFooter() {
  const total = papers.length;
  const ready = papers.filter(canDownloadPaper).length;
  const selected = getSelectedIds().length;
  const selectAll = $("#select-all");
  selectAll.checked = total > 0 && selected === total;
  selectAll.indeterminate = selected > 0 && selected < total;
  const done = Object.values(downloadState).filter((s) => s.status === "success").length;
  const failed = Object.values(downloadState).filter((s) => s.status === "error").length;
  const parts = [`${total} 篇`];
  if (ready < total) parts.push(`${ready} 可下载`);
  if (selected > 0) parts.push(`已选 ${selected}`);
  if (done > 0) parts.push(`完成 ${done}`);
  if (failed > 0) parts.push(`失败 ${failed}`);
  $("#footer-status").textContent = parts.join("  ·  ");
  $("#dl-count").textContent = selected > 0 ? `(${selected})` : "";
  $("#list-count").textContent = `${total} 篇`;
  const retryBtn = $("#btn-retry-failed");
  if (retryBtn) retryBtn.hidden = failed === 0 && !papers.some((p) => p.pdfFailed);
}

function setProgress(pct, text) {
  $("#progress").hidden = false;
  $("#progress-fill").style.width = pct + "%";
  if (text) $("#progress-text").textContent = text;
}

function hideProgress() {
  $("#progress").hidden = true;
  $("#progress-fill").style.width = "0";
}

// ── Cite Menu (Floating UI) ──

let citeMenuEl = null;

function ensureCiteMenu() {
  if (citeMenuEl) return citeMenuEl;
  const el = document.createElement("div");
  el.className = "cite-menu";
  el.hidden = true;
  el.innerHTML = `
    <button class="cite-menu-item" data-style="plain">复制原始信息</button>
    <button class="cite-menu-item" data-style="gb7714">复制 GB7714 引用</button>
    <button class="cite-menu-item" data-style="apa">复制 APA 引用</button>
    <button class="cite-menu-item" data-style="mla">复制 MLA 引用</button>
  `;
  document.body.appendChild(el);

  el.addEventListener("click", async (e) => {
    const item = e.target.closest(".cite-menu-item");
    if (!item) return;
    const style = item.dataset.style;
    const id = parseInt(el.dataset.paperId);
    const paper = papers.find((p) => p.id === id);
    if (!paper) { hideCiteMenu(); return; }
    hideCiteMenu();
    const btn = document.querySelector(`.copy-info-btn[data-id="${id}"]`);
    if (btn) btn.classList.add("loading");
    try {
      const text = await getCitation(paper, style);
      await navigator.clipboard.writeText(text);
      if (btn) {
        btn.classList.remove("loading");
        btn.classList.add("copied");
        setTimeout(() => btn.classList.remove("copied"), 1500);
      }
    } catch (err) {
      if (btn) btn.classList.remove("loading");
      addLog("error", "复制引用失败", err.message || String(err));
    }
  });

  // Close on outside click
  document.addEventListener("click", (e) => {
    if (!el.hidden && !e.target.closest(".cite-menu") && !e.target.closest(".copy-info-btn")) {
      hideCiteMenu();
    }
  });

  // Close on scroll within the paper list (so it doesn't drift)
  const list = document.getElementById("paper-list");
  if (list) list.addEventListener("scroll", hideCiteMenu, true);
  window.addEventListener("resize", hideCiteMenu);

  citeMenuEl = el;
  return el;
}

function showCiteMenu(btn, paperId) {
  const menu = ensureCiteMenu();
  menu.dataset.paperId = String(paperId);
  menu.hidden = false;
  const rect = btn.getBoundingClientRect();
  menu.style.top = (rect.bottom + 4) + "px";
  menu.style.right = (window.innerWidth - rect.right) + "px";
  menu.style.left = "auto";
}

function hideCiteMenu() {
  if (citeMenuEl) citeMenuEl.hidden = true;
}

// ── Export Menu (Floating UI) ──

let exportMenuEl = null;

function ensureExportMenu() {
  if (exportMenuEl) return exportMenuEl;
  const el = document.createElement("div");
  el.className = "cite-menu export-menu";
  el.hidden = true;
  el.innerHTML = `
    <div class="cite-menu-hint" id="export-menu-hint"></div>
    <button class="cite-menu-item" data-format="copy-gb7714">复制 GB7714 引用</button>
    <button class="cite-menu-item" data-format="copy-apa">复制 APA 引用</button>
    <button class="cite-menu-item" data-format="copy-mla">复制 MLA 引用</button>
    <div class="cite-menu-sep"></div>
    <button class="cite-menu-item" data-format="csv">导出为 CSV (Excel)</button>
    <button class="cite-menu-item" data-format="bibtex">导出为 BibTeX</button>
    <button class="cite-menu-item" data-format="ris">导出为 RIS (EndNote)</button>
  `;
  document.body.appendChild(el);

  el.addEventListener("click", async (e) => {
    const item = e.target.closest(".cite-menu-item");
    if (!item) return;
    const format = item.dataset.format;
    hideExportMenu();
    await doExport(format);
  });

  document.addEventListener("click", (e) => {
    if (!el.hidden && !e.target.closest(".export-menu") && !e.target.closest("#btn-export")) {
      hideExportMenu();
    }
  });

  window.addEventListener("resize", hideExportMenu);
  exportMenuEl = el;
  return el;
}

function showExportMenu(btn) {
  const menu = ensureExportMenu();
  // Update hint text based on current selection
  const selectedCount = getSelectedIds().length;
  const hint = menu.querySelector("#export-menu-hint");
  if (hint) {
    hint.textContent = selectedCount > 0
      ? `将导出已勾选的 ${selectedCount} 篇`
      : "请先勾选要导出的文献";
  }
  menu.hidden = false;
  const rect = btn.getBoundingClientRect();
  menu.style.top = (rect.bottom + 4) + "px";
  menu.style.right = (window.innerWidth - rect.right) + "px";
  menu.style.left = "auto";
}

function hideExportMenu() {
  if (exportMenuEl) exportMenuEl.hidden = true;
}

async function doExport(format) {
  // 导出只使用明确勾选的文献，包括没有 PDF 的条目。
  const selectedIds = getSelectedIds();
  const targets = papers.filter((p) => selectedIds.includes(p.id));
  if (targets.length === 0) {
    $("#footer-status").textContent = "请先勾选要导出的文献";
    return;
  }

  // Bulk copy citation text to clipboard
  if (format.startsWith("copy-")) {
    const style = format.slice(5);
    $("#footer-status").textContent = `正在获取 ${style.toUpperCase()} 引用...`;
    let map = new Map();
    try {
      map = await fetchOfficialCitations(targets, style);
    } catch (err) {
      addLog("error", "批量获取引用失败", err.message || String(err));
    }
    const lines = targets.map((p) => {
      if (map.get(p.id)) return map.get(p.id);
      if (citationCache[p.id]?.[style]) return citationCache[p.id][style];
      return formatCitation(p, style);
    }).filter(Boolean);
    if (lines.length === 0) {
      $("#footer-status").textContent = "没有可复制的引用";
      return;
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      $("#footer-status").textContent = `已复制 ${lines.length} 篇 ${style.toUpperCase()} 引用到剪切板`;
    } catch (err) {
      $("#footer-status").textContent = "复制失败: " + (err.message || err);
    }
    return;
  }

  const ts = new Date().toISOString().slice(0, 10);
  const baseName = `cnki-papers-${ts}-${targets.length}`;
  let filename = "", content = "", mime = "";
  if (format === "csv") {
    filename = baseName + ".csv";
    content = papersToCSV(targets);
    mime = "text/csv";
  } else if (format === "bibtex") {
    filename = baseName + ".bib";
    content = papersToBibTeX(targets);
    mime = "application/x-bibtex";
  } else if (format === "ris") {
    filename = baseName + ".ris";
    content = papersToRIS(targets);
    mime = "application/x-research-info-systems";
  } else {
    return;
  }
  try {
    await downloadAsFile(filename, content, mime);
    $("#footer-status").textContent = `已导出 ${targets.length} 篇为 ${format.toUpperCase()}`;
  } catch (err) {
    $("#footer-status").textContent = "导出失败: " + (err.message || err);
  }
}

// ── Events ──
// ── DOI Import ──
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
};

function parseDois(text) {
  const pattern = /10\.[0-9]{4,9}\/[-._;()/:a-zA-Z0-9]+/g;
  const matches = text.match(pattern) || [];
  return [...new Map(matches.map((doi) => [doi.toLowerCase(), doi])).values()]; // DOI 不区分大小写
}

async function fetchPdfByDoi(doi) {
  let meta = { title: "", source: "", date: "", author: "" };
  let pdfLink = "", pdfSource = "";

  // Step 1: Unpaywall — 获取元数据 + OA PDF
  try {
    const res = await sendToBackground({
      type: "FETCH_TEXT",
      url: `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=cnkihelper@heykee.com`,
      timeoutMs: 5000,
    });
    if (res?.ok && res.text) {
      const data = JSON.parse(res.text);
      meta.title = data.title || "";
      meta.source = data.journal_name || "";
      meta.date = data.year ? String(data.year) : "";
      meta.author = (data.z_authors || []).map((a) => [a.given, a.family].filter(Boolean).join(" ") || a.name || "").filter(Boolean).join("; ");
      const oaUrl = data?.best_oa_location?.url_for_pdf;
      if (safeHttpUrl(oaUrl)) { pdfLink = oaUrl; pdfSource = "Unpaywall"; }
    }
  } catch {}

  if (pdfLink) return { pdfLink, pdfSource, ...meta };

  // Step 2: bban.top 直链兜底
  try {
    const bbanUrl = `https://sci.bban.top/pdf/${encodeURI(doi).replace(/\?/g, "%3F").replace(/#/g, "%23")}.pdf?download=true`;
    const res = await sendToBackground({ type: "FETCH_PDF_INFO", url: bbanUrl, timeoutMs: 10000, headers: BROWSER_HEADERS });
    if (res?.ok && res.isPdf) {
      pdfLink = bbanUrl;
      pdfSource = "Sci-Hub";
    }
  } catch {}

  if (pdfLink) return { pdfLink, pdfSource, ...meta };
  if (meta.title) return { pdfLink: "", pdfSource: "", ...meta }; // 有元数据但无PDF
  return null;
}

let doiImportCancelled = false;
let doiFailedList = [];

async function importDois() {
  if (importingDois) return;
  importingDois = true;
  try { await performImportDois(); }
  catch (err) { addLog("error", "导入保存失败", err.message); $("#doi-count").textContent = `导入失败：${err.message}`; }
  finally {
    importingDois = false;
    $("#btn-doi-import").hidden = false;
    $("#btn-doi-stop").hidden = true;
    $("#doi-progress").hidden = true;
  }
}
async function performImportDois() {
  const generation = taskGeneration, epoch = paperEpoch;
  const text = $("#doi-input").value.trim();
  const dois = parseDois(text);
  if (dois.length === 0) { $("#doi-count").textContent = "未识别到有效 DOI"; return; }

  doiImportCancelled = false;
  doiFailedList = [];
  const btn = $("#btn-doi-import");
  const stopBtn = $("#btn-doi-stop");
  const copyFailedBtn = $("#btn-doi-copy-failed");
  btn.hidden = true;
  stopBtn.hidden = false;
  copyFailedBtn.hidden = true;

  let done = 0;
  const setDoiProgress = (pct, msg) => {
    $("#doi-progress").hidden = false;
    $("#doi-progress-fill").style.width = pct + "%";
    $("#doi-progress-text").textContent = msg;
  };


  const existingDois = new Map(papers.filter((p) => p.doi).map((p) => [p.doi.toLowerCase(), { ...p }]));
  let added = 0, updated = 0, notFound = 0;
  const duplicates = dois.filter((doi) => existingDois.get(doi.toLowerCase())?.pdfLink);
  const queue = dois.filter((doi) => !existingDois.get(doi.toLowerCase())?.pdfLink);
  const total = queue.length;
  let skipped = duplicates.length;
  setDoiProgress(0, `查询 0/${total}，跳过 ${skipped}`);

  if (queue.length === 0) {
    $("#doi-count").textContent = duplicates.length > 0
      ? `${duplicates.length} 个 DOI 已在列表中，无需重复导入`
      : "未识别到有效 DOI";
    btn.hidden = false;
    stopBtn.hidden = true;
    copyFailedBtn.hidden = true;
    $("#doi-progress").hidden = true;
    return;
  }

  const CONCURRENCY = 2;

  async function processOne(doi) {
    const result = await fetchPdfByDoi(doi);
    if (doiImportCancelled || !taskCurrent(generation, epoch)) return;
    const existing = existingDois.get(doi.toLowerCase());
    const paper = {
      id: Math.abs(`doi:${doi}`.split("").reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0)),
      doi, doiImport: true,
      title: result?.title || doi,
      detailUrl: `https://doi.org/${doi}`,
      pdfLink: result?.pdfLink || "",
      pdfFailed: !result?.pdfLink,
      pdfSource: result?.pdfSource || "",
      source: result?.source || "",
      date: result?.date || "",
      author: result?.author || "",
      keywords: "", quote: "0", download: "0", sourceUrl: "", level: "Wait",
    };
    if (!result?.pdfLink) {
      if (!result) addLog("error", `未找到任何信息: ${doi}`, `DOI: ${doi}`);
      else addLog("error", `未找到下载链接: ${result.title || doi}`, `DOI: ${doi}`);
      doiFailedList.push(doi);
      notFound++;
    }
    let saved;
    if (existing) {
      const changes = { doiImport: true, pdfLink: paper.pdfLink, pdfFailed: paper.pdfFailed, pdfSource: paper.pdfSource };
      // 查询失败不能清空已有作者、标题或其他已收集的元数据。
      for (const key of ["title", "author", "source", "date"]) if (result?.[key]) changes[key] = result[key];
      saved = await patchPaper(existing, changes, epoch);
      updated += saved?.updated || 0;
    } else {
      saved = await mutatePapers("add", { items: [paper] }, epoch);
      added += saved?.added || 0;
      if (saved && !saved.added) skipped++;
    }
    if (!saved || !taskCurrent(generation, epoch)) return;
    done++;
    setDoiProgress(Math.round((done / total) * 100), `查询 ${done}/${total}，跳过 ${skipped}`);
    renderList();
    restoreChecks();
    updateFooter();
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0 && !doiImportCancelled && taskCurrent(generation, epoch)) {
      await processOne(queue.shift());
    }
  });
  const outcomes = await Promise.allSettled(workers);
  const rejected = outcomes.find((r) => r.status === "rejected");
  if (rejected) throw rejected.reason;

  if (!taskCurrent(generation, epoch)) return;
  $("#doi-progress").hidden = true;
  $("#doi-count").textContent = doiImportCancelled
    ? `已停止，新增 ${added} 篇，更新 ${updated} 篇`
    : `新增 ${added} 篇，更新 ${updated} 篇，跳过 ${skipped} 篇，${notFound} 篇未找到链接`;
  btn.hidden = false;
  stopBtn.hidden = true;
  copyFailedBtn.hidden = doiFailedList.length === 0;
}

// ── Nav Tab Switch ──
function switchTab(feature) {
  $$(".nav-item").forEach((btn) => btn.classList.toggle("active", btn.dataset.feature === feature));
  $$(".feature").forEach((el) => { el.hidden = el.id !== `feature-${feature}`; });
}

function bindEvents() {
  $("#btn-add-proxy").addEventListener("click", addProxyDomain);
  // Download folder
  $("#input-folder").addEventListener("input", async (e) => {
    settings.downloadFolder = e.target.value.trim();
    await chrome.storage.local.set({ downloadFolder: settings.downloadFolder });
    const tip = $("#folder-tip");
    if (settings.downloadFolder) {
      tip.textContent = "需关闭Chrome「下载前询问保存位置」";
    } else {
      tip.textContent = "";
    }
  });

  // Nav tab switch
  $$(".nav-item[data-feature]").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.feature));
  });

  // DOI import
  $("#doi-input").addEventListener("input", () => {
    const dois = parseDois($("#doi-input").value);
    $("#doi-count").textContent = dois.length > 0 ? `识别到 ${dois.length} 个 DOI` : "";
  });
  $("#btn-doi-import").addEventListener("click", importDois);
  $("#btn-doi-stop").addEventListener("click", () => { doiImportCancelled = true; });
  $("#btn-doi-copy-failed").addEventListener("click", () => {
    navigator.clipboard.writeText(doiFailedList.join("\n")).then(() => {
      const btn = $("#btn-doi-copy-failed");
      const orig = btn.textContent;
      btn.textContent = "已复制！";
      setTimeout(() => { btn.textContent = orig; }, 1500);
    });
  });

  // Add all papers from current page
  $("#btn-add-page").addEventListener("click", async () => {
    const ok = await ensureContentScript();
    if (!ok) { $("#footer-status").textContent = "请先进入知网或 ProQuest 页面，点击浏览器工具栏的文献助手图标后重试"; return; }
    try {
      const result = await sendToContent({ type: "ADD_ALL_PAGE", useWebVPN: settings.useWebVPN });
      if (!result?.ok) {
        $("#footer-status").textContent = result?.error === "no_links" ? "当前页未找到文献" : `添加失败：${result?.error || "未知原因"}`;
        return;
      }
      // Reset sort to default (insertion order) after adding
      if (result.added > 0 && sortField !== "") {
        sortField = "";
        sortDir = "desc";
        saveSort();
      }
      // Storage change will trigger renderList via onChanged listener
      $("#footer-status").textContent = result.provider === "proquest"
        ? `新增 ${result.added} 篇公开论文，本页跳过 ${result.skipped} 条；可翻页继续添加`
        : result.added > 0
        ? `已添加 ${result.added} 篇 (本页共 ${result.total} 篇)`
        : `本页 ${result.total} 篇均已在列表中`;
    } catch (err) {
      $("#footer-status").textContent = "添加失败: " + err.message;
    }
  });

  // Fetch PDF links for pending papers
  $("#btn-fetch-links").addEventListener("click", fetchPdfLinks);

  // Batch download
  $("#btn-batch-dl").addEventListener("click", () => downloadSelected());

  // Retry failed
  $("#btn-retry-failed").addEventListener("click", () => retryFailed());
  $("#btn-resume").addEventListener("click", () => resumeDownload());

  // Clear
  $("#btn-clear").addEventListener("click", async () => {
    cancelTasks();
    Object.keys(downloadState).forEach((k) => delete downloadState[k]);
    pendingResumeIds = [];
    consecutiveFails = 0;
    Object.keys(citationCache).forEach((k) => delete citationCache[k]);
    try {
      await mutatePapers("clear");
    } catch (err) { $("#footer-status").textContent = `清空失败：${err.message}`; return; }
    renderList();
    updateResumeButton();
    updateFooter();
  });

  // Export menu (toggle)
  $("#btn-export").addEventListener("click", (e) => {
    e.stopPropagation();
    if (exportMenuEl && !exportMenuEl.hidden) {
      hideExportMenu();
    } else {
      showExportMenu(e.currentTarget);
    }
  });

  // Select all
  $("#select-all").addEventListener("change", async (e) => {
    const selected = e.target.checked;
    const items = papers.map((p) => ({ id: p.id, instance: p._instance, changes: { selected } }));
    try { await mutatePapers("patch", { items }); }
    catch (err) { addLog("error", "保存选择失败", err.message); restoreChecks(); }
  });

  // Sort
  $$(".sort-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      const field = pill.dataset.sort;
      if (sortField === field) { sortDir = sortDir === "desc" ? "asc" : "desc"; }
      else { sortField = field; sortDir = field === "date" ? "asc" : "desc"; }
      saveSort();
      renderList();
      restoreChecks();
      updateFooter();
    });
  });

  // Paper list clicks
  $("#paper-list").addEventListener("click", (e) => {
    const parse = e.target.closest(".fetch-retry-btn");
    if (parse) { fetchPdfLinks([Number(parse.dataset.id)]); return; }
    const dl = e.target.closest(".dl-btn");
    if (dl) { runDownloadQueue([parseInt(dl.dataset.id)]); return; }
    const retry = e.target.closest(".retry-btn");
    if (retry) { runDownloadQueue([parseInt(retry.dataset.id)]); return; }

    // Abstract toggle
    const absBtn = e.target.closest(".abstract-toggle-btn");
    if (absBtn) {
      const card = absBtn.closest(".paper-card");
      const absEl = card?.querySelector(".paper-abstract");
      if (absEl) {
        absEl.hidden = !absEl.hidden;
        absBtn.classList.toggle("active", !absEl.hidden);
      }
      return;
    }

    // Copy / cite menu (toggle floating menu)
    const copyBtn = e.target.closest(".copy-info-btn");
    if (copyBtn) {
      e.stopPropagation();
      const id = parseInt(copyBtn.dataset.id);
      if (citeMenuEl && !citeMenuEl.hidden && parseInt(citeMenuEl.dataset.paperId) === id) {
        hideCiteMenu();
      } else {
        showCiteMenu(copyBtn, id);
      }
      return;
    }
  });

  // Checkbox changes
  $("#paper-list").addEventListener("change", async (e) => {
    if (!e.target.classList.contains("paper-check")) return;
    const paper = papers.find((p) => p.id === Number(e.target.dataset.id));
    if (!paper) return;
    try { await patchPaper(paper, { selected: e.target.checked }); }
    catch (err) { addLog("error", "保存选择失败", err.message); restoreChecks(); }
  });

  // Toggles
  $("#toggle-webvpn").addEventListener("change", async (e) => {
    settings.useWebVPN = e.target.checked;
    await chrome.storage.local.set({ useWebVPN: settings.useWebVPN });
  });
  $("#toggle-levels").addEventListener("change", async (e) => {
    settings.fetchLevels = e.target.checked;
    await chrome.storage.local.set({ fetchLevels: settings.fetchLevels });
    renderList();
    restoreChecks();
    updateFooter();
    if (settings.fetchLevels) loadAllLevels();
  });
  $("#toggle-auto-open-verify").addEventListener("change", async (e) => {
    settings.autoOpenOnVerify = e.target.checked;
    await chrome.storage.local.set({ autoOpenOnVerify: settings.autoOpenOnVerify });
  });

  // Log panel
  $("#log-toggle").addEventListener("click", () => { $("#log-panel").hidden = !$("#log-panel").hidden; });
  $("#log-clear").addEventListener("click", () => { logs.length = 0; $("#log-list").innerHTML = ""; updateLogBadge(); $("#log-panel").hidden = true; });
  $("#log-copy-all").addEventListener("click", () => {
    const text = logs.filter((l) => l.level === "error").map((l) => `[${l.time}] ${l.title}\n  ${l.detail}`).join("\n\n");
    navigator.clipboard.writeText(text);
  });

  // Real-time storage sync (papers added from content script)
  chrome.storage.onChanged.addListener((changes) => {
    if (changes[ProxyDomains.storageKey]) {
      renderProxyDomains().catch((err) => { $("#proxy-status").textContent = `读取域名失败：${err.message}`; });
    }
    if (!changes.cnkiPapers && !changes.cnkiPapersEpoch) return;
    if (!acceptPaperSnapshot({
      papers: changes.cnkiPapers?.newValue || papers,
      epoch: changes.cnkiPapersEpoch?.newValue ?? paperEpoch,
      revision: changes.cnkiPapersRevision?.newValue ?? paperRevision,
    })) return;
    renderList();
    restoreChecks();
    updateFooter();
  });
}

// Show a dashed placeholder if the tip QR image hasn't been added yet.
function setupTipQrFallback() {
  const img = document.querySelector(".tip-qr-img");
  const ph = document.querySelector(".tip-qr-placeholder");
  if (!img || !ph) return;
  const showPh = () => { img.hidden = true; ph.hidden = false; };
  img.addEventListener("error", showPh);
  if (img.complete && img.naturalWidth === 0) showPh();
}

// ── Update Notes ──
const CURRENT_VERSION = chrome.runtime.getManifest().version;
const UPDATE_NOTE = `v${CURRENT_VERSION} 更新：新增 ProQuest 公开学位论文，支持跨页收藏、勾选和批量下载`;

async function checkUpdate() {
  const data = await chrome.storage.local.get(["lastSeenVersion"]);
  if (data.lastSeenVersion === CURRENT_VERSION) return;
  $("#update-text").textContent = UPDATE_NOTE;
  $("#update-banner").hidden = false;
  $("#update-close").addEventListener("click", async () => {
    $("#update-banner").hidden = true;
    await chrome.storage.local.set({ lastSeenVersion: CURRENT_VERSION });
  });
}

// ── Init ──
async function init() {
  await loadSettings();
  $(".footer-ver").textContent = `v${CURRENT_VERSION}`;
  $("#toggle-webvpn").checked = settings.useWebVPN;
  $("#toggle-levels").checked = settings.fetchLevels;
  $("#toggle-auto-open-verify").checked = settings.autoOpenOnVerify;
  $("#input-folder").value = settings.downloadFolder;
  if (settings.downloadFolder) $("#folder-tip").textContent = "需关闭Chrome「下载前询问保存位置」";
  bindEvents();
  setupTipQrFallback();
  renderList();
  checkUpdate();
  renderProxyDomains().catch((err) => { $("#proxy-status").textContent = `读取域名失败：${err.message}`; });
  // 工具栏点击授予 activeTab 后，为未自动匹配的图书馆代理页加载按钮。
  await ensureContentScript();
  if (papers.length > 0) {
    setTimeout(() => { restoreChecks(); updateFooter(); if (settings.fetchLevels) loadAllLevels(); }, 50);
  }
}

init();
