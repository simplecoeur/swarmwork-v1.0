'use strict';
/*
 * 本地假 LLM（OpenAI 兼容），仅用于测试，不联网、不花钱。
 * 启动：node tools/mock-llm.js （端口默认 8791，可用环境变量 MOCK_PORT 覆盖）
 * 行为：
 * - 普通（工人/拆单）请求 → 返回固定文案，usage {prompt_tokens:100, completion_tokens:50}
 * - 审核请求（system 含「审核员」或 user 以「请审核以下成果」开头）→ 按 MOCK_REVIEW_MODE 决定：
 *     pass（默认）→ {"pass":true,"reason":"符合标准"}
 *     fail-once   → 第 1 次审核不过、之后通过（打回重做分支）
 *     fail-always → 每次都不过（待裁决分支）
 * - 环境变量 MOCK_NO_USAGE=1 → 响应不带 usage（验证估算口径）
 * - 计次接口 GET /__counts → {chat, review} 调用次数（测试断言用）
 * - 请求回显 GET /__requests → [{kind:'chat'|'review', user}] 历次请求的 user 内容
 *   （截断 8000 字），供集成测试断言 prompt 注入确实到达模型侧
 */
const http = require('http');
const PORT = parseInt(process.env.MOCK_PORT || '8791', 10);
const REVIEW_MODE = process.env.MOCK_REVIEW_MODE || 'pass';
const NO_USAGE = process.env.MOCK_NO_USAGE === '1';

let chatCount = 0;
let reviewCount = 0;
const seenRequests = [];

const server = http.createServer((req, res) => {
  let s = '';
  req.on('data', (c) => {
    s += c;
  });
  req.on('end', () => {
    if (req.method === 'GET' && req.url.startsWith('/__counts')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ chat: chatCount, review: reviewCount }));
    }
    if (req.method === 'GET' && req.url.startsWith('/__requests')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(seenRequests));
    }
    if (req.method !== 'POST' || !req.url.startsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    let j = {};
    try {
      j = JSON.parse(s || '{}');
    } catch {
      /* 忽略 */
    }
    const msgs = j.messages || [];
    const sys = (msgs.find((m) => m.role === 'system') || {}).content || '';
    const usr = (msgs.filter((m) => m.role === 'user').pop() || {}).content || '';
    const isReview = sys.includes('审核员') || usr.startsWith('请审核以下成果');
    seenRequests.push({ kind: isReview ? 'review' : 'chat', user: usr.slice(0, 8000) });
    let content;
    if (isReview) {
      reviewCount++;
      if (REVIEW_MODE === 'fail-always' || (REVIEW_MODE === 'fail-once' && reviewCount === 1)) {
        content = '{"pass":false,"reason":"未满足审核要点：标题必须带数字（mock 打回）"}';
      } else {
        content = '{"pass":true,"reason":"符合标准"}';
      }
    } else {
      chatCount++;
      content =
        '这是由本地 mock 引擎生成的测试成果正文：结构完整、内容充实，专用于验证干活蜂群的任务流水线（执行→审核→交付）是否跑通。';
    }
    const payload = {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: j.model || 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    };
    if (!NO_USAGE) {
      payload.usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});
server.listen(PORT, () => console.log('mock-llm 已启动： http://127.0.0.1:' + PORT));
