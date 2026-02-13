import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist-plugin-test',
  clean: true,
  sourcemap: false,
  dts: false,
  splitting: false,
  esbuildPlugins: [
    {
      name: 'preserve-node-sqlite',
      setup(build) {
        build.onResolve({ filter: /^sqlite$/ }, () => ({
          path: 'node:sqlite',
          external: true,
        }));
      },
    },
  ],
});
