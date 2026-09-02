import { build } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedAlias } from '../vite.shared.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

const base = {
  root,
  resolve: { alias: sharedAlias },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  logLevel: 'warn',
};

/** The popup: a normal HTML entry, output flattened so paths stay predictable. */
async function buildPopup() {
  await build({
    ...base,
    plugins: [react()],
    build: {
      outDir,
      emptyOutDir: true,
      target: 'chrome111',
      rollupOptions: {
        input: path.join(root, 'popup.html'),
        output: {
          entryFileNames: 'popup.js',
          chunkFileNames: 'popup-[name].js',
          assetFileNames: 'popup.[ext]',
        },
      },
      watch: watch ? {} : undefined,
    },
  });
}

/** Service worker: ES module, single file. */
async function buildBackground() {
  await build({
    ...base,
    build: {
      outDir,
      emptyOutDir: false,
      target: 'chrome111',
      lib: { entry: path.join(root, 'src/background/index.ts'), formats: ['es'], fileName: () => 'background.js' },
      watch: watch ? {} : undefined,
    },
  });
}

/**
 * Capture bundle: injected with chrome.scripting.executeScript({ files }), which
 * runs it as a classic script, so it has to be a self-contained IIFE.
 */
async function buildCapture() {
  await build({
    ...base,
    build: {
      outDir,
      emptyOutDir: false,
      target: 'chrome111',
      lib: {
        entry: path.join(root, 'src/capture/entry.ts'),
        formats: ['iife'],
        name: '__c2dCaptureBundle',
        fileName: () => 'capture.js',
      },
      watch: watch ? {} : undefined,
    },
  });
}

async function copyStatic() {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const publicDir = path.join(root, 'public');
  await fs.cp(publicDir, outDir, { recursive: true });
}

await buildPopup();
await buildBackground();
await buildCapture();
await copyStatic();
console.log(`\n  code.to.design extension -> ${path.relative(process.cwd(), outDir)}\n`);
