const API_URL = 'https://page-snapshot.i-f17.workers.dev';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'fetchResource') {
    fetchResourceAsDataUrl(message.url)
      .then((dataUrl) => sendResponse({ dataUrl }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === 'capture') {
    handleCapture(message.tabId, message.expiration)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // Keep channel open for async response
  }

  if (message.action === 'startElementCapture') {
    handleStartElementCapture(message.tabId, message.expiration)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === 'captureSelectedElement') {
    const tabId = sender.tab?.id || message.tabId;
    handleSelectedElementCapture(tabId, message.expiration, message.marker)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === 'captureComplete') {
    // This is handled by the pending promise
    return false;
  }
});

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 32768;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

async function fetchResourceAsDataUrl(url) {
  let absoluteUrl;
  try {
    absoluteUrl = new URL(url).href;
  } catch {
    throw new Error('Invalid resource URL');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(absoluteUrl, {
      credentials: 'include',
      cache: 'force-cache',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Resource fetch failed: ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) return null;

    return `data:${contentType.split(';')[0]};base64,${arrayBufferToBase64(buffer)}`;
  } finally {
    clearTimeout(timeout);
  }
}

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

async function handleCapture(tabId, expiration, options = {}) {
  // Inject and execute the capture script
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: capturePageSnapshot,
    args: [options],
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

  const responseData = await response.json();
  return {
    ...responseData,
    title: result.title,
    sourceUrl: result.sourceUrl,
  };
}

async function handleStartElementCapture(tabId, expiration) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: startElementPicker,
    args: [expiration],
  });

  const result = results?.[0]?.result;
  if (!result?.success) {
    throw new Error(result?.error || 'Failed to start element picker');
  }

  return { success: true };
}

async function handleSelectedElementCapture(tabId, expiration, marker) {
  if (!tabId) {
    throw new Error('No active tab found');
  }

  if (!marker) {
    throw new Error('No selected element found');
  }

  const response = await handleCapture(tabId, expiration, { targetMarker: marker });
  await saveToHistory({
    url: response.url,
    title: response.title || 'Selected portion',
    sourceUrl: response.sourceUrl || '',
    createdAt: new Date().toISOString(),
    expiresAt: response.expiresAt,
  });

  return response;
}

async function saveToHistory(item) {
  const storageKey = 'snapshot_history';
  const result = await chrome.storage.local.get(storageKey);
  const history = result[storageKey] || [];

  history.unshift(item);
  if (history.length > 50) history.pop();

  await chrome.storage.local.set({ [storageKey]: history });
}

