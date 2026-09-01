import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const testRunner = path.join(__dirname, 'out', 'test', 'index.js');

spawn(process.execPath, [testRunner], {
  stdio: 'inherit',
  env: {
    ...process.env,
    TEST_RUNNER: '1',
  },
});
