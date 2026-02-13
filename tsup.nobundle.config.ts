import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist-nobundle',
  clean: true,
  sourcemap: false,
  dts: false,
  splitting: false,
  bundle: false,
});
