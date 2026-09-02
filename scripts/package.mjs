/** Zips both build outputs into release/ for sharing or installing elsewhere. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const releaseDir = path.join(root, 'release');

const targets = [
  { name: 'code-to-design-chrome-extension', dir: path.join(root, 'packages/extension/dist') },
  { name: 'code-to-design-figma-plugin', dir: path.join(root, 'packages/figma-plugin/dist') },
];

await fs.mkdir(releaseDir, { recursive: true });

for (const target of targets) {
  try {
    await fs.access(target.dir);
  } catch {
    console.error(`  missing ${path.relative(root, target.dir)} - run "npm run build" first`);
    process.exitCode = 1;
    continue;
  }
  const zip = path.join(releaseDir, `${target.name}.zip`);
  await fs.rm(zip, { force: true });
  zipDirectory(target.dir, zip);
  console.log(`  ${path.relative(root, zip)}`);
}

function zipDirectory(dir, zip) {
  if (process.platform === 'win32') {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `Compress-Archive -Path '${dir}\\*' -DestinationPath '${zip}' -Force`],
      { stdio: 'inherit' },
    );
  } else {
    execFileSync('zip', ['-r', '-q', zip, '.'], { cwd: dir, stdio: 'inherit' });
  }
}
