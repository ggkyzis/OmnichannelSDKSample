/**
 * OmnichannelService - Headless browser service for running Omnichannel SDK
 * 
 * This service uses Puppeteer to create a headless browser environment
 * where the Omnichannel Chat SDK can run server-side.
 */

import puppeteer from 'puppeteer';
import { EventEmitter } from 'events';
import http from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Find the bundled SDK file (created by esbuild.config.cjs)
function findSDKPath() {
  const possiblePaths = [
    // Bundled SDK (browser-compatible, built with esbuild)
    join(__dirname, 'dist', 'omnichannel-sdk-bundle.js'),
    join(process.cwd(), 'src', 'backend', 'dist', 'omnichannel-sdk-bundle.js'),
  ];
  
  for (const p of possiblePaths) {
    if (existsSync(p)) {
      console.log(`[OmnichannelService] Found bundled SDK at: ${p}`);
      return p;
    }
  }
  
  console.warn('[OmnichannelService] Bundled SDK not found. Run "node src/backend/esbuild.config.cjs" to build it.');
  return null;
}

class OmnichannelService extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.browser = null;
    this.page = null;
    this.isInitialized = false;
    this.sessionId = null;
    this.staticServer = null;
    this.staticServerPort = null;
  }

  /**
   * Start a simple HTTP server to serve the SDK and HTML page
   */
  async startStaticServer() {
    return new Promise((resolve, reject) => {
      const sdkPath = findSDKPath();
      
      // Create the HTML page content
      const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <title>Omnichannel SDK Headless</title>
  <script>
    // Polyfills required by the SDK
    window.global = window;
    var exports = {};
  </script>
</head>
<body>
  <div id="app">Omnichannel SDK Container</div>
  <script>
    // SDK will be loaded via addScriptTag from Puppeteer
    console.log('[Page] Ready for SDK');
  </script>
</body>
</html>`;

      this.staticServer = http.createServer((req, res) => {
        if (req.url === '/' || req.url === '/index.html') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(htmlContent);
        } else if (req.url === '/sdk.js' && sdkPath) {
          try {
            const sdkContent = readFileSync(sdkPath, 'utf-8');
            res.writeHead(200, { 'Content-Type': 'application/javascript' });
            res.end(sdkContent);
          } catch (err) {
            res.writeHead(500);
            res.end('Error reading SDK file');
          }
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });

      // Find an available port
      this.staticServer.listen(0, '127.0.0.1', () => {
        this.staticServerPort = this.staticServer.address().port;
        console.log(`[OmnichannelService] Static server started on port ${this.staticServerPort}`);
        resolve(this.staticServerPort);
      });

      this.staticServer.on('error', reject);
    });
  }

  /**
   * Launch headless browser and initialize Omnichannel SDK
   */
  async initialize() {
    try {
      console.log('[OmnichannelService] Launching headless browser...');
      
      // Start static server first
      await this.startStaticServer();
      
      // Launch Puppeteer with optimized settings for container
      this.browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-sync',
          '--disable-translate',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-first-run',
          '--safebrowsing-disable-auto-update'
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
      });

      this.page = await this.browser.newPage();

      // Set viewport and user agent
      await this.page.setViewport({ width: 1280, height: 720 });
      await this.page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      // Listen for console messages from the page
      this.page.on('console', (msg) => {
        const type = msg.type();
        const text = msg.text();
        if (type === 'error') {
          console.error('[Browser Console Error]', text);
        } else if (process.env.DEBUG === 'true') {
          console.log('[Browser Console]', text);
        }
      });

      // Handle page errors
      this.page.on('pageerror', (error) => {
        console.error('[Browser Page Error]', error.message);
        this.emit('error', error);
      });

      // Navigate to our local static server
      console.log('[OmnichannelService] Loading local page...');
      await this.page.goto(`http://127.0.0.1:${this.staticServerPort}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      // Check if we have a local SDK bundle
      const sdkPath = findSDKPath();
      if (sdkPath) {
        console.log(`[OmnichannelService] Loading bundled SDK from: ${sdkPath}`);
        await this.page.addScriptTag({ url: '/sdk.js' });
      } else {
        throw new Error('SDK bundle not found. Run "node src/backend/esbuild.config.cjs" to build it first.');
      }

      // Wait for SDK to be available
      console.log('[OmnichannelService] Waiting for SDK to load...');
      await this.page.waitForFunction(() => {
        return typeof window.OmnichannelChatSDK !== 'undefined';
      }, { timeout: 30000 });

      // Check what's available in the SDK bundle
      const sdkInfo = await this.page.evaluate(() => {
        const info = {
          hasOmnichannelChatSDK: typeof window.OmnichannelChatSDK !== 'undefined',
          hasDefault: typeof window.OmnichannelChatSDK?.default !== 'undefined',
          typeOfSDK: typeof window.OmnichannelChatSDK,
          keys: Object.keys(window.OmnichannelChatSDK || {}).slice(0, 15)
        };
        return info;
      });
      console.log('[OmnichannelService] SDK info:', JSON.stringify(sdkInfo, null, 2));

      console.log('[OmnichannelService] SDK loaded, initializing...');

      // Initialize the SDK in browser context
      const initResult = await this.page.evaluate(async (config) => {
        try {
          const omnichannelConfig = {
            orgUrl: config.orgUrl,
            orgId: config.orgId,
            widgetId: config.widgetId
          };

          // Chat SDK configuration
          const chatSDKConfig = {
            telemetry: {
              disable: true // Disable telemetry for headless usage
            }
          };

          // Get the SDK constructor - handle esbuild IIFE wrapper format
          // The bundle structure is: window.OmnichannelChatSDK.default (the actual class)
          // But sometimes it's nested differently
          let SDKClass = null;
          const sdk = window.OmnichannelChatSDK;
          
          // Debug: log what we have
          console.log('[SDK] Checking constructor candidates:');
          console.log('  - sdk.default type:', typeof sdk?.default);
          console.log('  - sdk.default?.default type:', typeof sdk?.default?.default);
          console.log('  - sdk.OmnichannelChatSDK type:', typeof sdk?.OmnichannelChatSDK);
          console.log('  - sdk.OmnichannelChatSDK?.default type:', typeof sdk?.OmnichannelChatSDK?.default);
          
          // Try different patterns based on how esbuild wraps the module
          if (typeof sdk?.default?.default === 'function') {
            // Double-wrapped default export
            SDKClass = sdk.default.default;
            console.log('[SDK] Using sdk.default.default');
          } else if (typeof sdk?.OmnichannelChatSDK?.default === 'function') {
            // Named export with default
            SDKClass = sdk.OmnichannelChatSDK.default;
            console.log('[SDK] Using sdk.OmnichannelChatSDK.default');
          } else if (typeof sdk?.OmnichannelChatSDK === 'function') {
            // Named export is the class
            SDKClass = sdk.OmnichannelChatSDK;
            console.log('[SDK] Using sdk.OmnichannelChatSDK');
          } else if (typeof sdk?.default === 'function') {
            // Single default export
            SDKClass = sdk.default;
            console.log('[SDK] Using sdk.default');
          } else if (typeof sdk === 'function') {
            // Direct function
            SDKClass = sdk;
            console.log('[SDK] Using sdk directly');
          }
          
          if (!SDKClass) {
            const available = Object.keys(sdk || {});
            const defaultKeys = sdk?.default ? Object.keys(sdk.default) : [];
            throw new Error('SDK class not found. Top keys: ' + available.join(', ') + '. Default keys: ' + defaultKeys.join(', '));
          }

          console.log('[SDK] Creating instance with config:', JSON.stringify(omnichannelConfig));
          window.chatSDK = new SDKClass(omnichannelConfig, chatSDKConfig);
          await window.chatSDK.initialize();
          
          console.log('[SDK] Initialized successfully');
          return { success: true };
        } catch (error) {
          console.error('[SDK] Initialization error:', error);
          return { success: false, error: error.message, stack: error.stack };
        }
      }, this.config);

      if (!initResult.success) {
        throw new Error(`SDK initialization failed: ${initResult.error}`);
      }

      // Expose function to receive messages from browser
      await this.page.exposeFunction('onSDKMessage', (message) => {
        this.emit('message', message);
      });

      await this.page.exposeFunction('onSDKAgentJoined', (agent) => {
        this.emit('agentJoined', agent);
      });

      await this.page.exposeFunction('onSDKAgentLeft', () => {
        this.emit('agentLeft');
      });

      await this.page.exposeFunction('onSDKTyping', (typing) => {
        this.emit('typing', typing);
      });

      await this.page.exposeFunction('onSDKError', (error) => {
        this.emit('error', error);
      });

      this.isInitialized = true;
      this.sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      console.log(`[OmnichannelService] Initialized with session: ${this.sessionId}`);
      return { success: true, sessionId: this.sessionId };

    } catch (error) {
      console.error('[OmnichannelService] Initialization error:', error);
      await this.close();
      throw error;
    }
  }

  /**
   * Create HTML page with Omnichannel SDK loaded
   */
  createSDKPage() {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Omnichannel SDK Headless</title>
        <script src="https://unpkg.com/@microsoft/omnichannel-chat-sdk@1.11.7/dist/OmnichannelChatSDK.min.js"></script>
      </head>
      <body>
        <div id="app">Omnichannel SDK Container</div>
        <script>
          console.log('[Page] Omnichannel SDK page loaded');
          window.addEventListener('error', (e) => {
            console.error('[Page Error]', e.message);
          });
        </script>
      </body>
      </html>
    `;
  }

  /**
   * Start a new chat conversation
   */
  async startChat(customContext = {}) {
    if (!this.isInitialized) {
      throw new Error('Service not initialized. Call initialize() first.');
    }

    console.log('[OmnichannelService] Starting chat...');

    const result = await this.page.evaluate(async (context) => {
      try {
        const optionalParams = {};
        
        // Add custom context if provided
        if (context && Object.keys(context).length > 0) {
          optionalParams.customContext = context;
        }

        await window.chatSDK.startChat(optionalParams);
        
        // Set up message listener
        window.chatSDK.onNewMessage((message) => {
          console.log('[SDK] New message received:', message);
          window.onSDKMessage({
            id: message.id || Date.now().toString(),
            content: message.content,
            timestamp: message.timestamp || new Date().toISOString(),
            sender: message.sender?.displayName || 'Agent',
            senderType: message.sender?.type || 'agent',
            messageType: message.messageType || 'text'
          });
        });

        // Set up typing indicator
        window.chatSDK.onTypingEvent((event) => {
          window.onSDKTyping(event);
        });

        // Set up agent events
        window.chatSDK.onAgentEndSession(() => {
          console.log('[SDK] Agent ended session');
          window.onSDKAgentLeft();
        });

        console.log('[SDK] Chat started successfully');
        return { success: true };
      } catch (error) {
        console.error('[SDK] Start chat error:', error);
        return { success: false, error: error.message };
      }
    }, customContext);

    if (!result.success) {
      throw new Error(`Failed to start chat: ${result.error}`);
    }

    return { success: true, sessionId: this.sessionId };
  }

  /**
   * Send a message
   */
  async sendMessage(content, messageType = 'text') {
    if (!this.isInitialized) {
      throw new Error('Service not initialized');
    }

    console.log(`[OmnichannelService] Sending message: ${content.substring(0, 50)}...`);

    const result = await this.page.evaluate(async (msg, type) => {
      try {
        const message = {
          content: msg
        };

        if (type === 'file') {
          // Handle file attachments differently
          message.contentType = 'file';
        }

        await window.chatSDK.sendMessage(message);
        
        return { 
          success: true, 
          messageId: Date.now().toString(),
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        console.error('[SDK] Send message error:', error);
        return { success: false, error: error.message };
      }
    }, content, messageType);

    if (!result.success) {
      throw new Error(`Failed to send message: ${result.error}`);
    }

    return result;
  }

  /**
   * Send typing indicator
   */
  async sendTypingIndicator() {
    if (!this.isInitialized) return;

    await this.page.evaluate(async () => {
      try {
        await window.chatSDK.sendTypingEvent();
      } catch (error) {
        console.error('[SDK] Typing indicator error:', error);
      }
    });
  }

  /**
   * Get chat transcript
   */
  async getTranscript() {
    if (!this.isInitialized) {
      throw new Error('Service not initialized');
    }

    const result = await this.page.evaluate(async () => {
      try {
        const transcript = await window.chatSDK.getMessages();
        return { success: true, messages: transcript };
      } catch (error) {
        console.error('[SDK] Get transcript error:', error);
        return { success: false, error: error.message };
      }
    });

    if (!result.success) {
      throw new Error(`Failed to get transcript: ${result.error}`);
    }

    return result.messages;
  }

  /**
   * Get current conversation state
   */
  async getConversationState() {
    if (!this.isInitialized) {
      return { state: 'not_initialized' };
    }

    const result = await this.page.evaluate(async () => {
      try {
        const state = await window.chatSDK.getCurrentLiveChatContext();
        return { success: true, state };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    return result;
  }

  /**
   * End the chat conversation
   */
  async endChat() {
    if (!this.isInitialized) {
      return { success: true, message: 'Not initialized' };
    }

    console.log('[OmnichannelService] Ending chat...');

    const result = await this.page.evaluate(async () => {
      try {
        await window.chatSDK.endChat();
        console.log('[SDK] Chat ended');
        return { success: true };
      } catch (error) {
        console.error('[SDK] End chat error:', error);
        return { success: false, error: error.message };
      }
    });

    return result;
  }

  /**
   * Download transcript before ending
   */
  async downloadTranscript() {
    if (!this.isInitialized) {
      throw new Error('Service not initialized');
    }

    const result = await this.page.evaluate(async () => {
      try {
        const transcript = await window.chatSDK.emailLiveChatTranscript();
        return { success: true, transcript };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    return result;
  }

  /**
   * Close browser and cleanup
   */
  async close() {
    console.log('[OmnichannelService] Closing service...');
    
    try {
      if (this.isInitialized) {
        await this.endChat();
      }
    } catch (error) {
      console.error('[OmnichannelService] Error ending chat during close:', error);
    }

    if (this.page) {
      try {
        await this.page.close();
      } catch (error) {
        console.error('[OmnichannelService] Error closing page:', error);
      }
      this.page = null;
    }

    if (this.browser) {
      try {
        await this.browser.close();
      } catch (error) {
        console.error('[OmnichannelService] Error closing browser:', error);
      }
      this.browser = null;
    }

    // Close static server
    if (this.staticServer) {
      try {
        this.staticServer.close();
      } catch (error) {
        console.error('[OmnichannelService] Error closing static server:', error);
      }
      this.staticServer = null;
      this.staticServerPort = null;
    }

    this.isInitialized = false;
    this.sessionId = null;
    
    console.log('[OmnichannelService] Service closed');
  }

  /**
   * Check if service is ready
   */
  isReady() {
    return this.isInitialized && this.browser !== null && this.page !== null;
  }

  /**
   * Get session info
   */
  getSessionInfo() {
    return {
      sessionId: this.sessionId,
      isInitialized: this.isInitialized,
      config: {
        orgId: this.config.orgId,
        orgUrl: this.config.orgUrl,
        widgetId: this.config.widgetId
      }
    };
  }
}

export default OmnichannelService;
