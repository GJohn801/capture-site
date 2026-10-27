const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const puppeteer = require('puppeteer');

const app = express();
const port = Number(process.env.PORT) || 3001;
const cwd = process.cwd();
const desktopRoot = path.join(os.homedir(), 'Desktop');
const serverLogPath = path.join(cwd, 'server.log');
const MAX_SITEMAPS = 100;
const MAX_SITEMAP_URLS = 5000;
const MAX_SITEMAP_SIZE = 5 * 1024 * 1024;

// Keep the server log open to capture requests and unexpected runtime failures.
const logStream = fs.createWriteStream(serverLogPath, { flags: 'a' });

const appendServerLog = (message) => {
  const timestamp = new Date().toISOString();
  logStream.write(`${timestamp} ${message}\n`);
};

// Middleware: log incoming HTTP requests.
app.use((req, res, next) => {
  appendServerLog(`${req.ip} ${req.method} ${req.url}`);
  next();
});

// Global error handlers: make sure unexpected crashes are recorded.
const handleFatalError = (label, error) => {
  const message = error && (error.stack || error.message || String(error));
  appendServerLog(`${label}: ${message}`);
  console.error(`${label}:`, message);
};

process.on('uncaughtException', (error) => {
  handleFatalError('UncaughtException', error);
});

