const test = require('node:test');
const assert = require('node:assert/strict');
const { formatCaptureFailureMessage, getFailedUrlsSummary } = require('../server');

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
