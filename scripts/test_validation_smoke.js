/**
 * Smoke-test: validation script exits successfully on current data.
 * Run: node scripts/test_validation_smoke.js
 */
const { execSync } = require('child_process');

try {
  execSync('npm run validate', { stdio: 'pipe' });
  console.log('test_validation_smoke: OK');
} catch (e) {
  console.error('test_validation_smoke: FAILED\n', e.stdout?.toString() || e.message);
  process.exit(1);
}