const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const failures = [];
let checked = 0;

function check(filename, source) {
  checked += 1;
  try {
    new vm.Script(source, { filename });
  } catch (error) {
    failures.push(`${path.relative(root, filename)}: ${error.message}`);
  }
}

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(filename);
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.min.js')) {
      check(filename, fs.readFileSync(filename, 'utf8'));
    }
  }
}

walk(path.join(root, 'api'));

for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
  const filename = path.join(root, entry.name);
  const html = fs.readFileSync(filename, 'utf8');
  const scripts = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  let index = 0;
  while ((match = scripts.exec(html))) {
    index += 1;
    if (/\bsrc\s*=/.test(match[1]) || /type\s*=\s*["'](?:application\/json|importmap)["']/.test(match[1])) continue;
    if (match[2].trim()) check(`${filename}#script${index}`, match[2]);
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Syntax check passed (${checked} scripts).`);
}
