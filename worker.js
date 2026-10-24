/**
 * Steam 数据代理 —— Cloudflare Worker
 *
 * 为什么需要它：
 *   浏览器的同源策略禁止直接访问 api.steampowered.com（实测这些接口
 *   都不返回 Access-Control-Allow-Origin），所以纯静态网页读不到 Steam 数据。
 *   这个 Worker 只做一件事：**转发**，并在响应里补上 CORS 头。
 *
 * 安全设计（重要）：
 *   1. **只允许 4 条固定路由**，不是开放代理 —— 否则会被人拿去当免费跳板
 *   2. **只允许白名单 Origin**（默认放行 localhost 和 *.github.io）
 *   3. **不记录、不存储 API Key**：Key 只作为查询参数透传给 Steam，不写 console
 *   4. 响应加 `Cache-Control`，商店数据可缓存，减少对 Steam 的压力
 *
 * 部署：见同目录 部署说明.md
 */

// ── 允许的来源（部署后把你的域名加进来）──
const ALLOWED_ORIGINS = [
  'https://suimoubian.github.io',
  'http://127.0.0.1:8848',
  'http://localhost:8848',
];

function corsHeaders(origin) {
  const ok = ALLOWED_ORIGINS.indexOf(origin) >= 0;
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

const UA_PAGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/* 带重试的 fetch —— Steam 的连接偶发握手超时，不重试会把一次抖动
   直接变成 502 抛给浏览器。线上（Cloudflare）网络比本机稳，重试 3 次足够。

   ⚠ 另一个保险：不同运行时对 `User-Agent` 头的支持不一样
   （有的会拒绝自定义 UA）。如果带 UA 的 fetch 直接抛错，
   就**去掉 UA 再试一次** —— 商店接口在没有 UA 时可能仍能通，
   总比整条链路失败好。 */
async function fetchRetry(url, init, tries, gapMs) {
  const n = tries || 3;
  const gap = gapMs == null ? 250 : gapMs;
  let last = null;
  for (let i = 0; i < n; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      last = e;
      const msg = String((e && e.message) || e);
      /* 头被拒绝 → 去掉 User-Agent 立刻重试（只做一次） */
      if (i === 0 && /user-?agent|header|forbidden/i.test(msg) &&
          init && init.headers && init.headers['User-Agent']) {
        const h2 = Object.assign({}, init.headers);
        delete h2['User-Agent'];
        try {
          return await fetch(url, Object.assign({}, init, { headers: h2 }));
        } catch (e2) {
          last = e2;
        }
      }
      if (i < n - 1) await new Promise(r => setTimeout(r, gap));
    }
  }
  throw last;
}

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
    }, extra || {}),
  });
}

