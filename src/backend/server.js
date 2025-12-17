/**
 * Express API Server for Omnichannel Headless Service
 * 
 * This server manages chat sessions using Puppeteer to run the
 * Omnichannel SDK in a headless browser environment.
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import OmnichannelService from './omnichannel-service.js';

const app = express();
const server = createServer(app);

// WebSocket server for real-time communication
const wss = new WebSocketServer({ server, path: '/ws' });

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Store active sessions
const sessions = new Map();
const wsClients = new Map(); // Map sessionId -> WebSocket clients

// Omnichannel configuration from environment
const getOmnichannelConfig = (customConfig = {}) => ({
  orgUrl: customConfig.orgUrl || process.env.OMNI_ORG_URL,
  orgId: customConfig.orgId || process.env.OMNI_ORG_ID,
  widgetId: customConfig.widgetId || process.env.OMNI_WIDGET_ID,
  cpsBotId: customConfig.cpsBotId || process.env.OMNI_CPS_BOT_ID
});

// Validate configuration
const validateConfig = (config) => {
  const required = ['orgUrl', 'orgId', 'widgetId'];
  const missing = required.filter(key => !config[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  }
  
  return true;
};

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');
  
  console.log(`[WebSocket] Client connected for session: ${sessionId || 'unknown'}`);

  if (sessionId) {
    if (!wsClients.has(sessionId)) {
      wsClients.set(sessionId, new Set());
    }
    wsClients.get(sessionId).add(ws);
  }

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log('[WebSocket] Received:', message);

      // Handle different message types
      if (message.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (error) {
      console.error('[WebSocket] Error processing message:', error);
    }
  });

  ws.on('close', () => {
    console.log(`[WebSocket] Client disconnected for session: ${sessionId || 'unknown'}`);
    if (sessionId && wsClients.has(sessionId)) {
      wsClients.get(sessionId).delete(ws);
      if (wsClients.get(sessionId).size === 0) {
        wsClients.delete(sessionId);
      }
    }
  });

  ws.on('error', (error) => {
    console.error('[WebSocket] Error:', error);
  });
});

// Broadcast message to session's WebSocket clients
const broadcastToSession = (sessionId, data) => {
  if (wsClients.has(sessionId)) {
    const message = JSON.stringify(data);
    wsClients.get(sessionId).forEach(client => {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(message);
      }
    });
  }
};

// Setup event listeners for a session
const setupSessionEvents = (service, sessionId) => {
  service.on('message', (message) => {
    console.log(`[Session ${sessionId}] Message received:`, message);
    broadcastToSession(sessionId, {
      type: 'message',
      sessionId,
      data: message
    });
  });

  service.on('agentJoined', (agent) => {
    console.log(`[Session ${sessionId}] Agent joined:`, agent);
    broadcastToSession(sessionId, {
      type: 'agentJoined',
      sessionId,
      data: agent
    });
  });

  service.on('agentLeft', () => {
    console.log(`[Session ${sessionId}] Agent left`);
    broadcastToSession(sessionId, {
      type: 'agentLeft',
      sessionId
    });
  });

  service.on('typing', (typing) => {
    broadcastToSession(sessionId, {
      type: 'typing',
      sessionId,
      data: typing
    });
  });

  service.on('error', (error) => {
    console.error(`[Session ${sessionId}] Error:`, error);
    broadcastToSession(sessionId, {
      type: 'error',
      sessionId,
      data: { message: error.message || 'Unknown error' }
    });
  });
};

// ============ API Routes ============

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeSessions: sessions.size
  });
});

// Get service configuration (without sensitive data)
app.get('/api/config', (req, res) => {
  const config = getOmnichannelConfig();
  res.json({
    orgUrl: config.orgUrl ? '***configured***' : null,
    orgId: config.orgId ? '***configured***' : null,
    widgetId: config.widgetId ? '***configured***' : null,
    cpsBotId: config.cpsBotId ? '***configured***' : null
  });
});

// Create new chat session
app.post('/api/chat/session', async (req, res) => {
  try {
    const customConfig = req.body.config || {};
    const config = getOmnichannelConfig(customConfig);
    
    validateConfig(config);

    console.log('[API] Creating new chat session...');
    
    const service = new OmnichannelService(config);
    const initResult = await service.initialize();
    
    const sessionId = initResult.sessionId;
    sessions.set(sessionId, service);
    
    // Setup event listeners
    setupSessionEvents(service, sessionId);

    console.log(`[API] Session created: ${sessionId}`);
    
    res.json({
      success: true,
      sessionId,
      message: 'Session created. Call /api/chat/{sessionId}/start to begin the chat.'
    });
  } catch (error) {
    console.error('[API] Create session error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Start chat for a session
app.post('/api/chat/:sessionId/start', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { customContext } = req.body;
    
    const service = sessions.get(sessionId);
    if (!service) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    console.log(`[API] Starting chat for session: ${sessionId}`);
    
    const result = await service.startChat(customContext);
    
    res.json({
      success: true,
      sessionId,
      message: 'Chat started successfully'
    });
  } catch (error) {
    console.error('[API] Start chat error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Send message
app.post('/api/chat/:sessionId/message', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { content, messageType } = req.body;
    
    if (!content) {
      return res.status(400).json({
        success: false,
        error: 'Message content is required'
      });
    }

    const service = sessions.get(sessionId);
    if (!service) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    console.log(`[API] Sending message for session: ${sessionId}`);
    
    const result = await service.sendMessage(content, messageType);
    
    res.json({
      success: true,
      messageId: result.messageId,
      timestamp: result.timestamp
    });
  } catch (error) {
    console.error('[API] Send message error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Send typing indicator
app.post('/api/chat/:sessionId/typing', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const service = sessions.get(sessionId);
    if (!service) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    await service.sendTypingIndicator();
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get conversation transcript
app.get('/api/chat/:sessionId/transcript', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const service = sessions.get(sessionId);
    if (!service) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    const messages = await service.getTranscript();
    
    res.json({
      success: true,
      sessionId,
      messages
    });
  } catch (error) {
    console.error('[API] Get transcript error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get conversation state
app.get('/api/chat/:sessionId/state', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const service = sessions.get(sessionId);
    if (!service) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    const state = await service.getConversationState();
    
    res.json({
      success: true,
      sessionId,
      state
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get session info
app.get('/api/chat/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const service = sessions.get(sessionId);
    if (!service) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    const info = service.getSessionInfo();
    
    res.json({
      success: true,
      ...info
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// End chat session
app.post('/api/chat/:sessionId/end', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const service = sessions.get(sessionId);
    if (!service) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    console.log(`[API] Ending chat for session: ${sessionId}`);
    
    await service.endChat();
    
    res.json({
      success: true,
      message: 'Chat ended. Session is still active for potential restart.'
    });
  } catch (error) {
    console.error('[API] End chat error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Delete session completely
app.delete('/api/chat/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const service = sessions.get(sessionId);
    if (service) {
      console.log(`[API] Deleting session: ${sessionId}`);
      await service.close();
      sessions.delete(sessionId);
      wsClients.delete(sessionId);
    }
    
    res.json({
      success: true,
      message: 'Session deleted'
    });
  } catch (error) {
    console.error('[API] Delete session error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// List all active sessions
app.get('/api/sessions', (req, res) => {
  const sessionList = [];
  sessions.forEach((service, sessionId) => {
    sessionList.push({
      sessionId,
      isReady: service.isReady()
    });
  });
  
  res.json({
    success: true,
    count: sessionList.length,
    sessions: sessionList
  });
});

// Cleanup all sessions
app.post('/api/cleanup', async (req, res) => {
  try {
    console.log('[API] Cleaning up all sessions...');
    
    const cleanupPromises = [];
    sessions.forEach((service, sessionId) => {
      cleanupPromises.push(
        service.close().then(() => {
          sessions.delete(sessionId);
          wsClients.delete(sessionId);
        })
      );
    });
    
    await Promise.all(cleanupPromises);
    
    res.json({
      success: true,
      message: 'All sessions cleaned up'
    });
  } catch (error) {
    console.error('[API] Cleanup error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('[API] Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Graceful shutdown
const gracefulShutdown = async () => {
  console.log('\n[Server] Received shutdown signal, cleaning up...');
  
  // Close all sessions
  const cleanupPromises = [];
  sessions.forEach((service, sessionId) => {
    console.log(`[Server] Closing session: ${sessionId}`);
    cleanupPromises.push(service.close());
  });
  
  await Promise.all(cleanupPromises);
  
  // Close WebSocket server
  wss.close(() => {
    console.log('[Server] WebSocket server closed');
  });
  
  // Close HTTP server
  server.close(() => {
    console.log('[Server] HTTP server closed');
    process.exit(0);
  });
  
  // Force exit after timeout
  setTimeout(() => {
    console.error('[Server] Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Start server
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║         Omnichannel Headless Service                       ║
╠════════════════════════════════════════════════════════════╣
║  HTTP API:     http://${HOST}:${PORT}                          ║
║  WebSocket:    ws://${HOST}:${PORT}/ws                         ║
║  Health:       http://${HOST}:${PORT}/api/health               ║
╚════════════════════════════════════════════════════════════╝
  `);
  
  // Log configuration status
  const config = getOmnichannelConfig();
  console.log('[Server] Configuration status:');
  console.log(`  - OMNI_ORG_URL: ${config.orgUrl ? '✓ configured' : '✗ missing'}`);
  console.log(`  - OMNI_ORG_ID: ${config.orgId ? '✓ configured' : '✗ missing'}`);
  console.log(`  - OMNI_WIDGET_ID: ${config.widgetId ? '✓ configured' : '✗ missing'}`);
  console.log(`  - OMNI_CPS_BOT_ID: ${config.cpsBotId ? '✓ configured' : '○ optional'}`);
  console.log('');
});

export default app;
