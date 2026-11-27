import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { buildSite } from '../scripts/build.mjs';
import { PROJECT_ROOT, PUBLIC_FILES, TOUCH_ICON, readSource, reviewFiles } from '../scripts/files.mjs';
import { screenText } from '../scripts/check.mjs';

async function fixture(t, files = PUBLIC_FILES) {
  const root = await mkdtemp(join(tmpdir(), 'my-schedule-build-'));
  // Only this test's verified temporary directory is cleaned up.
  t.after(() => {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('my-schedule-build-')) throw Error('Unexpected test cleanup path');
    return rm(root, { recursive: true, force: true });
  });
  for (const name of new Set(['package.json', ...files])) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), await readSource(PROJECT_ROOT, name));
  }
  return root;
}

async function walk(root, prefix = '') {
  const names = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) names.push(...await walk(join(root, entry.name), prefix + entry.name + '/'));
    else names.push(prefix + entry.name);
  }
  return names.sort();
}

test('Pages build emits only browser assets and nojekyll; copied bytes match source', async t => {
  const root = await fixture(t);
  const output = await buildSite(root);
  assert.deepEqual(await walk(output), [...PUBLIC_FILES, '.nojekyll'].sort());
  for (const file of PUBLIC_FILES) assert.deepEqual(await readFile(join(output, file)), await readSource(PROJECT_ROOT, file));
});

test('all HTML and module references resolve under both root and repository Pages paths', async t => {
  const output = await buildSite(await fixture(t));
  const html = await readFile(join(output, 'index.html'), 'utf8');
  assert.ok(!/<base\b/i.test(html), 'must not override relative resolution');
  const links = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]);
  for (const base of ['https://example.invalid/', 'https://example.invalid/my-schedule-app/']) {
    const seen = new Set();
    async function verify(file, url) {
      assert.ok(url.href.startsWith(base), `${file} escapes the project path`);
      assert.equal(url.search, '');
      assert.equal(url.hash, '');
      const path = decodeURIComponent(url.href.slice(base.length));
      assert.ok(PUBLIC_FILES.includes(path), `unpackaged reference: ${path}`);
      const text = await readFile(join(output, path), 'utf8');
      if (seen.has(path)) return;
      seen.add(path);
      if (path.endsWith('.js')) {
        for (const match of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
          assert.ok(match[1].startsWith('./'), 'browser imports must be relative');
          await verify(match[1], new URL(match[1], url));
        }
      }
    }
    for (const link of links) {
      assert.ok(link.startsWith('./'));
      await verify(link, new URL(link, base));
    }
    assert.equal(seen.size, PUBLIC_FILES.length - 1);
  }
});

test('brand icon CSS resolves to the packaged PNG under root and repository Pages paths', async t => {
  const output = await buildSite(await fixture(t));
  const css = (await readFile(join(output, 'styles.css'), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  const brandRules = [...css.matchAll(/\.brand-mark\s*\{([^{}]*)\}/g)];
  const references = brandRules.flatMap(([, declarations]) =>
    [...declarations.matchAll(/\burl\(\s*(?:"([^"]+)"|'([^']+)'|([^\s)]+))\s*\)/gi)]
      .map(([, doubleQuoted, singleQuoted, unquoted]) => doubleQuoted ?? singleQuoted ?? unquoted));
  assert.ok(references.length > 0, 'brand icon must reference an image');
  assert.ok(PUBLIC_FILES.includes(TOUCH_ICON));
  assert.deepEqual(await readFile(join(output, TOUCH_ICON)), await readSource(PROJECT_ROOT, TOUCH_ICON));
  for (const base of ['https://example.invalid/', 'https://example.invalid/my-schedule-app/']) {
    const stylesheet = new URL('styles.css', base);
    for (const reference of references) {
      assert.equal(new URL(reference, stylesheet).href, new URL(TOUCH_ICON, base).href);
    }
  }
});

test('rebuild discards stray output files without modifying source', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist', 'old-private-data.json'), '{}');
  const source = await readFile(join(root, 'src/app.js'));
  await buildSite(root);
  assert.deepEqual(await walk(join(root, 'dist')), [...PUBLIC_FILES, '.nojekyll'].sort());
  assert.deepEqual(await readFile(join(root, 'src/app.js')), source);
});

test('missing input fails before previous artifact is replaced', async t => {
  const root = await fixture(t, PUBLIC_FILES.filter(name => name !== 'styles.css'));
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist', 'keep.txt'), 'previous build');
  await assert.rejects(buildSite(root));
  assert.equal(await readFile(join(root, 'dist', 'keep.txt'), 'utf8'), 'previous build');
});

test('build refuses an unrelated project root', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'package.json'), '{"name":"unrelated"}');
  await assert.rejects(buildSite(root), /not the My Schedule project/);
});
test('invalid browser JavaScript fails build before previous artifact is replaced', async t => {
  const root=await fixture(t);
  await mkdir(join(root,'dist'));
  await writeFile(join(root,'dist','keep.txt'),'previous build');
  await writeFile(join(root,'src/app.js'),'export const broken = ;');
  await assert.rejects(buildSite(root),/invalid JavaScript/);
  assert.equal(await readFile(join(root,'dist','keep.txt'),'utf8'),'previous build');
});

test('home-screen icon is a bounded 180px PNG without ancillary chunks', async () => {
  const name = 'apple-touch-icon-v1.png';
  const html = (await readSource(PROJECT_ROOT, 'index.html')).toString('utf8');
  assert.ok(html.includes('<link rel="apple-touch-icon" sizes="180x180" href="./' + name + '">'));
  assert.deepEqual(PUBLIC_FILES.filter(file => file.endsWith('.png')), [name]);
  const png = await readSource(PROJECT_ROOT, name);
  assert.ok(png.length > 33 && png.length <= 64 * 1024);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(8), 13);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), 180);
  assert.equal(png.readUInt32BE(20), 180);
  let hasImageData = false;
  for (let offset = 8; offset < png.length;) {
    assert.ok(offset + 12 <= png.length);
    const length = png.readUInt32BE(offset);
    const kind = png.toString('ascii', offset + 4, offset + 8);
    assert.ok(['IHDR', 'IDAT', 'IEND'].includes(kind));
    offset += length + 12;
    assert.ok(offset <= png.length);
    if (kind === 'IDAT') hasImageData ||= length > 0;
    if (kind === 'IEND') {
      assert.equal(length, 0);
      assert.equal(offset, png.length);
      assert.ok(hasImageData);
      return;
    }
  }
  assert.fail('Missing PNG end chunk');
});

test('review selection includes the shipped icon and excludes incidental images and private data', async t => {
  const selected = await reviewFiles();
  assert.ok(selected.includes('apple-touch-icon-v1.png'));
  const root = await fixture(t, selected);
  for (const file of ['.env', '.git/config', 'dist/index.html', 'node_modules/example/index.js', 'artifacts/old.zip', 'docs/screenshots/example.jpg', 'docs/session.json', 'src/.env.js']) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), 'excluded fixture');
  }
  assert.deepEqual(await reviewFiles(root), selected);
  await assert.rejects(readSource(root, '../outside.txt'), /escapes/);
});

test('screening detects credential/contact examples without returning their values', () => {
  const value = 'sk-' + 'x'.repeat(32);
  const findings = screenText(value + '\n' + 'sample' + '@' + 'example.invalid');
  assert.ok(findings.includes('API token'));
  assert.ok(findings.includes('email address'));
  assert.ok(findings.every(finding => !finding.includes(value)));
  assert.deepEqual(screenText('架空の予定：カフェでひと休み'), []);
});
