/* Service Worker - handles networking, downloads, and side panel setup */
importScripts("proxy-domains.js", "download-tracking.js", "paper-store.js", "proquest.js");

// 动态脚本跨重启保留；启动和外部撤销权限时核对注册状态。
function syncProxyDomains() {
  ProxyDomains.update("sync").catch((err) => console.error("代理域名同步失败:", err));
}
syncProxyDomains();
chrome.permissions.onRemoved.addListener(syncProxyDomains);

// Open side panel on extension icon click
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

async function handleFetchText({ url, referrer, timeoutMs, headers, anonymous = false }) {
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, {
      method: "GET",
      credentials: anonymous ? "omit" : "include",
      cache: anonymous ? "no-store" : "default",
      redirect: "follow",
      referrer: referrer || undefined,
      signal: controller.signal,
      headers: headers || {},
    });
    return { ok: res.ok, status: res.status, text: await res.text(), finalUrl: res.url };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 只读取文件头，避免把 JSON 错误页或普通文本当成 PDF，也不预下载整份文件。
async function handleFetchPdfInfo({ url, timeoutMs = 10000, headers }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader;
  try {
    const res = await fetch(url, { credentials: "include", redirect: "follow", signal: controller.signal, headers: { ...headers, Range: "bytes=0-1023" } });
    const contentType = res.headers.get("content-type") || "";
    if (!res.ok || !res.body) return { ok: res.ok, status: res.status, isPdf: false, contentType };
    reader = res.body.getReader();
    const prefix = new Uint8Array(1024);
    let length = 0;
    while (length < prefix.length) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value.subarray(0, prefix.length - length);
      prefix.set(bytes, length);
      length += bytes.length;
      if (length >= 16) break;
    }
    const header = new TextDecoder().decode(prefix.subarray(0, length));
    const isPdf = /^\s*%PDF-\d\.\d/.test(header) && !/(?:html|json|xml)/i.test(contentType);
    return { ok: true, status: res.status, isPdf, contentType, finalUrl: res.url };
  } finally {
    if (reader) await reader.cancel().catch((err) => console.debug("PDF 文件头读取已结束", err.message));
    clearTimeout(timer);
  }
}

async function handleFetchPost({ url, body, referrer, headers }) {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      ...(headers || {}),
    },
    body: body || "",
    redirect: "follow",
    referrer: referrer || undefined,
  });
  return { ok: res.ok, status: res.status, text: await res.text(), finalUrl: res.url };
}

async function handleSaveDownload({ url, filename, useFolder, saveAs = false }) {
  await folderReady;
  const folder = useFolder ? DownloadTracking.folderName(cachedDownloadFolder) : "";
  if (folder) filename = `${folder}/${filename}`;
  // Chrome 注册文件名监听后，API 的 filename 仍可能被服务器名称覆盖。
  // 先登记，再用下载 ID 关联文件名事件；同 URL 的并发任务也不能串名。
  let resolveId;
  const task = { url, filename, ready: new Promise(resolve => { resolveId = resolve; }) };
  apiDownloadTasks.add(task);
  try {
    const downloadId = await chrome.downloads.download({ url, filename, saveAs });
    task.id = downloadId;
    await chrome.storage.session.set({ [downloadNameKey(downloadId)]: filename });
    resolveId(downloadId);
    return { ok: true, downloadId };
  } catch (err) {
    resolveId(null);
    apiDownloadTasks.delete(task);
    throw err;
  }
}

// 缓存文件夹设置
let cachedDownloadFolder = "";
const folderReady = chrome.storage.local.get(["downloadFolder"]).then((data) => {
  cachedDownloadFolder = (data.downloadFolder || "").trim();
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.downloadFolder !== undefined) {
    cachedDownloadFolder = (changes.downloadFolder.newValue || "").trim();
  }
});

