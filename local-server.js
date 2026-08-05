// Minimal local dev server: stdlib only, no deps, no netlify-cli.
// Serves static files from this folder and proxies POST /.netlify/functions/<name>
// to the matching netlify/functions/<name>.js handler. Run: node local-server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const FUNCTIONS_DIR = path.join(ROOT, 'netlify', 'functions');
const PORT = 8888;

for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  if (urlPath.startsWith('/.netlify/functions/')) {
    const fnName = urlPath.replace('/.netlify/functions/', '');
    const fnPath = path.join(FUNCTIONS_DIR, fnName + '.js');
    if (!fs.existsSync(fnPath)) {
      res.writeHead(404).end('Function not found: ' + fnName);
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        delete require.cache[require.resolve(fnPath)];
        const { handler } = require(fnPath);
        const result = await handler({ httpMethod: req.method, headers: req.headers, body });
        res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
        res.end(result.body);
      } catch (e) {
        res.writeHead(500).end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  let filePath = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404).end('Not found: ' + urlPath); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`local dev server: http://localhost:${PORT}/`));
