# minimi: temporal-first research chat

## How it works

```text
Browser chat ──SSE──> one Responses API loop ──web_search (max 4 calls)──> answer + source annotations
     │                         ▲
     └── local user ID ──> SQLite conversation store
                                  │
                       date resolution + FTS retrieval
                                  └── dated turns assembled into context
```

Every turn is saved with an absolute UTC timestamp and the browser’s IANA timezone. Before the model runs, `chrono-node` plus small explicit weekday/month rules resolve the user’s first date reference against the current local calendar. SQLite FTS5 retrieves related turns, and exact local-date matches take priority. The model receives the current clock, the resolved range, and a small set of timestamped records. An absent match is explicit context, so it can say it has no record instead of inventing one.

The model gets one tool: OpenAI’s hosted `web_search`. `tool_choice` stays automatic for ordinary conversation and memory lookup; a small freshness rule requires search for concrete current checks. Search is capped at four built-in calls. Responses stream as SSE, and citation annotations become inline links and source cards. The browser talks only to the local server; the OpenAI key stays in `.env`.

## Why this shape

The challenge is time plus recall, not planning. Calendar math and exact-date lookup are deterministic and cheap, so they happen before generation. FTS handles topic recall across chats without embedding every message or another model call. The final model sees only the current thread window and a bounded set of relevant past turns. SQLite keeps that index and conversation history durable across restarts. A single streamed model loop keeps the answer path explainable and lets the model decide when ordinary questions need no search.

I chose hosted search to keep the public app to one API key and receive search-grounded citation annotations directly in the response. A custom Tavily/Exa/Brave function could expose query arrays and date filters more explicitly, but would add another key, custom result normalization, and a client-side tool loop. Here the model can refine multiple searches internally, while `max_tool_calls` bounds the work.

## Considered and rejected

- **Planner, critic, or sub-agents:** extra latency and coordination for a problem with one retrieval step and one answer.
- **Vector database:** semantic recall is useful at larger scale, but exact dates are keys, and FTS is enough for a personal chat log.
- **History as a model tool:** adds a round trip and spends the only-tool budget on something local code can resolve directly.
- **A heavy agent framework:** obscures the prompt, search policy, persistence, and tool limit that reviewers need to inspect.
- **Always-on search:** slower and noisy for greetings or “what did I ask?” Memory questions use the model’s automatic tool choice.

## With another week

Add structured claim extraction for old answers, then verify each price or feature against dated official pages. Cache normalized search results with a short freshness window. Expand the eval set with live vendor changes, daylight-saving boundaries, conflicting publication dates, and long-history retrieval; track answer quality, citation coverage, tool calls, and latency over time. Add user-controlled export and deletion before supporting multiple users beyond a local browser profile.
