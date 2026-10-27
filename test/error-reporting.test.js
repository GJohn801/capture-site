const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  formatCaptureFailureMessage,
  getFailedUrlsSummary,
  fetchSitemapUrls,
  validateSitemapUrl,
  parseUrlList,
  resolveCaptureConfig,
  captureWebsitePdf,
  cancelCaptureSession,
} = require('../server');

test('appends the failing URL to Failed to fetch errors', () => {
  assert.equal(
    formatCaptureFailureMessage('Failed to fetch', 'https://example.com'),
    'Failed to fetch for https://example.com'
  );
});

test('builds a readable list of failed URLs from capture results', () => {
  const results = [
    { success: false, url: 'https://one.example' },
    { success: true, url: 'https://two.example' },
    { success: false, url: 'https://one.example' },
    { success: false, url: 'https://three.example' },
  ];

  assert.equal(getFailedUrlsSummary(results), 'https://one.example, https://three.example');
});

test('reads and deduplicates page URLs from a sitemap index', async () => {
  const sitemapDocuments = new Map([
    ['https://www.example.com/sitemap_index.xml', `
      <sitemapindex>
        <sitemap><loc>https://www.example.com/pages.xml</loc></sitemap>
        <sitemap><loc>https://www.example.com/posts.xml</loc></sitemap>
      </sitemapindex>
    `],
    ['https://www.example.com/pages.xml', `
      <urlset>
        <url><loc>https://www.example.com/about/</loc></url>
        <url><loc>https://www.example.com/search/?a=1&amp;b=2</loc></url>
      </urlset>
    `],
    ['https://www.example.com/posts.xml', `
      <urlset>
        <url><loc>https://www.example.com/about/</loc></url>
      </urlset>
    `],
  ]);
  const urls = await fetchSitemapUrls('https://www.example.com/sitemap_index.xml', async (url) => ({
    ok: true,
    status: 200,
    url,
    headers: { get: () => null },
    text: async () => sitemapDocuments.get(url),
  }));

  assert.deepEqual(urls.sort(), [
    'https://www.example.com/about/',
    'https://www.example.com/search/?a=1&b=2',
  ]);
});

test('rejects sitemap-index entries outside the configured site', async () => {
  await assert.rejects(
    fetchSitemapUrls('https://www.example.com/sitemap_index.xml', async (url) => ({
      ok: true,
      status: 200,
      url,
      headers: { get: () => null },
      text: async () => '<sitemapindex><sitemap><loc>https://other.example/sitemap.xml</loc></sitemap></sitemapindex>',
    })),
    /outside the configured site/
  );
});

test('rejects sitemap redirects', async () => {
  await assert.rejects(
    fetchSitemapUrls('https://www.example.com/sitemap_index.xml', async (url) => ({
      ok: false,
      status: 302,
      url,
      headers: { get: () => null },
      text: async () => '',
    })),
    /redirect is not allowed/
  );
});

test('loads pages from a user-provided sitemap URL', async () => {
  const sitemapUrl = 'https://www.example.com/custom-sitemap.xml';
  const requestedUrls = [];
  const urls = await fetchSitemapUrls(sitemapUrl, async (url) => {
    requestedUrls.push(url);
    return {
      ok: true,
      status: 200,
      url,
      headers: { get: () => null },
      text: async () => '<urlset><url><loc>https://www.example.com/custom-page/</loc></url></urlset>',
    };
  });

  assert.deepEqual(requestedUrls, [sitemapUrl]);
  assert.deepEqual(urls, ['https://www.example.com/custom-page/']);
});

test('validates custom sitemap URLs as HTTP or HTTPS URLs without credentials', () => {
  assert.throws(() => validateSitemapUrl(''), /Enter a sitemap URL/);
  assert.throws(() => validateSitemapUrl('file:///etc/passwd'), /valid HTTP or HTTPS sitemap URL/);
  assert.throws(() => validateSitemapUrl('https://user:pass@example.com/sitemap.xml'), /valid HTTP or HTTPS sitemap URL/);
  assert.equal(
    validateSitemapUrl('https://www.example.com/sitemap.xml'),
    'https://www.example.com/sitemap.xml'
  );
});

test('parses, normalizes, and deduplicates a newline-separated URL list', () => {
  assert.deepEqual(
    parseUrlList(' https://example.com \n\nhttps://example.com/about\nhttps://example.com/ '),
    ['https://example.com/', 'https://example.com/about']
  );
});

test('rejects empty and invalid URL lists', () => {
  assert.throws(() => parseUrlList(' \n '), /at least one URL/);
  assert.throws(() => parseUrlList('https://example.com\nfile:///etc/passwd'), /Invalid URL provided/);
});

test('resolves PDF exports to one 2000px full-page capture per URL', () => {
  assert.deepEqual(resolveCaptureConfig('pdf', 'wordpress'), {
    name: 'pdf',
    format: 'pdf',
    widths: [2000],
  });
});

test('exports a tall native PDF as one page with selectable text', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-site-pdf-test-'));
  const outputPath = path.join(tempDir, 'selectable-text.pdf');
  const html = '<style>html,body{margin:0}body{height:8000px}h1{position:absolute;top:7900px}</style><h1>Selectable text</h1>';

  try {
    await captureWebsitePdf(
      `data:text/html,${encodeURIComponent(html)}`,
      outputPath,
      { width: 800, delay: 0, timeout: 15 }
    );
    const pdf = (await fs.readFile(outputPath)).toString('latin1');

    assert.equal((pdf.match(/\/Type\s*\/Page\b/g) || []).length, 1);
    const mediaBox = pdf.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/);
    assert.equal(Number(mediaBox[1]), 600);
    assert.ok(Number(mediaBox[2]) >= 6000 && Number(mediaBox[2]) < 6002);
    assert.match(pdf, /\/Font\b/);
    assert.doesNotMatch(pdf, /\/Subtype\s*\/Image\b/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('preserves the selected responsive preset for JPEG screenshots', () => {
  assert.deepEqual(resolveCaptureConfig('jpeg', 'desktop-only'), {
    name: 'desktop-only',
    format: 'jpeg',
    widths: [1025],
  });
  assert.throws(() => resolveCaptureConfig('svg', 'wordpress'), /Unsupported capture format/);
});

test('cancels a running capture and clears its queued URLs', () => {
  let aborted = false;
  const session = {
    status: 'running',
    queuedUrls: 7,
    currentTask: { url: 'https://example.com', status: 'running' },
    abortController: { abort: () => { aborted = true; } },
  };

  assert.equal(cancelCaptureSession(session), true);
  assert.equal(aborted, true);
  assert.equal(session.status, 'cancelled');
  assert.equal(session.queuedUrls, 0);
  assert.equal(session.currentTask, null);
  assert.match(session.message, /queued URLs cleared/);
});

test('does not change a completed capture when cancellation is requested', () => {
  const session = { status: 'completed', queuedUrls: 0 };

  assert.equal(cancelCaptureSession(session), false);
  assert.equal(session.status, 'completed');
});
