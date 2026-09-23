import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';

app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = Number(process.env.RATE_LIMIT_PER_MINUTE || 20);
const requestLog = new Map<string, number[]>();

function rateLimit(ip: string) {
  const now = Date.now();
  const recent = (requestLog.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_REQUESTS_PER_WINDOW) return false;
  recent.push(now);
  requestLog.set(ip, recent);
  return true;
}

function cleanText(value: unknown, max = 120_000) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function resolveKey(provider: string, clientKey?: string) {
  const supplied = cleanText(clientKey, 500).trim();
  if (supplied) return supplied;
  if (provider === 'gemini') return process.env.GEMINI_API_KEY || '';
  if (provider === 'xai') return process.env.XAI_API_KEY || '';
  if (provider === 'groq') return process.env.GROQ_API_KEY || '';
  if (provider === 'openrouter') return process.env.OPENROUTER_API_KEY || '';
  return '';
}

function sendSse(res: express.Response, payload: Record<string, unknown>) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendDone(res: express.Response) {
  res.write('data: [DONE]\n\n');
  res.end();
}

function normalizeMessages(messages: any[]) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => ['user', 'assistant', 'system'].includes(m?.role))
    .slice(-40)
    .map((m) => ({
      role: m.role,
      content: cleanText(m.content)
    }));
}

function buildSystemPrompt(custom: string) {
  const base = 'You are Empire AI, a helpful, accurate, concise general-purpose AI assistant. Follow the user request, state uncertainty when needed, and use Markdown for readable answers.';
  return custom.trim() ? `${base}\n\nAdditional user instructions:\n${custom.trim()}` : base;
}

async function streamOpenAICompatible({
  url,
  key,
  model,
  messages,
  headers = {}
}: {
  url: string;
  key: string;
  model: string;
  messages: any[];
  headers?: Record<string, string>;
}, res: express.Response, signal: AbortSignal) {
  const upstream = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify({ model, messages, stream: true, temperature: 0.7 })
  });

  if (!upstream.ok) {
    const body = await upstream.text();
    throw new Error(`Provider error (${upstream.status}): ${body.slice(0, 700)}`);
  }
  if (!upstream.body) throw new Error('Provider returned no stream.');

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data);
        const text = parsed?.choices?.[0]?.delta?.content;
        if (typeof text === 'string' && text) sendSse(res, { text });
      } catch {
        // Ignore malformed keep-alive chunks.
      }
    }
  }
}

async function streamGemini({ key, model, messages, systemPrompt }: { key: string; model: string; messages: any[]; systemPrompt: string }, res: express.Response, signal: AbortSignal) {
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
  const upstream = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { temperature: 0.7 }
    })
  });

  if (!upstream.ok) {
    const body = await upstream.text();
    throw new Error(`Gemini error (${upstream.status}): ${body.slice(0, 700)}`);
  }
  if (!upstream.body) throw new Error('Gemini returned no stream.');

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data) continue;
      try {
        const parsed = JSON.parse(data);
        const text = parsed?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('');
        if (text) sendSse(res, { text });
      } catch {
        // Ignore incomplete provider chunks.
      }
    }
  }
}

app.get('/api/config', (_req, res) => {
  res.json({
    hasServerGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    hasServerXaiKey: Boolean(process.env.XAI_API_KEY),
    hasServerGroqKey: Boolean(process.env.GROQ_API_KEY),
    hasServerOpenRouterKey: Boolean(process.env.OPENROUTER_API_KEY),
    hasPasskey: Boolean(process.env.ACCESS_CODE)
  });
});

app.post('/api/verify-passkey', (req, res) => {
  const configured = process.env.ACCESS_CODE || '';
  const supplied = cleanText(req.body?.passkey, 200).trim();
  if (!configured) return res.status(503).json({ success: false, message: 'Founder access is not configured on this deployment.' });
  if (supplied && supplied === configured) return res.json({ success: true, message: 'Access code verified. Founder mode unlocked.' });
  return res.status(401).json({ success: false, message: 'Invalid access code.' });
});

app.post('/api/chat/stream', async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  if (!rateLimit(ip)) return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });

  const provider = cleanText(req.body?.provider, 40).trim();
  const model = cleanText(req.body?.model, 160).trim();
  const clientKey = cleanText(req.body?.apiKey, 500).trim();
  const messages = normalizeMessages(req.body?.messages);
  const systemPrompt = buildSystemPrompt(cleanText(req.body?.systemPrompt, 12_000));

  if (!['gemini', 'xai', 'groq', 'openrouter'].includes(provider)) return res.status(400).json({ error: 'Unsupported AI provider.' });
  if (!model) return res.status(400).json({ error: 'No model selected.' });
  if (!messages.length) return res.status(400).json({ error: 'No messages provided.' });

  const key = resolveKey(provider, clientKey);
  if (!key) return res.status(400).json({ error: `No API key is configured for ${provider}. Add it in Settings or Render Environment Variables.` });

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const controller = new AbortController();
  const onClose = () => controller.abort();
  req.on('close', onClose);

  try {
    if (provider === 'gemini') {
      await streamGemini({ key, model, messages, systemPrompt }, res, controller.signal);
    } else {
      const compatibleMessages = [{ role: 'system', content: systemPrompt }, ...messages.filter((m) => m.role !== 'system')];
      const url = provider === 'xai' ? 'https://api.x.ai/v1/chat/completions' : provider === 'groq' ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions';
      const extraHeaders = provider === 'openrouter' ? {
        'HTTP-Referer': process.env.APP_URL || '',
        'X-Title': process.env.APP_NAME || 'Empire AI'
      } : {};
      await streamOpenAICompatible({ url, key, model, messages: compatibleMessages, headers: extraHeaders }, res, controller.signal);
    }
    if (!res.writableEnded) sendDone(res);
  } catch (error: any) {
    if (!res.writableEnded) {
      sendSse(res, { error: error?.message || 'AI provider request failed.' });
      sendDone(res);
    }
  } finally {
    req.off('close', onClose);
  }
});

const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath, { index: 'index.html' }));
app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));

app.listen(PORT, HOST, () => {
  console.log(`Empire AI server listening on ${HOST}:${PORT}`);
});
