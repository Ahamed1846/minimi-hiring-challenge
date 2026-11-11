import 'dotenv/config';
import OpenAI from 'openai';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { MemoryStore } from '../src/memory.js';
import { runAgent, shouldRequireSearch } from '../src/agent.js';
import { currentLocalContext } from '../src/temporal.js';

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(await readFile(resolve(here, 'cases.json'), 'utf8'));
const args = process.argv.slice(2);
const caseArg = args.find((arg) => arg.startsWith('--case='))?.slice(7);
const limitArg = args.find((arg) => arg.startsWith('--limit='))?.slice(8);
const offline = args.includes('--offline');
let selected = caseArg ? cases.filter((item) => item.id === caseArg) : cases;
if (limitArg) selected = selected.slice(0, Number(limitArg));

if (!offline && !process.env.OPENAI_API_KEY) {
  console.error('Set OPENAI_API_KEY in .env before running live evals.');
  process.exit(2);
}
if (!selected.length) {
  console.error(`No eval case matched ${caseArg || 'the requested selection'}.`);
  process.exit(2);
}

const openai = offline ? null : new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const outcomes = [];
for (const testCase of selected) {
  const store = new MemoryStore(':memory:');
  const userId = `eval-${testCase.id}`;
  const chats = new Map();
  const getChat = (chatName, createdAt) => {
    if (!chats.has(chatName)) {
      chats.set(chatName, store.createConversation(userId, `Eval · ${chatName}`, createdAt));
    }
    return chats.get(chatName);
  };
  for (const turn of testCase.turns) {
    const conversation = getChat(turn.chat || 'main', turn.at);
    store.addMessage({
      userId,
      conversationId: conversation.id,
      role: turn.role,
      content: turn.content,
      createdAt: turn.at,
      timezone: testCase.timezone,
    });
  }
  const activeChat = getChat(testCase.activeChat || 'main', testCase.now);
  const question = store.addMessage({
    userId,
    conversationId: activeChat.id,
    role: 'user',
    content: testCase.prompt,
    createdAt: testCase.now,
    timezone: testCase.timezone,
  });
  const instant = new Date(testCase.now);
  const clock = { ...currentLocalContext(testCase.timezone, instant), timeZone: testCase.timezone };
  const memory = store.buildContext({
    userId,
    conversationId: activeChat.id,
    question: testCase.prompt,
    timezone: testCase.timezone,
    localDate: clock.date,
    currentMessageId: question.id,
  });
  if (offline) {
    const checks = testCase.checks || {};
    const failures = [];
    const date = memory.dateReference;
    if (checks.expectedDate && date?.start !== checks.expectedDate) failures.push(`resolved ${date?.start || 'no date'}, expected ${checks.expectedDate}`);
    if (checks.expectedDateEnd && date?.end !== checks.expectedDateEnd) failures.push(`range ended ${date?.end || 'no date'}, expected ${checks.expectedDateEnd}`);
    if (typeof checks.expectDateFound === 'boolean' && Boolean(date?.found) !== checks.expectDateFound) {
      failures.push(`date lookup found=${Boolean(date?.found)}, expected ${checks.expectDateFound}`);
    }
    if (checks.contextContainsAny?.length && !checks.contextContainsAny.some((term) => memory.memoryContext.toLowerCase().includes(term.toLowerCase()))) {
      failures.push(`retrieved context did not contain any of: ${checks.contextContainsAny.join(', ')}`);
    }
    outcomes.push({ id: testCase.id, pass: failures.length === 0, failures, date: date?.start || null, retrievedTurns: memory.retrievedCount });
    store.close();
    continue;
  }
  const startedAt = performance.now();
  let result;
  try {
    result = await runAgent({ openai, question: testCase.prompt, memory, clock });
  } catch (error) {
    outcomes.push({ id: testCase.id, pass: false, error: error.message });
    store.close();
    continue;
  }
  const elapsedMs = Math.round(performance.now() - startedAt);
  const checks = testCase.checks || {};
  const failures = [];
  const required = shouldRequireSearch(testCase.prompt, memory);
  if (typeof checks.requireSearch === 'boolean' && required !== checks.requireSearch) failures.push(`policy search=${required}, expected ${checks.requireSearch}`);
  if (checks.requireSearch && !result.searched) failures.push('expected at least one web search call');
  if (checks.requireCitations && !result.sources.length) failures.push('expected cited sources');
  if (checks.mentionAny?.length && !checks.mentionAny.some((term) => result.answer.toLowerCase().includes(term.toLowerCase()))) {
    failures.push(`answer did not mention any of: ${checks.mentionAny.join(', ')}`);
  }
  if (checks.acknowledgeMissing && !/no (saved|record|history|matching)|don't have|do not have|can't see|cannot see/i.test(result.answer)) {
    failures.push('answer did not acknowledge missing history');
  }
  if (checks.requireUncertainty && !/could(n't| not) verify|unclear|not (confirmed|verified)|unable to confirm|can't confirm/i.test(result.answer)) {
    failures.push('answer did not distinguish missing evidence from no change');
  }
  outcomes.push({
    id: testCase.id,
    pass: failures.length === 0,
    failures,
    elapsedMs,
    searchCalls: result.searchCalls,
    citations: result.sources.length,
    retrievedTurns: memory.retrievedCount,
    tokens: result.usage?.total_tokens ?? null,
  });
  store.close();
}

for (const outcome of outcomes) {
  const flag = outcome.pass ? 'PASS' : 'FAIL';
  const details = outcome.error ? ` · ${outcome.error}`
    : offline ? ` · date ${outcome.date || '—'} · ${outcome.retrievedTurns} retrieved turns`
      : ` · ${outcome.elapsedMs} ms · ${outcome.searchCalls} searches · ${outcome.citations} citations · ${outcome.retrievedTurns} retrieved turns`;
  console.log(`${flag} ${outcome.id}${details}`);
  for (const failure of outcome.failures || []) console.log(`  - ${failure}`);
}
const passed = outcomes.filter((outcome) => outcome.pass).length;
console.log(`\n${passed}/${outcomes.length} passed`);
if (passed !== outcomes.length) process.exitCode = 1;