// 从商店页 HTML 里取用户标签（顺序 = 票数降序，和本机脚本一致）
function extractTags(html) {
  const out = [];
  const re = /<a[^>]*class="app_tag"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const t = String(m[1] || '')
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (t && t !== '+' && out.indexOf(t) < 0) out.push(t);
    if (out.length >= 20) break;
  }
  return out;
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    // 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'GET') {
      return json({ ok: false, error: 'method-not-allowed' }, 405, cors);
    }

    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';

    try {
      // ── 路由 1：游戏列表 ──
      if (p === '/owned') {
        const key = url.searchParams.get('key') || '';
        const sid = url.searchParams.get('steamid') || '';
        if (!key || !/^\d{17}$/.test(sid)) {
          return json({ ok: false, error: 'bad-params' }, 400, cors);
        }
        const target = 'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/' +
          '?key=' + encodeURIComponent(key) +
          '&steamid=' + encodeURIComponent(sid) +
          '&include_appinfo=1&include_played_free_games=1&format=json';
        const r = await fetchRetry(target, {
          headers: { 'Accept': 'application/json', 'User-Agent': UA_PAGE },
        }, 3, 250);
        const text = await r.text();
        return new Response(text, {
          status: r.status,
          headers: Object.assign({
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          }, cors),
        });
      }

      // ── 路由 2：解析自定义 ID（/id/名字）──
      if (p === '/resolve') {
        const key = url.searchParams.get('key') || '';
        const vanity = url.searchParams.get('vanity') || '';
        if (!key || !vanity) {
          return json({ ok: false, error: 'bad-params' }, 400, cors);
        }
        const target = 'https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/' +
          '?key=' + encodeURIComponent(key) +
          '&vanityurl=' + encodeURIComponent(vanity);
        const r = await fetchRetry(target, {
          headers: { 'User-Agent': UA_PAGE },
        }, 3, 250);
        const text = await r.text();
        return new Response(text, {
          status: r.status,
          headers: Object.assign({
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          }, cors),
        });
      }

      // ── 路由 3：商店详情（类型 / 价格）──
      if (p === '/appdetails') {
        const appid = url.searchParams.get('appid') || '';
        if (!/^\d+$/.test(appid)) {
          return json({ ok: false, error: 'bad-params' }, 400, cors);
        }
        const target = 'https://store.steampowered.com/api/appdetails' +
          '?appids=' + appid + '&l=schinese&cc=cn';
        // 带上浏览器 UA：Steam 商店对空 UA 的请求常常直接超时/拒绝
        const r = await fetchRetry(target, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': UA_PAGE,
            'Accept-Language': 'zh-CN,zh;q=0.9',
          },
        }, 3, 250);
        const text = await r.text();
        return new Response(text, {
          status: r.status,
          headers: Object.assign({
            'Content-Type': 'application/json; charset=utf-8',
            // 商店数据变化很慢，缓存一天既省流量也避开限流
            'Cache-Control': 'public, max-age=86400',
          }, cors),
        });
      }

      // ── 路由 4：商店页标签 ──
      if (p === '/tags') {
        const appid = url.searchParams.get('appid') || '';
        if (!/^\d+$/.test(appid)) {
          return json({ ok: false, error: 'bad-params' }, 400, cors);
        }
        const target = 'https://store.steampowered.com/app/' + appid + '/?l=schinese';
        const r = await fetchRetry(target, {
          headers: { 'User-Agent': UA_PAGE, 'Accept-Language': 'zh-CN,zh;q=0.9' },
        }, 3, 250);
        const html = await r.text();
        return json({ ok: true, appid: appid, tags: extractTags(html) }, 200,
          Object.assign({ 'Cache-Control': 'public, max-age=86400' }, cors));
      }

      // ── 路由 0：自检（部署完先在浏览器打开 /ping 看一眼）──
      if (p === '/ping' || p === '/') {
        const out = { ok: true, worker: 'steam-proxy', at: new Date().toISOString() };

        // ① 能不能连上 Steam 的 API（这个端点不需要 Key）
        try {
          const r1 = await fetchRetry(
            'https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/',
            { headers: { 'Accept': 'application/json' } }, 2, 200);
          out.api = { status: r1.status, ok: r1.ok };
        } catch (e) {
          out.api = { error: String((e && e.message) || e).slice(0, 120) };
        }

        // ② 能不能连上 Steam 商店（带 UA）
        try {
          const r2 = await fetchRetry(
            'https://store.steampowered.com/api/appdetails?appids=730&l=schinese&cc=cn',
            { headers: { 'Accept': 'application/json', 'User-Agent': UA_PAGE } }, 2, 200);
          const txt = await r2.text();
          let parsed = null;
          try { parsed = JSON.parse(txt); } catch (e) {}
          out.store = {
            status: r2.status,
            ok: r2.ok,
            jsonOk: !!(parsed && parsed['730'] && parsed['730'].success),
          };
        } catch (e) {
          out.store = { error: String((e && e.message) || e).slice(0, 120) };
        }

        // ③ 商店页（取标签用）
        try {
          const r3 = await fetchRetry(
            'https://store.steampowered.com/app/730/?l=schinese',
            { headers: { 'User-Agent': UA_PAGE, 'Accept-Language': 'zh-CN,zh;q=0.9' } }, 2, 200);
          const html = await r3.text();
          out.page = { status: r3.status, ok: r3.ok, tags: extractTags(html).slice(0, 5) };
        } catch (e) {
          out.page = { error: String((e && e.message) || e).slice(0, 120) };
        }

        out.allGood = !!(out.api && out.api.ok && out.store && out.store.jsonOk);
        out.allowedOrigins = ALLOWED_ORIGINS;
        out.corsForThisOrigin = cors['Access-Control-Allow-Origin'];
        return json(out, 200, Object.assign({ 'Cache-Control': 'no-store' }, cors));
      }

      return json({ ok: false, error: 'not-found', path: p }, 404, cors);
    } catch (e) {
      // 注意：**不要**把 key 写进错误信息
      return json({ ok: false, error: 'upstream-failed', detail: String(e && e.message || e).slice(0, 120) }, 502, cors);
    }
  },
};
