import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT, reviewFiles, readSource } from './files.mjs';

// Heuristic screening only. Report categories and filenames, never matching secret values.
export function screenText(text) {
  const patterns = {
    'private key': /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
    'GitHub token': /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/,
    'API token': /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}/,
    'AWS access key': /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    'credential assignment': /\b(?:api[_-]?key|client[_-]?secret|password|access[_-]?token)\b\s*[=:]\s*["'][^"'\s]{8,}["']/i,
    'email address': /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    'Japanese telephone': /(?:^|[^\d])0[789]0-\d{4}-\d{4}(?:[^\d]|$)/,
  };
  return Object.entries(patterns).filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

export async function checkSources(root = PROJECT_ROOT) {
  const files = await reviewFiles(root);
  const findings = [];
  for (const name of files) {
    const text = (await readSource(root, name)).toString('utf8');
    for (const category of screenText(text)) findings.push(`${name}: ${category}`);
    if (/\.(?:m?js)$/.test(name)) {
      const result = spawnSync(process.execPath, ['--check','--input-type=module'], {input:text,encoding:'utf8'});
      if (result.status !== 0) throw Error(`Syntax check failed: ${name}\n${result.stderr}`);
    }
  }
  if (findings.length) throw Error('Review required (values hidden):\n' + findings.join('\n'));
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const files = await checkSources();
  console.log(`Syntax and heuristic secret/contact screening passed: ${files.length} source files`);
}
