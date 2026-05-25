const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const port = Number(process.env.PORT) || 3000;
const cwd = process.cwd();
const serverLogPath = path.join(cwd, 'server.log');

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
    return new URL(value).toString();
  } catch {
    throw new Error(`Invalid URL provided: ${value}`);
  }
};

// Resolve the output directory inside the project folder.
const resolveOutputDirectory = (name) => {
  const trimmedName = String(name).trim() || 'screenshots';

  if (path.isAbsolute(trimmedName) || trimmedName.includes('..')) {
    throw new Error('Invalid output directory name. Use a relative folder name only.');
  }

  const outputDirPath = path.resolve(cwd, trimmedName);
  if (!outputDirPath.startsWith(cwd + path.sep) && outputDirPath !== cwd) {
    throw new Error('Invalid output directory path. Output must be inside the project folder.');
  }

  return outputDirPath;
};

// Run capture-website with the desired arguments and return stdout/stderr.
const captureWebsite = (url, outputPath, options = {}) => {
  const args = ['capture-website', url, '--output', outputPath];

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
    execFile('npx', args, { shell: false }, (error, stdout, stderr) => {
      if (error) {
        reject({ error, stdout: stdout.trim(), stderr: stderr.trim() });
        return;
      }

      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
};

app.post('/capture', async (req, res) => {
  // Parse the request body.
  const singleUrl = String(req.body?.url || '').trim();
  const urlListRaw = String(req.body?.urls || '').trim();
  const outputDirName = String(req.body?.outputDir ?? '').trim();
  const captureMode = String(req.body?.captureMode || 'desktop').trim().toLowerCase();

  let outputDirPath;
  try {
    outputDirPath = resolveOutputDirectory(outputDirName);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  if (!['desktop', 'mobile'].includes(captureMode)) {
    return res.status(400).json({ error: 'captureMode must be either "desktop" or "mobile".' });
  }

  const urls = urlListRaw
    ? urlListRaw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : singleUrl
      ? [singleUrl]
      : [];

  if (urls.length === 0) {
    return res.status(400).json({ error: 'Enter at least one URL in the single URL field or URL list.' });
  }

  const validatedUrls = [];
  for (const rawUrl of urls) {
    try {
      validatedUrls.push(validateUrl(rawUrl));
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  }

  // Ensure the output directory exists before running any captures.
  await fs.promises.mkdir(outputDirPath, { recursive: true });
  const logsDir = path.join(outputDirPath, 'logs');
  await fs.promises.mkdir(logsDir, { recursive: true });

  const results = [];
  for (const url of validatedUrls) {
    const safeBase = makeSafeFilename(url);
    const filenameSuffix = captureMode === 'mobile' ? '-mobile' : '';
    const outputPath = path.join(outputDirPath, `${safeBase}${filenameSuffix}.jpg`);
    const outLog = path.join(logsDir, `${safeBase}${filenameSuffix}.out.log`);
    const errLog = path.join(logsDir, `${safeBase}${filenameSuffix}.err.log`);

    try {
      const captureOptions = {
        fullPage: true,
        type: 'jpeg',
        delay: 5,
        preloadLazyContent: true,
        overwrite: true,
        timeout: 120,
        waitForNetworkIdle: true,
      };

      if (captureMode === 'mobile') {
        captureOptions.width = 375;
        captureOptions.emulateDevice = 'iPhone X';
      }

      const result = await captureWebsite(url, outputPath, captureOptions);

      if (result.stdout) {
        await fs.promises.appendFile(outLog, result.stdout + '\n');
      }
      if (result.stderr) {
        await fs.promises.appendFile(errLog, result.stderr + '\n');
      }

      results.push({
        url,
        output: outputPath,
        success: true,
        captureMode,
        stdout: result.stdout,
        stderr: result.stderr,
        outLog,
        errLog,
      });
    } catch ({ error, stdout, stderr }) {
      const message = error?.message || 'Capture failed';
      await fs.promises.appendFile(errLog, `${message}\n${stdout || ''}\n${stderr || ''}\n`);

      results.push({
        url,
        output: outputPath,
        success: false,
        captureMode,
        error: message,
        stdout,
        stderr,
        outLog,
        errLog,
      });
    }
  }

  const successCount = results.filter((item) => item.success).length;
  const failureCount = results.length - successCount;

  return res.json({
    message: `${successCount} capture(s) completed, ${failureCount} failed.`,
    captureMode,
    outputDir: outputDirPath,
    results,
  });
});

const server = app.listen(port, () => {
  console.log('Capture UI starting...');
  console.log(`Active port: ${port}`);
  console.log(`Open http://localhost:${port} in your browser`);
  console.log('Use PORT=<port> npm start to run on a different port.');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Use a different port or stop the process currently listening on :${port}.`);
    console.error('Example: PORT=3001 npm start');
    process.exit(1);
  }

  throw error;
});

const shutdown = () => {
  appendServerLog('Shutting down server');
  server.close(() => {
    logStream.end(() => process.exit(0));
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
