const MAX_SIZE = 50 * 1024 * 1024; // 50MB (for compressed payload)

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

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// Decompress gzip data from base64
async function decompressHtml(base64Data) {
  // Decode base64 to binary
  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // Decompress using DecompressionStream
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();

  const decompressedChunks = [];
  const reader = ds.readable.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    decompressedChunks.push(value);
  }

  // Combine chunks and decode as UTF-8
  const totalLength = decompressedChunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of decompressedChunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder().decode(combined);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method === 'POST' && url.pathname === '/api/upload') {
      return handleUpload(request, env);
    }

    if (request.method === 'GET' && url.pathname.length > 1) {
      return handleServe(request, env, url.pathname.slice(1));
    }

    return new Response('Not Found', { status: 404 });
  },
};

async function handleUpload(request, env) {
  try {
    const contentLength = request.headers.get('Content-Length');
    if (contentLength && parseInt(contentLength) > MAX_SIZE) {
      return new Response(JSON.stringify({ error: 'Content too large' }), {
        status: 413,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    const body = await request.json();
    const { html, compressed, title, sourceUrl, expiresIn } = body;

    if (!html) {
      return new Response(JSON.stringify({ error: 'Missing html content' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    // Decompress if needed
    let finalHtml;
    if (compressed) {
      try {
        finalHtml = await decompressHtml(html);
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Failed to decompress: ' + e.message }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() },
        });
      }
    } else {
      finalHtml = html;
    }

    const id = generateId();
    const expiresAt = parseExpiration(expiresIn);

    const metadata = {
      title: title || 'Untitled',
      sourceUrl: sourceUrl || '',
      createdAt: new Date().toISOString(),
      expiresAt,
    };

    await env.SNAPSHOTS.put(id, finalHtml, {
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
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Upload failed: ' + err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
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
