/* 按原始 URL / downloadId 跟踪下载，不接管其他浏览器下载。 */
const DownloadTracking = (() => {
  function normalizedUrl(value) {
    try {
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol)) return "";
      url.hash = "";
      return url.href;
    } catch { return ""; }
  }
  function matches(item, expectedUrl) {
    const expected = normalizedUrl(expectedUrl);
    // DownloadItem.url 是重定向前地址；不按域名或最终落地页模糊匹配。
    return !!expected && normalizedUrl(item.url) === expected;
  }
  function folderName(value) {
    return String(value || "").trim().replace(/[\/:*?"<>|\\]/g, "_").replace(/^\.+$|[. ]+$/g, "");
  }
  function wait({ url, id = null, startTimeout = 15000, completeTimeout = 120000 }) {
    let finish;
    const promise = new Promise((resolve) => {
      let matchedId = id;
      let settled = false;
      let timer;
      finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        chrome.downloads.onCreated.removeListener(onCreate);
        chrome.downloads.onChanged.removeListener(onChange);
        resolve(result);
      };
      const inspect = (item) => {
        if (item?.state === "complete") finish("success");
        else if (item?.state === "interrupted") finish(item.error || "下载中断");
      };
      const checkCurrent = () => {
        chrome.downloads.search({ id: matchedId }, (items) => {
          if (chrome.runtime.lastError) { finish(chrome.runtime.lastError.message); return; }
          if (!settled) inspect(items?.[0]);
        });
      };
      const onCreate = (item) => {
        if (matchedId !== null || !matches(item, url)) return;
        matchedId = item.id;
        clearTimeout(timer);
        timer = setTimeout(() => finish("下载尚未完成，请先检查浏览器下载列表"), completeTimeout);
        inspect(item);
        if (!settled) checkCurrent();
      };
      const onChange = (delta) => {
        if (delta.id !== matchedId) return;
        if (delta.state?.current === "complete") finish("success");
        else if (delta.state?.current === "interrupted") finish(delta.error?.current || "下载中断");
      };
      chrome.downloads.onCreated.addListener(onCreate);
      chrome.downloads.onChanged.addListener(onChange);
      timer = setTimeout(() => finish(id === null ? "timeout" : "下载尚未完成，请先检查浏览器下载列表"), id === null ? startTimeout : completeTimeout);
      if (id !== null) checkCurrent();
    });
    promise.cancel = () => finish("cancelled");
    return promise;
  }
  return { matches, folderName, wait };
})();
