/* 用户自定义代理域名；侧边栏和 Service Worker 共用。 */
const ProxyDomains = (() => {
  const storageKey = "cnkiProxyDomains";
  const scriptId = "cnki-custom-proxies";

  function normalize(input) {
    const value = String(input || "").trim().replace(/^((?:https?:\/\/)?)\*\./i, "$1");
    if (!value || /[\s*]/.test(value)) throw new Error("请输入域名或网址；通配符仅支持 *.域名");
    let url;
    try {
      url = new URL(value.includes("://") ? value : `https://${value}`);
    } catch {
      throw new Error("域名或网址格式不正确");
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
      throw new Error("请填写 HTTP / HTTPS 网址，不要包含账号密码");
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host)) {
      throw new Error("请输入完整域名，例如 ycfw.library.hb.cn");
    }
    if (/(^|\.)(cnki\.net|edu\.cn)$/.test(host) || ["api.unpaywall.org", "sci.bban.top"].includes(host)) {
      throw new Error("该域名已内置支持，无需添加");
    }
    return host;
  }

  // 同时覆盖根域名和它的子域名；Chrome 的站点权限不区分端口。
  const pattern = (host) => `*://*.${host}/*`;
  const matchesHost = (hostname, domain) => hostname === domain || hostname.endsWith(`.${domain}`);

  async function list() {
    const data = await chrome.storage.local.get([storageKey]);
    return Array.isArray(data[storageKey]) ? data[storageKey] : [];
  }

  async function apply(domains) {
    const allowed = [];
    for (const domain of new Set(domains)) {
      const host = normalize(domain);
      if (await chrome.permissions.contains({ origins: [pattern(host)] })) allowed.push(host);
      else await chrome.permissions.remove({ origins: [pattern(host)] });
    }
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [scriptId] });
    if (allowed.length) {
      const script = {
        id: scriptId,
        matches: allowed.map(pattern),
        js: ["content/main.js"],
        runAt: "document_idle",
        persistAcrossSessions: true,
      };
      if (registered.length) await chrome.scripting.updateContentScripts([script]);
      else await chrome.scripting.registerContentScripts([script]);
    } else if (registered.length) {
      await chrome.scripting.unregisterContentScripts({ ids: [scriptId] });
    }
    await chrome.storage.local.set({ [storageKey]: allowed });
    return allowed;
  }

  // 注册、移除和浏览器撤销权限事件串行处理，避免覆盖另一个窗口的设置。
  let pending = Promise.resolve();
  function update(action, input) {
    const operation = pending.then(async () => {
      const domains = await list();
      if (action === "add") {
        const host = normalize(input);
        if (!await chrome.permissions.contains({ origins: [pattern(host)] })) {
          throw new Error("尚未获得该域名的访问权限，请重新添加并允许授权");
        }
        return apply([...domains, host]);
      }
      if (action === "remove") {
        const host = normalize(input);
        const removed = await chrome.permissions.remove({ origins: [pattern(host)] });
        if (!removed) throw new Error("未能移除网站权限，请在扩展管理页检查");
        return apply(domains.filter((domain) => domain !== host));
      }
      if (action === "sync") return apply(domains);
      throw new Error("未知域名操作");
    });
    // 当前调用仍向调用者报告错误，仅恢复后续操作的队列。
    pending = operation.catch(() => {});
    return operation;
  }

  return { storageKey, normalize, pattern, matchesHost, list, update };
})();
