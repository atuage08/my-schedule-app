import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { protectedSource } from './secure-source.mjs';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_FILES = ['index.html', 'styles.css', 'src/app.js', 'src/model.js', 'src/time-controls.js', 'src/dom.js', 'src/backup.js', 'src/storage.js', 'src/backup-ui.js', 'src/upgrade-notice.js'];
const ROOT_FILES = ['.gitignore', 'package.json', 'index.html', 'styles.css', 'server.mjs', 'README.md'];
const SOURCE_DIRS = { src: ['.js'], scripts: ['.mjs', '.ps1'], test: ['.js'], docs: ['.md'], '.github/workflows': ['.yml'] };

// Reject links/junctions as well as paths outside this checkout, including parent links.
export async function readSource(root, name) {
  return protectedSource(root,name);
}

export async function reviewFiles(root = PROJECT_ROOT) {
  const files = [...ROOT_FILES];
  let visited=0;
  for (const [directory, extensions] of Object.entries(SOURCE_DIRS)) {
    async function walk(name) {
      for (const entry of await protectedSource(root,name,{listing:true})) {
        if(++visited>4096)throw Error('Too many source entries');
        const path = `${name}/${entry.name}`;
        if (entry.kind==='link') throw Error(`Links are not allowed: ${path}`);
        // Images, data files, generated files, hidden directories and credentials are excluded.
        if (entry.kind==='directory' && !entry.name.startsWith('.') && !['node_modules', 'dist', 'artifacts'].includes(entry.name)) await walk(path);
        else if (entry.kind==='file' && !entry.name.startsWith('.') && extensions.some(ext => entry.name.endsWith(ext))) files.push(path);
      }
    }
    await walk(directory);
  }
  for (const name of files) await readSource(root, name);
  return files.sort();
}
