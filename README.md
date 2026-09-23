# Empire AI

A responsive multi-provider AI chat app built with React, Vite, TypeScript and Express.

## Providers
- Google Gemini
- xAI Grok
- Groq
- OpenRouter (GPT, DeepSeek, Perplexity and other compatible models)

## Local setup
1. Copy `.env.example` to `.env.local` or `.env`.
2. Add your own provider keys.
3. Run `npm install`.
4. Run `npm run build`.
5. Run `npm start`.
6. Open `http://localhost:3000`.

## Render
Create a **Web Service** from this repository.
- Build Command: `npm install && npm run build`
- Start Command: `npm start`
- Environment: Node
- Add environment variables from `.env.example` in Render.

Never commit real API keys. The frontend never receives server environment keys; requests are proxied through the Express server.

## Notes
- User-entered custom keys are stored locally in the browser and sent to the server only for the selected request.
- `ACCESS_CODE` is optional. If it is empty, Founder access is disabled.
- Rate limiting is enabled by default at 20 chat requests per minute per IP; change with `RATE_LIMIT_PER_MINUTE`.
