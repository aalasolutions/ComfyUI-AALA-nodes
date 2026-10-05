import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// ComfyUI imports every .js file under web/dist as an extension, so the build must be one self-contained module.
export default defineConfig({
  plugins: [vue()],
  define: {
    __VUE_OPTIONS_API__: 'false',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  build: {
    outDir: '../web/dist',
    emptyOutDir: true,
    sourcemap: false,
    modulePreload: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: 'src/main.ts',
      output: {
        format: 'es',
        entryFileNames: 'aala-media.js',
        inlineDynamicImports: true,
      },
    },
  },
});
