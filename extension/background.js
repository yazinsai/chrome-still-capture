const API_URL = 'https://page-snapshot.i-f17.workers.dev';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'capture') {
    handleCapture(message.tabId, message.expiration)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // Keep channel open for async response
  }

  if (message.action === 'captureComplete') {
    // This is handled by the pending promise
    return false;
  }
});

// Compress string using gzip
async function compressString(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);

  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(data);
  writer.close();

  const compressedChunks = [];
  const reader = cs.readable.getReader();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    compressedChunks.push(value);
  }

  const totalLength = compressedChunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const compressedData = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of compressedChunks) {
    compressedData.set(chunk, offset);
    offset += chunk.length;
  }

  // Convert to base64 for JSON transport (chunk to avoid stack overflow)
  let binary = '';
  const chunkSize = 32768;
  for (let i = 0; i < compressedData.length; i += chunkSize) {
    const chunk = compressedData.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

async function handleCapture(tabId, expiration) {
  // Inject and execute the capture script
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: capturePageSnapshot,
  });

  if (!results || results.length === 0) {
    throw new Error('Failed to execute capture script');
  }

  const result = results[0].result;

  if (!result || !result.success) {
    throw new Error(result?.error || 'Capture failed');
  }

  // Compress HTML before upload
  const originalSize = new TextEncoder().encode(result.html).length;
  const compressedHtml = await compressString(result.html);
  const compressedSize = compressedHtml.length;
  console.log(`Compression: ${(originalSize / 1024 / 1024).toFixed(2)}MB -> ${(compressedSize / 1024 / 1024).toFixed(2)}MB (${Math.round((1 - compressedSize / originalSize) * 100)}% reduction)`);

  // Upload to server
  const response = await fetch(`${API_URL}/api/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      html: compressedHtml,
      compressed: true,
      title: result.title,
      sourceUrl: result.sourceUrl,
      expiresIn: expiration,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upload failed: ${text}`);
  }

  return await response.json();
}