// This function runs in the page context and stays alive after the popup closes.
function startElementPicker(expiration) {
  try {
    if (window.__pageSnapshotPickerCleanup) {
      window.__pageSnapshotPickerCleanup();
    }

    const markerAttribute = 'data-page-snapshot-target';
    const uiAttribute = 'data-page-snapshot-ui';
    const marker = `ps-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    let currentElement = null;
    let lastMouseX = Math.floor(window.innerWidth / 2);
    let lastMouseY = Math.floor(window.innerHeight / 2);
    let isCapturing = false;

    const overlay = document.createElement('div');
    overlay.setAttribute(uiAttribute, 'true');
    overlay.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'pointer-events:none',
      'border:2px solid #0066cc',
      'background:rgba(0,102,204,0.08)',
      'box-shadow:0 0 0 99999px rgba(0,0,0,0.18)',
      'border-radius:4px',
      'transition:all 80ms ease',
      'display:none',
    ].join(';');

    const label = document.createElement('div');
    label.setAttribute(uiAttribute, 'true');
    label.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'pointer-events:none',
      'padding:4px 8px',
      'border-radius:6px',
      'background:#0066cc',
      'color:white',
      'font:12px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
      'box-shadow:0 4px 12px rgba(0,0,0,0.2)',
      'display:none',
    ].join(';');

    const hint = document.createElement('div');
    hint.setAttribute(uiAttribute, 'true');
    hint.style.cssText = [
      'position:fixed',
      'left:50%',
      'bottom:20px',
      'transform:translateX(-50%)',
      'z-index:2147483647',
      'padding:10px 12px',
      'border-radius:999px',
      'background:#111',
      'color:white',
      'font:13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,0.25)',
    ].join(';');
    hint.textContent = 'Hover to choose. Enter capture, Esc cancel, arrows move DOM.';

    document.documentElement.append(overlay, label, hint);

    function cleanup() {
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', updateOverlay, true);
      window.removeEventListener('resize', updateOverlay, true);
      overlay.remove();
      label.remove();
      hint.remove();
      window.__pageSnapshotPickerCleanup = null;
    }

    window.__pageSnapshotPickerCleanup = cleanup;

    function isPickerUi(element) {
      return element?.hasAttribute?.(uiAttribute) || Boolean(element?.closest?.(`[${uiAttribute}]`));
    }

    function getUsableRect(element) {
      if (!element || isPickerUi(element) || element === document.documentElement) return null;

      const rect = element.getBoundingClientRect();
      if (rect.width < 3 || rect.height < 3) return null;

      return rect;
    }

    function describeElement(element) {
      const rect = element.getBoundingClientRect();
      const id = element.id ? `#${element.id}` : '';
      const classes = [...element.classList].slice(0, 3).map((className) => `.${className}`).join('');
      return `${element.tagName.toLowerCase()}${id}${classes} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
    }

    function setCurrentElement(element) {
      if (isCapturing) return;

      let nextElement = element;
      while (nextElement && !getUsableRect(nextElement)) {
        nextElement = nextElement.parentElement;
      }

      currentElement = nextElement || document.body;
      updateOverlay();
    }

    function updateOverlay() {
      const rect = getUsableRect(currentElement);
      if (!rect) {
        overlay.style.display = 'none';
        label.style.display = 'none';
        return;
      }

      overlay.style.display = 'block';
      overlay.style.left = `${Math.max(0, rect.left)}px`;
      overlay.style.top = `${Math.max(0, rect.top)}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;

      label.style.display = 'block';
      label.textContent = describeElement(currentElement);
      label.style.left = `${Math.max(8, rect.left)}px`;
      label.style.top = `${Math.max(8, rect.top - 30)}px`;
    }

    function getFirstVisibleChild(element) {
      return [...element.children].find((child) => getUsableRect(child));
    }

    function getChildAtPoint(element) {
      const pointElement = document.elementFromPoint(lastMouseX, lastMouseY);
      let child = pointElement;

      while (child && child.parentElement !== element) {
        child = child.parentElement;
      }

      return getUsableRect(child) ? child : getFirstVisibleChild(element);
    }

    function getSibling(element, direction) {
      let sibling = direction === 'previous' ? element.previousElementSibling : element.nextElementSibling;

      while (sibling && !getUsableRect(sibling)) {
        sibling = direction === 'previous' ? sibling.previousElementSibling : sibling.nextElementSibling;
      }

      return sibling;
    }

    function showResultCard(url) {
      const card = document.createElement('div');
      card.setAttribute(uiAttribute, 'true');
      card.style.cssText = [
        'position:fixed',
        'right:16px',
        'top:16px',
        'z-index:2147483647',
        'width:320px',
        'padding:14px',
        'border-radius:12px',
        'background:white',
        'color:#111',
        'font:13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
        'box-shadow:0 14px 40px rgba(0,0,0,0.25)',
        'border:1px solid rgba(0,0,0,0.08)',
      ].join(';');

      card.innerHTML = `
        <div style="font-weight:600;margin-bottom:8px">Portion captured</div>
        <input value="${url.replace(/"/g, '&quot;')}" readonly style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;margin-bottom:10px;font:12px monospace">
        <div style="display:flex;gap:8px">
          <button data-copy style="flex:1;padding:8px;border:0;border-radius:6px;background:#0066cc;color:white;cursor:pointer">Copy</button>
          <a href="${url.replace(/"/g, '&quot;')}" target="_blank" rel="noreferrer" style="flex:1;text-align:center;padding:8px;border-radius:6px;background:#f0f7ff;color:#0066cc;text-decoration:none">Open</a>
          <button data-close style="padding:8px;border:0;border-radius:6px;background:#eee;color:#333;cursor:pointer">Close</button>
        </div>
      `;

      card.querySelector('[data-copy]').addEventListener('click', async () => {
        const input = card.querySelector('input');
        try {
          await navigator.clipboard.writeText(url);
        } catch {
          input.select();
          document.execCommand('copy');
        }
        card.querySelector('[data-copy]').textContent = 'Copied';
      });

      card.querySelector('[data-close]').addEventListener('click', () => card.remove());
      document.documentElement.append(card);
    }

    async function captureCurrentElement() {
      if (!currentElement || isCapturing) return;

      isCapturing = true;
      currentElement.setAttribute(markerAttribute, marker);
      hint.textContent = 'Capturing selected portion...';

      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('keydown', onKeyDown, true);

      try {
        const response = await chrome.runtime.sendMessage({
          action: 'captureSelectedElement',
          expiration,
          marker,
        });

        if (response?.error) {
          throw new Error(response.error);
        }

        cleanup();
        showResultCard(response.url);
      } catch (error) {
        currentElement.removeAttribute(markerAttribute);
        isCapturing = false;
        hint.textContent = error.message || 'Capture failed';
        document.addEventListener('mousemove', onMouseMove, true);
        document.addEventListener('keydown', onKeyDown, true);
      }
    }

    function onMouseMove(event) {
      lastMouseX = event.clientX;
      lastMouseY = event.clientY;
      setCurrentElement(document.elementFromPoint(lastMouseX, lastMouseY));
    }

    function onKeyDown(event) {
      if (!currentElement) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cleanup();
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        void captureCurrentElement();
        return;
      }

      const navigationKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
      if (!navigationKeys.includes(event.key)) return;

      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'ArrowUp' && currentElement.parentElement) {
        setCurrentElement(currentElement.parentElement);
      } else if (event.key === 'ArrowDown') {
        setCurrentElement(getChildAtPoint(currentElement));
      } else if (event.key === 'ArrowLeft') {
        setCurrentElement(getSibling(currentElement, 'previous') || currentElement);
      } else if (event.key === 'ArrowRight') {
        setCurrentElement(getSibling(currentElement, 'next') || currentElement);
      }
    }

    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', updateOverlay, true);
    window.addEventListener('resize', updateOverlay, true);

    setCurrentElement(document.elementFromPoint(lastMouseX, lastMouseY) || document.body);

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Failed to start element picker',
    };
  }
}

