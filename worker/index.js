let cachedManifest;
let manifestExpiresAt = 0;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }
  });
}

async function readManifest(bucket) {
  if (cachedManifest && Date.now() < manifestExpiresAt) return cachedManifest;
  const object = await bucket.get('manifest.json');
  if (!object) return null;
  cachedManifest = await object.json();
  manifestExpiresAt = Date.now() + 60_000;
  return cachedManifest;
}

function imageKey(pathname) {
  try {
    const segments = pathname.slice('/g/'.length).split('/').map(decodeURIComponent);
    if (segments[0] !== 'r' || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\'))) return null;
    return segments.join('/');
  } catch {
    return null;
  }
}

async function handleRequest(request, env, ctx) {
  if (request.method !== 'GET') return new Response('Not found', { status: 404 });
  const url = new URL(request.url);

  if (url.pathname === '/health') return new Response('ok', { headers: { 'Cache-Control': 'no-store' } });

  if (url.pathname === '/manifest') {
    const object = await env.GIFS.get('manifest.json');
    if (!object) return json({ error: 'Manifest not found' }, 404);
    return new Response(object.body, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
        ...(object.httpEtag ? { ETag: object.httpEtag } : {})
      }
    });
  }

  if (url.pathname.startsWith('/random/')) {
    let categoryName;
    try {
      categoryName = decodeURIComponent(url.pathname.slice('/random/'.length));
    } catch {
      return json({ error: 'Invalid category' }, 400);
    }
    if (!categoryName || categoryName.includes('/')) return json({ error: 'Invalid category' }, 400);
    const manifest = await readManifest(env.GIFS);
    if (!manifest) return json({ error: 'Manifest not found' }, 404);
    const entries = manifest.categories?.[categoryName];
    if (!Array.isArray(entries) || entries.length === 0) return json({ error: 'Unknown or empty category' }, 404);
    const size = url.searchParams.get('size') || manifest.default;
    const available = entries.filter((entry) => entry.sizes?.[size]);
    if (available.length === 0) return json({ error: 'No GIFs for requested size' }, 404);
    const entry = available[Math.floor(Math.random() * available.length)];
    const key = entry.sizes[size];
    const imageUrl = `${url.origin}/g/${key.split('/').map(encodeURIComponent).join('/')}`;
    return json({ url: imageUrl, id: entry.id, category: categoryName, size });
  }

  if (url.pathname.startsWith('/g/')) {
    const key = imageKey(url.pathname);
    if (!key) return json({ error: 'Invalid image key' }, 400);
    const cached = await caches.default.match(request);
    if (cached) return cached;
    const object = await env.GIFS.get(key);
    if (!object) return json({ error: 'Image not found' }, 404);
    const response = new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType || 'image/gif',
        'Cache-Control': object.httpMetadata?.cacheControl || 'public, max-age=31536000, immutable',
        ...(object.httpEtag ? { ETag: object.httpEtag } : {})
      }
    });
    ctx.waitUntil(caches.default.put(request, response.clone()));
    return response;
  }

  return new Response('Not found', { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      console.error('GIF service request failed:', error);
      return json({ error: 'Internal server error' }, 500);
    }
  }
};