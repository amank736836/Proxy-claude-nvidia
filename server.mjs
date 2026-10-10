/**
 * Anthropic → NVIDIA NIM Proxy (Standalone)
 * Maps Claude Code CLI Anthropic API formats to OpenAI for NVIDIA NIM.
 */

import express from 'express'
import OpenAI from 'openai'
import dotenv from 'dotenv'

dotenv.config()

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || ''
const NVIDIA_BASE_URL = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1'
const DEFAULT_MODEL = process.env.NVIDIA_MODEL || 'moonshotai/kimi-k2.6'
const PORT = 8082
// Bind to loopback only by default: the proxy holds the NVIDIA API key and has
// no client authentication, so it must not be reachable from the network.
// Set HOST=0.0.0.0 explicitly if you really need LAN access.
const HOST = process.env.HOST || '127.0.0.1'

// ─── Rate Limiter (sliding-window, default 40 RPM) ───────────────────────────
const RPM_LIMIT = (() => {
  const n = Number(process.env.NVIDIA_RPM_LIMIT)
  return Number.isFinite(n) && n > 0 ? n : 40
})()
const RPM_WINDOW_MS = 60_000
const RPM_MAX_WAIT_MS = (() => {
  const n = Number(process.env.NVIDIA_RPM_MAX_WAIT_MS)
  return Number.isFinite(n) && n >= 0 ? n : 8000
})()
const RPM_429_BACKOFF_MS = (() => {
  const n = Number(process.env.NVIDIA_RPM_429_BACKOFF_MS)
  return Number.isFinite(n) && n >= 0 ? n : 15000
})()

const recentTimestamps = []   // ms timestamps of slots held (in-flight + recently completed)
let pausedUntil = 0           // ms; while Date.now() < pausedUntil, reject immediately (no queue)
let waitingCount = 0          // callers currently sleeping inside acquireSlot waiting for a slot

function trimWindow(now) {
  const cutoff = now - RPM_WINDOW_MS
  while (recentTimestamps.length && recentTimestamps[0] < cutoff) recentTimestamps.shift()
}

async function acquireSlot(res) {
  const now = Date.now()

  // Reactive backoff: upstream already 429'd us — don't pile on.
  if (now < pausedUntil) {
    const retryAfter = Math.ceil((pausedUntil - now) / 1000)
    res.setHeader('Retry-After', String(retryAfter))
    res.status(429).json({
      type: 'error',
      error: { type: 'rate_limit_error', message: `Proxy in backoff after upstream 429; retry in ${retryAfter}s` }
    })
    return false
  }

  trimWindow(now)

  // If we're under the cap, take a slot immediately.
  if (recentTimestamps.length < RPM_LIMIT) {
    recentTimestamps.push(now)
    return true
  }

  // At cap. Compute how long until the oldest slot ages out.
  const oldest = recentTimestamps[0]
  const waitMs = RPM_WINDOW_MS - (now - oldest)

  if (waitMs > RPM_MAX_WAIT_MS) {
    console.log(`[rl] 429 to client: would wait ${(waitMs/1000).toFixed(1)}s > ${RPM_MAX_WAIT_MS/1000}s cap`)
    res.setHeader('Retry-After', String(Math.ceil(waitMs / 1000)))
    res.status(429).json({
      type: 'error',
      error: { type: 'rate_limit_error', message: `Upstream rate limit (${RPM_LIMIT}/min) reached; retry in ${Math.ceil(waitMs/1000)}s` }
    })
    return false
  }

  // Queue: wait, then re-check and take the slot.
  waitingCount++
  const depth = waitingCount
  console.log(`[rl] queued ${depth} deep, wait=${(waitMs/1000).toFixed(1)}s`)
  await new Promise(r => setTimeout(r, waitMs))
  waitingCount = Math.max(0, waitingCount - 1)
  trimWindow(Date.now())
  recentTimestamps.push(Date.now())
  return true
}

function isRateLimitError(err) {
  if (!err) return false
  if (err.status === 429 || err.statusCode === 429) return true
  const msg = String(err.message ?? err)
  return /rate.?limit/i.test(msg) || /\b429\b/.test(msg)
}

