import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { TOUCH_ICON } from './scripts/files.mjs';
// Optional desktop-only preview of the exact Pages artifact. Never bind to LAN.
const root = resolve('dist');
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
http.createServer(async (req,res)=>{
  try {
    const path = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
    const contentType = file === resolve(root, TOUCH_ICON) ? 'image/png' : mime[extname(file)];
    if (!file.startsWith(root + sep) || typeof contentType !== 'string') {res.writeHead(404);res.end();return;}
    const body = await readFile(file);
    res.writeHead(200,{'Content-Type':contentType,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(body);
  } catch {res.writeHead(404);res.end('Not found');}
}).listen(4173,'127.0.0.1',()=>console.log('マイスケジュール（PC内のみ）: http://127.0.0.1:4173 — build first: node scripts/build.mjs'));