process.on('unhandledRejection', (reason) => {
  handleFatalError('UnhandledRejection', reason);
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const captureSessions = new Map();
const cancelledCaptureRequests = new Map();

const markCaptureRequestCancelled = (captureId) => {
  if (cancelledCaptureRequests.has(captureId)) return;
  const timer = setTimeout(() => cancelledCaptureRequests.delete(captureId), 60_000);
  timer.unref?.();
  cancelledCaptureRequests.set(captureId, timer);
};

const consumeCancelledCaptureRequest = (captureId) => {
  const timer = cancelledCaptureRequests.get(captureId);
  if (!timer) return false;
  clearTimeout(timer);
  cancelledCaptureRequests.delete(captureId);
  return true;
};

const cancelCaptureSession = (session) => {
  if (!session || ['completed', 'failed', 'cancelled'].includes(session.status)) {
    return false;
  }

  session.cancelled = true;
  session.abortController?.abort();
  session.queuedUrls = 0;
  session.status = 'cancelled';
  session.currentTask = null;
  session.message = 'Capture cancelled; queued URLs cleared.';
  return true;
};

const formatCaptureFailureMessage = (message, url) => {
  const normalizedMessage = String(message || '').trim();

  if (!normalizedMessage) {
    return '';
  }

  if (/failed to fetch/i.test(normalizedMessage)) {
    return `${normalizedMessage} for ${url}`;
  }

  return normalizedMessage;
};

const getFailedUrlsSummary = (results = []) => {
  const failedUrls = [...new Set(
    (results || [])
      .filter((item) => item && !item.success && item.url)
      .map((item) => item.url)
  )];

  return failedUrls.join(', ');
};

const getCaptureSessionPayload = (session) => ({
  captureId: session.id,
  status: session.status,
  totalTasks: session.totalTasks,
  completedTasks: session.completedTasks,
  totalUrls: session.totalUrls,
  completedUrls: session.completedUrls,
  queuedUrls: session.queuedUrls,
  currentTask: session.currentTask,
  message: session.message,
  outputDir: session.outputDir,
  capturePreset: session.capturePreset,
  captureFormat: session.captureFormat,
  widths: session.widths,
  results: session.results,
});

const runCaptureSession = async (captureId, { urls, presetConfig, presetOutputDir, logsDir }) => {
  const session = captureSessions.get(captureId);
  if (!session) {
    return;
  }

  session.status = 'running';
  session.message = 'Starting capture';
  captureSessions.set(captureId, session);

  const results = [];

  for (const url of urls) {
    if (session.cancelled) break;
    const safeBase = makeSafeFilename(url);

    for (const width of presetConfig.widths) {
      if (session.cancelled) break;
      const outputFileName = presetConfig.format === 'pdf'
        ? `${safeBase}.pdf`
        : `${safeBase}-${presetConfig.name}-${width}px.jpg`;
      const outputPath = path.join(presetOutputDir, outputFileName);
      const outLog = path.join(logsDir, `${safeBase}-${presetConfig.name}-${width}px.out.log`);
      const errLog = path.join(logsDir, `${safeBase}-${presetConfig.name}-${width}px.err.log`);
      const isPdf = presetConfig.format === 'pdf';

      session.currentTask = { url, width, output: outputPath, status: 'running' };
      captureSessions.set(captureId, session);

      try {
        const captureOptions = isPdf
          ? { delay: 5, width, timeout: 120, signal: session.abortController.signal }
          : {
            fullPage: true,
            type: presetConfig.format,
            delay: 5,
            width,
            preloadLazyContent: true,
            overwrite: true,
            timeout: 120,
            waitForNetworkIdle: true,
            signal: session.abortController.signal,
          };

        const result = isPdf
          ? await captureWebsitePdf(url, outputPath, captureOptions)
          : await captureWebsite(url, outputPath, captureOptions);

        if (result.stdout) {
          await fs.promises.appendFile(outLog, result.stdout + '\n');
        }
        if (result.stderr) {
          await fs.promises.appendFile(errLog, result.stderr + '\n');
        }

        const resultItem = {
          url,
          width,
          output: outputPath,
          success: true,
          captureFormat: presetConfig.format,
          capturePreset: presetConfig.name,
          stdout: result.stdout,
          stderr: result.stderr,
          outLog,
          errLog,
        };

        results.push(resultItem);
        session.results = results.slice();
      } catch (captureError) {
        if (session.cancelled) break;
        const { error, stdout, stderr } = captureError || {};
        const message = formatCaptureFailureMessage(
          error?.message || captureError?.message || 'Capture failed',
          url
        );
        await fs.promises.appendFile(errLog, `${message}\n${stdout || ''}\n${stderr || ''}\n`);

        const resultItem = {
          url,
          width,
          output: outputPath,
          success: false,
          captureFormat: presetConfig.format,
          capturePreset: presetConfig.name,
          error: message,
          stdout,
          stderr,
          outLog,
          errLog,
        };

        results.push(resultItem);
        session.results = results.slice();
      }

      session.completedTasks += 1;
      const latestResult = results[results.length - 1];
      session.currentTask = {
        url,
        width,
        output: outputPath,
        status: latestResult?.success ? 'completed' : 'failed',
        error: latestResult?.error || null,
      };
      session.message = `Completed ${session.completedTasks}/${session.totalTasks} tasks`;
      session.status = session.completedTasks >= session.totalTasks ? 'completed' : 'running';
      captureSessions.set(captureId, session);
    }

    if (session.cancelled) break;
    session.completedUrls += 1;
    session.queuedUrls = Math.max(session.totalUrls - session.completedUrls, 0);
    captureSessions.set(captureId, session);
  }

  const successCount = results.filter((item) => item.success).length;
  const failureCount = results.length - successCount;
  const failedUrlsSummary = getFailedUrlsSummary(results);
  session.currentTask = null;
  session.queuedUrls = session.cancelled ? 0 : session.queuedUrls;
  session.status = session.cancelled ? 'cancelled' : 'completed';
  session.message = session.cancelled
    ? 'Capture cancelled; queued URLs cleared.'
    : `${successCount} ${presetConfig.format === 'pdf' ? 'PDF' : 'screenshot'}(s) completed for ${presetConfig.name} preset, ${failureCount} failed.${failedUrlsSummary ? ` Failed URLs: ${failedUrlsSummary}.` : ''}`;
  session.outputDir = presetOutputDir;
  session.results = results.slice();
  captureSessions.set(captureId, session);
};

// Convert a URL into a safe filename.
const makeSafeFilename = (url) => {
  return String(url)
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, '')
    .replace(/[/?&=]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 200) || 'capture';
};

// Validate a URL and normalize it to a canonical string.
const validateUrl = (value) => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error();
    }
    return url.toString();
  } catch {
    throw new Error(`Invalid URL provided: ${value}`);
  }
};