// This function runs in the page context
async function capturePageSnapshot() {
  // Fetch URL as data URL with timeout
  async function fetchAsDataUrl(url, baseUrl, silent = false) {
    try {
      // Handle relative URLs
      let absoluteUrl;
      try {
        absoluteUrl = new URL(url, baseUrl || location.href).href;
      } catch {
        return null;
      }

      if (absoluteUrl.startsWith('data:')) return absoluteUrl;

      // Create abort controller for timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      try {
        const response = await fetch(absoluteUrl, {
          credentials: 'include',
          cache: 'force-cache',
          signal: controller.signal
        });

        clearTimeout(timeout);

        if (!response.ok) {
          return null;
        }

        const blob = await response.blob();
        if (blob.size === 0) return null;

        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      } catch (e) {
        clearTimeout(timeout);
        // CORS errors are expected for cross-origin resources, silently fall back
        return null;
      }
    } catch (e) {
      return null;
    }
  }

  // Process CSS text to inline url() references
  async function processCssUrls(cssText, baseUrl) {
    // Match url() with various quote styles and handle format() hints
    const urlRegex = /url\(\s*['"]?([^'")]+?)['"]?\s*\)/g;
    const matches = [...cssText.matchAll(urlRegex)];
    if (matches.length === 0) return cssText;

    const urlMap = new Map();
    const uniqueUrls = [...new Set(matches.map(m => m[1]).filter(u =>
      !u.startsWith('data:') && !u.startsWith('#')
    ))];

    await Promise.all(uniqueUrls.map(async (originalUrl) => {
      const dataUrl = await fetchAsDataUrl(originalUrl, baseUrl);
      if (dataUrl) {
        urlMap.set(originalUrl, dataUrl);
      }
      // If fetch fails (CORS, etc.), we simply don't add to urlMap
      // and the original URL will be preserved in the CSS
    }));

    let result = cssText;
    for (const [originalUrl, dataUrl] of urlMap) {
      // Use simple string replacement to avoid regex issues
      result = result.split(`url("${originalUrl}")`).join(`url("${dataUrl}")`);
      result = result.split(`url('${originalUrl}')`).join(`url("${dataUrl}")`);
      result = result.split(`url(${originalUrl})`).join(`url("${dataUrl}")`);
    }

    return result;
  }

  // Get all CSS from stylesheets
  async function getAllStylesheetCSS() {
    const cssPromises = [];

    // Helper to recursively process @import rules
    async function processStyleSheet(sheet, depth = 0) {
      if (depth > 5) return ''; // Prevent infinite recursion

      const baseUrl = sheet.href || location.href;
      let cssText = '';

      try {
        const rules = sheet.cssRules || sheet.rules;
        for (const rule of rules) {
          if (rule.type === CSSRule.IMPORT_RULE && rule.styleSheet) {
            // Recursively process @import
            cssText += await processStyleSheet(rule.styleSheet, depth + 1);
          } else {
            cssText += rule.cssText + '\n';
          }
        }
        return await processCssUrls(cssText, baseUrl);
      } catch (e) {
        // CORS blocked - try fetching the stylesheet directly
        if (sheet.href) {
          try {
            const response = await fetch(sheet.href, { credentials: 'include' });
            if (response.ok) {
              let cssText = await response.text();
              return await processCssUrls(cssText, sheet.href);
            }
          } catch (e2) {
            // Silently fail - stylesheet won't be included
          }
        }
        return '';
      }
    }

    for (const sheet of document.styleSheets) {
      cssPromises.push(processStyleSheet(sheet));
    }

    for (const style of document.querySelectorAll('style')) {
      if (style.textContent) {
        cssPromises.push(processCssUrls(style.textContent, location.href));
      }
    }

    const cssTexts = await Promise.all(cssPromises);
    return cssTexts.filter(Boolean).join('\n');
  }

  // Convert image to data URL
  async function imageToDataUrl(img) {
    const originalSrc = img.src;
    if (!originalSrc || originalSrc.startsWith('data:')) return originalSrc;

    if (!img.complete) {
      await new Promise(r => { img.onload = img.onerror = r; setTimeout(r, 2000); });
    }

    if (img.naturalWidth === 0) {
      // Image didn't load, try fetching directly
      const dataUrl = await fetchAsDataUrl(originalSrc);
      return dataUrl || originalSrc; // Keep original URL as fallback
    }

    try {
      // Try canvas approach (works for same-origin and CORS-enabled images)
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      return canvas.toDataURL('image/png');
    } catch {
      // Canvas tainted by cross-origin image, try fetch
      const dataUrl = await fetchAsDataUrl(originalSrc);
      return dataUrl || originalSrc; // Keep original URL as fallback
    }
  }

  // Process images
  async function processImages(doc) {
    await Promise.all([...doc.querySelectorAll('img')].map(async (img) => {
      const src = img.getAttribute('src');
      if (!src || src.startsWith('data:')) return;

      // Try to find the original image in the live DOM
      let originalImg;
      try {
        originalImg = document.querySelector(`img[src="${CSS.escape(src)}"]`);
      } catch {
        // CSS.escape might fail on some URLs, try direct lookup
        originalImg = [...document.querySelectorAll('img')].find(i => i.src === src);
      }

      if (originalImg) {
        const dataUrl = await imageToDataUrl(originalImg);
        img.setAttribute('src', dataUrl);
      } else {
        // Image not in live DOM, try direct fetch or keep original URL
        const dataUrl = await fetchAsDataUrl(src);
        if (dataUrl) {
          img.setAttribute('src', dataUrl);
        }
        // If fetch fails, keep original URL (already set)
      }

      img.removeAttribute('srcset');
      img.removeAttribute('loading');
    }));
  }

  // Process inline backgrounds
  async function processInlineBackgrounds(doc) {
    await Promise.all([...doc.querySelectorAll('[style*="url"]')].map(async (el) => {
      const style = el.getAttribute('style');
      if (style) {
        el.setAttribute('style', await processCssUrls(style, location.href));
      }
    }));
  }

  // Process SVG images
  async function processSvgImages(doc) {
    await Promise.all([...doc.querySelectorAll('image[href], image[xlink\\:href]')].map(async (img) => {
      const href = img.getAttribute('href') || img.getAttribute('xlink:href');
      if (href && !href.startsWith('data:')) {
        const dataUrl = await fetchAsDataUrl(href);
        if (dataUrl) {
          img.setAttribute('href', dataUrl);
          img.removeAttribute('xlink:href');
        }
      }
    }));
  }

  // Process canvases
  function processCanvases(doc) {
    const canvases = document.querySelectorAll('canvas');
    const clonedCanvases = doc.querySelectorAll('canvas');
    canvases.forEach((canvas, i) => {
      try {
        const img = doc.createElement('img');
        img.src = canvas.toDataURL();
        img.style.cssText = window.getComputedStyle(canvas).cssText;
        clonedCanvases[i]?.replaceWith(img);
      } catch {}
    });
  }

  // Process iframes
  function processIframes(doc) {
    for (const iframe of doc.querySelectorAll('iframe')) {
      try {
        const src = iframe.getAttribute('src') || '';
        const original = src ? document.querySelector(`iframe[src="${CSS.escape(src)}"]`) : null;
        const iframeDoc = original?.contentDocument;

        if (iframeDoc?.body) {
          iframe.setAttribute('srcdoc', iframeDoc.documentElement.outerHTML);
          iframe.removeAttribute('src');
        } else {
          const div = doc.createElement('div');
          div.style.cssText = `width:${iframe.width||'100%'};height:${iframe.height||'150px'};background:#f5f5f5;border:1px dashed #ccc;display:flex;align-items:center;justify-content:center;color:#666;font:14px system-ui`;
          div.textContent = '[Embedded content]';
          iframe.replaceWith(div);
        }
      } catch {
        const div = doc.createElement('div');
        div.style.cssText = 'width:100%;height:150px;background:#f5f5f5;border:1px dashed #ccc;display:flex;align-items:center;justify-content:center;color:#666;font:14px system-ui';
        div.textContent = '[Embedded content]';
        iframe.replaceWith(div);
      }
    }
  }

  // Remove scripts
  function removeScripts(doc) {
    doc.querySelectorAll('script, noscript').forEach(el => el.remove());
    doc.querySelectorAll('*').forEach(el => {
      [...el.attributes].forEach(attr => {
        if (attr.name.startsWith('on') || (attr.name === 'href' && attr.value.startsWith('javascript:'))) {
          el.removeAttribute(attr.name);
        }
      });
    });
  }

  // Remove external resources
  function removeExternalResources(doc) {
    doc.querySelectorAll('link[rel="stylesheet"], link[rel="preload"], link[rel="prefetch"], link[rel="modulepreload"], link[rel="preconnect"], link[rel="dns-prefetch"], style').forEach(el => el.remove());
  }

  // Main capture logic
  try {
    const allCSS = await getAllStylesheetCSS();

    const docClone = document.documentElement.cloneNode(true);
    const tempDoc = document.implementation.createHTMLDocument('');
    tempDoc.replaceChild(docClone, tempDoc.documentElement);

    removeScripts(tempDoc);
    removeExternalResources(tempDoc);
    // Note: Skipping computed styles - rely on captured CSS instead (much smaller)

    await Promise.all([
      processImages(tempDoc),
      processInlineBackgrounds(tempDoc),
      processSvgImages(tempDoc),
    ]);

    processCanvases(tempDoc);
    processIframes(tempDoc);

    // Add CSS
    const styleEl = tempDoc.createElement('style');
    styleEl.textContent = allCSS;
    tempDoc.head.appendChild(styleEl);

    // Add metadata
    if (!tempDoc.querySelector('meta[charset]')) {
      const meta = tempDoc.createElement('meta');
      meta.setAttribute('charset', 'UTF-8');
      tempDoc.head.prepend(meta);
    }
    tempDoc.querySelectorAll('base').forEach(el => el.remove());

    const html = '<!DOCTYPE html>\n' + tempDoc.documentElement.outerHTML;

    return {
      success: true,
      html,
      title: document.title,
      sourceUrl: location.href,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Capture failed',
    };
  }
}
