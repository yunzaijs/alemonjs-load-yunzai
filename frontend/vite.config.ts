import { readFileSync } from 'fs';
import theme from '@alemonjs/react-ui/theme.json';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'url';
import { defineConfig } from 'vite';
const NODE_ENV = process.env.NODE_ENV === 'development';
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8')) as { version?: string };

export default defineConfig({
  base: NODE_ENV ? '/' : './',
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:17817/app/api/',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api/, '')
      }
    }
  },
  define: {
    'process.env.ALEMONJS_CSS_VARIABLES': NODE_ENV ? JSON.stringify(theme) : '{}',
    __APP_VERSION__: JSON.stringify(pkg.version ?? '0.0.0')
  },
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: '@',
        replacement: fileURLToPath(new URL('./src', import.meta.url))
      }
    ]
  },
  esbuild: {
    drop: NODE_ENV ? [] : ['console', 'debugger']
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true
    },
    minify: 'terser',
    terserOptions: {
      compress: NODE_ENV
        ? {}
        : {
          drop_console: true,
          drop_debugger: true
        }
    },
    rollupOptions: {
      output: {
        dir: '../dist',
        entryFileNames: 'assets/index.js',
        assetFileNames: 'assets/[name].[ext]'
      }
    }
  }
});