const parseUrlList = (value) => {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 80000) {
    throw new Error('Enter a URL list no larger than 80,000 bytes.');
  }

  const entries = value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) {
    throw new Error('Enter at least one URL.');
  }
  if (entries.length > MAX_SITEMAP_URLS) {
    throw new Error(`The URL list cannot contain more than ${MAX_SITEMAP_URLS} URLs.`);
  }

  const urls = [...new Set(entries.map(validateUrl))];
  if (urls.length > MAX_SITEMAP_URLS) {
    throw new Error(`The URL list cannot contain more than ${MAX_SITEMAP_URLS} unique URLs.`);
  }
  return urls;
};

const decodeXmlEntities = (value) => value
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'");

const extractSitemapLocations = (xml) => {
  const rootTag = xml.match(/<(?:[\w.-]+:)?(sitemapindex|urlset)\b/i)?.[1]?.toLowerCase();
  if (!rootTag) {
    throw new Error('The sitemap response is not a valid sitemap index or URL set.');
  }

  return {
    isIndex: rootTag === 'sitemapindex',
    locations: [...xml.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/gi)]
      .map((match) => decodeXmlEntities(match[1].trim()))
      .filter(Boolean),
  };
};

const validateSitemapUrl = (value) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Enter a sitemap URL.');
  }
  if (value.length > 2048) {
    throw new Error('Enter a valid sitemap URL (maximum 2048 characters).');
  }

  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error();
    }
    return url.toString();
  } catch {
    throw new Error('Enter a valid HTTP or HTTPS sitemap URL.');
  }
};

const fetchSitemapUrls = async (sitemapUrl, fetchImpl = fetch) => {
  const normalizedSitemapUrl = validateSitemapUrl(sitemapUrl);
  const sitemapOrigin = new URL(normalizedSitemapUrl).origin;
  const visitedSitemaps = new Set();
  const pageUrls = new Set();

  const readSitemap = async (sitemapUrl) => {
    const normalizedSitemapUrl = new URL(sitemapUrl);
    if (normalizedSitemapUrl.origin !== sitemapOrigin) {
      throw new Error(`Sitemap URL is outside the configured site: ${sitemapUrl}`);
    }
    const normalizedUrl = normalizedSitemapUrl.toString();
    if (visitedSitemaps.has(normalizedUrl)) {
      return;
    }
    if (visitedSitemaps.size >= MAX_SITEMAPS) {
      throw new Error(`The sitemap index contains more than ${MAX_SITEMAPS} sitemaps.`);
    }
    visitedSitemaps.add(normalizedUrl);

    const response = await fetchImpl(normalizedUrl, {
      signal: AbortSignal.timeout(20000),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`Sitemap redirect is not allowed: ${normalizedUrl}`);
    }
    if (!response.ok) {
      throw new Error(`Unable to fetch sitemap (${response.status}): ${normalizedUrl}`);
    }
    if (response.url && new URL(response.url).origin !== sitemapOrigin) {
      throw new Error(`Sitemap response is outside the configured site: ${response.url}`);
    }
    const contentLength = Number(response.headers?.get('content-length') || 0);
    if (contentLength > MAX_SITEMAP_SIZE) {
      throw new Error(`Sitemap is larger than the ${MAX_SITEMAP_SIZE} byte limit: ${normalizedUrl}`);
    }
    const xml = await response.text();
    if (Buffer.byteLength(xml, 'utf8') > MAX_SITEMAP_SIZE) {
      throw new Error(`Sitemap is larger than the ${MAX_SITEMAP_SIZE} byte limit: ${normalizedUrl}`);
    }

    const { isIndex, locations } = extractSitemapLocations(xml);
    if (isIndex) {
      await Promise.all(locations.map(readSitemap));
      return;
    }

    for (const location of locations) {
      const pageUrl = validateUrl(location);
      pageUrls.add(pageUrl);
      if (pageUrls.size > MAX_SITEMAP_URLS) {
        throw new Error(`The sitemap contains more than ${MAX_SITEMAP_URLS} pages.`);
      }
    }
  };

  await readSitemap(normalizedSitemapUrl);
  if (pageUrls.size === 0) {
    throw new Error('The sitemap does not contain any page URLs.');
  }
  return [...pageUrls];
};

