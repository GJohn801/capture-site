const express = require('express');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const port = Number(process.env.PORT) || 3000;
const cwd = process.cwd();
const desktopRoot = path.join(os.homedir(), 'Desktop');
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

const captureSessions = new Map();

const getCaptureSessionPayload = (session) => ({
  captureId: session.id,
  status: session.status,
  totalTasks: session.totalTasks,
  completedTasks: session.completedTasks,
  currentTask: session.currentTask,
  message: session.message,
  outputDir: session.outputDir,
  capturePreset: session.capturePreset,
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
    const safeBase = makeSafeFilename(url);

    for (const width of presetConfig.widths) {
      const outputFileName = `${safeBase}-${presetConfig.name}-${width}px.jpg`;
      const outputPath = path.join(presetOutputDir, outputFileName);
      const outLog = path.join(logsDir, `${safeBase}-${presetConfig.name}-${width}px.out.log`);
      const errLog = path.join(logsDir, `${safeBase}-${presetConfig.name}-${width}px.err.log`);

      session.currentTask = { url, width, output: outputPath, status: 'running' };
      captureSessions.set(captureId, session);

      try {
        const captureOptions = {
          fullPage: true,
          type: 'jpeg',
          delay: 5,
          width,
          preloadLazyContent: true,
          overwrite: true,
          timeout: 120,
          waitForNetworkIdle: true,
        };

        const result = await captureWebsite(url, outputPath, captureOptions);

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
          capturePreset: presetConfig.name,
          stdout: result.stdout,
          stderr: result.stderr,
          outLog,
          errLog,
        };

        results.push(resultItem);
        session.results = results.slice();
      } catch ({ error, stdout, stderr }) {
        const message = error?.message || 'Capture failed';
        await fs.promises.appendFile(errLog, `${message}\n${stdout || ''}\n${stderr || ''}\n`);

        const resultItem = {
          url,
          width,
          output: outputPath,
          success: false,
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
  }

  const successCount = results.filter((item) => item.success).length;
  const failureCount = results.length - successCount;
  session.currentTask = null;
  session.status = 'completed';
  session.message = `${successCount} screenshot(s) completed for ${presetConfig.name} preset, ${failureCount} failed.`;
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
    return new URL(value).toString();
  } catch {
    throw new Error(`Invalid URL provided: ${value}`);
  }
};

const SCREEN_SIZE_PRESETS = {
  wordpress: [375, 600, 768, 1025, 1200, 1600],
  webflow: [1025, 992, 767, 478],
};

const resolveCapturePreset = (value) => {
  const presetName = String(value || 'wordpress').trim().toLowerCase();
  const widths = SCREEN_SIZE_PRESETS[presetName];

  if (!widths) {
    throw new Error(`Unsupported capture preset: ${value}`);
  }

  return { name: presetName, widths };
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
  const urlListRaw = String(req.body?.urls || '').trim();
  const outputDirName = String(req.body?.outputDir ?? '').trim();
  const capturePresetInput = String(req.body?.capturePreset || 'wordpress').trim();

  let outputDirPath;
  try {
    outputDirPath = resolveOutputDirectory(outputDirName);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  let presetConfig;
  try {
    presetConfig = resolveCapturePreset(capturePresetInput);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const urls = urlListRaw
    ? urlListRaw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];

  if (urls.length === 0) {
    return res.status(400).json({ error: 'Enter at least one URL in the URL list.' });
  }

  const validatedUrls = [];
  for (const rawUrl of urls) {
    try {
      validatedUrls.push(validateUrl(rawUrl));
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  }

  const presetOutputDir = path.join(outputDirPath, presetConfig.name);
  const logsDir = path.join(presetOutputDir, 'logs');

  try {
    await fs.promises.mkdir(presetOutputDir, { recursive: true });
    await fs.promises.mkdir(logsDir, { recursive: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  const captureId = `capture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const session = {
    id: captureId,
    status: 'queued',
    totalTasks: validatedUrls.length * presetConfig.widths.length,
    completedTasks: 0,
    currentTask: null,
    results: [],
    message: 'Queued',
    outputDir: presetOutputDir,
    capturePreset: presetConfig.name,
    widths: presetConfig.widths,
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
      if (currentSession) {
        currentSession.status = 'failed';
        currentSession.message = error.message || 'Capture failed';
        currentSession.currentTask = null;
        captureSessions.set(captureId, currentSession);
      }
    }
  })();
});

app.get('/capture/status/:captureId', (req, res) => {
  const session = captureSessions.get(req.params.captureId);

  if (!session) {
    return res.status(404).json({ error: 'Capture session not found.' });
  }

  return res.json(getCaptureSessionPayload(session));
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
