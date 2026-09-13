// Vite configuration for the QuietBooks interface.
//
// SPDX-License-Identifier: Apache-2.0
//
// Three things here are load-bearing and none of them are defaults:
//
//  1. WASM and top-level await. `@midnight-ntwrk/onchain-runtime-v3` is a WASM
//     module the compact runtime awaits at module scope, so the bundle has to
//     keep top-level await instead of transpiling it away.
//  2. Node built-ins. `@quietbooks/contract` reaches for `node:crypto` and
//     `node:buffer` because it is shared with a Node CLI. Both have exact browser
//     equivalents, so they are aliased to small local shims rather than pulling a
//     polyfill bundle in.
//  3. Proving keys. `FetchZkConfigProvider` fetches `/keys/<circuit>.prover` and
//     `/zkir/<circuit>.bzkir` over HTTP. They live in the contract workspace and
//     are ~128 MB, so they are streamed from disk in dev and copied once at
//     build time instead of being committed into `public/`.

import { createReadStream, existsSync, cpSync, readdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import topLevelAwait from 'vite-plugin-top-level-await';
import wasm from 'vite-plugin-wasm';

const here = fileURLToPath(new URL('.', import.meta.url));
const zkArtifactRoot = resolve(here, '../contract/build');

/**
 * Where `@quietbooks/contract` can actually be imported from.
 *
 * It is a workspace dependency and is declared as one. The alias exists because
 * the package's published entry points do not currently resolve: "main" names
 * ./dist/index.js, its build emits ./dist/src/index.js, and that file re-exports
 * "../build/contract/index.js", which from dist/src points at a file that was
 * never emitted. The source tree is the one layout that is self-consistent, and
 * Vite compiles it as happily as the official example compiles its own
 * workspace sources. Delete the alias once dist resolves on its own.
 */
const contractEntry = (): string | undefined =>
  ['../contract/dist/index.js', '../contract/src/index.ts']
    .map((candidate) => resolve(here, candidate))
    .find((candidate) => existsSync(candidate));

/** The two directories the proof server's key material is read from. */
const ZK_DIRECTORIES = ['keys', 'zkir'] as const;

const contentTypeFor = (path: string): string =>
  path.endsWith('.json') ? 'application/json' : 'application/octet-stream';

/**
 * Serve the compiled proving keys in dev, and place them beside the bundle on
 * build.
 *
 * Copying 128 MB on every rebuild is slow enough to notice, so the copy is
 * skippable for anyone iterating on the interface alone.
 */
const zkArtifacts = (): Plugin => ({
  name: 'quietbooks-zk-artifacts',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = (req.url ?? '').split('?')[0];
      const directory = ZK_DIRECTORIES.find((name) => url.startsWith(`/${name}/`));
      if (directory === undefined) {
        next();
        return;
      }
      const file = resolve(zkArtifactRoot, decodeURIComponent(url.slice(1)));
      // Refuse anything that escapes the artifact root, since the path segment
      // arrives from the request.
      if (!file.startsWith(resolve(zkArtifactRoot)) || !existsSync(file)) {
        next();
        return;
      }
      void stat(file).then((info) => {
        res.setHeader('Content-Type', contentTypeFor(file));
        res.setHeader('Content-Length', String(info.size));
        createReadStream(file).pipe(res);
      });
    });
  },
  closeBundle() {
    if (process.env.QUIETBOOKS_SKIP_ZK_COPY === '1') {
      this.warn('QUIETBOOKS_SKIP_ZK_COPY=1 .. the bundle has no proving keys beside it');
      return;
    }
    for (const directory of ZK_DIRECTORIES) {
      const from = resolve(zkArtifactRoot, directory);
      if (!existsSync(from) || readdirSync(from).length === 0) {
        this.warn(
          `${directory}/ is missing from ../contract/build .. run "npm run compact" in the ` +
            'contract workspace, or proving will fail at runtime',
        );
        continue;
      }
      cpSync(from, resolve(here, 'dist', directory), { recursive: true });
    }
  },
});

export default defineConfig({
  cacheDir: './.vite',
  build: {
    target: 'esnext',
    // The WASM runtime is already minified and mangling it has broken source
    // maps for the proof path before; readable stack traces are worth more here
    // than a smaller bundle.
    minify: false,
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes('onchain-runtime-v3') ? 'wasm' : undefined),
      },
    },
    commonjsOptions: {
      transformMixedEsModules: true,
      extensions: ['.js', '.cjs'],
      ignoreDynamicRequires: true,
    },
  },
  plugins: [react(), wasm(), topLevelAwait(), zkArtifacts()],
  resolve: {
    // One instance of anything that keeps module-level state. The network id
    // lives in a module variable and is set once at start-up; two copies mean
    // the copy that gets read is not the copy that was set.
    dedupe: ['@midnight-ntwrk/midnight-js-network-id'],
    alias: {
      'node:crypto': resolve(here, 'src/shims/node-crypto.ts'),
      'node:buffer': resolve(here, 'src/shims/node-buffer.ts'),
      ...(contractEntry() === undefined ? {} : { '@quietbooks/contract': contractEntry()! }),
    },
    extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json', '.wasm'],
    mainFields: ['browser', 'module', 'main'],
  },
  optimizeDeps: {
    include: ['@midnight-ntwrk/compact-runtime'],
    exclude: ['@midnight-ntwrk/onchain-runtime-v3'],
    esbuildOptions: {
      target: 'esnext',
      supported: { 'top-level-await': true },
      platform: 'browser',
      format: 'esm',
    },
  },
});
