// =====================================================================
// WerNer Arama Köprüsü — Cloudflare Worker (ücretsiz plan yeter)
//
// İki uç nokta:
//   GET /search?q=...   -> web araması (başlık + link + özet)
//   GET /read?url=...   -> bir web sayfasının metnini okur
//
// Arama kaynağı:
//   * TAVILY_API_KEY ayarlıysa Tavily (daha kaliteli, ayda 1000 ücretsiz arama)
//   * ayarlı değilse anahtarsız DuckDuckGo
//
// İsteğe bağlı ayar (Worker > Settings > Variables):
//   ALLOWED_ORIGIN = https://siteadin.com   (sadece senin siten kullansın)
// =====================================================================

const MAX_TEXT = 6000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin': allowed === '*' ? '*' : allowed,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (allowed !== '*' && origin && origin !== allowed) return json({ error: 'Bu siteye izin yok.' }, 403);

    const url = new URL(request.url);
    try {
      if (url.pathname === '/search') {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) return json({ error: 'q parametresi gerekli' }, 400);
        const results = env.TAVILY_API_KEY ? await tavilySearch(q, env.TAVILY_API_KEY) : await ddgSearch(q);
        return json({ query: q, results });
      }
      if (url.pathname === '/read') {
        const target = (url.searchParams.get('url') || '').trim();
        if (!isSafeUrl(target)) return json({ error: 'Geçersiz veya izin verilmeyen URL' }, 400);
        return json({ url: target, text: await readPage(target) });
      }
      return json({ ok: true, name: 'WerNer Arama Köprüsü', endpoints: ['/search?q=', '/read?url='] });
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 502);
    }
  },
};

// ---------- Güvenlik: iç ağ adreslerini engelle ----------
function isSafeUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return false;
    const h = x.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
    if (h === '[::1]' || h.startsWith('[fc') || h.startsWith('[fd') || h.startsWith('[fe80')) return false;
    return true;
  } catch { return false; }
}

// ---------- Arama ----------
async function tavilySearch(q, key) {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({ query: q, max_results: 6, include_answer: false }),
  });
  if (!r.ok) throw new Error('Tavily hata: HTTP ' + r.status);
  const d = await r.json();
  return (d.results || []).map(x => ({ title: x.title, url: x.url, snippet: (x.content || '').slice(0, 400) }));
}

async function ddgSearch(q) {
  const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
    },
  });
  if (!r.ok) throw new Error('DuckDuckGo hata: HTTP ' + r.status);
  return parseDdg(await r.text());
}

function parseDdg(html) {
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m;
  while ((m = re.exec(html)) && out.length < 6) {
    let href = decodeEntities(m[1]);
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    if (href.startsWith('//')) href = 'https:' + href;
    if (!/^https?:\/\//.test(href)) continue;
    out.push({ title: clean(m[2]), url: href, snippet: clean(m[3] || '').slice(0, 400) });
  }
  return out;
}

// ---------- Sayfa okuma ----------
async function readPage(u) {
  const r = await fetch(u, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WerNerBot/1.0)', 'Accept': 'text/html,text/plain;q=0.9,*/*;q=0.5' },
  });
  if (!r.ok) throw new Error('Sayfa açılamadı: HTTP ' + r.status);
  const ct = r.headers.get('content-type') || '';
  if (!/text|json|xml/.test(ct)) throw new Error('Desteklenmeyen içerik türü: ' + ct);
  let body = (await r.text()).slice(0, 600000);
  if (/html/.test(ct)) {
    const title = (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    body = body
      .replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
    body = (title ? clean(title) + '\n\n' : '') + decodeEntities(body);
  }
  return body.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim().slice(0, MAX_TEXT);
}

// ---------- Yardımcılar ----------
function clean(s) { return decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
