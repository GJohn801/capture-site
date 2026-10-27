const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { captureWebsitePdf } = require('../server');

test('preserves screen viewport heights instead of expanding them to the PDF paper height', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-viewport-'));
  try {
    const output = path.join(dir, 'viewport.pdf');
    const html = `<style>
      html, body { margin: 0; }
      header { height: 100vh; min-height: 100dvh; }
      main { height: 2000px; }
    </style><header>Top selectable text</header><main>Bottom selectable text</main>`;
    await captureWebsitePdf(`data:text/html,${encodeURIComponent(html)}`, output,
      { width: 800, delay: 0, timeout: 20 });
    const pdf = (await fs.readFile(output)).toString('latin1');
    assert.equal((pdf.match(/\/Type\s*\/Page\b/g) || []).length, 1);
    const height = Number(pdf.match(/\/MediaBox\s*\[0 0 600 ([\d.]+)/)[1]);
    assert.ok(height >= 2400 && height < 2402, `Expected 3200 CSS pixels, got ${height} PDF points`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ignores website paper sizes, margins, named pages and forced page breaks', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-layout-'));
  try {
    const output = path.join(dir, 'layout.pdf');
    const html = `<style>
      @page { size: letter; margin: 1in; }
      @page chapter { size: A4; margin: 2in; }
      html, body { margin: 0; }
      section { height: 1300px; break-after: page; page: chapter; }
    </style><section>Top selectable text</section><section>Bottom selectable text</section>`;
    await captureWebsitePdf(`data:text/html,${encodeURIComponent(html)}`, output,
      { width: 800, delay: 0, timeout: 20 });
    const pdf = (await fs.readFile(output)).toString('latin1');
    assert.equal((pdf.match(/\/Type\s*\/Page\b/g) || []).length, 1);
    assert.match(pdf, /\/MediaBox\s*\[0 0 600 /);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('reports HTTP errors instead of saving an error page as a successful PDF', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<h1>Missing page</h1>');
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-http-'));
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const output = path.join(dir, 'missing.pdf');
    await assert.rejects(captureWebsitePdf(
      `http://127.0.0.1:${server.address().port}/missing`, output,
      { width: 800, delay: 0, timeout: 20 }
    ), /Unable to load page \(404\)/);
    await assert.rejects(fs.access(output), { code: 'ENOENT' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('bounds capture time even when a site keeps adding content on scroll', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'capture-growing-'));
  try {
    const html = `<style>body{height:4000px}</style><script>
      addEventListener('scroll', () => {
        document.body.style.height = (document.body.scrollHeight + 4000) + 'px';
      });
    </script><p>Infinite scrolling</p>`;
    await assert.rejects(captureWebsitePdf(
      `data:text/html,${encodeURIComponent(html)}`, path.join(dir, 'growing.pdf'),
      { width: 800, delay: 0, timeout: 3 }
    ), /PDF capture exceeded 3 seconds/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
