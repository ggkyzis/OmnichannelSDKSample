/**
 * esbuild configuration to bundle @microsoft/omnichannel-chat-sdk for browser use
 * This creates a browser-compatible bundle with Node.js polyfills
 * Based on: https://github.com/microsoft/omnichannel-chat-sdk/blob/main/playwright/esbuild.config.js
 */

const { build } = require('esbuild');
const { polyfillNode } = require('esbuild-plugin-polyfill-node');
const path = require('path');

// Custom plugin to handle Azure Communication Chat package for browser
const AzureCommunicationChatPolyfills = () => {
  return {
    name: 'AzureCommunicationChatPolyfill',
    setup: ({ onResolve }) => {
      onResolve({ filter: /@azure\/communication-chat/ }, (args) => {
        // Polyfill Chat Package to support real-time notifications on Browser
        if (args.path === '@azure/communication-chat') {
          try {
            const defaultPath = require.resolve('@azure/communication-chat');
            const basePath = path.dirname(path.dirname(defaultPath));
            const esmPath = path.join(basePath, 'dist-esm', 'src', 'index.js');
            return {
              path: esmPath.toString()
            };
          } catch (e) {
            // If not found, let esbuild handle it normally
            return null;
          }
        }
      });
    }
  };
};

async function buildSDK() {
  try {
    console.log('[esbuild] Building SDK bundle for browser...');
    
    await build({
      entryPoints: [
        require.resolve('@microsoft/omnichannel-chat-sdk')
      ],
      bundle: true,
      outfile: path.join(__dirname, 'dist', 'omnichannel-sdk-bundle.js'),
      format: 'iife',
      globalName: 'OmnichannelChatSDK',
      platform: 'browser',
      target: ['chrome90', 'firefox88', 'safari14'],
      define: {
        'global': 'window',
        'process.env.NODE_ENV': '"production"'
      },
      plugins: [
        AzureCommunicationChatPolyfills(),
        polyfillNode({
          polyfills: {
            crypto: true,
            buffer: true,
            stream: true,
            util: true,
            events: true,
            process: true,
            path: true,
            url: true,
            fs: false,
            os: false,
            http: false,
            https: false,
            net: false,
            tls: false,
            child_process: false,
            dns: false,
          }
        })
      ],
      external: [],
      minify: false, // Keep readable for debugging
      sourcemap: true,
      logLevel: 'info'
    });
    
    console.log('[esbuild] SDK bundle created successfully!');
    console.log('[esbuild] Output:', path.join(__dirname, 'dist', 'omnichannel-sdk-bundle.js'));
    
  } catch (error) {
    console.error('[esbuild] Build failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  buildSDK();
}

module.exports = { buildSDK };
