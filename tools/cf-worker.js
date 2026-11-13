// Cloudflare Worker: a small fetch proxy for novel sites whose bot protection
// refuses LNReader's own HTTP client but accepts a server-side fetch.
//
// Deploy (free plan is enough): Cloudflare dashboard -> Workers -> Create ->
// paste this file -> Deploy. Then, in LNReader, open the plugin's settings and
// set "Proxy URL" to https://<your-worker>.workers.dev
//
// Only hosts in ALLOWED_HOSTS are fetched, so the Worker cannot be used as an
// open proxy. Add a host only for a plugin that reads its proxy setting.
const ALLOWED_HOSTS = ['brightnovels.com', 'www.brightnovels.com'];

export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== '/proxy') return new Response('not found', { status: 404 });
    let target;
    try {
      target = new URL(url.searchParams.get('url') || '');
    } catch (e) {
      return new Response('bad url', { status: 400 });
    }
    if (target.protocol !== 'https:' || !ALLOWED_HOSTS.includes(target.hostname)) {
      return new Response('host not allowed', { status: 403 });
    }
    const headers = new Headers();
    for (const h of ['accept', 'content-type', 'x-inertia', 'x-inertia-version', 'x-requested-with']) {
      const v = req.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set('user-agent', req.headers.get('user-agent') || 'Mozilla/5.0');
    const upstream = await fetch(target.toString(), {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer(),
      redirect: 'follow',
    });
    const out = new Headers();
    out.set('content-type', upstream.headers.get('content-type') || 'application/octet-stream');
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
