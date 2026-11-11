# Daymark

A temporal-first research chat built for the minimi hiring challenge. Daymark searches the live web for current claims and remembers what you asked in earlier chats. Built with Node.js, Express, SQLite, and the OpenAI Responses API.

## Run locally

Requirements: Node.js 20 or newer.

```sh
npm install
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). If `OPENAI_API_KEY` is not set in the environment, the app asks for it on first launch and saves it in `data/settings.json` with user-only file permissions. It is not stored in browser storage, chat history, or Git. The local server uses it for OpenAI requests. `OPENAI_MODEL` and `PORT` are optional; the default model is `gpt-6-astra`.

## Memory and privacy

Conversations and local settings are stored under `data/`, which is ignored by Git. Each browser profile has its own local history ID. The UI can delete one conversation or clear all of its history. To answer a follow-up, Daymark sends the current thread and a bounded selection of relevant dated turns to the model API; it does not upload the full SQLite database. The API key is plain text protected by local file permissions, not encrypted. Do not expose this local server to other users without adding authentication and access controls.

## Quality checks

`evals/cases.json` contains the challenge prompts and temporal, missing-history, retrieval, and freshness variants. Run `npm run evals -- --offline` to check date resolution and memory retrieval without a key. With an API key configured, run `npm run evals` to replay the prompts live. Use `npm run evals -- --case crm-follow-up` or `-- --limit 2` for a smaller live run. Live evals make API calls and report response time, search calls, citation count, and simple answer assertions.

See [DESIGN.md](./DESIGN.md) for the architecture and trade-offs.