const SCREEN_SIZE_PRESETS = {
  wordpress: [375, 600, 768, 1025, 1200, 1600],
  webflow: [1025, 992, 767, 478],
  'desktop-only': [1025],
};

const captureWebsitePdf = async (url, outputPath, { width, delay, timeout, signal }) => {
  const browser = await puppeteer.launch({ headless: true });
  const viewportHeight = 1200;
  let timedOut = false;
  const onAbort = () => {
    void browser.close().catch((error) => {
      appendServerLog(`Unable to close PDF capture browser: ${error.message}`);
    });
  };

  signal?.addEventListener('abort', onAbort, { once: true });
  // Bound the entire capture, including sites that keep growing as we scroll.
  const deadline = setTimeout(() => {
    timedOut = true;
    onAbort();
  }, timeout * 1000);

  try {
    if (signal?.aborted) {
      throw new Error('Capture cancelled.');
    }

    const page = await browser.newPage();
    page.setDefaultTimeout(timeout * 1000);
    await page.setViewport({ width, height: viewportHeight, deviceScaleFactor: 1 });
    await page.emulateMediaType('screen');
    const response = await page.goto(url, {
      timeout: timeout * 1000,
      waitUntil: 'domcontentloaded',
    });
    if (response && !response.ok()) {
      throw new Error(`Unable to load page (${response.status()}): ${url}`);
    }
    const waitForIdle = async () => {
      try {
        await page.waitForNetworkIdle({ timeout: 5000 });
      } catch (error) {
        // Analytics and live widgets may never become idle.
        if (!(error instanceof puppeteer.TimeoutError)) throw error;
      }
    };
    await waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, delay * 1000));

    // Screen media alone does not remove @page rules or explicit pagination.
    await page.addStyleTag({ content: `
      html { scroll-behavior: auto !important; }
      *, *::before, *::after {
        page: auto !important;
        break-before: auto !important;
        break-after: auto !important;
        break-inside: auto !important;
      }
    ` });

    let pageHeight = await page.evaluate(() => Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    ));
    let scrollPosition = 0;

    while (scrollPosition < pageHeight) {
      if (signal?.aborted) {
        throw new Error('Capture cancelled.');
      }

      await page.evaluate((scrollBy) => window.scrollBy(0, scrollBy), viewportHeight);
      scrollPosition += viewportHeight;
      await waitForIdle();
      pageHeight = await page.evaluate(() => Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight
      ));
    }

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images, (image) => image.decode().catch(() => {})));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    // Chromium resolves vh/dvh against the paper height during printing, even
    // with screen media. Preserve the settled screen boxes before that reflow.
    // Read every box first so applying a size cannot affect later measurements.
    await page.evaluate(() => {
      const properties = ['height', 'min-height', 'max-height'];
      const snapshots = Array.from(document.querySelectorAll('*'))
        .filter((element) => element instanceof HTMLElement && element.getClientRects().length)
        .map((element) => {
          const style = getComputedStyle(element);
          return { element, sizes: properties.map((property) => [property, style.getPropertyValue(property)]) };
        });
      for (const { element, sizes } of snapshots) {
        for (const [property, value] of sizes) {
          if (/^-?[\d.]+px$/.test(value)) element.style.setProperty(property, value, 'important');
        }
      }
    });
    // Fonts, lazy images and scroll handlers can change the final layout.
    pageHeight = await page.evaluate(() => Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight
    ));
    // One extra CSS pixel avoids Chromium's fractional paper-size rounding.
    const paperHeight = Math.max(1, Math.ceil(pageHeight)) + 1;
    await page.addStyleTag({ content: `
      @page { size: ${width}px ${paperHeight}px !important; margin: 0 !important; }
    ` });
    const pdfBytes = await page.pdf({
      width: `${width}px`,
      height: `${paperHeight}px`,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: true,
      printBackground: true,
    });
    const pageCount = (Buffer.from(pdfBytes).toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
    if (pageCount !== 1) {
      throw new Error(`Expected one PDF page, but Chromium generated ${pageCount}. The site's layout could not fit on one page.`);
    }
    await fs.promises.writeFile(outputPath, pdfBytes);

    return { stdout: '', stderr: '' };
  } catch (error) {
    if (signal?.aborted) throw new Error('Capture cancelled.');
    if (timedOut) throw new Error(`PDF capture exceeded ${timeout} seconds: ${url}`);
    throw error;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', onAbort);
    await browser.close();
  }
};

