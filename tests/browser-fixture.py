"""独立浏览器回归的本地 HTTP/HTTPS 响应；不访问真实知网或 DOI 服务。"""
import argparse
import json
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit


STATE = {"fail": False, "delay": 0, "validPdf": False, "pqMode": "open", "pqToken": 0, "pqDelay": 0}
REQUESTS = []
# 小型可打开 PDF，便于同时核对文件头和 Chrome 下载完成状态。
stream = b"BT /F1 12 Tf 50 100 Td (Local regression fixture) Tj ET"
objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
]
PDF = b"%PDF-1.4\n"
offsets = [0]
for index, obj in enumerate(objects, 1):
    offsets.append(len(PDF))
    PDF += f"{index} 0 obj\n".encode() + obj + b"\nendobj\n"
xref = len(PDF)
PDF += b"xref\n0 6\n0000000000 65535 f \n"
PDF += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets[1:])
PDF += f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()


class Handler(BaseHTTPRequestHandler):
    def reply(self, body, kind="text/html; charset=utf-8", status=200, headers=None):
        body = body.encode() if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass  # PDF 文件头校验会主动关闭响应流。

    def do_GET(self):
        parsed = urlsplit(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        host = self.headers.get("Host", "")
        REQUESTS.append({"host": host, "path": self.path, "referer": self.headers.get("Referer", "")})
        if path == "/control":
            for key, values in query.items():
                if key in STATE:
                    STATE[key] = json.loads(values[0])
            return self.reply(json.dumps(STATE), "application/json")
        if path == "/requests":
            return self.reply(json.dumps(REQUESTS), "application/json")
        if path.startswith("/counts/") and path.endswith("/search"):
            prefix = path.removesuffix("/search")
            rows = ''.join(f'<tr><td class="name"><a class="fz14" href="{prefix}/{i}/kcms/detail">Count fixture {prefix}-{i}</a></td></tr>' for i in range(20))
            return self.reply(f'<table class="result-table-list">{rows}</table>')
        if path == "/resultsol/member/1":
            rows = []
            for doc_id in ["920001", "920002", "920003"]:
                publication = '<span class="jnlArticle"><strong>Member Journal</strong> Vol. 2, Iss. 1, (2025): 1-5.</span>' if doc_id == "920002" else '<span class="dissertpub">Member University ProQuest Dissertations &amp; Theses, 2025.</span>'
                label = "提供预览" if doc_id == "920003" else "全文文献"
                rows.append(f'<li class="resultItem"><div class="resultHeader"><h3><a href="/docview/{doc_id}/SESSION/1">Member document {doc_id}</a></h3>{publication}'
                            f'<div class="format-display">{label}</div><a href="/purchase">订购</a></div></li>')
            return self.reply(f'<ul>{"".join(rows)}</ul>')
        if path.startswith("/docview/920"):
            doc_id = path.split("/")[2]
            member = "pq_fixture_member=1" in self.headers.get("Cookie", "")
            preview = not member or doc_id == "920003"
            label = "下载预览" if preview else "下载 PDF"
            access = "提供预览" if preview else "全文文献"
            publication = '<span class="jnlArticle"><strong>Member Journal</strong> Vol. 2, Iss. 1, (2025): 1-5.</span>' if doc_id == "920002" else '<span class="dissertpub">Member University ProQuest Dissertations &amp; Theses, 2025.</span>'
            STATE["pqToken"] += 1
            return self.reply(f'<ul class="format-wrapper"><li>{access}</li></ul><h1 class="documentTitle">Member document {doc_id}</h1>{publication}'
                              f'<a class="pdf-download" title="{label}" href="https://media.proquest.com:18543/media/{doc_id}?_s=member{STATE["pqToken"]}">{label}</a><a href="/purchase">订购</a>')
        if path.startswith("/resultsol/journals/"):
            page = path.rsplit("/", 1)[-1]
            ids = ["910001", "910003", "910004", "910006"] if page == "1" else ["910002", "910001"]
            rows = []
            for doc_id in ids:
                label = "提供预览" if doc_id == "910003" else "摘要" if doc_id == "910006" else "全文文献"
                rows.append(f'<li class="resultItem"><div class="resultHeader"><h3><a href="/docview/{doc_id}/SESSION/{page}">Public journal {doc_id}</a></h3>'
                            '<span class="scholUnivAuthors"><span class="truncatedAuthor">Cheng, Zhuo; Lu, Xiaoping; 等.</span></span>'
                            '<span class="jnlArticle"><strong>Fixture Journal</strong><strong>; London</strong> Vol. 7, Iss. 11, (Nov 1, 2025): 2700-2713.</span>'
                            f'<div class="format-display"><span>{label}</span></div></div></li>')
            other = "2" if page == "1" else "1"
            return self.reply(f'<ul>{"".join(rows)}</ul><a id="next-page" href="/resultsol/journals/{other}">第 {other} 页</a>')
        if path.startswith("/resultsol/fixture/"):
            page = path.rsplit("/", 1)[-1]
            ids = ["900001", "900003", "900004"] if page == "1" else ["900002", "900001"]
            rows = []
            for doc_id in ids:
                access = "提供预览" if doc_id == "900003" else "摘要" if doc_id == "900004" else "公开论文"
                rows.append(f'<li class="resultItem"><div class="resultHeader"><h3><a href="/docview/{doc_id}/SESSION/{page}?accountid=fixture">Public thesis {doc_id}</a></h3>'
                            '<span class="scholUnivAuthors"><span class="truncatedAuthor">Hammer, John R.</span></span>'
                            '<span class="dissertpub">Fixture University ProQuest Dissertations &amp; Theses, 2026. 123.</span>'
                            f'<div class="format-display"><span>{access}</span></div></div></li>')
            other = "2" if page == "1" else "1"
            return self.reply(f'<ul>{"".join(rows)}</ul><a id="next-page" href="/resultsol/fixture/{other}">第 {other} 页</a>')
        if path.startswith(("/docview/900", "/docview/910")):
            mode, delay = STATE["pqMode"], STATE["pqDelay"]
            time.sleep(delay)
            doc_id = path.split("/")[2]
            STATE["pqToken"] += 1
            if doc_id.startswith("910"):
                preview = doc_id == "910003" or mode == "preview"
                unknown = doc_id == "910004" or mode == "unknown"
                access = '<span>提供预览</span>' if preview else '<span>全文文献</span>' if unknown else '<span title="开放阅览" aria-label="开放阅览">全文文献</span>'
                label = "下载预览" if preview else "下载 PDF"
                href = '/login' if unknown else f'https://media.proquest.com:18543/media/{doc_id}?_s=fixture{STATE["pqToken"]}'
                link = '' if mode == "missing" else f'<a class="tool-option-link pdf-download" title="{label}" href="{href}">{label}</a>'
                return self.reply(f'<ul class="format-wrapper"><li>{access}</li><li>学术期刊</li></ul><h1 class="documentTitle">Public journal {doc_id}</h1>'
                                  '<span class="scholUnivAuthors"><span class="truncatedAuthor">Cheng, Zhuo; Lu, Xiaoping; 等.</span>'
                                  '<span id="moreAuthors_fixture" style="display:none" class="truncatedAuthor">Cheng, Zhuo; Lu, Xiaoping; Long, Chunlin.</span></span>'
                                  '<span class="jnlArticle"><strong>Fixture Journal</strong><strong>; London</strong> Vol. 7, Iss. 11, (Nov 1, 2025): 2700-2713.</span>'
                                  f'<a href="https://doi.org/10.1000/{doc_id}">DOI</a>{link}')
            preview = doc_id == "900003" or mode == "preview"
            label = "Download preview" if preview else "Download PDF"
            notice = "Document preview" if preview else "This graduate work has been published as open access."
            if mode == "unknown":
                notice = "Full text may be available"
            cls = "wt-download-pdf" if doc_id == "900001" else "tool-option-link pdf-download"
            heading = '<h2 class="unauthdocheader">' if doc_id == "900001" else '<h1 class="documentTitle">'
            end = '</h2>' if doc_id == "900001" else '</h1>'
            url = f'https://media.proquest.com:18543/media/{doc_id}?_s=fixture{STATE["pqToken"]}'
            link = '' if mode == "missing" else f'<a class="{cls}" title="{label}" href="{url}">{label}</a>'
            return self.reply(f'{heading}Public thesis {doc_id}{end}<strong>{notice}</strong>'
                              '<span class="scholUnivAuthors"><span class="truncatedAuthor">Hammer, John R.</span></span>'
                              '<span class="dissertpub">Fixture University ProQuest Dissertations &amp; Theses, 2026. 123.</span>'
                              + link)
        if path.startswith(("/media/900", "/media/910", "/media/920")):
            if path.startswith("/media/920") and "pq_fixture_member=1" not in self.headers.get("Cookie", ""):
                return self.reply("<html>Please sign in</html>", status=403)
            if STATE["pqMode"] == "html":
                return self.reply("<html>Service unavailable</html>")
            return self.reply(PDF, "application/pdf", headers={"Content-Disposition": 'attachment; filename="ProQuestDocument.pdf"'})
        if path.startswith("/v2/"):
            return self.reply(json.dumps({
                "title": "<b>DOI fixture</b>", "journal_name": "Fixture journal", "year": 2026,
                "z_authors": [{"given": "John Q.", "family": "Smith"}],
            }), "application/json")
        if path.startswith("/pdf/") and not STATE["validPdf"]:
            return self.reply('{"error":"not found"}', "application/json")
        if path.endswith("/redirect"):
            return self.reply(b"", status=302, headers={"Location": path.replace("/redirect", "/download")})
        if path.endswith("/download") or path.startswith("/pdf/"):
            return self.reply(PDF, "application/pdf", headers={"Content-Disposition": 'attachment; filename="fixture.pdf"'})
        if path.endswith("/verify"):
            return self.reply("<html><body>安全验证：请输入验证码</body></html>")
        if path.endswith("/kcms/detail"):
            delay, fail = STATE["delay"], STATE["fail"]
            time.sleep(delay)
            if fail:
                return self.reply("temporarily unavailable", status=503)
            prefix = path.removesuffix("/kcms/detail")
            return self.reply(f'<div class="operate-btn"><a href="{prefix}/redirect">Download PDF</a></div>'
                              '<div class="author"><a>First Author</a><a>Second Author</a></div>'
                              '<div class="top-tip">2026,12(3):45-52</div>')
        if path.endswith("/portal"):
            return self.reply('<a class="fz14" href="/notice">普通图书馆公告</a>')
        prefix = path.removesuffix("/search")
        return self.reply(f'<table class="result-table-list"><tr><td class="name"><a class="fz14" '
                          f'href="{prefix}/kcms/detail">Integration fixture {host}</a></td>'
                          '<td class="author">Original Author</td></tr></table>')

    def log_message(self, fmt, *args):
        print(self.headers.get("Host", ""), fmt % args, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--cert", required=True)
    parser.add_argument("--key", required=True)
    args = parser.parse_args()
    http = ThreadingHTTPServer(("127.0.0.1", 18580), Handler)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(args.cert, args.key)
    https = ThreadingHTTPServer(("127.0.0.1", 18543), Handler)
    https.socket = tls.wrap_socket(https.socket, server_side=True)
    threading.Thread(target=https.serve_forever, daemon=True).start()
    print("Local fixtures: HTTP 18580 / HTTPS 18543", flush=True)
    http.serve_forever()