// 标记限于一个原始 URL，失败、验证码和等待结束后主动清理；遗留标记 15 秒过期。
const pendingDownloads = new Map();
const apiDownloadTasks = new Set();
const downloadNameKey = (id) => `cnkiDownloadName:${id}`;
chrome.downloads.onChanged.addListener((delta) => {
  if (!["complete", "interrupted"].includes(delta.state?.current)) return;
  chrome.storage.session.remove(downloadNameKey(delta.id)).catch(err => console.error("清理下载文件名失败:", err));
  for (const task of apiDownloadTasks) {
    task.ready.then(async id => {
      if (id !== delta.id) return;
      apiDownloadTasks.delete(task);
      await chrome.storage.session.remove(downloadNameKey(id));
    }).catch(err => console.error("清理下载文件名失败:", err));
  }
});
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const ownTasks = item.byExtensionId === chrome.runtime.id
    ? [...apiDownloadTasks].filter(task => task.url === item.url) : [];
  if (item.byExtensionId === chrome.runtime.id) {
    Promise.all(ownTasks.map(task => task.ready)).then(async ids => {
      const task = ownTasks[ids.indexOf(item.id)];
      const key = downloadNameKey(item.id);
      // 请求较慢、后台休眠重启后，仍按 ID 恢复已登记的文件名。
      const filename = task?.filename || (await chrome.storage.session.get(key))[key];
      if (filename) {
        apiDownloadTasks.delete(task);
        await chrome.storage.session.remove(key);
        suggest({ filename, conflictAction: "uniquify" });
      } else suggest();
    }).catch(err => {
      console.error("读取下载文件名失败:", err);
      suggest();
    });
    return true;
  }
  for (const [token, task] of pendingDownloads) {
    if (task.expires <= Date.now()) { pendingDownloads.delete(token); continue; }
    if (!DownloadTracking.matches(item, task.url)) continue;
    pendingDownloads.delete(token);
    const basename = item.filename.split(/[\\/]/).pop();
    if (task.folder && basename) suggest({ filename: `${task.folder}/${basename}`, conflictAction: "uniquify" });
    else suggest();
    return;
  }
  suggest();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.type) return;

  const handle = async () => {
    try {
      if (msg.type === "PAPER_STORE") return await PaperStore.update(msg);
      if (msg.type === "FETCH_PROQUEST_DOCUMENT") {
        const url = ProQuest.documentUrl(msg.url);
        if (!url) throw new Error("无效的 ProQuest 文档地址");
        // 本版只支持公开全文，详情请求不使用机构账号 Cookie。
        return await handleFetchText({ url, timeoutMs: 20000, anonymous: true });
      }
      if (msg.type === "FETCH_TEXT") return await handleFetchText(msg);
      if (msg.type === "FETCH_PDF_INFO") return await handleFetchPdfInfo(msg);
      if (msg.type === "FETCH_POST") return await handleFetchPost(msg);
      if (msg.type === "SAVE_DOWNLOAD") return await handleSaveDownload(msg);
      if (msg.type === "MARK_DOWNLOAD") {
        if (!DownloadTracking.matches({ url: msg.url }, msg.url)) throw new Error("无效下载地址");
        await folderReady;
        const token = crypto.randomUUID();
        pendingDownloads.set(token, { url: msg.url, folder: DownloadTracking.folderName(cachedDownloadFolder), expires: Date.now() + 15000 });
        return { ok: true, token };
      }
      if (msg.type === "UNMARK_DOWNLOAD") { pendingDownloads.delete(msg.token); return { ok: true }; }
      if (msg.type === "UPDATE_PROXY_DOMAIN") {
        // 网站内容脚本无权修改域名设置。
        if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("sidepanel/index.html")) {
          throw new Error("请从文献助手设置中修改代理域名");
        }
        const domains = await ProxyDomains.update(msg.action, msg.domain);
        return { ok: true, domains };
      }
      return { ok: false, error: "unknown_type" };
    } catch (err) {
      return { ok: false, error: err?.message || "unknown_error" };
    }
  };

  handle().then(sendResponse);
  return true;
});
