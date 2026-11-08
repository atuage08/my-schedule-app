import { createHash } from 'node:crypto';
import { checkSources, screenText } from './check.mjs';
import { PROJECT_ROOT, readSource } from './files.mjs';

const files = await checkSources();
const entries = [];
for (const path of files) {
  const content = await readSource(PROJECT_ROOT, path);
  if(screenText(content.toString('utf8')).length)throw Error(`Review required: ${path}`);
  entries.push({ path, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'),...(process.argv.includes('--with-content')?{contentBase64:content.toString('base64')}:{}) });
}
// No absolute user paths, Git identity, remotes, environment variables or credentials.
console.log(JSON.stringify({ format: 1, project: 'my-schedule-prototype', files: entries }, null, 2));
