# Omnichannel Headless Service

Runs the D365 Omnichannel Chat SDK server-side using Puppeteer in a Docker container.

## Setup

Create `.env` file (no quotes around values):
```
OMNI_ORG_URL=https://your-org.crm.dynamics.com
OMNI_ORG_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
OMNI_WIDGET_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
OMNI_CPS_BOT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

## Run

```bash
# Build
docker build -t omnichannel-headless .

# Start
docker run -d -p 3001:3001 --env-file .env --shm-size=512mb --name omnichannel-headless omnichannel-headless

# Logs
docker logs -f omnichannel-headless

# Stop
docker stop omnichannel-headless && docker rm omnichannel-headless
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check |
| POST | `/api/chat/session` | Create session |
| POST | `/api/chat/:id/start` | Start chat |
| POST | `/api/chat/:id/message` | Send message `{content: "..."}` |
| GET | `/api/chat/:id/transcript` | Get messages |
| POST | `/api/chat/:id/end` | End chat |
| DELETE | `/api/chat/:id` | Delete session |

## WebSocket

Connect to `ws://localhost:3001/ws?sessionId={id}` for real-time events:

- `message` - New message received
- `agentJoined` - Agent joined
- `agentLeft` - Agent left
- `typing` - Typing indicator

## Test Client

Open `websocket-test.html` in browser to test the API and WebSocket events.

### WebSocket disconnects
- Check network connectivity
- Implement reconnection logic in client
