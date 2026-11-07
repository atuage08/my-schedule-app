import { createHash } from 'node:crypto';
import { checkSources } from './check.mjs';
import { PROJECT_ROOT, readSource } from './files.mjs';

const files = await checkSources();
const entries = [];
for (const path of files) {
  const content = await readSource(PROJECT_ROOT, path);
  entries.push({ path, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
}
// No absolute user paths, Git identity, remotes, environment variables or credentials.
console.log(JSON.stringify({ format: 1, project: 'my-schedule-prototype', files: entries }, null, 2));