function triggerUpstreamBackoff() {
  pausedUntil = Date.now() + RPM_429_BACKOFF_MS
  console.log(`[rl] upstream 429 → pausing limiter ${RPM_429_BACKOFF_MS/1000}s`)
}

const nvidia = new OpenAI({ apiKey: NVIDIA_API_KEY, baseURL: NVIDIA_BASE_URL })

const app = express()
app.use(express.json({ limit: '20mb' }))

// ─── Format Converters ────────────────────────────────────────────────────────
function toOpenAIMessages(system, anthropicMsgs) {
  const out = []
  if (system) out.push({ role: 'system', content: system })

  for (const msg of anthropicMsgs) {
    const { role, content } = msg

    if (typeof content === 'string') {
      out.push({ role, content })
      continue
    }
    if (!Array.isArray(content)) continue

    const toolResults = content.filter(b => b.type === 'tool_result')
    const rest = content.filter(b => b.type !== 'tool_result')

    if (rest.length > 0) {
      const toolCalls = rest.filter(b => b.type === 'tool_use')
      const textBlocks = rest.filter(b => b.type === 'text')
      const textContent = textBlocks.map(b => b.text).join('') || null

      if (toolCalls.length > 0) {
        out.push({
          role: 'assistant',
          content: textContent,
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) }
          }))
        })
      } else if (textContent) {
        out.push({ role, content: textContent })
      }
    }

    for (const tr of toolResults) {
      const resultText = typeof tr.content === 'string'
        ? tr.content
        : Array.isArray(tr.content)
          ? tr.content.map(c => c.text ?? JSON.stringify(c)).join('\n')
          : String(tr.content ?? '')
      out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: resultText })
    }
  }
  return out
}

function toOpenAITools(tools) {
  if (!tools?.length) return undefined
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? {} }
  }))
}

function toAnthropicResponse(completion, model) {
  const choice = completion.choices?.[0]
  const msg = choice?.message ?? {}
  const content = []

  if (msg.content) content.push({ type: 'text', text: msg.content })
  if (msg.tool_calls?.length) {
    for (const tc of msg.tool_calls) {
      let input = {}
      try { input = JSON.parse(tc.function.arguments || '{}') } catch {}
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input })
    }
  }

  const finishReason = choice?.finish_reason
  const stopReason = finishReason === 'tool_calls' ? 'tool_use' : finishReason === 'length' ? 'max_tokens' : 'end_turn'

  return {
    id: 'msg_' + (completion.id ?? Date.now()),
    type: 'message',
    role: 'assistant',
    content,
    model: model ?? completion.model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0
    }
  }
}

// ─── SSE Helper ─────────────────────────────────────────────────────
function sse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

