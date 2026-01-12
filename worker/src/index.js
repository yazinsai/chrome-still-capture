const MAX_SIZE = 10 * 1024 * 1024; // 10MB

function generateId() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function parseExpiration(expiresIn) {
  if (!expiresIn || expiresIn === 'never') {
    return null;
  }

  const now = Date.now();
  const match = expiresIn.match(/^(\d+)([dhm])$/);

  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const multipliers = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return new Date(now + value * multipliers[unit]).toISOString();
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    if (request.method === 'POST' && url.pathname === '/api/upload') {
      return handleUpload(request, env, origin);
    }

    if (request.method === 'GET' && url.pathname.length > 1) {
      return handleServe(request, env, url.pathname.slice(1));
    }

    return new Response('Not Found', { status: 404 });
  },
};

async function handleUpload(request, env, origin) {
  try {
    const contentLength = request.headers.get('Content-Length');
    if (contentLength && parseInt(contentLength) > MAX_SIZE) {
      return new Response(JSON.stringify({ error: 'Content too large' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    const body = await request.json();
    const { html, title, sourceUrl, expiresIn } = body;

    if (!html) {
      return new Response(JSON.stringify({ error: 'Missing html content' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    if (new TextEncoder().encode(html).length > MAX_SIZE) {
      return new Response(JSON.stringify({ error: 'Content too large' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    const id = generateId();
    const expiresAt = parseExpiration(expiresIn);

    const metadata = {
      title: title || 'Untitled',
      sourceUrl: sourceUrl || '',
      createdAt: new Date().toISOString(),
      expiresAt,
    };

    await env.SNAPSHOTS.put(id, html, {
      httpMetadata: {
        contentType: 'text/html; charset=utf-8',
      },
      customMetadata: metadata,
    });

    const snapshotUrl = new URL(request.url);
    snapshotUrl.pathname = `/${id}`;

    return new Response(
      JSON.stringify({
        id,
        url: snapshotUrl.toString(),
        expiresAt,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Upload failed: ' + err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
}

async function handleServe(request, env, id) {
  try {
    const object = await env.SNAPSHOTS.get(id);

    if (!object) {
      return new Response('Snapshot not found', { status: 404 });
    }

    const metadata = object.customMetadata || {};

    if (metadata.expiresAt) {
      const expiresAt = new Date(metadata.expiresAt);
      if (expiresAt < new Date()) {
        await env.SNAPSHOTS.delete(id);
        return new Response('Snapshot has expired', { status: 410 });
      }
    }

    const headers = new Headers();
    headers.set('Content-Type', 'text/html; charset=utf-8');
    headers.set('Cache-Control', 'public, max-age=3600');

    if (metadata.expiresAt) {
      headers.set('X-Expires-At', metadata.expiresAt);
    }
    if (metadata.sourceUrl) {
      headers.set('X-Source-Url', metadata.sourceUrl);
    }

    return new Response(object.body, { headers });
  } catch (err) {
    return new Response('Error retrieving snapshot', { status: 500 });
  }
}