const resolveCapturePreset = (value) => {
  const presetName = String(value || 'wordpress').trim().toLowerCase();
  const widths = SCREEN_SIZE_PRESETS[presetName];

  if (!widths) {
    throw new Error(`Unsupported capture preset: ${value}`);
  }

  return { name: presetName, widths };
};

const resolveCaptureConfig = (formatValue, presetValue) => {
  const format = String(formatValue || 'jpeg').trim().toLowerCase();
  if (format === 'pdf') {
    return { name: 'pdf', format, widths: [2000] };
  }
  if (format !== 'jpeg') {
    throw new Error(`Unsupported capture format: ${formatValue}`);
  }
  return { ...resolveCapturePreset(presetValue), format };
};

// Resolve the output directory under the user's Desktop.
const resolveOutputDirectory = (name) => {
  const trimmedName = String(name).trim() || 'screenshots';

  if (path.isAbsolute(trimmedName) || trimmedName.includes('..')) {
    throw new Error('Invalid output directory name. Use a relative folder name only.');
  }

  const outputDirPath = path.resolve(desktopRoot, trimmedName);
  if (!outputDirPath.startsWith(desktopRoot + path.sep) && outputDirPath !== desktopRoot) {
    throw new Error('Invalid output directory path. Output must be inside your Desktop folder.');
  }

  return outputDirPath;
};

