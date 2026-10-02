// Optional self-hosted CORS proxy for the Currency_Conversion page.
//
// The four card-network endpoints do not send Access-Control-Allow-Origin, so
// the page normally fetches them through public CORS proxies, which can be
// slow or rate-limited. Deploying this Worker (free tier is plenty) gives you
// a private, reliable channel:
//
//   1. Go to https://workers.cloudflare.com -> Create Worker -> paste this file
//   2. Deploy, copy the worker URL (e.g. https://cc-proxy.you.workers.dev)
//   3. On the page: 设置 Settings -> 自定义代理 Custom proxy ->
//      https://cc-proxy.you.workers.dev/?url={url}
//
// The template {url} is required; the worker substitutes the raw target URL.
// Requests are cached 1h at the edge and restricted to the four card networks.

const ALLOWED_HOSTS = [
  "www.visa.com.hk",
  "usa.visa.com",
  "www.visa.com.sg",
  "www.visa.com.tw",
  "www.visa.com.au",
  "www.mastercard.com",
  "www.jcb.jp",
  "m.unionpayintl.com",
  "www.unionpayintl.com",
];

export default {
  async fetch(request) {
    const u = new URL(request.url);
    const target = u.searchParams.get("url");
    if (!target) return new Response("missing ?url= parameter", { status: 400 });
    let tu;
    try { tu = new URL(target); } catch { return new Response("bad url", { status: 400 }); }
    if (!ALLOWED_HOSTS.includes(tu.hostname)) {
      return new Response("host not allowed: " + tu.hostname, { status: 403 });
    }
    const upstream = await fetch(target, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "Accept": "application/json,text/html,*/*",
      },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") || "text/plain",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
      },
    });
  },
};
