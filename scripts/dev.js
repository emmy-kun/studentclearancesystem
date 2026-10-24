// Starts the API (server, :4000) and the website (client, :5173) together.
// Run from clearance-system:  npm run dev    (Ctrl+C stops both)
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const parts = [
  { name: 'api', dir: 'server', color: '\x1b[36m' },
  { name: 'web', dir: 'client', color: '\x1b[35m' },
];

const children = parts.map(({ name, dir, color }) => {
  // shell: true lets Windows find npm.cmd
  const child = spawn('npm run dev', { cwd: path.join(root, dir), shell: true });
  const prefix = `${color}[${name}]\x1b[0m `;
  const relay = (stream, out) => {
    let buffered = '';
    stream.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop();
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);
  child.on('exit', (code) => {
    process.stdout.write(`${prefix}stopped${code ? ` (exit code ${code})` : ''}\n`);
  });
  return child;
});

console.log('Starting... open http://localhost:5173 once both are ready. Press Ctrl+C to stop.');

function stopAll() {
  for (const child of children) if (!child.killed) child.kill();
  process.exit(0);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
