import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from './memory.js';
import { currentLocalContext } from './temporal.js';
import { MODEL, runAgent } from './agent.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dataDir = resolve(process.env.MINIMI_DATA_DIR || resolve(root, 'data'));
await mkdir(dataDir, { recursive: true });

const app = express();
const port = Number(process.env.PORT || 3000);
const store = new MemoryStore(resolve(dataDir, 'minimi.sqlite'));
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

app.disable('x-powered-by');
app.use(express.json({ limit: '128kb' }));
app.use(express.static(resolve(root, 'public'), { extensions: ['html'] }));

function validUserId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{10,80}$/.test(value);
}

function timezoneOf(value) {
  if (typeof value !== 'string' || value.length > 80) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value;
  } catch {
    return 'UTC';
  }
}

function requireUser(req, res) {
  const userId = req.body?.userId ?? req.query.userId ?? req.get('x-minimi-user');
  if (!validUserId(userId)) {
    res.status(400).json({ error: 'A valid local user ID is required.' });
    return null;
  }
  return userId;
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

app.get('/api/health', (_req, res) => {
  res.json({ ready: Boolean(openai), model: MODEL, needsApiKey: !openai });
});

app.get('/api/conversations', (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  res.json({ conversations: store.listConversations(userId) });
});

app.get('/api/conversations/:id', (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  const conversation = store.getConversation(userId, req.params.id);
  if (!conversation) return res.status(404).json({ error: 'Chat not found.' });
  res.json({ conversation, messages: store.getMessages(userId, req.params.id) });
});

app.delete('/api/conversations/:id', (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  res.json({ deleted: store.deleteConversation(userId, req.params.id) });
});

app.delete('/api/history', (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  store.clearHistory(userId);
  res.json({ cleared: true });
});

app.post('/api/chat', async (req, res) => {
  const userId = requireUser(req, res);
  if (!userId) return;
  if (!openai) {
    return res.status(503).json({ error: 'Add OPENAI_API_KEY to .env, then restart minimi.' });
  }

  const question = typeof req.body.message === 'string' ? req.body.message.trim() : '';
  if (!question) return res.status(400).json({ error: 'Write a message to start.' });
  if (question.length > 20_000) return res.status(413).json({ error: 'Messages are limited to 20,000 characters.' });

  const timezone = timezoneOf(req.body.timezone);
  const instant = new Date();
  const clock = { ...currentLocalContext(timezone, instant), timeZone: timezone };
  let conversation = req.body.conversationId
    ? store.getConversation(userId, req.body.conversationId)
    : null;
  if (req.body.conversationId && !conversation) return res.status(404).json({ error: 'Chat not found.' });
  if (!conversation) conversation = store.createConversation(userId, question.replace(/\s+/g, ' ').slice(0, 62) || 'New chat', instant.toISOString());

  const userMessage = store.addMessage({
    userId,
    conversationId: conversation.id,
    role: 'user',
    content: question,
    timezone,
    createdAt: instant.toISOString(),
  });
  const memory = store.buildContext({
    userId,
    conversationId: conversation.id,
    question,
    timezone,
    localDate: clock.date,
    currentMessageId: userMessage.id,
  });

  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  sendEvent(res, 'meta', { conversation, userMessage, clock, model: MODEL });
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const result = await runAgent({
      openai,
      question,
      memory,
      clock,
      abortSignal: controller.signal,
      onEvent: (event) => sendEvent(res, event.type, event),
    });
    const assistantMessage = store.addMessage({
      userId,
      conversationId: conversation.id,
      role: 'assistant',
      content: result.answer,
      timezone,
      citations: { sources: result.sources, markers: result.markers },
    });
    sendEvent(res, 'done', {
      ...result,
      assistantMessage: { ...assistantMessage, citations: result.sources, markers: result.markers },
      memory: { retrievedCount: memory.retrievedCount, dateReference: memory.dateReference },
    });
  } catch (error) {
    if (!controller.signal.aborted) {
      const message = error?.status === 401
        ? 'The API key was rejected. Check OPENAI_API_KEY in .env.'
        : error?.status === 429
          ? 'The API limit was reached. Please try again shortly.'
          : error?.message || 'Something went wrong while answering.';
      sendEvent(res, 'error', { message });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
});

app.get(/.*/, (_req, res) => res.sendFile(resolve(root, 'public/index.html')));

const server = app.listen(port, '127.0.0.1', () => {
  console.log(`minimi listening on http://127.0.0.1:${port}`);
  if (!openai) console.log('Set OPENAI_API_KEY in .env to enable chat.');
});

function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