// ─── Main Endpoint ────────────────────────────────────────────────────────────
app.post('/v1/messages', async (req, res) => {
  const { model, messages, tools, system, max_tokens, stream, temperature, top_p } = req.body
  const targetModel = model || DEFAULT_MODEL

  const openaiMessages = toOpenAIMessages(system, messages ?? [])
  const openaiTools = toOpenAITools(tools)

  const params = {
    model: targetModel,
    messages: openaiMessages,
    max_tokens: max_tokens ?? 8096,
    ...(temperature != null ? { temperature } : {}),
    ...(top_p != null ? { top_p } : {}),
    ...(openaiTools ? { tools: openaiTools, tool_choice: 'auto' } : {})
  }

  if (stream) {
    if (!(await acquireSlot(res))) return

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    const msgId = 'msg_' + Date.now()
    sse(res, {
      type: 'message_start',
      message: { id: msgId, type: 'message', role: 'assistant', content: [], model: targetModel, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
    })

    try {
      const oStream = await nvidia.chat.completions.create({ ...params, stream: true })
      let blockIndex = 0
      let textStarted = false
      const toolBlocks = {}

      for await (const chunk of oStream) {
        const delta = chunk.choices?.[0]?.delta
        const finish = chunk.choices?.[0]?.finish_reason
        const usage = chunk.usage

        if (delta?.content) {
          if (!textStarted) {
            sse(res, { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } })
            textStarted = true
          }
          sse(res, { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: delta.content } })
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const tcIdx = tc.index
            if (!toolBlocks[tcIdx]) {
              if (textStarted && !toolBlocks[tcIdx]) blockIndex++
              const bIdx = textStarted ? blockIndex : blockIndex++
              toolBlocks[tcIdx] = { blockIdx: bIdx, id: tc.id ?? `call_${tcIdx}`, name: tc.function?.name ?? '', args: '' }
              sse(res, {
                type: 'content_block_start', index: toolBlocks[tcIdx].blockIdx,
                content_block: { type: 'tool_use', id: toolBlocks[tcIdx].id, name: toolBlocks[tcIdx].name, input: {} }
              })
            }
            if (tc.function?.name && !toolBlocks[tcIdx].name) toolBlocks[tcIdx].name = tc.function.name
            if (tc.function?.arguments) {
              toolBlocks[tcIdx].args += tc.function.arguments
              sse(res, {
                type: 'content_block_delta', index: toolBlocks[tcIdx].blockIdx,
                delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
              })
            }
          }
        }

        if (finish) {
          if (textStarted) sse(res, { type: 'content_block_stop', index: 0 })
          for (const tb of Object.values(toolBlocks)) {
            sse(res, { type: 'content_block_stop', index: tb.blockIdx })
          }
          const stopReason = finish === 'tool_calls' ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn'
          sse(res, { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage?.completion_tokens ?? 0 } })
          sse(res, { type: 'message_stop' })
        }
      }
      res.end()

    } catch (err) {
      if (isRateLimitError(err)) triggerUpstreamBackoff()
      console.error('[proxy] Stream error:', err.message)
      try {
        const rateLimited = isRateLimitError(err)
        sse(res, {
          type: 'error',
          error: {
            type: rateLimited ? 'rate_limit_error' : 'api_error',
            message: rateLimited ? err.message : 'Upstream stream failed. See proxy logs for details.'
          }
        })
        res.end()
      } catch {}
    }
  } else {
    if (!(await acquireSlot(res))) return
    try {
      const completion = await nvidia.chat.completions.create(params)
      res.json(toAnthropicResponse(completion, targetModel))
    } catch (err) {
      if (isRateLimitError(err)) triggerUpstreamBackoff()
      console.error('[proxy] Error:', err.message)
      const rateLimited = isRateLimitError(err)
      res.status(rateLimited ? 429 : 500).json({
        type: 'error',
        error: {
          type: rateLimited ? 'rate_limit_error' : 'api_error',
          // Don't echo raw upstream error text to the client; it is logged above.
          message: rateLimited ? err.message : 'Upstream request failed. See proxy logs for details.'
        }
      })
    }
  }
})

app.get('/health', (_, res) => res.json({ status: 'ok', model: DEFAULT_MODEL, backend: NVIDIA_BASE_URL }))
app.get('/v1/models', (_, res) => res.json({ data: [{ id: DEFAULT_MODEL, object: 'model', owned_by: 'nvidia' }] }))

if (!NVIDIA_API_KEY) {
  console.warn('[proxy] WARNING: NVIDIA_API_KEY is not set. Upstream requests will fail.')
}

app.listen(PORT, HOST, () => {
  console.log(`\n🚀  GLOBAL Anthropic→NVIDIA Proxy running on http://${HOST}:${PORT}`)
  console.log(`📡  Backend : ${NVIDIA_BASE_URL}`)
  console.log(`🤖  Model   : ${DEFAULT_MODEL}`)
  console.log(`🚦  Rate limit: ${RPM_LIMIT}/min (queue cap ${RPM_MAX_WAIT_MS/1000}s, backoff ${RPM_429_BACKOFF_MS/1000}s on upstream 429)`)
  console.log(`\n   Point Claude Code at: ANTHROPIC_BASE_URL=http://localhost:${PORT}`)
  console.log(`   ANTHROPIC_API_KEY=sk-nvidia-proxy\n`)
})