// This function runs in the page context
async function capturePageSnapshot(options = {}) {
  const targetMarker = options?.targetMarker;
  const targetAttribute = 'data-page-snapshot-target';
  const canvasAttribute = 'data-page-snapshot-canvas-index';
  let originalTargetElement = null;
  let originalCanvases = [];

  async function fetchViaExtensionAsDataUrl(absoluteUrl) {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return null;

      const response = await chrome.runtime.sendMessage({
        action: 'fetchResource',
        url: absoluteUrl,
      });

      return response?.dataUrl || null;
    } catch {
      return null;
    }
  }

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

      const fetchViaExtension = () => fetchViaExtensionAsDataUrl(absoluteUrl);

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
          return await fetchViaExtension();
        }

        const blob = await response.blob();
        if (blob.size === 0) return await fetchViaExtension();

        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      } catch (e) {
        clearTimeout(timeout);
        // CORS errors are expected for cross-origin resources; the extension
        // worker can still read many resources that are display-only to the page.
        return await fetchViaExtension();
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
    const originalSrc = img.currentSrc || img.src;
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
    const liveImages = [...document.querySelectorAll('img')];
    const documentBaseUrl = document.baseURI || location.href;

    function toAbsoluteUrl(url) {
      try {
        return new URL(url, documentBaseUrl).href;
      } catch {
        return null;
      }
    }

    function findOriginalImage(src) {
      const absoluteSrc = toAbsoluteUrl(src);

      return liveImages.find((candidate) => {
        const candidateSrc = candidate.getAttribute('src');
        return (
          candidateSrc === src ||
          (absoluteSrc && (candidate.src === absoluteSrc || candidate.currentSrc === absoluteSrc))
        );
      });
    }

    await Promise.all([...doc.querySelectorAll('img')].map(async (img) => {
      const src = img.getAttribute('src');
      img.removeAttribute('srcset');
      img.removeAttribute('loading');

      if (!src || src.startsWith('data:')) return;

      const originalImg = findOriginalImage(src);
      if (originalImg) {
        const dataUrl = await imageToDataUrl(originalImg);
        img.setAttribute('src', dataUrl);
      } else {
        // Image not in live DOM, try direct fetch or keep original URL
        const dataUrl = await fetchAsDataUrl(src, documentBaseUrl);
        if (dataUrl) {
          img.setAttribute('src', dataUrl);
        }
        // If fetch fails, keep original URL (already set)
      }
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
    const clonedCanvases = doc.querySelectorAll(`canvas[${canvasAttribute}]`);
    clonedCanvases.forEach((clonedCanvas) => {
      try {
        const originalIndex = Number(clonedCanvas.getAttribute(canvasAttribute));
        const canvas = originalCanvases[originalIndex];
        if (!canvas) return;

        const img = doc.createElement('img');
        img.src = canvas.toDataURL();
        img.style.cssText = window.getComputedStyle(canvas).cssText;
        clonedCanvas.replaceWith(img);
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

  function removePickerUi(doc) {
    doc.querySelectorAll('[data-page-snapshot-ui]').forEach(el => el.remove());
  }

  function isolateTargetPath(doc, marker) {
    const target = doc.querySelector(`[${targetAttribute}="${marker}"]`);

    if (!target) {
      throw new Error('Selected element is no longer available');
    }

    target.removeAttribute(targetAttribute);

    let current = target;
    while (current && current !== doc.body) {
      const parent = current.parentElement;
      if (!parent) break;

      [...parent.children].forEach((child) => {
        if (child !== current) child.remove();
      });

      current = parent;
    }
  }

  // Main capture logic
  try {
    if (targetMarker) {
      originalTargetElement = document.querySelector(`[${targetAttribute}="${targetMarker}"]`);
    }
    originalCanvases = [...document.querySelectorAll('canvas')];
    originalCanvases.forEach((canvas, index) => {
      canvas.setAttribute(canvasAttribute, String(index));
    });

    const allCSS = await getAllStylesheetCSS();

    const docClone = document.documentElement.cloneNode(true);
    const tempDoc = document.implementation.createHTMLDocument('');
    tempDoc.replaceChild(docClone, tempDoc.documentElement);

    removePickerUi(tempDoc);
    if (targetMarker) {
      isolateTargetPath(tempDoc, targetMarker);
    }

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
      title: targetMarker ? `${document.title} - selection` : document.title,
      sourceUrl: location.href,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Capture failed',
    };
  } finally {
    if (originalTargetElement) {
      originalTargetElement.removeAttribute(targetAttribute);
    }
    originalCanvases.forEach((canvas) => {
      canvas.removeAttribute(canvasAttribute);
    });
  }
}
