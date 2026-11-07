import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PUBLIC_FILES = ['index.html', 'styles.css', 'src/app.js', 'src/model.js', 'src/time-controls.js'];
const ROOT_FILES = ['.gitignore', 'package.json', 'index.html', 'styles.css', 'server.mjs', 'README.md'];
const SOURCE_DIRS = { src: ['.js'], scripts: ['.mjs', '.ps1'], test: ['.js'], docs: ['.md'], '.github/workflows': ['.yml'] };

// Reject links/junctions as well as paths outside this checkout, including parent links.
export async function readSource(root, name) {
  root = await realpath(root);
  const path = resolve(root, name);
  if (!path.startsWith(root + sep)) throw Error('Source path escapes the project');
  for (const segment of relative(root, path).split(sep)) {
    // Components are inspected below using their growing absolute path.
    if (!segment || segment === '..') throw Error('Invalid source path');
  }
  let current = root;
  for (const segment of relative(root, path).split(sep)) {
    current = join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw Error(`Links are not allowed: ${name}`);
  }
  if (!(await lstat(path)).isFile()) throw Error(`Not a source file: ${name}`);
  return readFile(path);
}

export async function reviewFiles(root = PROJECT_ROOT) {
  const files = [...ROOT_FILES];
  for (const [directory, extensions] of Object.entries(SOURCE_DIRS)) {
    async function walk(name) {
      for (const entry of await readdir(join(root, name), { withFileTypes: true })) {
        const path = `${name}/${entry.name}`;
        if (entry.isSymbolicLink()) throw Error(`Links are not allowed: ${path}`);
        // Images, data files, generated files, hidden directories and credentials are excluded.
        if (entry.isDirectory() && !entry.name.startsWith('.') && !['node_modules', 'dist', 'artifacts'].includes(entry.name)) await walk(path);
        else if (entry.isFile() && !entry.name.startsWith('.') && extensions.some(ext => entry.name.endsWith(ext))) files.push(path);
      }
    }
    await walk(directory);
  }
  for (const name of files) await readSource(root, name);
  return files.sort();
}
