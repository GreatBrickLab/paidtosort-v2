// Builds the static, local Scalar docs page from the generated contract and serves it on 127.0.0.1:4796.
import { copyFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
mkdirSync('docs/vendor', { recursive: true });
copyFileSync('node_modules/@scalar/api-reference/dist/browser/standalone.js', 'docs/vendor/scalar.js');
copyFileSync('contract/openapi.yaml', 'docs/openapi.yaml');
if (process.argv.includes('--build')) { console.log('docs built in docs/'); process.exit(0); }
const types = { '.html': 'text/html', '.js': 'text/javascript', '.yaml': 'application/yaml' };
createServer((req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  const file = join('docs', p || 'index.html');
  if (!file.startsWith('docs') || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }); res.end(readFileSync(file));
}).listen(4796, '127.0.0.1', () => console.log('docs: http://127.0.0.1:4796/'));