// Run capture-website with the desired arguments and return stdout/stderr.
const captureWebsite = (url, outputPath, options = {}) => {
  const args = ['--no-install', 'capture-website', url, '--output', outputPath];

  if (options.fullPage) {
    args.push('--full-page');
  }

  if (options.type) {
    args.push('--type', options.type);
  }

  if (typeof options.width === 'number') {
    args.push('--width', String(options.width));
  }

  if (typeof options.height === 'number') {
    args.push('--height', String(options.height));
  }

  if (typeof options.delay === 'number') {
    args.push('--delay', String(options.delay));
  }

  if (options.emulateDevice) {
    args.push('--emulate-device', options.emulateDevice);
  }

  if (options.preloadLazyContent) {
    args.push('--preload-lazy-content');
  }

  if (options.overwrite) {
    args.push('--overwrite');
  }

  if (typeof options.timeout === 'number') {
    args.push('--timeout', String(options.timeout));
  }

  if (options.waitForNetworkIdle) {
    args.push('--wait-for-network-idle');
  }

  if (options.quality != null) {
    args.push('--quality', String(options.quality));
  }

  return new Promise((resolve, reject) => {
    execFile('npx', args, { shell: false, signal: options.signal }, (error, stdout, stderr) => {
      if (error) {
        reject({ error, stdout: stdout.trim(), stderr: stderr.trim() });
        return;
      }

      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
};

app.post('/capture', async (req, res) => {
  const requestedCaptureId = String(req.body?.captureId ?? '').trim();
  if (requestedCaptureId && !/^[a-zA-Z0-9_-]{1,128}$/.test(requestedCaptureId)) {
    return res.status(400).json({ error: 'Invalid capture ID.' });
  }
  if (requestedCaptureId && consumeCancelledCaptureRequest(requestedCaptureId)) {
    return res.status(410).json({ error: 'Capture request cancelled.' });
  }
  if (requestedCaptureId && captureSessions.has(requestedCaptureId)) {
    return res.status(409).json({ error: 'Capture ID is already in use.' });
  }

  const outputDirName = String(req.body?.outputDir ?? '').trim();
  const capturePresetInput = String(req.body?.capturePreset || 'wordpress').trim();
  const captureFormatInput = String(req.body?.captureFormat || 'jpeg').trim();
  const sourceType = String(req.body?.sourceType || 'sitemap');

  let outputDirPath;
  try {
    outputDirPath = resolveOutputDirectory(outputDirName);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  let presetConfig;
  try {
    presetConfig = resolveCaptureConfig(captureFormatInput, capturePresetInput);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  let validatedUrls;
  if (sourceType === 'urls') {
    try {
      validatedUrls = parseUrlList(req.body?.urlList);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  } else if (sourceType === 'sitemap') {
    let sitemapUrl;
    try {
      sitemapUrl = validateSitemapUrl(String(req.body?.sitemapUrl ?? '').trim());
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    try {
      validatedUrls = await fetchSitemapUrls(sitemapUrl);
    } catch (error) {
      appendServerLog(`Sitemap fetch failed: ${error.message}`);
      return res.status(502).json({ error: `Unable to load pages from the site sitemap: ${error.message}` });
    }
  } else {
    return res.status(400).json({ error: 'Choose either sitemap or URL list as the page source.' });
  }

  const presetOutputDir = path.join(outputDirPath, presetConfig.name);
  const logsDir = path.join(presetOutputDir, 'logs');

  try {
    await fs.promises.mkdir(presetOutputDir, { recursive: true });
    await fs.promises.mkdir(logsDir, { recursive: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  if (requestedCaptureId && consumeCancelledCaptureRequest(requestedCaptureId)) {
    return res.status(410).json({ error: 'Capture request cancelled.' });
  }

  const captureId = requestedCaptureId || `capture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const session = {
    id: captureId,
    status: 'queued',
    totalTasks: validatedUrls.length * presetConfig.widths.length,
    completedTasks: 0,
    totalUrls: validatedUrls.length,
    completedUrls: 0,
    queuedUrls: validatedUrls.length,
    currentTask: null,
    results: [],
    message: 'Queued',
    outputDir: presetOutputDir,
    capturePreset: presetConfig.name,
    captureFormat: presetConfig.format,
    widths: presetConfig.widths,
    cancelled: false,
    abortController: new AbortController(),
  };
  captureSessions.set(captureId, session);

  res.json(getCaptureSessionPayload(session));

  void (async () => {
    try {
      await runCaptureSession(captureId, {
        urls: validatedUrls,
        presetConfig,
        presetOutputDir,
        logsDir,
      });
    } catch (error) {
      const currentSession = captureSessions.get(captureId);
      if (currentSession && !currentSession.cancelled) {
        currentSession.status = 'failed';
        currentSession.message = error.message || 'Capture failed';
        currentSession.currentTask = null;
        captureSessions.set(captureId, currentSession);
      }
    }
  })();
});

app.post('/capture/cancel', (req, res) => {
  const captureId = String(req.body?.captureId ?? '').trim();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(captureId)) {
    return res.status(400).json({ error: 'Invalid capture ID.' });
  }

  const session = captureSessions.get(captureId);
  if (!session) {
    markCaptureRequestCancelled(captureId);
    return res.status(202).json({ status: 'cancellation-requested' });
  }

  cancelCaptureSession(session);
  return res.json(getCaptureSessionPayload(session));
});

app.get('/capture/status/:captureId', (req, res) => {
  const session = captureSessions.get(req.params.captureId);

  if (!session) {
    return res.status(404).json({ error: 'Capture session not found.' });
  }

  return res.json(getCaptureSessionPayload(session));
});

let server;

const shutdown = () => {
  appendServerLog('Shutting down server');
  if (server) {
    server.close(() => {
      logStream.end(() => process.exit(0));
    });
  } else {
    logStream.end(() => process.exit(0));
  }
};

if (require.main === module) {
  server = app.listen(port, () => {
    console.log('Capture UI starting...');
    console.log(`Active port: ${port}`);
    console.log(`Open http://localhost:${port} in your browser`);
    console.log('Use PORT=<port> npm start to run on a different port.');
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Use a different port or stop the process currently listening on :${port}.`);
      console.error('Example: PORT=3002 npm start');
      process.exit(1);
    }

    throw error;
  });

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {
  formatCaptureFailureMessage,
  getFailedUrlsSummary,
  extractSitemapLocations,
  fetchSitemapUrls,
  validateSitemapUrl,
  parseUrlList,
  resolveCaptureConfig,
  captureWebsitePdf,
  cancelCaptureSession,
};
