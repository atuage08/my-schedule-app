import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = resolve('.');
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
http.createServer(async (req,res)=>{
  try {
    const path = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
    if (!file.startsWith(root + sep) || !['.html','.css','.js'].includes(extname(file))) {res.writeHead(404);res.end();return;}
    const body = await readFile(file);
    res.writeHead(200,{'Content-Type':mime[extname(file)],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(body);
  } catch {res.writeHead(404);res.end('Not found');}
}).listen(4173,'0.0.0.0',()=>console.log('マイスケジュール: http://localhost:4173 (LAN: port 4173)'));
