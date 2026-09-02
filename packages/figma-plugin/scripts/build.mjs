import { build } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'dist');
const sharedAlias = { '@c2d/shared': path.resolve(root, '../shared/src/index.ts') };

const base = {
  root,
  resolve: { alias: sharedAlias },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  logLevel: 'warn',
};

/** The sandbox bundle. Figma runs it as a plain script with no module loader. */
async function buildCode() {
  await build({
    ...base,
    build: {
      outDir,
      emptyOutDir: true,
      target: 'es2017',
      lib: {
        entry: path.join(root, 'src/code/main.ts'),
        formats: ['iife'],
        name: '__c2dPlugin',
        fileName: () => 'code.js',
      },
    },
  });
}

/**
 * The UI has to be one self-contained HTML file: Figma inlines it as `__html__`
 * and the iframe cannot fetch sibling assets.
 */
async function buildUi() {
  await build({
    ...base,
    plugins: [react()],
    build: {
      outDir,
      emptyOutDir: false,
      target: 'chrome111',
      cssCodeSplit: false,
      lib: {
        entry: path.join(root, 'src/ui/main.tsx'),
        formats: ['iife'],
        name: '__c2dUi',
        fileName: () => 'ui.js',
      },
    },
  });

  const js = await fs.readFile(path.join(outDir, 'ui.js'), 'utf8');
  const cssPath = await findCss(outDir);
  const css = cssPath ? await fs.readFile(cssPath, 'utf8') : '';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>code.to.design</title>
<style>${css}</style>
</head>
<body>
<script>${js.replace(/<\/script/gi, '<\\/script')}</script>
</body>
</html>
`;
  await fs.writeFile(path.join(outDir, 'ui.html'), html);
  await fs.rm(path.join(outDir, 'ui.js'), { force: true });
  if (cssPath) await fs.rm(cssPath, { force: true });
}

async function findCss(dir) {
  for (const name of await fs.readdir(dir)) {
    if (name.endsWith('.css')) return path.join(dir, name);
  }
  return null;
}

async function copyManifest() {
  const manifest = await fs.readFile(path.join(root, 'manifest.json'), 'utf8');
  await fs.writeFile(path.join(outDir, 'manifest.json'), manifest);
}

await buildCode();
await buildUi();
await copyManifest();
console.log(`\n  code.to.design Figma plugin -> ${path.relative(process.cwd(), outDir)}\n`);
