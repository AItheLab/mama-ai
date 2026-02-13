#!/usr/bin/env node

// src/index.ts
import { join as join5 } from "path";
import { Command } from "commander";

// src/channels/api.ts
import { randomUUID } from "crypto";
import { createServer } from "http";

// src/utils/logger.ts
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
var LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};
var _globalOptions = { level: "info" };
function initLogger(options) {
  _globalOptions = options;
  if (options.filePath) {
    const dir = dirname(options.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}
function shouldLog(level) {
  return LOG_LEVELS[level] >= LOG_LEVELS[_globalOptions.level];
}
function formatForStderr(entry) {
  const { timestamp, level, module, message, ...rest } = entry;
  const time = timestamp.split("T")[1]?.replace("Z", "") ?? timestamp;
  const prefix = `${time} [${level.toUpperCase().padEnd(5)}] [${module}]`;
  const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : "";
  return `${prefix} ${message}${extra}`;
}
function writeLog(entry) {
  if (_globalOptions.filePath) {
    try {
      appendFileSync(_globalOptions.filePath, `${JSON.stringify(entry)}
`);
    } catch {
    }
  }
  if (!_globalOptions.silent) {
    const formatted = formatForStderr(entry);
    process.stderr.write(`${formatted}
`);
  }
}
function createLogger(moduleName) {
  function log(level, message, context) {
    if (!shouldLog(level)) return;
    const entry = {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      level,
      module: moduleName,
      message,
      ...context
    };
    writeLog(entry);
  }
  return {
    debug: (message, context) => log("debug", message, context),
    info: (message, context) => log("info", message, context),
    warn: (message, context) => log("warn", message, context),
    error: (message, context) => log("error", message, context)
  };
}

// src/channels/api.ts
var logger = createLogger("channel:api");
function json(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
function parseJsonBody(body) {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}
function extractBearerToken(header) {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed.startsWith("Bearer ")) return null;
  return trimmed.slice(7).trim();
}
function isLocalhostHost(host) {
  return host === "127.0.0.1" || host === "localhost";
}
function createApiRequestHandler(options) {
  return async function handle(request) {
    const authToken = extractBearerToken(request.headers.authorization);
    if (authToken !== options.token) {
      return { status: 401, body: { error: "Unauthorized" } };
    }
    if (request.method === "POST" && request.pathname === "/api/message") {
      const body = parseJsonBody(request.body);
      const message = String(body.message ?? "").trim();
      if (!message) {
        return { status: 400, body: { error: "message is required" } };
      }
      const response = await options.agent.processMessage(message, "api");
      return {
        status: 200,
        body: {
          content: response.content,
          model: response.model,
          provider: response.provider
        }
      };
    }
    if (request.method === "GET" && request.pathname === "/api/status") {
      const status = typeof options.statusSnapshot === "function" && await options.statusSnapshot() || {
        status: "ok"
      };
      return { status: 200, body: status };
    }
    if (request.method === "GET" && request.pathname === "/api/jobs") {
      const jobs = options.scheduler ? await options.scheduler.listJobs() : [];
      return { status: 200, body: { jobs } };
    }
    if (request.method === "POST" && request.pathname === "/api/jobs") {
      if (!options.scheduler) {
        return { status: 503, body: { error: "Scheduler unavailable" } };
      }
      const body = parseJsonBody(request.body);
      const schedule = String(body.schedule ?? "").trim();
      const task = String(body.task ?? "").trim();
      const name = typeof body.name === "string" ? body.name : void 0;
      if (!schedule || !task) {
        return { status: 400, body: { error: "schedule and task are required" } };
      }
      const id = await options.scheduler.createJob({ name, schedule, task });
      return { status: 201, body: { id } };
    }
    if (request.method === "GET" && request.pathname === "/api/audit") {
      if (!options.auditStore) {
        return { status: 503, body: { error: "Audit store unavailable" } };
      }
      const limitRaw = request.searchParams.get("limit");
      const limit = Math.max(1, Math.min(100, Number.parseInt(limitRaw ?? "20", 10) || 20));
      const entries = options.auditStore.getRecent(limit);
      return { status: 200, body: { entries } };
    }
    if (request.method === "GET" && request.pathname === "/api/memory/search") {
      if (!options.memorySearch) {
        return { status: 503, body: { error: "Memory search unavailable" } };
      }
      const q = request.searchParams.get("q")?.trim() ?? "";
      if (!q) {
        return { status: 400, body: { error: "q is required" } };
      }
      const result = await options.memorySearch(q);
      return { status: 200, body: { result } };
    }
    if (request.method === "GET" && request.pathname === "/api/cost") {
      if (!options.costSnapshot) {
        return { status: 503, body: { error: "Cost tracker unavailable" } };
      }
      return { status: 200, body: options.costSnapshot() };
    }
    return { status: 404, body: { error: "Not found" } };
  };
}
function createApiChannel(options) {
  if (!isLocalhostHost(options.host)) {
    throw new Error("API channel must bind to localhost (127.0.0.1 or localhost).");
  }
  const token = options.token?.trim() ? options.token : randomUUID();
  const handler = createApiRequestHandler({
    token,
    agent: options.agent,
    scheduler: options.scheduler,
    auditStore: options.auditStore,
    memorySearch: options.memorySearch,
    costSnapshot: options.costSnapshot,
    statusSnapshot: options.statusSnapshot
  });
  let server = null;
  let boundPort = null;
  return {
    name: "api",
    async start() {
      server = createServer(async (req, res) => {
        try {
          if (!req.url || !req.method) {
            json(res, 404, { error: "Not found" });
            return;
          }
          const parsed = new URL(req.url, `http://${options.host}:${options.port}`);
          const response = await handler({
            method: req.method,
            pathname: parsed.pathname,
            searchParams: parsed.searchParams,
            headers: {
              authorization: req.headers.authorization
            },
            body: await readBody(req)
          });
          json(res, response.status, response.body);
        } catch (error) {
          json(res, 500, {
            error: error instanceof Error ? error.message : String(error)
          });
        }
      });
      await new Promise((resolve, reject) => {
        server?.once("error", reject);
        server?.listen(options.port, options.host, () => {
          const address = server?.address();
          if (address && typeof address !== "string") {
            boundPort = address.port;
          }
          resolve();
        });
      });
      logger.info("API channel started", {
        host: options.host,
        port: boundPort ?? options.port
      });
    },
    async stop() {
      if (!server) return;
      await new Promise((resolve, reject) => {
        server?.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      server = null;
      boundPort = null;
      logger.info("API channel stopped");
    },
    getToken() {
      return token;
    },
    getPort() {
      return boundPort;
    }
  };
}

// src/channels/telegram.ts
import { mkdirSync as mkdirSync2, writeFileSync } from "fs";
import { basename, join } from "path";
import { setTimeout as sleep } from "timers/promises";
var logger2 = createLogger("channel:telegram");
var TELEGRAM_MESSAGE_LIMIT = 4096;
var APPROVAL_TIMEOUT_MS = 5 * 6e4;
function splitMessage(text, limit = TELEGRAM_MESSAGE_LIMIT) {
  if (text.length <= limit) return [text];
  const lines = text.split("\n");
  const chunks = [];
  let current = "";
  for (const line of lines) {
    if (line.length > limit) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < line.length; i += limit) {
        chunks.push(line.slice(i, i + limit));
      }
      continue;
    }
    if ((current + (current ? "\n" : "") + line).length > limit) {
      if (current) chunks.push(current);
      current = line;
      continue;
    }
    current = current ? `${current}
${line}` : line;
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [text.slice(0, limit)];
}
function approvalKey(request) {
  return `${request.capability}:${request.action}:${request.resource}`;
}
function isAuthorized(allowedUserIds, fromId) {
  return allowedUserIds.includes(fromId);
}
function renderApprovalMessage(request) {
  return [
    "\u{1F512} Permission Request",
    `Action: ${request.capability}:${request.action}`,
    `Path/Resource: ${request.resource}`
  ].join("\n");
}
function normalizeDocumentName(fileName) {
  return basename(fileName).replace(/[^\w.-]/g, "_");
}
async function sendChunked(adapter, chatId, text, options = {}) {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await adapter.sendMessage(chatId, chunk, {
      parseMode: options.markdown ? "Markdown" : void 0,
      disableNotification: options.disableNotification
    });
  }
}
function createTelegramChannel(options) {
  const pendingById = /* @__PURE__ */ new Map();
  const alwaysApproved = /* @__PURE__ */ new Set();
  const chatByUser = /* @__PURE__ */ new Map();
  async function handleIncoming(message) {
    if (!isAuthorized(options.allowedUserIds, message.fromId)) {
      return;
    }
    chatByUser.set(message.fromId, message.chatId);
    if (message.voice) {
      await sendChunked(
        options.adapter,
        message.chatId,
        "Voice messages are not supported yet. Please send text for now."
      );
      return;
    }
    if (message.document) {
      mkdirSync2(options.workspacePath, { recursive: true });
      const fileName = normalizeDocumentName(message.document.fileName);
      const targetPath = join(options.workspacePath, fileName);
      writeFileSync(targetPath, message.document.content, "utf-8");
      const response2 = await options.agent.processMessage(
        `A document was uploaded to ${targetPath}. Please review and process it.`,
        "telegram"
      );
      await sendChunked(options.adapter, message.chatId, response2.content, { markdown: true });
      return;
    }
    const text = message.text?.trim() ?? "";
    if (!text) return;
    if (text.startsWith("/")) {
      await handleCommand(message.chatId, text);
      return;
    }
    const response = await options.agent.processMessage(text, "telegram");
    await sendChunked(options.adapter, message.chatId, response.content, { markdown: true });
  }
  async function handleCommand(chatId, input) {
    const [command, ...args] = input.trim().split(/\s+/);
    switch (command) {
      case "/status": {
        const status = typeof options.statusSnapshot === "function" && await options.statusSnapshot() || "Mama is running.";
        await sendChunked(options.adapter, chatId, String(status));
        return;
      }
      case "/jobs": {
        if (!options.scheduler) {
          await sendChunked(options.adapter, chatId, "Scheduler is not enabled.");
          return;
        }
        const jobs = await options.scheduler.listJobs();
        if (jobs.length === 0) {
          await sendChunked(options.adapter, chatId, "No scheduled jobs.");
          return;
        }
        const lines = jobs.map(
          (job) => `- ${job.id} | ${job.enabled ? "enabled" : "disabled"} | ${job.schedule} | ${job.name}`
        );
        await sendChunked(options.adapter, chatId, lines.join("\n"));
        return;
      }
      case "/audit": {
        if (!options.auditStore) {
          await sendChunked(options.adapter, chatId, "Audit store is not available.");
          return;
        }
        const entries = options.auditStore.getRecent(10);
        const lines = entries.map(
          (entry) => `- ${entry.timestamp.toISOString()} ${entry.capability}:${entry.action} ${entry.result}`
        );
        await sendChunked(options.adapter, chatId, lines.join("\n") || "No audit entries.");
        return;
      }
      case "/cost": {
        if (!options.costSnapshot) {
          await sendChunked(options.adapter, chatId, "Cost tracker is not available.");
          return;
        }
        const cost = options.costSnapshot();
        await sendChunked(
          options.adapter,
          chatId,
          [
            `Today: $${cost.todayCostUsd.toFixed(4)}`,
            `This month: $${cost.monthCostUsd.toFixed(4)}`,
            `Total: $${cost.totalCostUsd.toFixed(4)}`
          ].join("\n")
        );
        return;
      }
      case "/memory": {
        if (!options.memorySearch) {
          await sendChunked(options.adapter, chatId, "Memory search is not available.");
          return;
        }
        const query = args.join(" ").trim();
        if (!query) {
          await sendChunked(options.adapter, chatId, "Usage: /memory <query>");
          return;
        }
        const result = await options.memorySearch(query);
        await sendChunked(options.adapter, chatId, result);
        return;
      }
      default:
        await sendChunked(options.adapter, chatId, `Unknown command: ${command}`);
    }
  }
  async function handleCallback(callback) {
    if (!isAuthorized(options.allowedUserIds, callback.fromId)) {
      return;
    }
    const [action, approvalId] = callback.data.split(":");
    if (!approvalId) return;
    const pending = pendingById.get(approvalId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingById.delete(approvalId);
    if (action === "always") {
      alwaysApproved.add(pending.key);
      pending.resolve(true);
      await sendChunked(options.adapter, callback.chatId, "Approved and stored as always allow.");
      return;
    }
    const approved = action === "approve";
    pending.resolve(approved);
    await sendChunked(options.adapter, callback.chatId, approved ? "Approved." : "Denied.");
  }
  async function sendProactiveMessage(chatId, text, priority = "normal") {
    if (priority === "urgent") {
      for (let i = 0; i < 2; i++) {
        await sendChunked(options.adapter, chatId, text);
      }
      return;
    }
    const disableNotification = priority === "low";
    await sendChunked(options.adapter, chatId, text, { disableNotification });
  }
  function bindSandboxApproval() {
    if (!options.sandbox) return;
    options.sandbox.setApprovalHandler(async (request) => {
      const key = approvalKey(request);
      if (alwaysApproved.has(key)) return true;
      const chatId = chatByUser.get(options.allowedUserIds[0] ?? -1);
      if (!chatId) return false;
      const id = Math.random().toString(36).slice(2, 10);
      await options.adapter.sendMessage(chatId, renderApprovalMessage(request), {
        replyMarkup: {
          inline_keyboard: [
            [
              { text: "\u2705 Approve", callback_data: `approve:${id}` },
              { text: "\u274C Deny", callback_data: `deny:${id}` },
              { text: "\u{1F513} Always", callback_data: `always:${id}` }
            ]
          ]
        }
      });
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          pendingById.delete(id);
          resolve(false);
        }, APPROVAL_TIMEOUT_MS);
        pendingById.set(id, { id, chatId, resolve, timeout, key });
      });
    });
  }
  return {
    name: "telegram",
    async start() {
      if (!options.token) {
        throw new Error("Telegram token is required");
      }
      bindSandboxApproval();
      await options.adapter.start({
        onMessage: handleIncoming,
        onCallback: handleCallback
      });
      logger2.info("Telegram channel started");
    },
    async stop() {
      for (const pending of pendingById.values()) {
        clearTimeout(pending.timeout);
        pending.resolve(false);
      }
      pendingById.clear();
      await options.adapter.stop();
      logger2.info("Telegram channel stopped");
    },
    handleIncoming,
    handleCallback,
    sendProactiveMessage
  };
}
async function telegramApi(token, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`Telegram API ${method} failed with HTTP ${response.status}`);
  }
  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram API ${method} returned ok=false`);
  }
  return data.result;
}
async function downloadTelegramDocument(token, fileId) {
  const result = await telegramApi(token, "getFile", { file_id: fileId });
  const filePath = result.file_path;
  if (!filePath) return "";
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!response.ok) return "";
  return await response.text();
}
function createTelegramHttpAdapter(token) {
  let running = false;
  let offset = 0;
  let pollLoop = null;
  return {
    async start(handlers) {
      running = true;
      pollLoop = (async () => {
        while (running) {
          try {
            const updates = await telegramApi(token, "getUpdates", {
              timeout: 20,
              offset
            });
            for (const update of updates) {
              offset = Math.max(offset, update.update_id + 1);
              const message = update.message;
              if (message?.chat?.id && message.from?.id) {
                let documentContent = "";
                if (message.document?.file_id) {
                  documentContent = await downloadTelegramDocument(token, message.document.file_id);
                }
                await handlers.onMessage({
                  chatId: message.chat.id,
                  fromId: message.from.id,
                  text: message.text,
                  voice: Boolean(message.voice),
                  document: message.document?.file_name || message.document?.file_id ? {
                    fileName: message.document?.file_name ?? "document.txt",
                    content: documentContent
                  } : void 0
                });
              }
              const callback = update.callback_query;
              if (callback?.data && callback.from?.id && callback.message?.chat?.id) {
                await handlers.onCallback({
                  chatId: callback.message.chat.id,
                  fromId: callback.from.id,
                  data: callback.data
                });
              }
            }
          } catch (error) {
            logger2.warn("Telegram polling error", {
              error: error instanceof Error ? error.message : String(error)
            });
            await sleep(1e3);
          }
        }
      })();
    },
    async stop() {
      running = false;
      if (pollLoop) {
        await pollLoop.catch(() => void 0);
      }
      pollLoop = null;
    },
    async sendMessage(chatId, text, options) {
      await telegramApi(token, "sendMessage", {
        chat_id: chatId,
        text,
        parse_mode: options?.parseMode,
        disable_notification: options?.disableNotification,
        reply_markup: options?.replyMarkup
      });
    }
  };
}

// src/channels/terminal.tsx
import { Box, render, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useRef, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
function formatPlanForApproval(plan) {
  const stepLines = plan.steps.map((step) => `- ${step.id}. ${step.description} [${step.tool}]`);
  const riskLine = plan.risks.length > 0 ? `Risks: ${plan.risks.join("; ")}` : "Risks: none";
  return [
    "Plan requires approval:",
    `Goal: ${plan.goal}`,
    ...stepLines,
    `Estimated duration: ${plan.estimatedDuration}`,
    riskLine,
    "Approve? (yes/no)"
  ].join("\n");
}
function formatEvent(event) {
  switch (event.type) {
    case "tool_call_started":
      return `Running tool: ${event.toolName}`;
    case "tool_call_finished":
      return event.success ? `Tool finished: ${event.toolName}` : `Tool failed: ${event.toolName}${event.error ? ` (${event.error})` : ""}`;
    case "plan_created":
      return `Plan created with ${event.plan.steps.length} step(s).`;
    case "plan_approval_requested":
      return "Plan has side effects and needs approval.";
    case "plan_step_started":
      return `Step ${event.stepId} started: ${event.description}`;
    case "plan_step_finished":
      return `Step ${event.stepId} ${event.status} (${event.percentComplete}%)`;
    default:
      return null;
  }
}
function App({ agent, agentName, sandbox }) {
  const messageId = useRef(1);
  const [messages, setMessages] = useState([
    {
      id: "msg-0",
      role: "system",
      content: `${agentName} ready. Type your message. Ctrl+C to exit.`
    }
  ]);
  const [input, setInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [pendingDecision, setPendingDecision] = useState(null);
  const { exit } = useApp();
  const appendMessage = useCallback((message) => {
    const id = `msg-${messageId.current++}`;
    setMessages((prev) => [...prev, { id, ...message }]);
  }, []);
  useEffect(() => {
    if (!sandbox) return;
    sandbox.setApprovalHandler(async (request) => {
      return new Promise((resolve) => {
        appendMessage({
          role: "system",
          content: `Approval needed (${request.capability}:${request.action}) on "${request.resource}". Approve? (yes/no)`
        });
        setPendingDecision({ kind: "sandbox", request, resolve });
      });
    });
  }, [appendMessage, sandbox]);
  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      exit();
    }
  });
  const handleSubmit = useCallback(
    async (value) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      if (pendingDecision) {
        const normalized = trimmed.toLowerCase();
        if (!["y", "yes", "n", "no"].includes(normalized)) {
          appendMessage({
            role: "system",
            content: "Please answer with yes or no."
          });
          setInput("");
          return;
        }
        const approved = normalized === "y" || normalized === "yes";
        pendingDecision.resolve(approved);
        setPendingDecision(null);
        setInput("");
        appendMessage({
          role: "system",
          content: approved ? "Approved." : "Denied."
        });
        return;
      }
      if (isProcessing) return;
      setInput("");
      appendMessage({ role: "user", content: trimmed });
      setIsProcessing(true);
      try {
        const response = await agent.processMessage(trimmed, "terminal", {
          onEvent(event) {
            const eventText = formatEvent(event);
            if (eventText) {
              appendMessage({ role: "system", content: eventText });
            }
          },
          onPlanApproval(plan) {
            return new Promise((resolve) => {
              appendMessage({
                role: "system",
                content: formatPlanForApproval(plan)
              });
              setPendingDecision({ kind: "plan", plan, resolve });
            });
          }
        });
        appendMessage({
          role: "assistant",
          content: response.content,
          model: response.model
        });
      } catch (err) {
        appendMessage({
          role: "system",
          content: `Error: ${err instanceof Error ? err.message : String(err)}`
        });
      } finally {
        setIsProcessing(false);
      }
    },
    [agent, appendMessage, isProcessing, pendingDecision]
  );
  const visibleMessages = messages.slice(-20);
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", padding: 1, children: [
    /* @__PURE__ */ jsxs(Box, { marginBottom: 1, children: [
      /* @__PURE__ */ jsxs(Text, { bold: true, color: "magenta", children: [
        "\u{1F931} ",
        agentName
      ] }),
      /* @__PURE__ */ jsx(Text, { color: "gray", children: " \u2014 Personal AI Agent" })
    ] }),
    /* @__PURE__ */ jsx(Box, { flexDirection: "column", marginBottom: 1, children: visibleMessages.map((msg) => /* @__PURE__ */ jsxs(Box, { marginBottom: 0, children: [
      msg.role === "user" && /* @__PURE__ */ jsxs(Text, { children: [
        /* @__PURE__ */ jsx(Text, { color: "cyan", bold: true, children: "You: " }),
        /* @__PURE__ */ jsx(Text, { children: msg.content })
      ] }),
      msg.role === "assistant" && /* @__PURE__ */ jsxs(Text, { children: [
        /* @__PURE__ */ jsx(Text, { color: "magenta", bold: true, children: `${agentName}: ` }),
        /* @__PURE__ */ jsx(Text, { children: msg.content }),
        msg.model && /* @__PURE__ */ jsx(Text, { color: "gray", children: ` [${msg.model}]` })
      ] }),
      msg.role === "system" && /* @__PURE__ */ jsx(Text, { color: "yellow", dimColor: true, children: msg.content })
    ] }, msg.id)) }),
    /* @__PURE__ */ jsx(Box, { children: pendingDecision ? /* @__PURE__ */ jsxs(Box, { flexDirection: "column", children: [
      /* @__PURE__ */ jsx(Text, { color: "yellow", children: pendingDecision.kind === "sandbox" ? "Awaiting sandbox approval (yes/no)..." : "Awaiting plan approval (yes/no)..." }),
      /* @__PURE__ */ jsxs(Box, { children: [
        /* @__PURE__ */ jsx(Text, { color: "cyan", bold: true, children: "> " }),
        /* @__PURE__ */ jsx(TextInput, { value: input, onChange: setInput, onSubmit: handleSubmit })
      ] })
    ] }) : isProcessing ? /* @__PURE__ */ jsx(Text, { color: "yellow", children: "\u23F3 Working..." }) : /* @__PURE__ */ jsxs(Box, { children: [
      /* @__PURE__ */ jsx(Text, { color: "cyan", bold: true, children: "> " }),
      /* @__PURE__ */ jsx(TextInput, { value: input, onChange: setInput, onSubmit: handleSubmit })
    ] }) })
  ] });
}
function startTerminal(agent, agentName, sandbox) {
  const instance = render(/* @__PURE__ */ jsx(App, { agent, agentName, sandbox }));
  instance.waitUntilExit().then(() => {
    process.exit(0);
  });
}

// src/cli/cost.ts
function formatUsd(value) {
  return `$${value.toFixed(4)}`;
}
function formatInt(value) {
  return value.toLocaleString("en-US");
}
function recordsForPeriod(tracker, period) {
  switch (period) {
    case "today":
      return tracker.getUsageToday();
    case "week":
      return tracker.getUsageThisWeek();
    case "month":
      return tracker.getUsageThisMonth();
    default:
      return tracker.getRecords();
  }
}
async function withTracker(options, configPath, run) {
  const services = await options.resolveTracker(configPath);
  try {
    return await run(services.tracker);
  } finally {
    services.close();
  }
}
function registerCostCommand(program2, options) {
  program2.command("cost").option("-c, --config <path>", "Path to config file").option("--period <period>", "today|week|month|all", "today").description("Show LLM usage and cost dashboard").action(async (commandOptions) => {
    try {
      await withTracker(options, commandOptions.config, async (tracker) => {
        const period = ["today", "week", "month", "all"].includes(
          commandOptions.period
        ) ? commandOptions.period : "today";
        const records = recordsForPeriod(tracker, period);
        const summary = tracker.summarize(records);
        process.stdout.write(`Cost dashboard (${period})
`);
        process.stdout.write(
          `Records: ${records.length} | Input tokens: ${formatInt(summary.totalInputTokens)} | Output tokens: ${formatInt(summary.totalOutputTokens)}
`
        );
        process.stdout.write(
          `Total cost: ${formatUsd(summary.totalCostUsd)} | Avg/day: ${formatUsd(summary.averageCostPerDayUsd)}
`
        );
        process.stdout.write("\nBy model:\n");
        const modelEntries = Object.entries(summary.byModel).sort(
          (a, b) => b[1].costUsd - a[1].costUsd
        );
        if (modelEntries.length === 0) {
          process.stdout.write("(no usage records)\n");
          return;
        }
        for (const [model, stats] of modelEntries) {
          process.stdout.write(
            `- ${model}: in=${formatInt(stats.inputTokens)} out=${formatInt(stats.outputTokens)} cost=${formatUsd(stats.costUsd)}
`
          );
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Error: ${message}
`);
      process.exitCode = 1;
    }
  });
}

// src/cli/init.ts
import { copyFileSync, existsSync as existsSync2, mkdirSync as mkdirSync3, readFileSync, writeFileSync as writeFileSync2 } from "fs";
import { homedir as homedir2 } from "os";
import { dirname as dirname2, join as join3 } from "path";
import { createInterface } from "readline/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// src/config/defaults.ts
import { homedir, platform } from "os";
import { join as join2 } from "path";
function getMamaHome() {
  const envHome = process.env.MAMA_HOME;
  if (envHome) return envHome;
  const home = homedir();
  const os2 = platform();
  if (os2 === "darwin") {
    return join2(home, ".mama");
  }
  const xdgData = process.env.XDG_DATA_HOME;
  if (xdgData) {
    return join2(xdgData, "mama");
  }
  return join2(home, ".mama");
}
function getDefaultConfigPath() {
  return join2(getMamaHome(), "config.yaml");
}

// src/cli/init.ts
function resolveTemplatePath(name) {
  return join3(process.cwd(), "templates", name);
}
function ensureMamaStructure(mamaHome) {
  for (const dir of ["logs", "workspace", "notes", "skills"]) {
    mkdirSync3(join3(mamaHome, dir), { recursive: true });
  }
}
function askOrDefault(question, current, defaultValue, yes) {
  if (current !== void 0) return Promise.resolve(current);
  if (yes) return Promise.resolve(defaultValue);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return rl.question(`${question} [${defaultValue}]: `).then((answer) => answer.trim() || defaultValue).finally(() => rl.close());
}
async function collectAnswers(options) {
  const name = await askOrDefault("Your name", options.name, "Alex", Boolean(options.yes));
  const claudeApiKey = await askOrDefault(
    "Claude API key (optional)",
    options.claudeApiKey,
    "",
    Boolean(options.yes)
  );
  const telegramToken = await askOrDefault(
    "Telegram bot token (optional)",
    options.telegramToken,
    "",
    Boolean(options.yes)
  );
  return { name, claudeApiKey, telegramToken };
}
function renderConfig(template, answers) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  const parsed = parseYaml(template);
  const user = parsed.user ?? {};
  user.name = answers.name;
  user.timezone = timezone;
  user.locale = locale;
  parsed.user = user;
  const channels = parsed.channels ?? {};
  const telegram = channels.telegram ?? {};
  telegram.bot_token = answers.telegramToken || `\${MAMA_TELEGRAM_TOKEN}`;
  channels.telegram = telegram;
  parsed.channels = channels;
  const llm = parsed.llm ?? {};
  const providers = llm.providers ?? {};
  const claude = providers.claude ?? {};
  claude.api_key = answers.claudeApiKey;
  claude.default_model = claude.default_model ?? "claude-sonnet-4-20250514";
  claude.max_monthly_budget_usd = claude.max_monthly_budget_usd ?? 50;
  providers.claude = claude;
  llm.providers = providers;
  parsed.llm = llm;
  return stringifyYaml(parsed);
}
function writeConfig(configPath, answers, force = false) {
  const template = readFileSync(resolveTemplatePath("config.default.yaml"), "utf-8");
  const config = renderConfig(template, answers);
  if (existsSync2(configPath) && !force) {
    throw new Error(`Config already exists at ${configPath}. Use --force to overwrite.`);
  }
  mkdirSync3(dirname2(configPath), { recursive: true });
  writeFileSync2(configPath, config, "utf-8");
}
function copyTemplateIfMissing(srcName, destPath) {
  if (existsSync2(destPath)) return;
  copyFileSync(resolveTemplatePath(srcName), destPath);
}
function registerInitCommand(program2) {
  program2.command("init").description("Initialize Mama home directory and default configuration").option("--name <name>", "User name").option("--claude-api-key <key>", "Claude API key").option("--telegram-token <token>", "Telegram bot token").option("-y, --yes", "Use defaults and skip interactive prompts").option("--force", "Overwrite existing config").action(async (options) => {
    try {
      const result = await runInit(options);
      process.stdout.write(`Initialized Mama at ${result.mamaHome}
`);
      process.stdout.write(`Config: ${result.configPath}
`);
      process.stdout.write(`Workspace: ${join3(result.mamaHome, "workspace")}
`);
      process.stdout.write(`Next: run "mama chat"
`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Error: ${message}
`);
      process.exitCode = 1;
    }
  });
}
async function runInit(options) {
  const mamaHome = getMamaHome();
  ensureMamaStructure(mamaHome);
  const answers = await collectAnswers(options);
  const configPath = getDefaultConfigPath();
  writeConfig(configPath, answers, options.force);
  copyTemplateIfMissing("SOUL.md", join3(mamaHome, "soul.md"));
  copyTemplateIfMissing("heartbeat.md", join3(mamaHome, "heartbeat.md"));
  return {
    mamaHome,
    configPath
  };
}

// src/cli/jobs.ts
function writeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}
`);
}
async function withScheduler(options, configPath, run) {
  const services = await options.resolveScheduler(configPath);
  try {
    return await run(services.scheduler);
  } finally {
    services.close();
  }
}
function formatDate(value) {
  return value ? value.toISOString() : "-";
}
function registerJobsCommands(program2, options) {
  const jobs = program2.command("jobs").description("Scheduled job operations");
  jobs.command("list").option("-c, --config <path>", "Path to config file").option("--enabled", "Show only enabled jobs").description("List scheduled jobs").action(async (commandOptions) => {
    try {
      const rows = await withScheduler(
        options,
        commandOptions.config,
        (scheduler2) => scheduler2.listJobs()
      );
      const jobsToPrint = commandOptions.enabled ? rows.filter((job) => job.enabled) : rows;
      if (jobsToPrint.length === 0) {
        process.stdout.write("No scheduled jobs found.\n");
        return;
      }
      for (const job of jobsToPrint) {
        process.stdout.write(
          `${job.id} | ${job.enabled ? "enabled" : "disabled"} | ${job.schedule} | ${job.name}
`
        );
        process.stdout.write(
          `  task="${job.task}" | runs=${job.runCount} | last=${formatDate(job.lastRun)} | next=${formatDate(job.nextRun)}
`
        );
      }
    } catch (error) {
      writeError(error);
      process.exitCode = 1;
    }
  });
  jobs.command("create").argument("<schedule>", "Cron expression or natural language schedule").argument("<task>", "Task description").option("-n, --name <name>", "Optional job name").option("-c, --config <path>", "Path to config file").description("Create a scheduled job").action(
    async (schedule, task, commandOptions) => {
      try {
        const id = await withScheduler(
          options,
          commandOptions.config,
          (scheduler2) => scheduler2.createJob({ name: commandOptions.name, schedule, task })
        );
        process.stdout.write(`Created job ${id}
`);
      } catch (error) {
        writeError(error);
        process.exitCode = 1;
      }
    }
  );
  for (const action of ["enable", "disable", "delete"]) {
    jobs.command(action).argument("<id>", "Job id").option("-c, --config <path>", "Path to config file").description(`${action[0]?.toUpperCase()}${action.slice(1)} a scheduled job`).action(async (id, commandOptions) => {
      try {
        await withScheduler(options, commandOptions.config, async (scheduler2) => {
          if (action === "enable") {
            await scheduler2.enableJob(id);
          } else if (action === "disable") {
            await scheduler2.disableJob(id);
          } else {
            await scheduler2.deleteJob(id);
          }
        });
        process.stdout.write(`${action}d job ${id}
`);
      } catch (error) {
        writeError(error);
        process.exitCode = 1;
      }
    });
  }
}

// src/cli/memory.ts
var CATEGORY_VALUES = [
  "fact",
  "preference",
  "pattern",
  "goal",
  "relationship",
  "skill",
  "routine",
  "emotional",
  "project"
];
function withColor(text, code, colors) {
  if (!colors.enabled) return text;
  return `\x1B[${code}m${text}\x1B[0m`;
}
function title(text, colors) {
  return withColor(text, "1;36", colors);
}
function section(text, colors) {
  return withColor(text, "1;33", colors);
}
function ok(text, colors) {
  return withColor(text, "32", colors);
}
function dim(text, colors) {
  return withColor(text, "90", colors);
}
function danger(text, colors) {
  return withColor(text, "31", colors);
}
function clampLimit(value, fallback) {
  if (!value || Number.isNaN(value)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(value)));
}
function summarizeContent(content, max = 140) {
  if (content.length <= max) return content;
  return `${content.slice(0, max - 3)}...`;
}
function formatDate2(value) {
  return value.toISOString().replace("T", " ").replace(".000Z", "Z");
}
function formatConsolidatedMemoryLine(index, memory, colors) {
  const meta = dim(
    `${memory.id} | ${memory.category} | confidence=${memory.confidence.toFixed(2)} | active=${memory.active ? "yes" : "no"} | reinforced=${memory.reinforcementCount}`,
    colors
  );
  const content = summarizeContent(memory.content, 220);
  return `${index}. ${content}
   ${meta}`;
}
function formatEpisodeLine(index, episode, colors) {
  const meta = dim(
    `${episode.id} | ${episode.role} | ${episode.channel} | ${formatDate2(episode.timestamp)}`,
    colors
  );
  const content = summarizeContent(episode.content, 200);
  return `${index}. ${content}
   ${meta}`;
}
function readCount(store, sql) {
  const row = store.get(sql);
  return row?.count ?? 0;
}
function readCategoryDistribution(store) {
  return store.all(
    `SELECT category, COUNT(*) AS count
		 FROM memories
		 GROUP BY category
		 ORDER BY count DESC, category ASC`
  );
}
function createMemoryCliOutput() {
  return {
    write(value) {
      process.stdout.write(value);
    },
    writeError(value) {
      process.stderr.write(value);
    }
  };
}
function getColors() {
  return {
    enabled: process.env.NO_COLOR !== "1"
  };
}
function categoryOptionValue(value) {
  if (CATEGORY_VALUES.includes(value)) {
    return value;
  }
  throw new Error(`Invalid category "${value}". Expected one of: ${CATEGORY_VALUES.join(", ")}`);
}
function renderConsolidatedSearchSection(memories, colors) {
  const lines = [section("Consolidated Memories", colors)];
  if (memories.length === 0) {
    lines.push(dim("No consolidated memory matches.", colors));
    return lines;
  }
  for (let i = 0; i < memories.length; i++) {
    const memory = memories[i];
    if (memory) {
      lines.push(formatConsolidatedMemoryLine(i + 1, memory, colors));
    }
  }
  return lines;
}
function renderEpisodicSearchSection(episodes, colors) {
  const lines = [section("Episodic Memories", colors)];
  if (episodes.length === 0) {
    lines.push(dim("No episodic memory matches.", colors));
    return lines;
  }
  for (let i = 0; i < episodes.length; i++) {
    const episode = episodes[i];
    if (episode) {
      lines.push(formatEpisodeLine(i + 1, episode, colors));
    }
  }
  return lines;
}
function createMemoryCliHandlers(services, colors = getColors()) {
  async function search(query, options = {}) {
    const limit = clampLimit(options.limit, 10);
    const [memories, episodes] = await Promise.all([
      services.consolidated.search(query, { topK: limit, includeInactive: true, minConfidence: 0 }),
      services.episodic.searchSemantic(query, { topK: limit })
    ]);
    const lines = [];
    lines.push(`${title("Memory Search", colors)}  ${dim(`query="${query}"`, colors)}`);
    lines.push(`${dim(`Top ${limit} per source`, colors)}
`);
    lines.push(...renderConsolidatedSearchSection(memories, colors));
    lines.push("");
    lines.push(...renderEpisodicSearchSection(episodes, colors));
    return `${lines.join("\n")}
`;
  }
  async function list(options = {}) {
    const minConfidence = options.minConfidence ?? 0;
    const memories = options.category ? (await services.consolidated.getByCategory(options.category)).filter(
      (memory) => memory.confidence >= minConfidence
    ) : await services.consolidated.getActive(minConfidence);
    const lines = [];
    lines.push(title("Consolidated Memories", colors));
    lines.push(
      dim(
        `count=${memories.length} | minConfidence=${minConfidence.toFixed(2)}${options.category ? ` | category=${options.category}` : ""}`,
        colors
      )
    );
    lines.push("");
    if (memories.length === 0) {
      lines.push(dim("No memories found for the selected filters.", colors));
      return `${lines.join("\n")}
`;
    }
    for (let i = 0; i < memories.length; i++) {
      const memory = memories[i];
      if (memory) {
        lines.push(formatConsolidatedMemoryLine(i + 1, memory, colors));
      }
    }
    return `${lines.join("\n")}
`;
  }
  async function forget(id) {
    await services.consolidated.deactivate(id);
    return `${ok("Memory deactivated.", colors)} ${dim(id, colors)}
`;
  }
  async function consolidate() {
    if (!services.consolidation) {
      throw new Error("Consolidation engine is not available.");
    }
    const report = await services.consolidation.runConsolidation({ force: true });
    const lines = [];
    lines.push(title("Consolidation Report", colors));
    lines.push(dim(`${report.startedAt} -> ${report.finishedAt}`, colors));
    lines.push("");
    if (report.skipped) {
      lines.push(`${section("Status", colors)} ${dim("skipped", colors)}`);
      lines.push(dim(report.skipReason ?? "No reason provided", colors));
      return `${lines.join("\n")}
`;
    }
    lines.push(`${section("Processed episodes", colors)} ${report.processedEpisodes}`);
    lines.push(`${section("Created", colors)} ${report.created}`);
    lines.push(`${section("Reinforced", colors)} ${report.reinforced}`);
    lines.push(`${section("Updated", colors)} ${report.updated}`);
    lines.push(`${section("Contradicted", colors)} ${report.contradicted}`);
    lines.push(`${section("Decayed", colors)} ${report.decayed}`);
    lines.push(`${section("Deactivated", colors)} ${report.deactivated}`);
    lines.push(`${section("Connected", colors)} ${report.connected}`);
    if (report.errors.length > 0) {
      lines.push("");
      lines.push(section("Errors", colors));
      for (const error of report.errors) {
        lines.push(`${danger("-", colors)} ${error}`);
      }
    }
    return `${lines.join("\n")}
`;
  }
  async function stats() {
    const totalEpisodes = readCount(services.store, "SELECT COUNT(*) AS count FROM episodes");
    const unconsolidatedEpisodes = readCount(
      services.store,
      "SELECT COUNT(*) AS count FROM episodes WHERE consolidated = 0"
    );
    const totalMemories = readCount(services.store, "SELECT COUNT(*) AS count FROM memories");
    const activeMemories = readCount(
      services.store,
      "SELECT COUNT(*) AS count FROM memories WHERE active = 1"
    );
    const inactiveMemories = readCount(
      services.store,
      "SELECT COUNT(*) AS count FROM memories WHERE active = 0"
    );
    const enabledJobs = readCount(
      services.store,
      "SELECT COUNT(*) AS count FROM jobs WHERE enabled = 1"
    );
    const categoryRows = readCategoryDistribution(services.store);
    const lines = [];
    lines.push(title("Memory Stats", colors));
    lines.push("");
    lines.push(section("Episodes", colors));
    lines.push(`- total: ${totalEpisodes}`);
    lines.push(`- unconsolidated: ${unconsolidatedEpisodes}`);
    lines.push("");
    lines.push(section("Consolidated Memories", colors));
    lines.push(`- total: ${totalMemories}`);
    lines.push(`- active: ${activeMemories}`);
    lines.push(`- inactive: ${inactiveMemories}`);
    lines.push("");
    lines.push(section("Scheduler", colors));
    lines.push(`- enabled jobs: ${enabledJobs}`);
    lines.push("");
    lines.push(section("By Category", colors));
    if (categoryRows.length === 0) {
      lines.push(dim("(No consolidated memories yet)", colors));
    } else {
      for (const row of categoryRows) {
        lines.push(`- ${row.category}: ${row.count}`);
      }
    }
    return `${lines.join("\n")}
`;
  }
  return {
    search,
    list,
    forget,
    consolidate,
    stats
  };
}
async function withServices(resolveServices, configPath, run) {
  const services = await resolveServices(configPath);
  try {
    const handlers = createMemoryCliHandlers(services);
    return await run(handlers);
  } finally {
    services.close();
  }
}
function writeOutput(output, text) {
  output.write(text);
}
function writeFailure(output, error) {
  const colors = getColors();
  const message = error instanceof Error ? error.message : String(error);
  output.writeError(`${danger("Error:", colors)} ${message}
`);
}
function registerMemoryCommands(program2, options) {
  const output = createMemoryCliOutput();
  const memory = program2.command("memory").description("Memory operations");
  memory.command("search").argument("<query>", "Search query").option("-c, --config <path>", "Path to config file").option(
    "-l, --limit <n>",
    "Top results per source",
    (value) => Number.parseInt(value, 10)
  ).description("Semantic search across consolidated and episodic memories").action(async (query, commandOptions) => {
    try {
      const rendered = await withServices(
        options.resolveServices,
        commandOptions.config,
        (handlers) => handlers.search(query, { limit: commandOptions.limit })
      );
      writeOutput(output, rendered);
    } catch (error) {
      writeFailure(output, error);
      process.exitCode = 1;
    }
  });
  memory.command("list").option("-c, --config <path>", "Path to config file").option("--category <category>", "Filter by category", categoryOptionValue).option(
    "--min-confidence <value>",
    "Minimum confidence (0-1)",
    (value) => Number.parseFloat(value)
  ).description("List consolidated memories").action(
    async (commandOptions) => {
      try {
        const rendered = await withServices(
          options.resolveServices,
          commandOptions.config,
          (handlers) => handlers.list({
            category: commandOptions.category,
            minConfidence: commandOptions.minConfidence
          })
        );
        writeOutput(output, rendered);
      } catch (error) {
        writeFailure(output, error);
        process.exitCode = 1;
      }
    }
  );
  memory.command("forget").argument("<id>", "Memory ID").option("-c, --config <path>", "Path to config file").description("Deactivate a specific consolidated memory").action(async (id, commandOptions) => {
    try {
      const rendered = await withServices(
        options.resolveServices,
        commandOptions.config,
        (handlers) => handlers.forget(id)
      );
      writeOutput(output, rendered);
    } catch (error) {
      writeFailure(output, error);
      process.exitCode = 1;
    }
  });
  memory.command("consolidate").option("-c, --config <path>", "Path to config file").description("Manually run memory consolidation now").action(async (commandOptions) => {
    try {
      const rendered = await withServices(
        options.resolveServices,
        commandOptions.config,
        (handlers) => handlers.consolidate()
      );
      writeOutput(output, rendered);
    } catch (error) {
      writeFailure(output, error);
      process.exitCode = 1;
    }
  });
  memory.command("stats").option("-c, --config <path>", "Path to config file").description("Show memory statistics").action(async (commandOptions) => {
    try {
      const rendered = await withServices(
        options.resolveServices,
        commandOptions.config,
        (handlers) => handlers.stats()
      );
      writeOutput(output, rendered);
    } catch (error) {
      writeFailure(output, error);
      process.exitCode = 1;
    }
  });
}

// src/config/loader.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync4, readFileSync as readFileSync2 } from "fs";
import { parse as parseYaml2 } from "yaml";

// src/config/schema.ts
import { z } from "zod";
var AgentSchema = z.object({
  name: z.string().default("Mama"),
  soulPath: z.string().default("./soul.md")
});
var UserSchema = z.object({
  name: z.string().default("User"),
  telegramIds: z.array(z.number()).default([]),
  timezone: z.string().default("UTC"),
  locale: z.string().default("en-US")
});
var ClaudeProviderSchema = z.object({
  apiKey: z.string().default(""),
  defaultModel: z.string().default("claude-sonnet-4-20250514"),
  maxMonthlyBudgetUsd: z.number().positive().default(50)
});
var OllamaProviderSchema = z.object({
  host: z.string().url().default("http://localhost:11434"),
  apiKey: z.string().default(""),
  defaultModel: z.string().default("minimax-m2.5:cloud"),
  smartModel: z.string().default("minimax-m2.5:cloud"),
  fastModel: z.string().default("gemini-3-flash-preview:cloud"),
  embeddingModel: z.string().default("nomic-embed-text")
});
var RoutingSchema = z.object({
  complexReasoning: z.enum(["claude", "ollama"]).default("ollama"),
  codeGeneration: z.enum(["claude", "ollama"]).default("ollama"),
  simpleTasks: z.enum(["claude", "ollama"]).default("ollama"),
  embeddings: z.enum(["claude", "ollama"]).default("ollama"),
  memoryConsolidation: z.enum(["claude", "ollama"]).default("ollama"),
  privateContent: z.enum(["claude", "ollama"]).default("ollama")
});
var LlmSchema = z.object({
  defaultProvider: z.enum(["claude", "ollama"]).default("ollama"),
  providers: z.object({
    claude: ClaudeProviderSchema.default({}),
    ollama: OllamaProviderSchema.default({})
  }).default({}),
  routing: RoutingSchema.default({})
});
var TerminalChannelSchema = z.object({
  enabled: z.boolean().default(true)
});
var TelegramChannelSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().default(""),
  defaultChatId: z.number().int().optional()
});
var ApiChannelSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(3377),
  token: z.string().default("")
});
var ChannelsSchema = z.object({
  terminal: TerminalChannelSchema.default({}),
  telegram: TelegramChannelSchema.default({}),
  api: ApiChannelSchema.default({})
});
var FsPathPermission = z.object({
  path: z.string(),
  actions: z.array(z.enum(["read", "write", "list", "delete"])),
  level: z.enum(["auto", "ask", "deny"])
});
var FilesystemSandboxSchema = z.object({
  workspace: z.string().default("~/.mama/workspace"),
  allowedPaths: z.array(FsPathPermission).default([]),
  deniedPaths: z.array(z.string()).default([])
});
var ShellSandboxSchema = z.object({
  safeCommands: z.array(z.string()).default([
    "ls",
    "cat",
    "head",
    "tail",
    "grep",
    "find",
    "wc",
    "date",
    "whoami",
    "pwd",
    "echo",
    "git status",
    "git log",
    "git diff"
  ]),
  askCommands: z.array(z.string()).default(["git commit", "git push", "git pull", "mkdir", "cp", "mv", "npm", "pnpm", "node"]),
  deniedPatterns: z.array(z.string()).default([
    "rm -rf",
    "sudo",
    "curl | bash",
    "wget | sh",
    "chmod 777",
    "> /dev",
    "mkfs",
    "dd if="
  ])
});
var NetworkSandboxSchema = z.object({
  allowedDomains: z.array(z.string()).default(["ollama.com", "api.telegram.org", "localhost", "api.github.com"]),
  askDomains: z.boolean().default(true),
  rateLimitPerMinute: z.number().int().positive().default(30),
  logAllRequests: z.boolean().default(true)
});
var SandboxSchema = z.object({
  filesystem: FilesystemSandboxSchema.default({}),
  shell: ShellSandboxSchema.default({}),
  network: NetworkSandboxSchema.default({})
});
var HeartbeatSchema = z.object({
  enabled: z.boolean().default(true),
  intervalMinutes: z.number().int().positive().default(30),
  heartbeatFile: z.string().default("~/.mama/heartbeat.md")
});
var FileWatcherTriggerSchema = z.object({
  path: z.string(),
  events: z.array(z.enum(["add", "change", "unlink", "rename"])).default(["add"]),
  task: z.string().min(1)
});
var WebhookHookSchema = z.object({
  id: z.string().min(1),
  token: z.string().default(""),
  task: z.string().min(1)
});
var WebhookTriggersSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(3378),
  hooks: z.array(WebhookHookSchema).default([])
});
var TriggersSchema = z.object({
  fileWatchers: z.array(FileWatcherTriggerSchema).default([]),
  webhooks: WebhookTriggersSchema.default({})
});
var SchedulerSchema = z.object({
  heartbeat: HeartbeatSchema.default({}),
  maxConcurrentJobs: z.number().int().positive().default(3),
  triggers: TriggersSchema.default({})
});
var DaemonSchema = z.object({
  pidFile: z.string().default("~/.mama/mama.pid"),
  healthCheckIntervalSeconds: z.number().int().positive().default(30)
});
var ConsolidationSchema = z.object({
  enabled: z.boolean().default(true),
  intervalHours: z.number().positive().default(6),
  minEpisodesToConsolidate: z.number().int().positive().default(10),
  model: z.enum(["claude", "ollama"]).default("ollama")
});
var MemorySchema = z.object({
  consolidation: ConsolidationSchema.default({}),
  maxEpisodicEntries: z.number().int().positive().default(1e5),
  embeddingDimensions: z.number().int().positive().default(768),
  searchTopK: z.number().int().positive().default(10)
});
var LoggingSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  file: z.string().default("~/.mama/logs/mama.log"),
  maxSizeMb: z.number().positive().default(50),
  rotate: z.boolean().default(true)
});
var ConfigSchema = z.object({
  version: z.number().int().default(1),
  agent: AgentSchema.default({}),
  user: UserSchema.default({}),
  llm: LlmSchema.default({}),
  channels: ChannelsSchema.default({}),
  sandbox: SandboxSchema.default({}),
  scheduler: SchedulerSchema.default({}),
  daemon: DaemonSchema.default({}),
  memory: MemorySchema.default({}),
  logging: LoggingSchema.default({})
});

// src/config/loader.ts
function resolveEnvVars(value) {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (_match, varName) => {
      const envValue = process.env[varName];
      if (envValue === void 0) {
        return "";
      }
      return envValue;
    });
  }
  if (Array.isArray(value)) {
    return value.map(resolveEnvVars);
  }
  if (value !== null && typeof value === "object") {
    return resolveEnvVarsInObject(value);
  }
  return value;
}
function resolveEnvVarsInObject(obj) {
  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    result[key] = resolveEnvVars(val);
  }
  return result;
}
function snakeToCamel(str) {
  return str.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
}
function convertKeysToCamelCase(obj) {
  if (Array.isArray(obj)) {
    return obj.map(convertKeysToCamelCase);
  }
  if (obj !== null && typeof obj === "object") {
    const result = {};
    for (const [key, val] of Object.entries(obj)) {
      result[snakeToCamel(key)] = convertKeysToCamelCase(val);
    }
    return result;
  }
  return obj;
}
function loadConfig(configPath) {
  const path2 = configPath ?? getDefaultConfigPath();
  let rawConfig = {};
  if (existsSync3(path2)) {
    try {
      const content = readFileSync2(path2, "utf-8");
      const parsed = parseYaml2(content);
      if (parsed !== null && typeof parsed === "object") {
        rawConfig = parsed;
      }
    } catch (err) {
      return {
        ok: false,
        error: new Error(
          `Failed to parse config at ${path2}: ${err instanceof Error ? err.message : String(err)}`
        )
      };
    }
  }
  const camelConfig = convertKeysToCamelCase(rawConfig);
  const resolvedConfig = resolveEnvVarsInObject(camelConfig);
  const result = ConfigSchema.safeParse(resolvedConfig);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `  - ${issue.path.join(".")}: ${issue.message}`
    );
    return {
      ok: false,
      error: new Error(`Invalid configuration:
${issues.join("\n")}`)
    };
  }
  return { ok: true, value: result.data };
}
function ensureMamaHome() {
  const home = getMamaHome();
  if (!existsSync3(home)) {
    mkdirSync4(home, { recursive: true });
  }
  const logsDir = `${home}/logs`;
  if (!existsSync3(logsDir)) {
    mkdirSync4(logsDir, { recursive: true });
  }
  return home;
}
var _config = null;
function initConfig(configPath) {
  const result = loadConfig(configPath);
  if (result.ok) {
    _config = result.value;
  }
  return result;
}
function getConfig() {
  if (_config === null) {
    throw new Error("Config not initialized. Call initConfig() first.");
  }
  return _config;
}

// src/core/context.ts
function buildSystemPrompt(soul, memories) {
  const parts = [soul];
  if (memories && memories.length > 0) {
    parts.push("\n## Relevant Memories");
    for (const mem of memories) {
      parts.push(`- ${mem}`);
    }
  }
  parts.push("\n## Guidelines");
  parts.push("- Be concise and helpful");
  parts.push("- If you plan to perform actions with side effects, explain what you will do first");
  parts.push("- If you are unsure, say so honestly");
  parts.push("- Respect the user's time \u2014 be efficient");
  return parts.join("\n");
}

// src/core/tools/fs-tools.ts
import { z as z2 } from "zod";

// src/core/tools/types.ts
function formatZodIssues(issues) {
  return issues.map((issue) => {
    const path2 = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path2}: ${issue.message}`;
  }).join("; ");
}
function createTool(args) {
  return {
    name: args.name,
    description: args.description,
    parameters: args.parameters,
    jsonSchema: args.jsonSchema,
    execute: args.execute,
    async run(rawParams, context) {
      const parsed = args.parameters.safeParse(rawParams);
      if (!parsed.success) {
        return {
          success: false,
          output: null,
          error: `Invalid tool parameters: ${formatZodIssues(parsed.error.issues)}`
        };
      }
      return args.execute(parsed.data, context);
    },
    getDefinition() {
      return {
        name: args.name,
        description: args.description,
        parameters: args.jsonSchema
      };
    }
  };
}

// src/core/tools/fs-tools.ts
function fromCapabilityResult(result) {
  return {
    success: result.success,
    output: result.output,
    error: result.error
  };
}
function shQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
var ReadFileParams = z2.object({
  path: z2.string().min(1)
});
var WriteFileParams = z2.object({
  path: z2.string().min(1),
  content: z2.string()
});
var ListDirectoryParams = z2.object({
  path: z2.string().min(1)
});
var SearchFilesParams = z2.object({
  path: z2.string().min(1),
  pattern: z2.string().min(1)
});
var MoveFileParams = z2.object({
  sourcePath: z2.string().min(1),
  destinationPath: z2.string().min(1)
});
var readFileTool = createTool({
  name: "read_file",
  description: "Read a UTF-8 text file from an allowed path.",
  parameters: ReadFileParams,
  jsonSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or relative file path to read" }
    },
    required: ["path"]
  },
  async execute(params, context) {
    const result = await context.sandbox.execute(
      "filesystem",
      "read",
      { path: params.path },
      context.requestedBy
    );
    return fromCapabilityResult(result);
  }
});
var writeFileTool = createTool({
  name: "write_file",
  description: "Create or overwrite a UTF-8 text file in an allowed path.",
  parameters: WriteFileParams,
  jsonSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write" },
      content: { type: "string", description: "Text content to write into the file" }
    },
    required: ["path", "content"]
  },
  async execute(params, context) {
    const result = await context.sandbox.execute(
      "filesystem",
      "write",
      { path: params.path, content: params.content },
      context.requestedBy
    );
    return fromCapabilityResult(result);
  }
});
var listDirectoryTool = createTool({
  name: "list_directory",
  description: "List entries of an allowed directory path.",
  parameters: ListDirectoryParams,
  jsonSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path to list" }
    },
    required: ["path"]
  },
  async execute(params, context) {
    const result = await context.sandbox.execute(
      "filesystem",
      "list",
      { path: params.path },
      context.requestedBy
    );
    return fromCapabilityResult(result);
  }
});
var searchFilesTool = createTool({
  name: "search_files",
  description: "Search files by name pattern under an allowed directory.",
  parameters: SearchFilesParams,
  jsonSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory root to search" },
      pattern: { type: "string", description: "find-compatible -name pattern (e.g. *.ts)" }
    },
    required: ["path", "pattern"]
  },
  async execute(params, context) {
    const command = `find ${shQuote(params.path)} -name ${shQuote(params.pattern)} -print`;
    const result = await context.sandbox.execute("shell", "run", { command }, context.requestedBy);
    if (!result.success) {
      return fromCapabilityResult(result);
    }
    const stdout = result.output?.stdout ?? "";
    const files = stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    return { success: true, output: files };
  }
});
var moveFileTool = createTool({
  name: "move_file",
  description: "Move or rename a file between allowed paths.",
  parameters: MoveFileParams,
  jsonSchema: {
    type: "object",
    properties: {
      sourcePath: { type: "string", description: "Original file path" },
      destinationPath: { type: "string", description: "Destination file path" }
    },
    required: ["sourcePath", "destinationPath"]
  },
  async execute(params, context) {
    const command = `mv -- ${shQuote(params.sourcePath)} ${shQuote(params.destinationPath)}`;
    const result = await context.sandbox.execute("shell", "run", { command }, context.requestedBy);
    return fromCapabilityResult(result);
  }
});
function createFsTools() {
  return [readFileTool, writeFileTool, listDirectoryTool, searchFilesTool, moveFileTool];
}

// src/core/tools/meta-tools.ts
import { z as z3 } from "zod";
var AskUserParams = z3.object({
  question: z3.string().min(1),
  context: z3.string().optional()
});
var ReportProgressParams = z3.object({
  message: z3.string().min(1),
  percent: z3.number().min(0).max(100).optional()
});
var askUserTool = createTool({
  name: "ask_user",
  description: "Request clarification from the user when task intent is ambiguous.",
  parameters: AskUserParams,
  jsonSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "Question to ask the user" },
      context: { type: "string", description: "Optional context shown with the question" }
    },
    required: ["question"]
  },
  async execute(params) {
    return {
      success: true,
      output: {
        type: "user-question",
        requiresUserInput: true,
        question: params.question,
        context: params.context
      }
    };
  }
});
var reportProgressTool = createTool({
  name: "report_progress",
  description: "Emit structured progress updates during multi-step execution.",
  parameters: ReportProgressParams,
  jsonSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Progress message" },
      percent: { type: "number", description: "Optional completion percentage (0-100)" }
    },
    required: ["message"]
  },
  async execute(params) {
    return {
      success: true,
      output: {
        type: "progress-update",
        message: params.message,
        percent: params.percent
      }
    };
  }
});
function createMetaTools() {
  return [askUserTool, reportProgressTool];
}

// src/core/tools/network-tools.ts
import { z as z4 } from "zod";
function fromCapabilityResult2(result) {
  return {
    success: result.success,
    output: result.output,
    error: result.error
  };
}
var HttpRequestParams = z4.object({
  url: z4.string().url(),
  method: z4.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).default("GET"),
  headers: z4.record(z4.string()).optional(),
  body: z4.string().optional()
});
var httpRequestTool = createTool({
  name: "http_request",
  description: "Execute an outbound HTTP request through sandboxed network rules.",
  parameters: HttpRequestParams,
  jsonSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Fully-qualified URL to request" },
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        description: "HTTP method"
      },
      headers: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Optional request headers"
      },
      body: { type: "string", description: "Optional request body for non-GET methods" }
    },
    required: ["url"]
  },
  async execute(params, context) {
    const result = await context.sandbox.execute(
      "network",
      "request",
      {
        url: params.url,
        method: params.method,
        headers: params.headers,
        body: params.body
      },
      context.requestedBy
    );
    return fromCapabilityResult2(result);
  }
});
function createNetworkTools() {
  return [httpRequestTool];
}

// src/core/tools/scheduler-tools.ts
import { z as z5 } from "zod";

// src/scheduler/registry.ts
var scheduler = null;
function setScheduler(value) {
  scheduler = value;
}
function getScheduler() {
  return scheduler;
}

// src/core/tools/scheduler-tools.ts
var CreateScheduledJobParams = z5.object({
  name: z5.string().min(1).optional(),
  schedule: z5.string().min(1),
  task: z5.string().min(1)
});
var ListScheduledJobsParams = z5.object({
  enabledOnly: z5.boolean().optional()
});
var ManageJobParams = z5.object({
  id: z5.string().min(1),
  action: z5.enum(["enable", "disable", "delete"])
});
var createScheduledJobTool = createTool({
  name: "create_scheduled_job",
  description: "Create a persistent scheduled job for the agent.",
  parameters: CreateScheduledJobParams,
  jsonSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Optional job name" },
      schedule: {
        type: "string",
        description: 'Cron expression or natural language schedule (e.g. "every 30 minutes")'
      },
      task: { type: "string", description: "Task to execute on each run" }
    },
    required: ["schedule", "task"]
  },
  async execute(params) {
    const scheduler2 = getScheduler();
    if (!scheduler2) {
      return { success: false, output: null, error: "Scheduler is not available." };
    }
    const id = await scheduler2.createJob(params);
    const created = await scheduler2.getJob(id);
    return { success: true, output: created };
  }
});
var listScheduledJobsTool = createTool({
  name: "list_scheduled_jobs",
  description: "List all currently registered scheduled jobs.",
  parameters: ListScheduledJobsParams,
  jsonSchema: {
    type: "object",
    properties: {
      enabledOnly: {
        type: "boolean",
        description: "When true, only enabled jobs are returned"
      }
    },
    required: []
  },
  async execute(params) {
    const scheduler2 = getScheduler();
    if (!scheduler2) {
      return { success: false, output: null, error: "Scheduler is not available." };
    }
    const jobs = await scheduler2.listJobs();
    return {
      success: true,
      output: params.enabledOnly ? jobs.filter((job) => job.enabled) : jobs
    };
  }
});
var manageJobTool = createTool({
  name: "manage_job",
  description: "Enable, disable, or delete an existing scheduled job.",
  parameters: ManageJobParams,
  jsonSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Job id" },
      action: {
        type: "string",
        enum: ["enable", "disable", "delete"],
        description: "Operation to apply"
      }
    },
    required: ["id", "action"]
  },
  async execute(params) {
    const scheduler2 = getScheduler();
    if (!scheduler2) {
      return { success: false, output: null, error: "Scheduler is not available." };
    }
    switch (params.action) {
      case "enable":
        await scheduler2.enableJob(params.id);
        break;
      case "disable":
        await scheduler2.disableJob(params.id);
        break;
      case "delete":
        await scheduler2.deleteJob(params.id);
        break;
    }
    return {
      success: true,
      output: {
        id: params.id,
        action: params.action
      }
    };
  }
});
function createSchedulerTools() {
  return [createScheduledJobTool, listScheduledJobsTool, manageJobTool];
}

// src/core/tools/shell-tools.ts
import { z as z6 } from "zod";
function fromCapabilityResult3(result) {
  return {
    success: result.success,
    output: result.output,
    error: result.error
  };
}
var ExecuteCommandParams = z6.object({
  command: z6.string().min(1),
  cwd: z6.string().min(1).optional(),
  timeout: z6.number().int().positive().max(3e5).optional()
});
var executeCommandTool = createTool({
  name: "execute_command",
  description: "Execute a shell command through the sandbox policy engine.",
  parameters: ExecuteCommandParams,
  jsonSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      cwd: { type: "string", description: "Optional working directory" },
      timeout: { type: "number", description: "Optional timeout in milliseconds" }
    },
    required: ["command"]
  },
  async execute(params, context) {
    const result = await context.sandbox.execute(
      "shell",
      "run",
      {
        command: params.command,
        cwd: params.cwd,
        timeout: params.timeout
      },
      context.requestedBy
    );
    return fromCapabilityResult3(result);
  }
});
function createShellTools() {
  return [executeCommandTool];
}

// src/core/tools/index.ts
var TOOL_REGISTRY = [
  ...createFsTools(),
  ...createShellTools(),
  ...createNetworkTools(),
  ...createSchedulerTools(),
  ...createMetaTools()
];
function getToolByName(name) {
  return TOOL_REGISTRY.find((tool) => tool.name === name);
}
function getToolDefinitions() {
  return TOOL_REGISTRY.map((tool) => tool.getDefinition());
}
async function executeTool(toolName, params, context) {
  const tool = getToolByName(toolName);
  if (!tool) {
    return {
      success: false,
      output: null,
      error: `Unknown tool: ${toolName}`
    };
  }
  return tool.run(params, context);
}

// src/core/executor.ts
var DEFAULT_MAX_RETRIES = 1;
function parseFallbackInstruction(value) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^([a-z_][a-z0-9_]*)\s*(\{[\s\S]*\})?$/i);
  if (!match?.[1]) return null;
  const toolName = match[1];
  const rawParams = match[2];
  if (!toolName) return null;
  if (!rawParams) {
    return { toolName, params: {} };
  }
  try {
    const parsed = JSON.parse(rawParams);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { toolName, params: parsed };
    }
    return { toolName, params: {} };
  } catch {
    return null;
  }
}
function createExecutor(deps = {}) {
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
  const toolExecutor = deps.executeToolFn ?? executeTool;
  async function runStep(step, context, retries) {
    let attempts = 0;
    let lastResult = {
      success: false,
      output: null,
      error: "Tool did not execute"
    };
    for (let i = 0; i <= retries; i++) {
      attempts++;
      lastResult = await toolExecutor(step.tool, step.params, context);
      if (lastResult.success) {
        return {
          stepId: step.id,
          tool: step.tool,
          description: step.description,
          status: "success",
          attempts,
          output: lastResult.output,
          rawResult: lastResult
        };
      }
    }
    return {
      stepId: step.id,
      tool: step.tool,
      description: step.description,
      status: step.canFail ? "failed-acceptable" : "failed-critical",
      attempts,
      error: lastResult.error ?? "Step failed",
      output: lastResult.output,
      rawResult: lastResult
    };
  }
  async function executePlan(plan, context) {
    const completed = /* @__PURE__ */ new Set();
    const results = [];
    let aborted = false;
    for (const [index, step] of plan.steps.entries()) {
      const dependenciesReady = step.dependsOn.every((id) => completed.has(id));
      if (!dependenciesReady) {
        const skipped = {
          stepId: step.id,
          tool: step.tool,
          description: step.description,
          status: "skipped",
          attempts: 0,
          error: "Dependencies not met"
        };
        results.push(skipped);
        continue;
      }
      context.onEvent?.({
        type: "plan_step_started",
        stepId: step.id,
        description: step.description,
        tool: step.tool
      });
      const stepResult = await runStep(step, context, maxRetries);
      let finalResult = { ...stepResult };
      if (!stepResult.rawResult.success) {
        const fallback = parseFallbackInstruction(step.fallback);
        if (fallback) {
          const fallbackRun = await toolExecutor(fallback.toolName, fallback.params, context);
          if (fallbackRun.success) {
            finalResult = {
              stepId: step.id,
              tool: fallback.toolName,
              description: step.description,
              status: "fallback",
              attempts: stepResult.attempts + 1,
              output: fallbackRun.output
            };
          } else {
            finalResult = {
              ...finalResult,
              attempts: stepResult.attempts + 1,
              error: fallbackRun.error ?? finalResult.error
            };
          }
        }
      }
      results.push(finalResult);
      if (finalResult.status === "success" || finalResult.status === "fallback") {
        completed.add(step.id);
      }
      if (finalResult.status === "failed-acceptable") {
        completed.add(step.id);
      }
      const percentComplete = Math.round((index + 1) / plan.steps.length * 100);
      context.onEvent?.({
        type: "plan_step_finished",
        stepId: step.id,
        description: step.description,
        tool: finalResult.tool,
        status: finalResult.status,
        error: finalResult.error,
        attempts: finalResult.attempts,
        percentComplete
      });
      if (finalResult.status === "failed-critical") {
        aborted = true;
        break;
      }
    }
    return {
      aborted,
      completedSteps: completed.size,
      totalSteps: plan.steps.length,
      results
    };
  }
  return { executePlan };
}

// src/core/planner.ts
var DEFAULT_MAX_STEPS = 8;
var MULTI_STEP_HINTS = [
  /\bthen\b/i,
  /\band then\b/i,
  /\bafter that\b/i,
  /\bfirst\b.*\bthen\b/i,
  /\bcreate\b.*\b(write|list|read|move|run)\b/i,
  /\bmulti[- ]step\b/i
];
function shouldPlanInput(input) {
  return MULTI_STEP_HINTS.some((pattern) => pattern.test(input));
}
function buildPlanningPrompt(input, history) {
  const toolList = getToolDefinitions().map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");
  const recentHistory = history.slice(-6).map((msg) => `${msg.role}: ${msg.content}`).join("\n");
  return [
    "You are planning steps for a tool-using agent.",
    "Return ONLY valid JSON with this shape:",
    '{"goal":"...","steps":[{"id":1,"description":"...","tool":"...","params":{},"dependsOn":[],"canFail":false,"fallback":"optional"}],"hasSideEffects":true,"estimatedDuration":"...","risks":["..."]}',
    "Rules:",
    "- Use only the listed tools",
    "- Keep steps minimal and ordered",
    "- Read before write when relevant",
    "- Mark hasSideEffects true for write/move/shell/network mutating tasks",
    "Available tools:",
    toolList,
    "Recent conversation:",
    recentHistory || "(none)",
    `User request: ${input}`
  ].join("\n");
}
function extractJsonBlock(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (!char) continue;
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth++;
      continue;
    }
    if (char === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}
function asRecord(value) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return {};
}
function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}
function toNumberArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0);
}
function normalizeStep(raw, fallbackId) {
  const step = asRecord(raw);
  const id = Number(step.id);
  const normalizedId = Number.isInteger(id) && id > 0 ? id : fallbackId;
  const description = String(step.description ?? "").trim();
  const tool = String(step.tool ?? "").trim();
  if (!description || !tool) return null;
  const fallbackValue = step.fallback;
  const fallback = typeof fallbackValue === "string" && fallbackValue.trim() ? fallbackValue : void 0;
  return {
    id: normalizedId,
    description,
    tool,
    params: asRecord(step.params),
    dependsOn: toNumberArray(step.dependsOn),
    canFail: Boolean(step.canFail),
    fallback
  };
}
function normalizePlan(raw, maxSteps) {
  const candidate = asRecord(raw);
  const rawSteps = Array.isArray(candidate.steps) ? candidate.steps : [];
  if (rawSteps.length === 0) return null;
  const steps = [];
  for (const [index, rawStep] of rawSteps.entries()) {
    if (steps.length >= maxSteps) break;
    const normalized = normalizeStep(rawStep, index + 1);
    if (normalized) {
      steps.push(normalized);
    }
  }
  if (steps.length === 0) return null;
  steps.sort((a, b) => a.id - b.id);
  const sideEffectTools = /* @__PURE__ */ new Set(["write_file", "move_file", "execute_command", "http_request"]);
  const hasExplicitSideEffects = Boolean(candidate.hasSideEffects);
  const hasToolSideEffects = steps.some((step) => sideEffectTools.has(step.tool));
  return {
    goal: String(candidate.goal ?? "Complete user request"),
    steps,
    hasSideEffects: hasExplicitSideEffects || hasToolSideEffects,
    estimatedDuration: String(candidate.estimatedDuration ?? "unknown"),
    risks: toStringArray(candidate.risks)
  };
}
function parsePlanFromText(text, maxSteps = DEFAULT_MAX_STEPS) {
  const json3 = extractJsonBlock(text);
  if (!json3) return null;
  try {
    const parsed = JSON.parse(json3);
    return normalizePlan(parsed, maxSteps);
  } catch {
    return null;
  }
}
function createPlanner(deps) {
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
  async function createPlan(input, history) {
    const requestText = buildPlanningPrompt(input, history);
    const response = await deps.router.complete({
      messages: [{ role: "user", content: requestText }],
      taskType: "complex_reasoning",
      temperature: 0,
      maxTokens: 1400
    });
    return parsePlanFromText(response.content, maxSteps);
  }
  return {
    shouldPlan: shouldPlanInput,
    createPlan
  };
}

// src/core/agent.ts
var logger3 = createLogger("core:agent");
function createAgent(deps) {
  const { router, workingMemory, soul, sandbox, episodicMemory, retrieval } = deps;
  const planner = createPlanner({ router });
  const executor = createExecutor();
  const maxIterations = deps.maxIterations ?? 10;
  const retrievalTokenBudget = deps.retrievalTokenBudget ?? 1200;
  function emit(options, event) {
    options?.onEvent?.(event);
  }
  function buildRequest(toolsEnabled) {
    return {
      messages: workingMemory.getMessages(),
      systemPrompt: buildSystemPrompt(soul.getSoulPrompt(), workingMemory.getSystemInjection()),
      taskType: "general",
      maxTokens: 4096,
      tools: toolsEnabled ? getToolDefinitions() : void 0
    };
  }
  function stringifyToolResult(result) {
    return JSON.stringify({
      success: result.success,
      output: result.output,
      error: result.error
    });
  }
  function formatPlanSummary(plan) {
    const stepLines = plan.steps.map((step) => `${step.id}. ${step.description} [${step.tool}]`);
    const riskLine = plan.risks.length > 0 ? `
Risks: ${plan.risks.join("; ")}` : "";
    return [`Plan: ${plan.goal}`, ...stepLines, riskLine].filter(Boolean).join("\n");
  }
  function formatExecutionSummary(plan, result) {
    if (!result) {
      return `Plan created for "${plan.goal}", but no execution results are available.`;
    }
    const lines = [`Plan executed: ${plan.goal}`];
    for (const step of result.results) {
      const detail = step.error ? ` \u2014 ${step.error}` : "";
      lines.push(`${step.stepId}. ${step.description}: ${step.status}${detail}`);
    }
    if (result.aborted) {
      lines.push("Execution aborted due to a critical step failure.");
    }
    return lines.join("\n");
  }
  async function recordEpisode(channel, role, content, metadata) {
    if (!episodicMemory) return;
    try {
      await episodicMemory.storeEpisode({
        channel,
        role,
        content,
        metadata
      });
    } catch (error) {
      logger3.warn("Failed to record episodic memory", {
        channel,
        role,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  async function refreshRetrievedContext(input) {
    if (!retrieval) return;
    try {
      const context = await retrieval.retrieveContext(input, retrievalTokenBudget);
      workingMemory.setSystemInjection(context.entries);
    } catch (error) {
      workingMemory.setSystemInjection([]);
      logger3.warn("Failed to retrieve memory context", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  async function processMessage(input, channel, options) {
    logger3.info("Processing message", { channel, inputLength: input.length });
    const userMessage = { role: "user", content: input };
    workingMemory.addMessage(userMessage);
    await recordEpisode(channel, "user", input, { event: "user_message" });
    await refreshRetrievedContext(input);
    if (sandbox && planner.shouldPlan(input)) {
      const plan = await planner.createPlan(input, workingMemory.getMessages());
      if (plan) {
        emit(options, { type: "plan_created", plan });
        await recordEpisode(channel, "system", formatPlanSummary(plan), {
          event: "plan_created",
          stepCount: plan.steps.length,
          hasSideEffects: plan.hasSideEffects
        });
        if (plan.hasSideEffects) {
          emit(options, { type: "plan_approval_requested", plan });
          const approved = options?.onPlanApproval ? await options.onPlanApproval(plan) : false;
          if (!approved) {
            const cancelled = `Plan cancelled by user.
${formatPlanSummary(plan)}`;
            workingMemory.addMessage({ role: "assistant", content: cancelled });
            await recordEpisode(channel, "assistant", cancelled, { event: "plan_cancelled" });
            return {
              content: cancelled,
              model: "planner-executor",
              provider: "internal",
              tokenUsage: { input: 0, output: 0 },
              iterations: 0,
              toolCallsExecuted: 0
            };
          }
        }
        const execution = await executor.executePlan(plan, {
          sandbox,
          requestedBy: channel,
          onEvent: (event) => emit(options, event)
        });
        const summary = formatExecutionSummary(plan, execution);
        workingMemory.addMessage({ role: "assistant", content: summary });
        await recordEpisode(channel, "assistant", summary, {
          event: "plan_executed",
          aborted: execution.aborted,
          stepCount: execution.results.length
        });
        return {
          content: summary,
          model: "planner-executor",
          provider: "internal",
          tokenUsage: { input: 0, output: 0 },
          iterations: 0,
          toolCallsExecuted: execution.results.length,
          planExecution: execution
        };
      }
    }
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let toolCallsExecuted = 0;
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const response = await router.complete(buildRequest(Boolean(sandbox)));
      totalInputTokens += response.usage.inputTokens;
      totalOutputTokens += response.usage.outputTokens;
      if (response.toolCalls.length === 0) {
        workingMemory.addMessage({
          role: "assistant",
          content: response.content
        });
        await recordEpisode(channel, "assistant", response.content, {
          event: "assistant_response",
          model: response.model,
          provider: response.provider,
          iterations: iteration + 1
        });
        logger3.info("Message processed", {
          channel,
          model: response.model,
          provider: response.provider,
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          iterations: iteration + 1,
          toolCallsExecuted
        });
        return {
          content: response.content,
          model: response.model,
          provider: response.provider,
          tokenUsage: {
            input: totalInputTokens,
            output: totalOutputTokens
          },
          iterations: iteration + 1,
          toolCallsExecuted
        };
      }
      if (!sandbox) {
        const noSandboxMessage = "Tool call requested but sandbox is not configured.";
        workingMemory.addMessage({ role: "assistant", content: noSandboxMessage });
        await recordEpisode(channel, "assistant", noSandboxMessage, {
          event: "tool_unavailable"
        });
        return {
          content: noSandboxMessage,
          model: response.model,
          provider: response.provider,
          tokenUsage: {
            input: totalInputTokens,
            output: totalOutputTokens
          },
          iterations: iteration + 1,
          toolCallsExecuted
        };
      }
      workingMemory.addMessage({
        role: "assistant",
        content: response.content,
        toolCalls: response.toolCalls
      });
      if (response.content.trim().length > 0) {
        await recordEpisode(channel, "assistant", response.content, {
          event: "assistant_tool_request",
          toolCount: response.toolCalls.length
        });
      }
      for (const toolCall of response.toolCalls) {
        emit(options, {
          type: "tool_call_started",
          callId: toolCall.id,
          toolName: toolCall.name
        });
        const result = await executeTool(toolCall.name, toolCall.arguments, {
          sandbox,
          requestedBy: channel
        });
        toolCallsExecuted++;
        emit(options, {
          type: "tool_call_finished",
          callId: toolCall.id,
          toolName: toolCall.name,
          success: result.success,
          error: result.error
        });
        const toolResultContent = stringifyToolResult(result);
        workingMemory.addMessage({
          role: "tool",
          content: toolResultContent,
          toolResultId: toolCall.id
        });
        await recordEpisode(channel, "tool", toolResultContent, {
          event: "tool_result",
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          success: result.success
        });
      }
    }
    const limitMessage = `Maximum tool iterations (${maxIterations}) reached. Please refine the request.`;
    workingMemory.addMessage({ role: "assistant", content: limitMessage });
    await recordEpisode(channel, "assistant", limitMessage, {
      event: "tool_iteration_limit",
      maxIterations
    });
    logger3.warn("Tool iteration limit reached", {
      channel,
      maxIterations,
      toolCallsExecuted
    });
    return {
      content: limitMessage,
      model: "tool-loop",
      provider: "internal",
      tokenUsage: {
        input: totalInputTokens,
        output: totalOutputTokens
      },
      iterations: maxIterations,
      toolCallsExecuted
    };
  }
  function getConversationHistory() {
    return workingMemory.getMessages();
  }
  function clearHistory() {
    workingMemory.clear();
    logger3.info("Conversation history cleared");
  }
  return {
    processMessage,
    getConversationHistory,
    clearHistory
  };
}

// src/daemon.ts
import { spawn } from "child_process";
import { existsSync as existsSync4, mkdirSync as mkdirSync5, readFileSync as readFileSync3, rmSync, writeFileSync as writeFileSync3 } from "fs";
import { dirname as dirname3 } from "path";
var logger4 = createLogger("daemon");
function writePidFile(pidFile, pid) {
  mkdirSync5(dirname3(pidFile), { recursive: true });
  writeFileSync3(pidFile, `${pid}
`, "utf-8");
}
function readPidFile(pidFile) {
  if (!existsSync4(pidFile)) return null;
  const raw = readFileSync3(pidFile, "utf-8").trim();
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function getDaemonStatus(pidFile) {
  const pid = readPidFile(pidFile);
  if (!pid) return { running: false, pid: null };
  return { running: isProcessAlive(pid), pid };
}
function stopDaemonProcess(pidFile) {
  const pid = readPidFile(pidFile);
  if (!pid) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}
function readDaemonLogs(logFile, lines = 100) {
  if (!existsSync4(logFile)) return "";
  const content = readFileSync3(logFile, "utf-8");
  const chunks = content.split("\n");
  return chunks.slice(-lines).join("\n").trim();
}
function startDetachedDaemonProcess(options) {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return child.pid ?? -1;
}
function createDaemonController(options) {
  const now = options.now ?? (() => /* @__PURE__ */ new Date());
  const healthCheckIntervalMs = Math.max(5e3, options.healthCheckIntervalMs ?? 3e4);
  let running = false;
  let healthTimer = null;
  async function runHealthChecks() {
    for (const service of options.services) {
      if (!service.healthCheck) continue;
      const healthy = await service.healthCheck();
      if (healthy) continue;
      logger4.warn("Service health check failed, restarting service", {
        service: service.name
      });
      await service.stop();
      await service.start();
    }
  }
  async function start() {
    if (running) return;
    const existing = getDaemonStatus(options.pidFile);
    if (existing.running) {
      throw new Error(`Daemon already running (pid ${existing.pid})`);
    }
    writePidFile(options.pidFile, process.pid);
    for (const service of options.services) {
      await service.start();
      logger4.info("Service started", { service: service.name, at: now().toISOString() });
    }
    healthTimer = setInterval(() => {
      runHealthChecks().catch((error) => {
        logger4.error("Daemon health check loop failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, healthCheckIntervalMs);
    running = true;
  }
  async function stop() {
    if (!running) {
      rmSync(options.pidFile, { force: true });
      return;
    }
    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
    for (let i = options.services.length - 1; i >= 0; i--) {
      const service = options.services[i];
      if (!service) continue;
      try {
        await service.stop();
        logger4.info("Service stopped", { service: service.name, at: now().toISOString() });
      } catch (error) {
        logger4.error("Failed to stop service", {
          service: service.name,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    rmSync(options.pidFile, { force: true });
    running = false;
  }
  return {
    start,
    stop,
    isRunning: () => running
  };
}

// src/llm/cost-tracker.ts
var logger5 = createLogger("llm:cost-tracker");
var MODEL_PRICING = {
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-haiku-4-20250514": { input: 0.8, output: 4 },
  "claude-opus-4-20250514": { input: 15, output: 75 },
  // Ollama models are free by default.
  default: { input: 0, output: 0 }
};
function getCostForModel(model, usage) {
  const fallbackPricing = MODEL_PRICING.default ?? { input: 0, output: 0 };
  const pricing = MODEL_PRICING[model] ?? fallbackPricing;
  const inputCost = usage.inputTokens / 1e6 * pricing.input;
  const outputCost = usage.outputTokens / 1e6 * pricing.output;
  return inputCost + outputCost;
}
function parseUsageRow(row) {
  return {
    id: row.id,
    timestamp: new Date(row.timestamp),
    provider: row.provider,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    taskType: row.task_type,
    latencyMs: row.latency_ms
  };
}
function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}
function startOfWeek(date) {
  const day = date.getDay();
  const copy = startOfDay(date);
  copy.setDate(copy.getDate() - day);
  return copy;
}
function startOfMonth(date) {
  const copy = startOfDay(date);
  copy.setDate(1);
  return copy;
}
function sumCost(entries) {
  return entries.reduce((sum, record) => sum + record.costUsd, 0);
}
function sumTokens(entries) {
  return entries.reduce(
    (acc, record) => ({
      input: acc.input + record.inputTokens,
      output: acc.output + record.outputTokens
    }),
    { input: 0, output: 0 }
  );
}
function estimateAverageCostPerDay(entries) {
  if (entries.length === 0) return 0;
  const timestamps = entries.map((entry) => entry.timestamp.getTime());
  const min = Math.min(...timestamps);
  const max = Math.max(...timestamps);
  const days = Math.max(1, Math.ceil((max - min) / 864e5) + 1);
  return sumCost(entries) / days;
}
function createCostTracker(options = {}) {
  const records = [];
  const clock = options.clock ?? (() => /* @__PURE__ */ new Date());
  let idCounter = 0;
  if (options.store) {
    const rows = options.store.all(
      `SELECT id, timestamp, provider, model, input_tokens, output_tokens, cost_usd, task_type, latency_ms
			 FROM llm_usage
			 ORDER BY timestamp ASC`
    );
    for (const row of rows) {
      records.push(parseUsageRow(row));
    }
    idCounter = rows.length;
  }
  function persist(entry) {
    if (!options.store) return;
    options.store.run(
      `INSERT INTO llm_usage (id, timestamp, provider, model, input_tokens, output_tokens, cost_usd, task_type, latency_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.timestamp.toISOString(),
        entry.provider,
        entry.model,
        entry.inputTokens,
        entry.outputTokens,
        entry.costUsd,
        entry.taskType,
        entry.latencyMs
      ]
    );
  }
  function record(params) {
    const costUsd = getCostForModel(params.model, params.usage);
    idCounter++;
    const entry = {
      id: `usage-${idCounter}`,
      timestamp: clock(),
      provider: params.provider,
      model: params.model,
      inputTokens: params.usage.inputTokens,
      outputTokens: params.usage.outputTokens,
      costUsd,
      taskType: params.taskType,
      latencyMs: params.latencyMs
    };
    records.push(entry);
    persist(entry);
    logger5.debug("LLM usage recorded", {
      model: params.model,
      inputTokens: params.usage.inputTokens,
      outputTokens: params.usage.outputTokens,
      costUsd: costUsd.toFixed(6),
      latencyMs: params.latencyMs
    });
    return entry;
  }
  function filterByDate(start) {
    return records.filter((record2) => record2.timestamp >= start);
  }
  function getUsageToday() {
    return filterByDate(startOfDay(clock()));
  }
  function getUsageThisWeek() {
    return filterByDate(startOfWeek(clock()));
  }
  function getUsageThisMonth() {
    return filterByDate(startOfMonth(clock()));
  }
  function summarize(entries = records) {
    const byModel = {};
    for (const record2 of entries) {
      const current = byModel[record2.model] ?? {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0
      };
      current.inputTokens += record2.inputTokens;
      current.outputTokens += record2.outputTokens;
      current.costUsd += record2.costUsd;
      byModel[record2.model] = current;
    }
    const totals = sumTokens(entries);
    return {
      totalInputTokens: totals.input,
      totalOutputTokens: totals.output,
      totalCostUsd: sumCost(entries),
      averageCostPerDayUsd: estimateAverageCostPerDay(entries),
      byModel
    };
  }
  function clear() {
    records.length = 0;
    idCounter = 0;
    if (options.store) {
      options.store.run("DELETE FROM llm_usage");
    }
  }
  return {
    record,
    getUsageToday,
    getUsageThisWeek,
    getUsageThisMonth,
    getTotalCost: () => sumCost(records),
    getCostToday: () => sumCost(getUsageToday()),
    getCostThisMonth: () => sumCost(getUsageThisMonth()),
    getRecords: () => [...records],
    summarize,
    clear
  };
}

// src/llm/providers/claude.ts
import Anthropic from "@anthropic-ai/sdk";
var logger6 = createLogger("llm:claude");
function convertMessages(messages) {
  const result = [];
  for (const msg of messages) {
    if (msg.role === "system") continue;
    if (msg.role === "tool") {
      const toolResultBlock = {
        type: "tool_result",
        tool_use_id: msg.toolResultId ?? "",
        content: msg.content
      };
      result.push({ role: "user", content: [toolResultBlock] });
      continue;
    }
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      const content = [];
      if (msg.content) {
        content.push({ type: "text", text: msg.content });
      }
      for (const tc of msg.toolCalls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.arguments
        });
      }
      result.push({ role: "assistant", content });
      continue;
    }
    result.push({
      role: msg.role,
      content: msg.content
    });
  }
  return result;
}
function mapFinishReason(stopReason) {
  switch (stopReason) {
    case "end_turn":
      return "end";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    default:
      return "end";
  }
}
function createClaudeProvider(config) {
  const client = new Anthropic({ apiKey: config.apiKey });
  async function complete(request) {
    const model = request.model ?? config.defaultModel;
    const messages = convertMessages(request.messages);
    const startTime = Date.now();
    logger6.debug("Claude request", { model, messageCount: messages.length });
    const params = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 4096
    };
    if (request.systemPrompt) {
      params.system = request.systemPrompt;
    }
    if (request.temperature !== void 0) {
      params.temperature = request.temperature;
    }
    if (request.tools && request.tools.length > 0) {
      params.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters
      }));
    }
    const response = await client.messages.create(params);
    const latencyMs = Date.now() - startTime;
    let textContent = "";
    const toolCalls = [];
    for (const block of response.content) {
      if (block.type === "text") {
        textContent += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input
        });
      }
    }
    logger6.debug("Claude response", {
      model: response.model,
      latencyMs,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      stopReason: response.stop_reason
    });
    return {
      content: textContent,
      toolCalls,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens
      },
      model: response.model,
      provider: "claude",
      finishReason: mapFinishReason(response.stop_reason)
    };
  }
  async function isAvailable() {
    return config.apiKey.length > 0;
  }
  return {
    name: "claude",
    complete,
    isAvailable
  };
}

// src/llm/providers/ollama.ts
import { Ollama } from "ollama";
var logger7 = createLogger("llm:ollama");
function convertMessages2(messages) {
  return messages.filter((msg) => msg.role !== "system").map((msg) => ({
    role: msg.role === "tool" ? "user" : msg.role,
    content: msg.role === "tool" ? `[Tool Result (${msg.toolResultId ?? "unknown"})]: ${msg.content}` : msg.content
  }));
}
function createOllamaProvider(config) {
  const headers = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : void 0;
  const client = new Ollama({ host: config.host, headers });
  async function complete(request) {
    const model = request.model ?? config.defaultModel;
    const messages = convertMessages2(request.messages);
    const startTime = Date.now();
    logger7.debug("Ollama request", { model, messageCount: messages.length });
    const ollamaMessages = messages.map((m) => ({
      role: m.role,
      content: m.content
    }));
    if (request.systemPrompt) {
      ollamaMessages.unshift({ role: "system", content: request.systemPrompt });
    }
    const params = {
      model,
      messages: ollamaMessages,
      options: {}
    };
    if (request.temperature !== void 0 && params.options) {
      params.options.temperature = request.temperature;
    }
    if (request.maxTokens && params.options) {
      params.options.num_predict = request.maxTokens;
    }
    if (request.tools && request.tools.length > 0) {
      params.tools = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          // ToolDefinition.parameters is already a JSON Schema object.
          parameters: tool.parameters
        }
      }));
    }
    const response = await client.chat(params);
    const latencyMs = Date.now() - startTime;
    const toolCalls = [];
    if (response.message.tool_calls) {
      for (const tc of response.message.tool_calls) {
        toolCalls.push({
          id: `ollama-${Date.now()}-${toolCalls.length}`,
          name: tc.function.name,
          arguments: tc.function.arguments
        });
      }
    }
    const inputTokens = response.prompt_eval_count ?? 0;
    const outputTokens = response.eval_count ?? 0;
    logger7.debug("Ollama response", {
      model,
      latencyMs,
      inputTokens,
      outputTokens
    });
    return {
      content: response.message.content,
      toolCalls,
      usage: { inputTokens, outputTokens },
      model,
      provider: "ollama",
      finishReason: toolCalls.length > 0 ? "tool_use" : "end"
    };
  }
  async function isAvailable() {
    try {
      await client.list();
      return true;
    } catch {
      return false;
    }
  }
  async function embed(text) {
    const response = await client.embed({
      model: config.embeddingModel,
      input: text
    });
    return response.embeddings[0] ?? [];
  }
  return {
    name: "ollama",
    complete,
    isAvailable,
    embed
  };
}

// src/llm/router.ts
var logger8 = createLogger("llm:router");
function getModelForTask(config, provider, taskType) {
  if (provider === "claude") {
    return config.llm.providers.claude.defaultModel;
  }
  const ollama = config.llm.providers.ollama;
  switch (taskType) {
    case "complex_reasoning":
    case "code_generation":
    case "memory_consolidation":
      return ollama.smartModel;
    case "simple_tasks":
    case "private_content":
      return ollama.fastModel;
    case "embeddings":
      return ollama.embeddingModel;
    default:
      return ollama.defaultModel;
  }
}
function createLLMRouter(deps) {
  const { config } = deps;
  const costTracker = createCostTracker({ store: deps.usageStore });
  const providers = /* @__PURE__ */ new Map();
  if (deps.claudeProvider) providers.set("claude", deps.claudeProvider);
  if (deps.ollamaProvider) providers.set("ollama", deps.ollamaProvider);
  function route(taskType) {
    const routing = config.llm.routing;
    const routingMap = {
      complex_reasoning: routing.complexReasoning,
      code_generation: routing.codeGeneration,
      simple_tasks: routing.simpleTasks,
      embeddings: routing.embeddings,
      memory_consolidation: routing.memoryConsolidation,
      private_content: routing.privateContent,
      general: config.llm.defaultProvider
    };
    const provider = routingMap[taskType] ?? config.llm.defaultProvider;
    const model = getModelForTask(config, provider, taskType);
    return {
      provider,
      model,
      reason: `Task type "${taskType}" routed to ${provider}/${model}`
    };
  }
  async function complete(request) {
    const taskType = request.taskType ?? "general";
    const decision = route(taskType);
    const startTime = Date.now();
    let primaryError;
    const primary = providers.get(decision.provider);
    if (primary) {
      try {
        const response = await primary.complete({
          ...request,
          model: request.model ?? decision.model
        });
        const latencyMs = Date.now() - startTime;
        costTracker.record({
          provider: decision.provider,
          model: response.model,
          usage: response.usage,
          taskType,
          latencyMs
        });
        logger8.info("LLM request completed", {
          provider: decision.provider,
          model: response.model,
          taskType,
          latencyMs,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens
        });
        return response;
      } catch (err) {
        primaryError = err;
        logger8.warn("Primary provider failed, trying fallback", {
          provider: decision.provider,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
    const fallbackName = decision.provider === "claude" ? "ollama" : "claude";
    const fallback = providers.get(fallbackName);
    if (fallback) {
      const fallbackModel = getModelForTask(config, fallbackName, taskType);
      try {
        const response = await fallback.complete({
          ...request,
          model: request.model ?? fallbackModel
        });
        const latencyMs = Date.now() - startTime;
        costTracker.record({
          provider: fallbackName,
          model: response.model,
          usage: response.usage,
          taskType,
          latencyMs
        });
        logger8.info("LLM request completed via fallback", {
          provider: fallbackName,
          model: response.model,
          taskType,
          latencyMs
        });
        return response;
      } catch (err) {
        throw new Error(
          `All LLM providers failed. Last error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    if (primaryError) {
      throw new Error(
        `Primary provider "${decision.provider}" failed and no fallback provider is configured. Last error: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}`
      );
    }
    throw new Error("No LLM providers available");
  }
  return {
    complete,
    route,
    getCostTracker: () => costTracker
  };
}

// src/memory/consolidated.ts
import { v4 as uuidv4 } from "uuid";
var logger9 = createLogger("memory:consolidated");
var SELECT_MEMORIES = `SELECT id, created_at, updated_at, category, content, confidence, source_episodes, embedding, active,
		        reinforcement_count, last_reinforced_at, contradictions
		 FROM memories`;
function clampConfidence(value) {
  return Math.max(0, Math.min(1, value));
}
function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item));
  } catch {
    return [];
  }
}
function serializeEmbedding(embedding) {
  if (!embedding) return null;
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}
function deserializeEmbedding(value) {
  if (!value || value.byteLength < 4) return null;
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  return new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));
}
function mapRowToMemory(row) {
  return {
    id: row.id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    category: row.category,
    content: row.content,
    confidence: row.confidence,
    sourceEpisodes: parseJsonArray(row.source_episodes),
    embedding: deserializeEmbedding(row.embedding),
    active: Boolean(row.active),
    reinforcementCount: row.reinforcement_count ?? 0,
    lastReinforcedAt: row.last_reinforced_at ? new Date(row.last_reinforced_at) : null,
    contradictions: parseJsonArray(row.contradictions)
  };
}
function lexicalScore(content, queryTokens2) {
  if (queryTokens2.length === 0) return 0;
  const normalized = content.toLowerCase();
  let hits = 0;
  for (const token of queryTokens2) {
    if (normalized.includes(token)) hits++;
  }
  return hits / queryTokens2.length;
}
function cosineSimilarity(a, b) {
  if (!a || a.length === 0 || b.length === 0) return 0;
  const dimensions = Math.min(a.length, b.length);
  if (dimensions === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < dimensions; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
function tokenizeQuery(query) {
  return query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
}
function buildSearchQuery(options) {
  const params = [];
  const filters = [];
  if (!options.includeInactive) {
    filters.push("active = 1");
  }
  if (options.minConfidence !== void 0) {
    filters.push("confidence >= ?");
    params.push(clampConfidence(options.minConfidence));
  }
  if (options.category) {
    filters.push("category = ?");
    params.push(options.category);
  }
  return {
    whereClause: filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "",
    params
  };
}
function createConsolidatedMemoryStore(options) {
  const topKDefault = options.defaultTopK ?? 10;
  function getById(id) {
    const row = options.store.get(
      `${SELECT_MEMORIES}
			 WHERE id = ?`,
      [id]
    );
    return row ? mapRowToMemory(row) : null;
  }
  function requireMemory(id) {
    const memory = getById(id);
    if (!memory) {
      throw new Error(`Memory not found: ${id}`);
    }
    return memory;
  }
  async function resolveEmbedding(content) {
    try {
      return await options.embeddings.embed(content);
    } catch (error) {
      logger9.warn("Failed to generate consolidated embedding", {
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }
  async function resolveUpdatedEmbedding(current, changes) {
    if (!changes.content || changes.content === current.content) {
      return current.embedding;
    }
    return options.embeddings.embed(changes.content);
  }
  function buildNextState(current, changes, embedding) {
    return {
      category: changes.category ?? current.category,
      content: changes.content ?? current.content,
      confidence: clampConfidence(changes.confidence ?? current.confidence),
      sourceEpisodes: changes.sourceEpisodes ?? current.sourceEpisodes,
      embedding,
      active: changes.active ?? current.active,
      reinforcementCount: changes.reinforcementCount ?? current.reinforcementCount,
      lastReinforcedAt: changes.lastReinforcedAt ? changes.lastReinforcedAt.toISOString() : current.lastReinforcedAt?.toISOString() ?? null,
      contradictions: changes.contradictions ?? current.contradictions
    };
  }
  async function resolveQueryEmbedding(query) {
    try {
      return await options.embeddings.embed(query);
    } catch (error) {
      logger9.warn("Failed to generate query embedding for consolidated search", {
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }
  function rankSearchResults(memories, queryEmbedding, queryTokens2, topK) {
    return memories.map((memory) => {
      const semantic = queryEmbedding ? cosineSimilarity(memory.embedding, queryEmbedding) : 0;
      const lexical = lexicalScore(memory.content, queryTokens2);
      const confidenceBoost = memory.confidence * 0.05;
      const score = semantic * 0.75 + lexical * 0.25 + confidenceBoost;
      return { memory, score };
    }).sort((a, b) => b.score - a.score).slice(0, topK).map((item) => item.memory);
  }
  async function create(memory) {
    const id = uuidv4();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const confidence = clampConfidence(memory.confidence ?? 1);
    const embedding = await resolveEmbedding(memory.content);
    options.store.run(
      `INSERT INTO memories (
				id, created_at, updated_at, category, content, confidence, source_episodes,
				embedding, active, reinforcement_count, last_reinforced_at, contradictions
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        now,
        now,
        memory.category,
        memory.content,
        confidence,
        JSON.stringify(memory.sourceEpisodes ?? []),
        serializeEmbedding(embedding),
        memory.active ?? true ? 1 : 0,
        1,
        now,
        JSON.stringify(memory.contradictions ?? [])
      ]
    );
    return id;
  }
  async function update(id, changes) {
    const current = requireMemory(id);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const nextEmbedding = await resolveUpdatedEmbedding(current, changes);
    const next = buildNextState(current, changes, nextEmbedding);
    options.store.run(
      `UPDATE memories
			 SET updated_at = ?,
			     category = ?,
			     content = ?,
			     confidence = ?,
			     source_episodes = ?,
			     embedding = ?,
			     active = ?,
			     reinforcement_count = ?,
			     last_reinforced_at = ?,
			     contradictions = ?
			 WHERE id = ?`,
      [
        now,
        next.category,
        next.content,
        next.confidence,
        JSON.stringify(next.sourceEpisodes),
        serializeEmbedding(next.embedding),
        next.active ? 1 : 0,
        next.reinforcementCount,
        next.lastReinforcedAt,
        JSON.stringify(next.contradictions),
        id
      ]
    );
  }
  async function reinforce(id) {
    requireMemory(id);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    options.store.run(
      `UPDATE memories
			 SET reinforcement_count = COALESCE(reinforcement_count, 0) + 1,
			     last_reinforced_at = ?,
			     updated_at = ?,
			     confidence = MIN(confidence + 0.05, 1.0)
			 WHERE id = ?`,
      [now, now, id]
    );
  }
  async function deactivate(id) {
    requireMemory(id);
    options.store.run(`UPDATE memories SET active = 0, updated_at = ? WHERE id = ?`, [
      (/* @__PURE__ */ new Date()).toISOString(),
      id
    ]);
  }
  async function reactivate(id) {
    requireMemory(id);
    options.store.run(`UPDATE memories SET active = 1, updated_at = ? WHERE id = ?`, [
      (/* @__PURE__ */ new Date()).toISOString(),
      id
    ]);
  }
  async function search(query, searchOptions = {}) {
    const topK = searchOptions.topK ?? topKDefault;
    const queryTokens2 = tokenizeQuery(query);
    const sqlQuery = buildSearchQuery(searchOptions);
    const rows = options.store.all(
      `${SELECT_MEMORIES}
			 ${sqlQuery.whereClause}
			 ORDER BY updated_at DESC
			 LIMIT 2000`,
      sqlQuery.params
    );
    const memories = rows.map(mapRowToMemory);
    if (query.trim().length === 0) {
      return memories.slice(0, topK);
    }
    const queryEmbedding = await resolveQueryEmbedding(query);
    return rankSearchResults(memories, queryEmbedding, queryTokens2, topK);
  }
  async function getByCategory(category) {
    const rows = options.store.all(
      `${SELECT_MEMORIES}
			 WHERE category = ? AND active = 1
			 ORDER BY confidence DESC, updated_at DESC`,
      [category]
    );
    return rows.map(mapRowToMemory);
  }
  async function getActive(minConfidence = 0) {
    const rows = options.store.all(
      `${SELECT_MEMORIES}
			 WHERE active = 1 AND confidence >= ?
			 ORDER BY confidence DESC, updated_at DESC`,
      [clampConfidence(minConfidence)]
    );
    return rows.map(mapRowToMemory);
  }
  return {
    create,
    update,
    reinforce,
    deactivate,
    reactivate,
    search,
    getByCategory,
    getActive
  };
}

// src/memory/consolidation.ts
import { v4 as uuidv42 } from "uuid";
import { z as z7 } from "zod";
var logger10 = createLogger("memory:consolidation");
var CATEGORY_VALUES2 = [
  "fact",
  "preference",
  "pattern",
  "goal",
  "relationship",
  "skill",
  "routine",
  "emotional",
  "project"
];
var MemoryCategorySchema = z7.enum(CATEGORY_VALUES2);
var ConsolidationLLMResultSchema = z7.object({
  new: z7.array(
    z7.object({
      category: MemoryCategorySchema,
      content: z7.string().min(1),
      confidence: z7.number().min(0).max(1).optional(),
      sourceEpisodes: z7.array(z7.string()).optional()
    })
  ).default([]),
  reinforce: z7.array(
    z7.object({
      memoryId: z7.string().min(1),
      reason: z7.string().optional()
    })
  ).default([]),
  update: z7.array(
    z7.object({
      memoryId: z7.string().min(1),
      newContent: z7.string().min(1),
      reason: z7.string().optional()
    })
  ).default([]),
  contradict: z7.array(
    z7.object({
      memoryId: z7.string().min(1),
      contradictedBy: z7.string().min(1),
      resolution: z7.string().optional()
    })
  ).default([]),
  decay: z7.array(
    z7.object({
      memoryId: z7.string().min(1),
      newConfidence: z7.number().min(0).max(1)
    })
  ).default([]),
  connect: z7.array(
    z7.object({
      memoryA: z7.string().min(1),
      memoryB: z7.string().min(1),
      relationship: z7.string().min(1)
    })
  ).default([])
}).strict();
var EMPTY_RESULT = {
  new: [],
  reinforce: [],
  update: [],
  contradict: [],
  decay: [],
  connect: []
};
function clampConfidence2(value) {
  return Math.max(0, Math.min(1, value));
}
function parseJsonArray2(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item));
  } catch {
    return [];
  }
}
function serializeEmbedding2(embedding) {
  if (!embedding) return null;
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}
function insertPreparedNewMemories(store, items, nowIso) {
  for (const item of items) {
    store.run(
      `INSERT INTO memories (
				id, created_at, updated_at, category, content, confidence, source_episodes, embedding,
				active, reinforcement_count, last_reinforced_at, contradictions
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        nowIso,
        nowIso,
        item.category,
        item.content,
        item.confidence,
        JSON.stringify(item.sourceEpisodes),
        serializeEmbedding2(item.embedding),
        1,
        1,
        nowIso,
        JSON.stringify([])
      ]
    );
  }
}
function applyReinforcements(store, items, nowIso) {
  for (const item of items) {
    store.run(
      `UPDATE memories
			 SET reinforcement_count = COALESCE(reinforcement_count, 0) + 1,
			     confidence = MIN(confidence + 0.05, 1.0),
			     last_reinforced_at = ?,
			     updated_at = ?
			 WHERE id = ?`,
      [nowIso, nowIso, item.memoryId]
    );
  }
}
function applyPreparedUpdates(store, items, nowIso) {
  for (const item of items) {
    store.run(
      `UPDATE memories
			 SET content = ?,
			     embedding = ?,
			     updated_at = ?
			 WHERE id = ?`,
      [item.newContent, serializeEmbedding2(item.embedding), nowIso, item.memoryId]
    );
  }
}
function applyContradictions(store, items, nowIso, errors) {
  for (const item of items) {
    const row = store.get(
      `SELECT id, category, content, confidence, source_episodes, reinforcement_count,
			        last_reinforced_at, contradictions, active
			 FROM memories
			 WHERE id = ?`,
      [item.memoryId]
    );
    if (!row) {
      errors.push(`Missing memory for contradiction: ${item.memoryId}`);
      continue;
    }
    const contradictions = parseJsonArray2(row.contradictions);
    if (!contradictions.includes(item.contradictedBy)) {
      contradictions.push(item.contradictedBy);
    }
    const loweredConfidence = Math.max(0.1, row.confidence - 0.2);
    store.run(
      `UPDATE memories
			 SET contradictions = ?, confidence = ?, updated_at = ?
			 WHERE id = ?`,
      [JSON.stringify(contradictions), loweredConfidence, nowIso, item.memoryId]
    );
  }
}
function applyDecayActions(store, items, nowIso, deactivateThreshold) {
  let deactivated = 0;
  for (const item of items) {
    const confidence = clampConfidence2(item.newConfidence);
    store.run(
      `UPDATE memories
			 SET confidence = ?, updated_at = ?
			 WHERE id = ?`,
      [confidence, nowIso, item.memoryId]
    );
    if (confidence < deactivateThreshold) {
      store.run(
        `UPDATE memories
				 SET active = 0, updated_at = ?
				 WHERE id = ?`,
        [nowIso, item.memoryId]
      );
      deactivated++;
    }
  }
  return deactivated;
}
function markEpisodesConsolidated(store, episodes) {
  if (episodes.length === 0) return;
  const placeholders = episodes.map(() => "?").join(", ");
  store.run(
    `UPDATE episodes
		 SET consolidated = 1
		 WHERE id IN (${placeholders})`,
    episodes.map((episode) => episode.id)
  );
}
function parseEpisodeRow(row) {
  const metadata = row.metadata ? JSON.parse(row.metadata) : {};
  return {
    id: row.id,
    timestamp: new Date(row.timestamp),
    channel: row.channel,
    role: row.role,
    content: row.content,
    embedding: null,
    metadata,
    consolidated: Boolean(row.consolidated)
  };
}
function extractJsonBlock2(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1).trim();
  }
  return null;
}
function parseConsolidationResponse(text) {
  const block = extractJsonBlock2(text);
  if (!block) {
    return EMPTY_RESULT;
  }
  try {
    const raw = JSON.parse(block);
    return ConsolidationLLMResultSchema.parse(raw);
  } catch {
    return EMPTY_RESULT;
  }
}
function promptMemoryView(memory) {
  return {
    id: memory.id,
    category: memory.category,
    content: memory.content,
    confidence: memory.confidence,
    sourceEpisodes: parseJsonArray2(memory.source_episodes),
    reinforcementCount: memory.reinforcement_count ?? 0,
    lastReinforcedAt: memory.last_reinforced_at,
    contradictions: parseJsonArray2(memory.contradictions)
  };
}
function promptEpisodeView(episode) {
  return {
    id: episode.id,
    timestamp: episode.timestamp.toISOString(),
    channel: episode.channel,
    role: episode.role,
    content: episode.content,
    metadata: episode.metadata
  };
}
function buildConsolidationPrompt(params) {
  const existing = params.existingMemories.map(promptMemoryView);
  const episodes = params.episodes.map(promptEpisodeView);
  return [
    "You are the memory consolidation system for Mama.",
    "Analyze the new episodes and return strict JSON only.",
    "Prefer updating/reinforcing existing memories instead of duplicates.",
    "Categories allowed: fact, preference, pattern, goal, relationship, skill, routine, emotional, project.",
    "",
    "Output schema:",
    "{",
    '  "new": [{ "category": "...", "content": "...", "confidence": 0-1, "sourceEpisodes": ["..."] }],',
    '  "reinforce": [{ "memoryId": "...", "reason": "..." }],',
    '  "update": [{ "memoryId": "...", "newContent": "...", "reason": "..." }],',
    '  "contradict": [{ "memoryId": "...", "contradictedBy": "...", "resolution": "..." }],',
    '  "decay": [{ "memoryId": "...", "newConfidence": 0-1 }],',
    '  "connect": [{ "memoryA": "...", "memoryB": "...", "relationship": "..." }]',
    "}",
    "",
    `Current consolidated memories (${existing.length}):`,
    JSON.stringify(existing, null, 2),
    "",
    `New episodes (${episodes.length}):`,
    JSON.stringify(episodes, null, 2)
  ].join("\n");
}
function createConsolidationEngine(options) {
  const batchSize = options.batchSize ?? 100;
  const minEpisodesDefault = options.minEpisodesToConsolidate ?? 10;
  const deactivateThreshold = options.deactivateThreshold ?? 0.1;
  function getPendingEpisodeCount() {
    const row = options.store.get(
      "SELECT COUNT(*) AS count FROM episodes WHERE consolidated = 0"
    );
    return row?.count ?? 0;
  }
  function loadPendingEpisodes(limit) {
    const rows = options.store.all(
      `SELECT id, timestamp, channel, role, content, metadata, consolidated
			 FROM episodes
			 WHERE consolidated = 0
			 ORDER BY timestamp ASC
			 LIMIT ?`,
      [limit]
    );
    return rows.map(parseEpisodeRow);
  }
  function loadExistingMemories() {
    return options.store.all(
      `SELECT id, category, content, confidence, source_episodes, reinforcement_count,
			        last_reinforced_at, contradictions, active
			 FROM memories
			 WHERE active = 1
			 ORDER BY confidence DESC, updated_at DESC
			 LIMIT 300`
    );
  }
  async function embedOrNull(text) {
    try {
      return await options.embeddings.embed(text);
    } catch (error) {
      logger10.warn("Failed to embed consolidation content", {
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }
  async function prepareNewMemories(items) {
    const prepared = [];
    for (const item of items) {
      prepared.push({
        id: uuidv42(),
        category: item.category,
        content: item.content,
        confidence: clampConfidence2(item.confidence ?? 0.75),
        sourceEpisodes: item.sourceEpisodes ?? [],
        embedding: await embedOrNull(item.content)
      });
    }
    return prepared;
  }
  async function prepareUpdates(items) {
    const prepared = [];
    for (const item of items) {
      prepared.push({
        memoryId: item.memoryId,
        newContent: item.newContent,
        embedding: await embedOrNull(item.newContent)
      });
    }
    return prepared;
  }
  async function runConsolidation(runOptions = {}) {
    const startedAt = /* @__PURE__ */ new Date();
    const pendingCount = getPendingEpisodeCount();
    const threshold = runOptions.minEpisodesToConsolidate ?? minEpisodesDefault;
    if (!runOptions.force && pendingCount < threshold) {
      return {
        startedAt: startedAt.toISOString(),
        finishedAt: (/* @__PURE__ */ new Date()).toISOString(),
        skipped: true,
        skipReason: `Only ${pendingCount} pending episodes (min ${threshold})`,
        pendingEpisodes: pendingCount,
        processedEpisodes: 0,
        created: 0,
        reinforced: 0,
        updated: 0,
        contradicted: 0,
        decayed: 0,
        deactivated: 0,
        connected: 0,
        errors: []
      };
    }
    const episodes = loadPendingEpisodes(batchSize);
    if (episodes.length === 0) {
      return {
        startedAt: startedAt.toISOString(),
        finishedAt: (/* @__PURE__ */ new Date()).toISOString(),
        skipped: true,
        skipReason: "No unconsolidated episodes",
        pendingEpisodes: pendingCount,
        processedEpisodes: 0,
        created: 0,
        reinforced: 0,
        updated: 0,
        contradicted: 0,
        decayed: 0,
        deactivated: 0,
        connected: 0,
        errors: []
      };
    }
    const existingMemories = loadExistingMemories();
    const prompt = buildConsolidationPrompt({ existingMemories, episodes });
    const request = { role: "user", content: prompt };
    const response = await options.router.complete({
      messages: [request],
      taskType: "memory_consolidation",
      temperature: 0.1,
      maxTokens: 4096
    });
    const parsed = parseConsolidationResponse(response.content);
    const preparedNew = await prepareNewMemories(parsed.new);
    const preparedUpdate = await prepareUpdates(parsed.update);
    const errors = [];
    let deactivated = 0;
    const nowIso = (/* @__PURE__ */ new Date()).toISOString();
    options.store.transaction(() => {
      insertPreparedNewMemories(options.store, preparedNew, nowIso);
      applyReinforcements(options.store, parsed.reinforce, nowIso);
      applyPreparedUpdates(options.store, preparedUpdate, nowIso);
      applyContradictions(options.store, parsed.contradict, nowIso, errors);
      deactivated = applyDecayActions(options.store, parsed.decay, nowIso, deactivateThreshold);
      markEpisodesConsolidated(options.store, episodes);
    });
    let decayReport;
    if (runOptions.runDecay !== false && options.decay) {
      decayReport = await options.decay.runDecay();
    }
    if (runOptions.regenerateSoul !== false && options.soul) {
      const memories = await options.consolidated.getActive(0);
      options.soul.regenerateFromMemories(memories);
    }
    const report = {
      startedAt: startedAt.toISOString(),
      finishedAt: (/* @__PURE__ */ new Date()).toISOString(),
      skipped: false,
      pendingEpisodes: pendingCount,
      processedEpisodes: episodes.length,
      created: preparedNew.length,
      reinforced: parsed.reinforce.length,
      updated: preparedUpdate.length,
      contradicted: parsed.contradict.length,
      decayed: parsed.decay.length,
      deactivated,
      connected: parsed.connect.length,
      errors,
      decayReport
    };
    logger10.info("Consolidation run finished", { ...report });
    return report;
  }
  return {
    runConsolidation,
    getPendingEpisodeCount
  };
}
function createConsolidationScheduler(options) {
  const intervalMs = Math.max(6e4, options.intervalHours * 60 * 60 * 1e3);
  let timer = null;
  let running = false;
  async function tick() {
    if (running) {
      return {
        startedAt: (/* @__PURE__ */ new Date()).toISOString(),
        finishedAt: (/* @__PURE__ */ new Date()).toISOString(),
        skipped: true,
        skipReason: "Consolidation already running",
        pendingEpisodes: options.engine.getPendingEpisodeCount(),
        processedEpisodes: 0,
        created: 0,
        reinforced: 0,
        updated: 0,
        contradicted: 0,
        decayed: 0,
        deactivated: 0,
        connected: 0,
        errors: []
      };
    }
    if (options.isIdle && !options.isIdle()) {
      return {
        startedAt: (/* @__PURE__ */ new Date()).toISOString(),
        finishedAt: (/* @__PURE__ */ new Date()).toISOString(),
        skipped: true,
        skipReason: "Agent is active",
        pendingEpisodes: options.engine.getPendingEpisodeCount(),
        processedEpisodes: 0,
        created: 0,
        reinforced: 0,
        updated: 0,
        contradicted: 0,
        decayed: 0,
        deactivated: 0,
        connected: 0,
        errors: []
      };
    }
    running = true;
    try {
      const report = await options.engine.runConsolidation({
        minEpisodesToConsolidate: options.minEpisodesToConsolidate
      });
      options.onReport?.(report);
      return report;
    } finally {
      running = false;
    }
  }
  function start() {
    if (timer) return;
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
  }
  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }
  return {
    start,
    stop,
    runOnce: tick,
    isRunning: () => running
  };
}

// src/memory/decay.ts
var logger11 = createLogger("memory:decay");
function clampConfidence3(value) {
  return Math.max(0, Math.min(1, value));
}
function daysBetween(older, newer) {
  return Math.max(0, (newer.getTime() - older.getTime()) / (24 * 60 * 60 * 1e3));
}
function createDecayEngine(options) {
  const inactiveDaysThreshold = options.inactiveDaysThreshold ?? 30;
  const decayFactor = options.decayFactor ?? 0.9;
  const deactivateThreshold = options.deactivateThreshold ?? 0.1;
  async function runDecay() {
    const now = options.now ?? /* @__PURE__ */ new Date();
    const candidates = options.store.all(
      `SELECT id, created_at, last_reinforced_at, confidence
			 FROM memories
			 WHERE active = 1`
    );
    let decayed = 0;
    let deactivated = 0;
    for (const candidate of candidates) {
      const reference = candidate.last_reinforced_at ? new Date(candidate.last_reinforced_at) : new Date(candidate.created_at);
      const ageDays = daysBetween(reference, now);
      if (ageDays < inactiveDaysThreshold) {
        continue;
      }
      const newConfidence = clampConfidence3(candidate.confidence * decayFactor);
      if (newConfidence !== candidate.confidence) {
        await options.consolidated.update(candidate.id, { confidence: newConfidence });
        decayed++;
      }
      if (newConfidence < deactivateThreshold) {
        await options.consolidated.deactivate(candidate.id);
        deactivated++;
      }
    }
    logger11.info("Decay run completed", {
      checked: candidates.length,
      decayed,
      deactivated
    });
    return {
      checked: candidates.length,
      decayed,
      deactivated
    };
  }
  return {
    runDecay
  };
}

// src/memory/embeddings.ts
var logger12 = createLogger("memory:embeddings");
function normalizeEmbedding(value) {
  return value instanceof Float32Array ? value : Float32Array.from(value);
}
function createEmbeddingService(options) {
  const cache = /* @__PURE__ */ new Map();
  async function embed(text) {
    const key = text.trim();
    if (cache.has(key)) {
      const cached = cache.get(key);
      if (cached) {
        return cached;
      }
    }
    const value = await options.embedder(key);
    const embedding = normalizeEmbedding(value);
    cache.set(key, embedding);
    logger12.debug("Embedding generated", {
      textLength: key.length,
      dimensions: embedding.length,
      cacheSize: cache.size
    });
    return embedding;
  }
  async function embedBatch(texts) {
    const unique = [...new Set(texts.map((item) => item.trim()))];
    await Promise.all(unique.map((text) => embed(text)));
    return texts.map((text) => {
      const cached = cache.get(text.trim());
      if (!cached) {
        throw new Error("Embedding cache inconsistency");
      }
      return cached;
    });
  }
  function clearCache() {
    cache.clear();
  }
  function getCacheSize() {
    return cache.size;
  }
  return {
    embed,
    embedBatch,
    clearCache,
    getCacheSize
  };
}

// src/memory/episodic.ts
import { v4 as uuidv43 } from "uuid";
var logger13 = createLogger("memory:episodic");
var STOPWORDS = /* @__PURE__ */ new Set([
  "the",
  "this",
  "that",
  "with",
  "from",
  "have",
  "what",
  "when",
  "where",
  "which",
  "while",
  "about",
  "there",
  "their",
  "your",
  "you",
  "and",
  "for",
  "into",
  "just",
  "than",
  "then",
  "were",
  "will",
  "would",
  "could",
  "should",
  "been",
  "they",
  "them",
  "also",
  "please"
]);
function serializeEmbedding3(embedding) {
  if (!embedding) return null;
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}
function deserializeEmbedding2(value) {
  if (!value || value.byteLength < 4) return null;
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  const dimensions = Math.floor(bytes.byteLength / 4);
  return new Float32Array(bytes.buffer, 0, dimensions);
}
function parseMetadata(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
function mapRowToEpisode(row) {
  return {
    id: row.id,
    timestamp: new Date(row.timestamp),
    channel: row.channel,
    role: row.role,
    content: row.content,
    embedding: deserializeEmbedding2(row.embedding),
    metadata: parseMetadata(row.metadata),
    consolidated: Boolean(row.consolidated)
  };
}
function normalizeTopicToken(token) {
  return token.toLowerCase();
}
function extractTopics(content) {
  const tokens = content.toLowerCase().match(/[a-z0-9]{4,}/g)?.map((token) => token.trim()).filter((token) => token.length >= 4 && !STOPWORDS.has(token)).map((token) => normalizeTopicToken(token));
  if (!tokens) return [];
  const frequencies = /* @__PURE__ */ new Map();
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return [...frequencies.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([token]) => token);
}
function extractEntities(content) {
  const entities = content.match(/\b[A-Z][a-zA-Z0-9_-]{2,}\b/g) ?? [];
  return [...new Set(entities)].slice(0, 8);
}
function detectImportance(content) {
  const normalized = content.toLowerCase();
  if (normalized.includes("urgent") || normalized.includes("critical") || normalized.includes("security") || normalized.includes("incident")) {
    return "high";
  }
  if (content.length > 280) {
    return "high";
  }
  if (content.length > 120) {
    return "medium";
  }
  return "low";
}
function detectEmotionalTone(content) {
  const normalized = content.toLowerCase();
  const positive = ["great", "thanks", "good", "awesome", "love", "nice", "perfect"];
  const negative = ["error", "fail", "broken", "angry", "upset", "problem", "issue"];
  if (positive.some((token) => normalized.includes(token))) return "positive";
  if (negative.some((token) => normalized.includes(token))) return "negative";
  return "neutral";
}
function enrichMetadata(content, metadata) {
  const providedTopics = Array.isArray(metadata?.topics) ? metadata.topics.map((topic) => normalizeTopicToken(String(topic))) : [];
  const providedEntities = Array.isArray(metadata?.entities) ? metadata.entities.map((entity) => String(entity)) : [];
  const topics = [.../* @__PURE__ */ new Set([...providedTopics, ...extractTopics(content)])].slice(0, 10);
  const entities = [.../* @__PURE__ */ new Set([...providedEntities, ...extractEntities(content)])].slice(0, 10);
  return {
    ...metadata,
    topics,
    entities,
    importance: metadata?.importance ?? detectImportance(content),
    emotionalTone: metadata?.emotionalTone ?? detectEmotionalTone(content)
  };
}
function cosineSimilarity2(a, b) {
  if (!a || a.length === 0 || b.length === 0) return 0;
  const dimensions = Math.min(a.length, b.length);
  if (dimensions === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < dimensions; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
function buildQueryFilters(options) {
  const filters = [];
  const params = [];
  if (options.start) {
    filters.push("timestamp >= ?");
    params.push(options.start.toISOString());
  }
  if (options.end) {
    filters.push("timestamp <= ?");
    params.push(options.end.toISOString());
  }
  if (options.channel) {
    filters.push("channel = ?");
    params.push(options.channel);
  }
  if (options.role) {
    filters.push("role = ?");
    params.push(options.role);
  }
  return {
    whereClause: filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "",
    params
  };
}
function queryTokens(query) {
  return query.toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((token) => !STOPWORDS.has(token)).slice(0, 8) ?? [];
}
function createEpisodicMemory(options) {
  const topKDefault = options.defaultTopK ?? 10;
  function getCandidates(searchOptions = {}) {
    const filters = buildQueryFilters(searchOptions);
    const rows = options.store.all(
      `SELECT id, timestamp, channel, role, content, embedding, metadata, consolidated
			 FROM episodes
			 ${filters.whereClause}
			 ORDER BY timestamp DESC
			 LIMIT 3000`,
      filters.params
    );
    return rows.map(mapRowToEpisode);
  }
  async function storeEpisode(episode) {
    const id = uuidv43();
    const timestamp = (episode.timestamp ?? /* @__PURE__ */ new Date()).toISOString();
    const metadata = enrichMetadata(episode.content, episode.metadata);
    let embedding = null;
    try {
      embedding = await options.embeddings.embed(episode.content);
    } catch (error) {
      logger13.warn("Failed to generate embedding for episode", {
        id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    options.store.run(
      `INSERT INTO episodes (id, timestamp, channel, role, content, embedding, metadata, consolidated)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        timestamp,
        episode.channel,
        episode.role,
        episode.content,
        serializeEmbedding3(embedding),
        JSON.stringify(metadata),
        episode.consolidated ? 1 : 0
      ]
    );
    return id;
  }
  async function searchSemantic(query, searchOptions = {}) {
    const queryEmbedding = await options.embeddings.embed(query);
    const topK = searchOptions.topK ?? topKDefault;
    const candidates = getCandidates(searchOptions);
    return candidates.map((episode) => ({
      episode,
      score: cosineSimilarity2(episode.embedding, queryEmbedding)
    })).sort((a, b) => b.score - a.score).slice(0, topK).map((item) => item.episode);
  }
  async function searchTemporal(start, end) {
    const rows = options.store.all(
      `SELECT id, timestamp, channel, role, content, embedding, metadata, consolidated
			 FROM episodes
			 WHERE timestamp >= ? AND timestamp <= ?
			 ORDER BY timestamp DESC`,
      [start.toISOString(), end.toISOString()]
    );
    return rows.map(mapRowToEpisode);
  }
  async function searchHybrid(query, hybridOptions = {}) {
    const queryEmbedding = await options.embeddings.embed(query);
    const nowMs = Date.now();
    const topicTokens = queryTokens(query);
    const topK = hybridOptions.topK ?? topKDefault;
    const semanticWeight = hybridOptions.semanticWeight ?? 0.65;
    const temporalWeight = hybridOptions.temporalWeight ?? 0.25;
    const topicWeight = hybridOptions.topicWeight ?? 0.1;
    const candidates = getCandidates(hybridOptions);
    return candidates.map((episode) => {
      const semanticScore = cosineSimilarity2(episode.embedding, queryEmbedding);
      const ageDays = Math.max(0, (nowMs - episode.timestamp.getTime()) / (24 * 60 * 60 * 1e3));
      const temporalScore = 1 / (1 + ageDays);
      const topics = episode.metadata.topics ?? [];
      const topicHits = topicTokens.filter((token) => topics.includes(token)).length;
      const topicScore = topicTokens.length > 0 ? topicHits / topicTokens.length : 0;
      const score = semanticWeight * semanticScore + temporalWeight * temporalScore + topicWeight * topicScore;
      return {
        episode,
        score
      };
    }).sort((a, b) => b.score - a.score).slice(0, topK).map((item) => item.episode);
  }
  async function getRecent(limit) {
    const rows = options.store.all(
      `SELECT id, timestamp, channel, role, content, embedding, metadata, consolidated
			 FROM episodes
			 ORDER BY timestamp DESC
			 LIMIT ?`,
      [Math.max(1, limit)]
    );
    return rows.map(mapRowToEpisode);
  }
  async function markConsolidated(ids) {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(", ");
    options.store.run(`UPDATE episodes SET consolidated = 1 WHERE id IN (${placeholders})`, ids);
  }
  return {
    storeEpisode,
    searchSemantic,
    searchTemporal,
    searchHybrid,
    getRecent,
    markConsolidated
  };
}

// src/memory/working.ts
var logger14 = createLogger("memory:working");
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
function estimateMessageTokens(msg) {
  let tokens = estimateTokens(msg.content);
  tokens += 4;
  if (msg.toolCalls) {
    for (const tc of msg.toolCalls) {
      tokens += estimateTokens(JSON.stringify(tc));
    }
  }
  return tokens;
}
function createWorkingMemory(options) {
  const maxTokens = options.maxTokens;
  const compressThreshold = options.compressThreshold ?? 0.75;
  const messages = [];
  const memoryInjections = [];
  let totalTokens = 0;
  function addMessage(msg) {
    const tokens = estimateMessageTokens(msg);
    messages.push(msg);
    totalTokens += tokens;
    logger14.debug("Message added to working memory", {
      role: msg.role,
      tokens,
      totalTokens,
      messageCount: messages.length
    });
  }
  function getMessages() {
    return [...messages];
  }
  function getTokenCount() {
    return totalTokens;
  }
  async function compress(summarizer) {
    if (totalTokens < maxTokens * compressThreshold) return;
    const keepCount = Math.min(4, messages.length);
    const toCompress = messages.slice(0, messages.length - keepCount);
    const toKeep = messages.slice(messages.length - keepCount);
    if (toCompress.length === 0) return;
    logger14.info("Compressing working memory", {
      compressing: toCompress.length,
      keeping: toKeep.length
    });
    const summary = await summarizer(toCompress);
    messages.length = 0;
    messages.push({
      role: "system",
      content: `[Previous conversation summary]: ${summary}`
    });
    messages.push(...toKeep);
    totalTokens = messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
    logger14.info("Working memory compressed", {
      newTokenCount: totalTokens,
      messageCount: messages.length
    });
  }
  function clear() {
    messages.length = 0;
    memoryInjections.length = 0;
    totalTokens = 0;
  }
  function setSystemInjection(entries) {
    memoryInjections.length = 0;
    for (const entry of entries) {
      const trimmed = entry.trim();
      if (trimmed.length > 0) {
        memoryInjections.push(trimmed);
      }
    }
  }
  function getSystemInjection() {
    return [...memoryInjections];
  }
  return {
    addMessage,
    getMessages,
    getTokenCount,
    compress,
    setSystemInjection,
    clear,
    getSystemInjection
  };
}

// src/memory/retrieval.ts
var logger15 = createLogger("memory:retrieval");
var STOPWORDS2 = /* @__PURE__ */ new Set([
  "the",
  "this",
  "that",
  "with",
  "from",
  "have",
  "what",
  "when",
  "where",
  "which",
  "while",
  "about",
  "there",
  "their",
  "your",
  "you",
  "and",
  "for",
  "into",
  "just",
  "than",
  "then",
  "were",
  "will",
  "would",
  "could",
  "should",
  "been",
  "they",
  "them",
  "also",
  "please",
  "need",
  "want"
]);
function tokenizeQuery2(query) {
  return query.toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((token) => !STOPWORDS2.has(token)).slice(0, 10) ?? [];
}
function lexicalScore2(value, queryTokens2) {
  if (queryTokens2.length === 0) return 0;
  const normalized = value.toLowerCase();
  let hits = 0;
  for (const token of queryTokens2) {
    if (normalized.includes(token)) hits += 1;
  }
  return hits / queryTokens2.length;
}
function clampUnit(value) {
  return Math.max(0, Math.min(1, value));
}
function hoursSince(date, now) {
  return Math.max(0, (now.getTime() - date.getTime()) / (1e3 * 60 * 60));
}
function scoreMemory(memory, queryTokens2, now) {
  const lexical = lexicalScore2(memory.content, queryTokens2);
  const freshness = clampUnit(1 - hoursSince(memory.updatedAt, now) / (24 * 14));
  return lexical * 0.5 + memory.confidence * 0.35 + freshness * 0.15;
}
function scoreEpisode(episode, queryTokens2, now, windowHours) {
  const lexical = lexicalScore2(episode.content, queryTokens2);
  const recency = clampUnit(1 - hoursSince(episode.timestamp, now) / windowHours);
  const importanceBoost = episode.metadata.importance === "high" ? 0.15 : 0;
  return lexical * 0.55 + recency * 0.45 + importanceBoost;
}
function scoreGoal(job, queryTokens2, now) {
  const lexical = lexicalScore2(`${job.name} ${job.task}`, queryTokens2);
  if (!job.next_run) {
    return lexical * 0.7 + 0.15;
  }
  const nextRun = new Date(job.next_run);
  const hoursUntil = (nextRun.getTime() - now.getTime()) / (1e3 * 60 * 60);
  const urgency = hoursUntil <= 0 ? 1 : clampUnit(1 - hoursUntil / 24);
  return lexical * 0.6 + urgency * 0.4;
}
function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}
function formatMemoryEntry(memory) {
  return `[memory/${memory.category}/c=${memory.confidence.toFixed(2)}] ${truncate(memory.content, 220)}`;
}
function formatEpisodeEntry(episode) {
  return `[recent/${episode.role}] ${truncate(episode.content, 180)}`;
}
function formatGoalEntry(job) {
  const nextRun = job.next_run ? ` (next: ${new Date(job.next_run).toISOString()})` : "";
  return `[goal/${job.name}] ${truncate(job.task, 160)}${nextRun}`;
}
function selectWithinBudget(candidates, tokenBudget) {
  const entries = [];
  let usedTokens = 0;
  for (const candidate of candidates) {
    if (usedTokens + candidate.tokenCount > tokenBudget) {
      continue;
    }
    entries.push(candidate.entry);
    usedTokens += candidate.tokenCount;
  }
  return { entries, tokenCount: usedTokens };
}
function createMemoryRetrievalPipeline(options) {
  const maxMemoryResults = options.maxMemoryResults ?? 10;
  const maxRecentEpisodes = options.maxRecentEpisodes ?? 20;
  const recentWindowHours = options.recentWindowHours ?? 24;
  const minConfidence = options.minConfidence ?? 0.3;
  function loadActiveJobs(limit = 20) {
    return options.store.all(
      `SELECT id, name, task, next_run
			 FROM jobs
			 WHERE enabled = 1
			 ORDER BY COALESCE(next_run, '9999-12-31T00:00:00.000Z') ASC
			 LIMIT ?`,
      [limit]
    );
  }
  async function retrieveContext(query, tokenBudget) {
    if (tokenBudget <= 0) {
      return {
        entries: [],
        formatted: "",
        tokenCount: 0,
        stats: {
          tokenBudget,
          candidates: 0,
          included: 0,
          memories: 0,
          episodes: 0,
          goals: 0
        }
      };
    }
    const now = /* @__PURE__ */ new Date();
    const queryTokens2 = tokenizeQuery2(query);
    const [memories, recentEpisodes] = await Promise.all([
      options.consolidated.search(query, {
        topK: maxMemoryResults,
        minConfidence
      }),
      options.episodic.getRecent(maxRecentEpisodes)
    ]);
    const recentThreshold = now.getTime() - recentWindowHours * 60 * 60 * 1e3;
    const episodes = recentEpisodes.filter(
      (episode) => episode.timestamp.getTime() >= recentThreshold
    );
    const goals = loadActiveJobs();
    const candidates = [];
    for (const memory of memories) {
      const entry = formatMemoryEntry(memory);
      candidates.push({
        type: "memory",
        score: scoreMemory(memory, queryTokens2, now),
        entry,
        tokenCount: estimateTokens(entry)
      });
    }
    for (const episode of episodes) {
      const entry = formatEpisodeEntry(episode);
      candidates.push({
        type: "episode",
        score: scoreEpisode(episode, queryTokens2, now, recentWindowHours),
        entry,
        tokenCount: estimateTokens(entry)
      });
    }
    for (const goal of goals) {
      const entry = formatGoalEntry(goal);
      candidates.push({
        type: "goal",
        score: scoreGoal(goal, queryTokens2, now),
        entry,
        tokenCount: estimateTokens(entry)
      });
    }
    candidates.sort((a, b) => b.score - a.score || a.tokenCount - b.tokenCount);
    const selected = selectWithinBudget(candidates, tokenBudget);
    const formatted = selected.entries.join("\n");
    logger15.debug("Retrieved context from memory pipeline", {
      queryLength: query.length,
      tokenBudget,
      candidateCount: candidates.length,
      includedCount: selected.entries.length,
      selectedTokens: selected.tokenCount,
      memories: memories.length,
      episodes: episodes.length,
      goals: goals.length
    });
    return {
      entries: selected.entries,
      formatted,
      tokenCount: selected.tokenCount,
      stats: {
        tokenBudget,
        candidates: candidates.length,
        included: selected.entries.length,
        memories: memories.length,
        episodes: episodes.length,
        goals: goals.length
      }
    };
  }
  return {
    retrieveContext
  };
}

// src/memory/soul.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync6, readFileSync as readFileSync4, writeFileSync as writeFileSync4 } from "fs";
import { dirname as dirname4 } from "path";
var logger16 = createLogger("memory:soul");
var DEFAULT_SOUL = `# {agentName} \u2014 Soul Definition

## Identity
You are {agentName}, a personal AI agent owned by {userName}.
Your job is to take care of {userName}'s digital life.

## Personality
- Proactive but not intrusive
- Honest \u2014 if you can't do something, say so
- Security-conscious \u2014 always explain what you're about to do
- Efficient \u2014 minimal steps, maximum result

## Knowledge
(No consolidated memories yet)

## Active Goals
(No active goals yet)

## Preferences
(No learned preferences yet)

## Boundaries
(Configured via sandbox permissions)
`;
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function uniqueByContent(memories) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const memory of memories) {
    const key = memory.content.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(memory);
  }
  return result;
}
function upsertSection(document, title2, body) {
  const sectionHeader = `## ${title2}`;
  const sectionText = `${sectionHeader}
${body}`;
  const pattern = new RegExp(`## ${escapeRegExp(title2)}\\n[\\s\\S]*?(?=\\n## |$)`, "m");
  if (pattern.test(document)) {
    return document.replace(pattern, sectionText);
  }
  const trimmed = document.trimEnd();
  return `${trimmed}

${sectionText}
`;
}
function toBulletedList(memories, emptyLabel) {
  if (memories.length === 0) return emptyLabel;
  return memories.map((memory) => `- ${memory.content} (confidence ${memory.confidence.toFixed(2)})`).join("\n");
}
function createSoul(config) {
  let soulContent;
  function load() {
    if (existsSync5(config.soulPath)) {
      logger16.info("Loading soul from file", { path: config.soulPath });
      const raw = readFileSync4(config.soulPath, "utf-8");
      return raw.replace(/\{userName\}/g, config.userName).replace(/\{agentName\}/g, config.agentName);
    }
    logger16.info("Using default soul template");
    return DEFAULT_SOUL.replace(/\{userName\}/g, config.userName).replace(
      /\{agentName\}/g,
      config.agentName
    );
  }
  soulContent = load();
  return {
    getSoulPrompt: () => soulContent,
    reload: () => {
      soulContent = load();
    },
    regenerateFromMemories(memories) {
      const activeMemories = uniqueByContent(
        memories.filter((memory) => memory.active).sort(
          (a, b) => b.confidence - a.confidence || b.updatedAt.getTime() - a.updatedAt.getTime()
        )
      );
      const knowledge = activeMemories.filter(
        (memory) => ["fact", "pattern", "relationship", "skill", "project"].includes(memory.category)
      );
      const goals = activeMemories.filter((memory) => memory.category === "goal");
      const preferences = activeMemories.filter(
        (memory) => ["preference", "routine", "emotional"].includes(memory.category)
      );
      let nextSoul = soulContent;
      nextSoul = upsertSection(
        nextSoul,
        "Knowledge",
        toBulletedList(knowledge.slice(0, 12), "(No consolidated memories yet)")
      );
      nextSoul = upsertSection(
        nextSoul,
        "Active Goals",
        toBulletedList(goals.slice(0, 8), "(No active goals yet)")
      );
      nextSoul = upsertSection(
        nextSoul,
        "Preferences",
        toBulletedList(preferences.slice(0, 8), "(No learned preferences yet)")
      );
      mkdirSync6(dirname4(config.soulPath), { recursive: true });
      writeFileSync4(config.soulPath, nextSoul, "utf-8");
      soulContent = nextSoul;
      logger16.info("Soul regenerated from consolidated memories", {
        path: config.soulPath,
        totalMemories: activeMemories.length
      });
    }
  };
}

// src/memory/store.ts
import { mkdirSync as mkdirSync7, readdirSync, readFileSync as readFileSync5 } from "fs";
import { dirname as dirname5, join as join4 } from "path";
import { DatabaseSync } from "sqlite";
import { fileURLToPath } from "url";
var logger17 = createLogger("memory:store");
function defaultDbPath() {
  return join4(getMamaHome(), "mama.db");
}
function defaultMigrationsDir() {
  const currentFile = fileURLToPath(import.meta.url);
  return join4(dirname5(currentFile), "migrations");
}
function parseMigrationVersion(fileName) {
  const match = fileName.match(/^(\d+)_.*\.sql$/);
  if (!match?.[1]) {
    throw new Error(`Invalid migration filename: ${fileName}`);
  }
  return Number.parseInt(match[1], 10);
}
function loadMigrationFiles(migrationsDir) {
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql"));
  const migrations = files.map((name) => ({
    version: parseMigrationVersion(name),
    name,
    path: join4(migrationsDir, name)
  }));
  migrations.sort((a, b) => a.version - b.version || a.name.localeCompare(b.name));
  return migrations;
}
function ensureMigrationTable(db) {
  db.exec(`
		CREATE TABLE IF NOT EXISTS _migrations (
			version INTEGER PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			applied_at DATETIME NOT NULL
		)
	`);
}
function withTransaction(db, fn) {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function runPendingMigrations(db, migrationsDir) {
  const migrations = loadMigrationFiles(migrationsDir);
  const appliedRows = db.prepare("SELECT version, name FROM _migrations ORDER BY version ASC").all();
  const appliedVersions = new Set(appliedRows.map((row) => row.version));
  const insertMigration = db.prepare(
    "INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)"
  );
  const result = { applied: [], skipped: [] };
  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      result.skipped.push(migration.name);
      continue;
    }
    const sql = readFileSync5(migration.path, "utf-8");
    withTransaction(db, () => {
      db.exec(sql);
      insertMigration.run(migration.version, migration.name, (/* @__PURE__ */ new Date()).toISOString());
    });
    result.applied.push(migration.name);
    logger17.info("Applied migration", {
      version: migration.version,
      name: migration.name
    });
  }
  return result;
}
function createMemoryStore(options = {}) {
  const dbPath = options.dbPath ?? defaultDbPath();
  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir();
  if (dbPath !== ":memory:") {
    mkdirSync7(dirname5(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  ensureMigrationTable(db);
  runPendingMigrations(db, migrationsDir);
  function runMigrations() {
    return runPendingMigrations(db, migrationsDir);
  }
  function getAppliedMigrations() {
    const rows = db.prepare("SELECT version, name, applied_at FROM _migrations ORDER BY version ASC").all();
    return rows.map((row) => ({
      version: row.version,
      name: row.name,
      appliedAt: row.applied_at
    }));
  }
  function listTables() {
    const rows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC"
    ).all();
    return rows.map((row) => row.name);
  }
  function run(sql, params = []) {
    db.prepare(sql).run(...params);
  }
  function all(sql, params = []) {
    return db.prepare(sql).all(...params);
  }
  function get(sql, params = []) {
    return db.prepare(sql).get(...params);
  }
  function transaction(fn) {
    let result;
    withTransaction(db, () => {
      result = fn();
    });
    return result;
  }
  function close() {
    db.close();
  }
  return {
    getDbPath: () => dbPath,
    runMigrations,
    getAppliedMigrations,
    listTables,
    run,
    all,
    get,
    transaction,
    close
  };
}

// src/sandbox/audit.ts
import Database from "better-sqlite3";
var logger18 = createLogger("sandbox:audit");
function createInMemoryAuditStore() {
  const entries = [];
  function toStoredEntry(entry) {
    return {
      ...entry,
      output: entry.output?.slice(0, 1024),
      params: entry.params ? JSON.parse(JSON.stringify(entry.params)) : void 0
    };
  }
  function sortNewest(items) {
    return [...items].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }
  return {
    log(entry) {
      entries.push(toStoredEntry(entry));
    },
    query(filters) {
      const filtered = entries.filter((entry) => {
        if (filters.capability && entry.capability !== filters.capability) return false;
        if (filters.action && entry.action !== filters.action) return false;
        if (filters.result && entry.result !== filters.result) return false;
        if (filters.requestedBy && entry.requestedBy !== filters.requestedBy) return false;
        if (filters.since && entry.timestamp < filters.since) return false;
        if (filters.until && entry.timestamp > filters.until) return false;
        return true;
      });
      return sortNewest(filtered).slice(0, 1e3);
    },
    getRecent(limit) {
      return sortNewest(entries).slice(0, limit);
    },
    close() {
    }
  };
}
function createAuditStore(dbPath) {
  let db;
  try {
    db = new Database(dbPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger18.warn("SQLite audit store unavailable, using in-memory fallback", { reason });
    return createInMemoryAuditStore();
  }
  db.pragma("journal_mode = WAL");
  db.exec(`
		CREATE TABLE IF NOT EXISTS audit_log (
			id TEXT PRIMARY KEY,
			timestamp TEXT NOT NULL,
			capability TEXT NOT NULL,
			action TEXT NOT NULL,
			resource TEXT,
			params TEXT,
			decision TEXT NOT NULL,
			result TEXT NOT NULL,
			output TEXT,
			error TEXT,
			duration_ms INTEGER,
			requested_by TEXT
		)
	`);
  db.exec(`
		CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
		CREATE INDEX IF NOT EXISTS idx_audit_capability ON audit_log(capability);
		CREATE INDEX IF NOT EXISTS idx_audit_result ON audit_log(result);
	`);
  const insertStmt = db.prepare(`
		INSERT INTO audit_log (id, timestamp, capability, action, resource, params, decision, result, output, error, duration_ms, requested_by)
		VALUES (@id, @timestamp, @capability, @action, @resource, @params, @decision, @result, @output, @error, @durationMs, @requestedBy)
	`);
  const queryStmt = db.prepare(`
		SELECT * FROM audit_log
		WHERE (@capability IS NULL OR capability = @capability)
		AND (@action IS NULL OR action = @action)
		AND (@result IS NULL OR result = @result)
		AND (@since IS NULL OR timestamp >= @since)
		AND (@until IS NULL OR timestamp <= @until)
		AND (@requestedBy IS NULL OR requested_by = @requestedBy)
		ORDER BY timestamp DESC
		LIMIT 1000
	`);
  const recentStmt = db.prepare(`
		SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?
	`);
  function log(entry) {
    const truncatedOutput = entry.output?.slice(0, 1024);
    insertStmt.run({
      id: entry.id,
      timestamp: entry.timestamp.toISOString(),
      capability: entry.capability,
      action: entry.action,
      resource: entry.resource ?? "",
      params: entry.params ? JSON.stringify(entry.params) : null,
      decision: entry.decision,
      result: entry.result,
      output: truncatedOutput ?? null,
      error: entry.error ?? null,
      durationMs: entry.durationMs,
      requestedBy: entry.requestedBy
    });
    logger18.debug("Audit entry logged", {
      id: entry.id,
      capability: entry.capability,
      action: entry.action,
      decision: entry.decision,
      result: entry.result
    });
  }
  function rowToEntry(row) {
    return {
      id: row.id,
      timestamp: new Date(row.timestamp),
      capability: row.capability,
      action: row.action,
      resource: row.resource,
      params: row.params ? JSON.parse(row.params) : void 0,
      decision: row.decision,
      result: row.result,
      output: row.output ?? void 0,
      error: row.error ?? void 0,
      durationMs: row.duration_ms,
      requestedBy: row.requested_by
    };
  }
  function query(filters) {
    const rows = queryStmt.all({
      capability: filters.capability ?? null,
      action: filters.action ?? null,
      result: filters.result ?? null,
      since: filters.since?.toISOString() ?? null,
      until: filters.until?.toISOString() ?? null,
      requestedBy: filters.requestedBy ?? null
    });
    return rows.map(rowToEntry);
  }
  function getRecent(limit) {
    const rows = recentStmt.all(limit);
    return rows.map(rowToEntry);
  }
  function close() {
    db.close();
  }
  return { log, query, getRecent, close };
}

// src/sandbox/fs-cap.ts
import {
  existsSync as existsSync6,
  readdirSync as readdirSync2,
  readFileSync as readFileSync6,
  realpathSync,
  unlinkSync,
  writeFileSync as writeFileSync5
} from "fs";
import path from "path";
import micromatch from "micromatch";
import { v4 as uuidv44 } from "uuid";
var logger19 = createLogger("sandbox:fs");
var AUDIT_OUTPUT_MAX_BYTES = 1024;
function expandTilde(filePath, homePath) {
  if (filePath === "~") {
    return homePath;
  }
  if (filePath.startsWith("~/")) {
    return path.join(homePath, filePath.slice(2));
  }
  return filePath;
}
function truncateOutput(value, maxBytes) {
  if (Buffer.byteLength(value, "utf-8") <= maxBytes) {
    return value;
  }
  const buf = Buffer.from(value, "utf-8");
  const truncated = buf.subarray(0, maxBytes).toString("utf-8");
  return `${truncated}... [truncated]`;
}
function isPathTraversal(rawPath, resolvedPath, homePath) {
  if (!rawPath.includes("..")) {
    return false;
  }
  const expanded = expandTilde(rawPath, homePath);
  const expectedParent = path.dirname(path.resolve(expanded.split("..")[0] ?? expanded));
  if (!resolvedPath.startsWith(expectedParent)) {
    return true;
  }
  return false;
}
function createFsCapability(config, homePath) {
  const resolvedWorkspace = path.resolve(expandTilde(config.workspace, homePath));
  const resolvedDeniedPatterns = config.deniedPaths.map(
    (p) => path.resolve(expandTilde(p, homePath))
  );
  const resolvedAllowedRules = config.allowedPaths.map((rule) => ({
    ...rule,
    resolvedPattern: path.resolve(expandTilde(rule.path, homePath))
  }));
  function resolveFsPath(rawPath) {
    const expanded = expandTilde(rawPath, homePath);
    return path.resolve(expanded);
  }
  function resolveActionPath(resolvedPath, action) {
    try {
      if (action === "write") {
        if (!existsSync6(resolvedPath)) {
          const parent = path.dirname(resolvedPath);
          const realParent = realpathSync(parent);
          return { ok: true, path: path.join(realParent, path.basename(resolvedPath)) };
        }
      }
      return { ok: true, path: realpathSync(resolvedPath) };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Failed to resolve real path";
      return { ok: false, reason };
    }
  }
  function checkPermission(request) {
    const resolvedPath = resolveFsPath(request.resource);
    const actionPath = resolveActionPath(resolvedPath, request.action);
    if (!actionPath.ok) {
      return {
        allowed: false,
        reason: `Path resolution failed for "${request.resource}": ${actionPath.reason}`,
        level: "denied"
      };
    }
    const effectivePath = actionPath.path;
    if (isPathTraversal(request.resource, effectivePath, homePath)) {
      logger19.warn("Path traversal detected", {
        raw: request.resource,
        resolved: effectivePath
      });
      return {
        allowed: false,
        reason: `Path traversal detected: ${request.resource} resolves to ${effectivePath}`,
        level: "denied"
      };
    }
    for (const deniedPattern of resolvedDeniedPatterns) {
      if (micromatch.isMatch(effectivePath, deniedPattern)) {
        logger19.debug("Path denied by rule", {
          path: effectivePath,
          pattern: deniedPattern
        });
        return {
          allowed: false,
          reason: `Path is denied: ${request.resource}`,
          level: "denied"
        };
      }
    }
    if (effectivePath === resolvedWorkspace || effectivePath.startsWith(`${resolvedWorkspace}/`)) {
      return { allowed: true, level: "auto" };
    }
    for (const rule of resolvedAllowedRules) {
      const matchesPath = micromatch.isMatch(effectivePath, rule.resolvedPattern);
      const matchesAction = rule.actions.includes(request.action);
      if (matchesPath && matchesAction) {
        if (rule.level === "deny") {
          return {
            allowed: false,
            reason: `Rule explicitly denies ${request.action} on ${request.resource}`,
            level: "denied"
          };
        }
        const level = rule.level === "ask" ? "user-approved" : "auto";
        return { allowed: true, level };
      }
    }
    return {
      allowed: false,
      reason: `No rule allows '${request.action}' on ${request.resource}`,
      level: "denied"
    };
  }
  async function execute(action, params) {
    const rawPath = params.path;
    if (!rawPath) {
      const auditEntry = createAuditEntry(
        action,
        "",
        params,
        "rule-denied",
        "error",
        0,
        void 0,
        "Missing required parameter: path"
      );
      return {
        success: false,
        output: null,
        error: "Missing required parameter: path",
        auditEntry,
        durationMs: 0
      };
    }
    const resolvedPath = resolveFsPath(rawPath);
    const permRequest = {
      capability: "filesystem",
      action,
      resource: rawPath,
      requestedBy: params.requestedBy ?? "agent"
    };
    const decision = checkPermission(permRequest);
    if (!decision.allowed) {
      const auditEntry = createAuditEntry(
        action,
        resolvedPath,
        params,
        "rule-denied",
        "denied",
        0,
        void 0,
        decision.reason
      );
      logger19.warn("Filesystem access denied", {
        action,
        path: resolvedPath,
        reason: decision.reason
      });
      return {
        success: false,
        output: null,
        error: decision.reason,
        auditEntry,
        durationMs: 0
      };
    }
    if (decision.level === "user-approved" && params.__approvedByUser !== true) {
      const auditEntry = createAuditEntry(
        action,
        resolvedPath,
        params,
        "rule-denied",
        "denied",
        0,
        void 0,
        "Missing explicit user approval token",
        permRequest.requestedBy
      );
      return {
        success: false,
        output: null,
        error: "Missing explicit user approval token",
        auditEntry,
        durationMs: 0
      };
    }
    const actionPath = resolveActionPath(resolvedPath, action);
    if (!actionPath.ok) {
      const auditEntry = createAuditEntry(
        action,
        resolvedPath,
        params,
        "error",
        "error",
        0,
        void 0,
        `Path resolution failed: ${actionPath.reason}`,
        permRequest.requestedBy
      );
      return {
        success: false,
        output: null,
        error: `Path resolution failed: ${actionPath.reason}`,
        auditEntry,
        durationMs: 0
      };
    }
    const executionPath = actionPath.path;
    const start = Date.now();
    try {
      let output;
      let outputStr;
      switch (action) {
        case "read": {
          const content = readFileSync6(executionPath, "utf-8");
          output = content;
          outputStr = content;
          break;
        }
        case "write": {
          const content = params.content ?? "";
          writeFileSync5(executionPath, content, "utf-8");
          const bytesWritten = Buffer.byteLength(content, "utf-8");
          output = { bytesWritten };
          outputStr = `${String(bytesWritten)} bytes written`;
          break;
        }
        case "list": {
          const entries = readdirSync2(executionPath);
          output = entries;
          outputStr = entries.join("\n");
          break;
        }
        case "delete": {
          unlinkSync(executionPath);
          output = { deleted: true };
          outputStr = `Deleted ${executionPath}`;
          break;
        }
        default: {
          const durationMs2 = Date.now() - start;
          const auditEntry2 = createAuditEntry(
            action,
            executionPath,
            params,
            "rule-denied",
            "error",
            durationMs2,
            void 0,
            `Unknown action: ${action}`
          );
          return {
            success: false,
            output: null,
            error: `Unknown action: ${action}`,
            auditEntry: auditEntry2,
            durationMs: durationMs2
          };
        }
      }
      const durationMs = Date.now() - start;
      const decisionLabel = decision.level === "user-approved" ? "user-approved" : "auto-approved";
      const auditEntry = createAuditEntry(
        action,
        executionPath,
        params,
        decisionLabel,
        "success",
        durationMs,
        truncateOutput(outputStr, AUDIT_OUTPUT_MAX_BYTES),
        void 0,
        permRequest.requestedBy
      );
      logger19.debug("Filesystem action executed", {
        action,
        path: executionPath,
        durationMs
      });
      return {
        success: true,
        output,
        auditEntry,
        durationMs
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      const errorMessage = err instanceof Error ? err.message : "Unknown error during filesystem operation";
      logger19.error("Filesystem action failed", {
        action,
        path: executionPath,
        error: errorMessage
      });
      const auditEntry = createAuditEntry(
        action,
        executionPath,
        params,
        "error",
        "error",
        durationMs,
        void 0,
        errorMessage,
        permRequest.requestedBy
      );
      return {
        success: false,
        output: null,
        error: errorMessage,
        auditEntry,
        durationMs
      };
    }
  }
  function createAuditEntry(action, resource, params, decision, result, durationMs, output, error, requestedBy) {
    return {
      id: uuidv44(),
      timestamp: /* @__PURE__ */ new Date(),
      capability: "filesystem",
      action,
      resource,
      params,
      decision,
      result,
      output,
      error,
      durationMs,
      requestedBy: requestedBy ?? "agent"
    };
  }
  return {
    name: "filesystem",
    description: "Controls file system access: read, write, list, and delete operations",
    checkPermission,
    execute
  };
}

// src/sandbox/network-cap.ts
import { v4 as uuidv45 } from "uuid";
var logger20 = createLogger("sandbox:network");
var MAX_RESPONSE_BODY_LENGTH = 1e4;
function extractDomain(url) {
  return new URL(url).hostname;
}
function createNetworkCapability(config) {
  const sessionApprovedDomains = /* @__PURE__ */ new Set();
  const requestTimestamps = [];
  function isRateLimited() {
    const now = Date.now();
    const windowStart = now - 6e4;
    while (requestTimestamps.length > 0) {
      const first = requestTimestamps[0];
      if (first === void 0 || first >= windowStart) break;
      requestTimestamps.shift();
    }
    return requestTimestamps.length >= config.rateLimitPerMinute;
  }
  function checkPermission(request) {
    let domain;
    try {
      domain = extractDomain(request.resource);
    } catch {
      return { allowed: false, reason: `Invalid URL: ${request.resource}`, level: "denied" };
    }
    if (config.allowedDomains.includes(domain) || sessionApprovedDomains.has(domain)) {
      return { allowed: true, level: "auto" };
    }
    if (config.askDomains) {
      return { allowed: true, level: "user-approved" };
    }
    return {
      allowed: false,
      reason: `Domain not allowed: ${domain}`,
      level: "denied"
    };
  }
  async function execute(action, params) {
    const startTime = Date.now();
    const requestedBy = params.requestedBy ?? "agent";
    const url = params.url;
    if (!url || typeof url !== "string") {
      const auditEntry = createAuditEntry({
        action,
        resource: String(url ?? ""),
        params,
        decision: "error",
        result: "error",
        error: 'Missing or invalid "url" parameter',
        durationMs: Date.now() - startTime,
        requestedBy
      });
      return {
        success: false,
        output: null,
        error: 'Missing or invalid "url" parameter',
        auditEntry,
        durationMs: auditEntry.durationMs
      };
    }
    const method = params.method ?? "GET";
    const headers = params.headers;
    const body = params.body;
    const permission = checkPermission({
      capability: "network",
      action,
      resource: url,
      requestedBy
    });
    if (!permission.allowed) {
      const auditEntry = createAuditEntry({
        action,
        resource: url,
        params: { url, method },
        decision: "rule-denied",
        result: "denied",
        error: permission.reason,
        durationMs: Date.now() - startTime,
        requestedBy
      });
      logger20.warn("Network request denied", {
        url,
        method,
        reason: permission.reason
      });
      return {
        success: false,
        output: null,
        error: permission.reason,
        auditEntry,
        durationMs: auditEntry.durationMs
      };
    }
    if (permission.level === "user-approved" && params.__approvedByUser !== true) {
      const auditEntry = createAuditEntry({
        action,
        resource: url,
        params: { url, method },
        decision: "rule-denied",
        result: "denied",
        error: "Missing explicit user approval token",
        durationMs: Date.now() - startTime,
        requestedBy
      });
      return {
        success: false,
        output: null,
        error: "Missing explicit user approval token",
        auditEntry,
        durationMs: auditEntry.durationMs
      };
    }
    if (isRateLimited()) {
      const error = `Rate limit exceeded: ${config.rateLimitPerMinute} requests per minute`;
      const auditEntry = createAuditEntry({
        action,
        resource: url,
        params: { url, method },
        decision: "rule-denied",
        result: "error",
        error,
        durationMs: Date.now() - startTime,
        requestedBy
      });
      logger20.warn("Network rate limit exceeded", {
        url,
        method,
        rateLimitPerMinute: config.rateLimitPerMinute
      });
      return {
        success: false,
        output: null,
        error,
        auditEntry,
        durationMs: auditEntry.durationMs
      };
    }
    try {
      const fetchOptions = { method };
      if (headers) {
        fetchOptions.headers = headers;
      }
      if (body && method !== "GET" && method !== "HEAD") {
        fetchOptions.body = body;
      }
      const response = await fetch(url, fetchOptions);
      requestTimestamps.push(Date.now());
      const responseBody = await response.text();
      const truncatedBody = responseBody.length > MAX_RESPONSE_BODY_LENGTH ? `${responseBody.slice(0, MAX_RESPONSE_BODY_LENGTH)}... [truncated, ${responseBody.length} total chars]` : responseBody;
      const responseHeaders = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      const output = {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: truncatedBody
      };
      const durationMs = Date.now() - startTime;
      const decision = permission.level === "user-approved" ? "user-approved" : "auto-approved";
      const auditEntry = createAuditEntry({
        action,
        resource: url,
        params: { url, method },
        decision,
        result: "success",
        output: `HTTP ${response.status} ${response.statusText}`,
        durationMs,
        requestedBy
      });
      try {
        const domain = extractDomain(url);
        sessionApprovedDomains.add(domain);
      } catch {
      }
      if (config.logAllRequests) {
        logger20.info("Network request completed", {
          url,
          method,
          status: response.status,
          durationMs
        });
      } else {
        logger20.debug("Network request completed", {
          url,
          method,
          status: response.status,
          durationMs
        });
      }
      return {
        success: true,
        output,
        auditEntry,
        durationMs
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);
      const auditEntry = createAuditEntry({
        action,
        resource: url,
        params: { url, method },
        decision: "error",
        result: "error",
        error: errorMessage,
        durationMs,
        requestedBy
      });
      logger20.error("Network request failed", {
        url,
        method,
        error: errorMessage,
        durationMs
      });
      return {
        success: false,
        output: null,
        error: errorMessage,
        auditEntry,
        durationMs
      };
    }
  }
  function createAuditEntry(fields) {
    return {
      id: uuidv45(),
      timestamp: /* @__PURE__ */ new Date(),
      capability: "network",
      action: fields.action,
      resource: fields.resource,
      params: fields.params,
      decision: fields.decision,
      result: fields.result,
      output: fields.output,
      error: fields.error,
      durationMs: fields.durationMs,
      requestedBy: fields.requestedBy
    };
  }
  return {
    name: "network",
    description: "Controlled outbound HTTP requests with domain allowlists and rate limiting",
    checkPermission,
    execute
  };
}

// src/sandbox/sandbox.ts
import { v4 as uuidv46 } from "uuid";
var logger21 = createLogger("sandbox");
function createSandbox(auditStore) {
  const capabilities = /* @__PURE__ */ new Map();
  let approvalHandler = null;
  function register(capability) {
    capabilities.set(capability.name, capability);
    logger21.info("Capability registered", { name: capability.name });
  }
  function check(capName, action, resource, requestedBy = "agent") {
    const capability = capabilities.get(capName);
    if (!capability) {
      return { allowed: false, reason: `Unknown capability: ${capName}`, level: "denied" };
    }
    const request = {
      capability: capName,
      action,
      resource,
      requestedBy
    };
    return capability.checkPermission(request);
  }
  async function execute(capName, action, params, requestedBy = "agent") {
    const baseParams = { ...params, requestedBy };
    const capability = capabilities.get(capName);
    if (!capability) {
      const entry = createDeniedAuditEntry(
        capName,
        action,
        baseParams,
        `Unknown capability: ${capName}`,
        requestedBy
      );
      auditStore?.log(entry);
      return {
        success: false,
        output: null,
        error: `Unknown capability: ${capName}`,
        auditEntry: entry,
        durationMs: 0
      };
    }
    const resource = baseParams.path ?? baseParams.command ?? baseParams.url ?? "";
    const permission = check(capName, action, resource, requestedBy);
    if (!permission.allowed) {
      logger21.warn("Capability denied", {
        capability: capName,
        action,
        resource,
        reason: permission.reason
      });
      const entry = createDeniedAuditEntry(
        capName,
        action,
        baseParams,
        permission.reason,
        requestedBy
      );
      auditStore?.log(entry);
      return {
        success: false,
        output: null,
        error: permission.reason,
        auditEntry: entry,
        durationMs: 0
      };
    }
    if (permission.level === "user-approved" || permission.level === "ask") {
      if (!approvalHandler) {
        const entry = createDeniedAuditEntry(
          capName,
          action,
          baseParams,
          "No approval handler available",
          requestedBy
        );
        auditStore?.log(entry);
        return {
          success: false,
          output: null,
          error: "No approval handler available",
          auditEntry: entry,
          durationMs: 0
        };
      }
      const approvalReq = {
        capability: capName,
        action,
        resource,
        context: baseParams.context
      };
      const approved = await approvalHandler(approvalReq);
      if (!approved) {
        logger21.info("User denied capability", { capability: capName, action, resource });
        const entry = {
          id: uuidv46(),
          timestamp: /* @__PURE__ */ new Date(),
          capability: capName,
          action,
          resource,
          params: baseParams,
          decision: "user-denied",
          result: "denied",
          durationMs: 0,
          requestedBy
        };
        auditStore?.log(entry);
        return {
          success: false,
          output: null,
          error: "User denied the action",
          auditEntry: entry,
          durationMs: 0
        };
      }
    }
    const executionParams = permission.level === "user-approved" ? { ...baseParams, __approvedByUser: true } : baseParams;
    const result = await capability.execute(action, executionParams);
    auditStore?.log(result.auditEntry);
    logger21.info("Capability executed", {
      capability: capName,
      action,
      resource,
      success: result.success,
      durationMs: result.durationMs
    });
    return result;
  }
  function setApprovalHandler(handler) {
    approvalHandler = handler;
  }
  return {
    register,
    check,
    execute,
    setApprovalHandler,
    getCapability: (name) => capabilities.get(name),
    getCapabilities: () => [...capabilities.values()]
  };
}
function createDeniedAuditEntry(capability, action, params, reason, requestedBy) {
  return {
    id: uuidv46(),
    timestamp: /* @__PURE__ */ new Date(),
    capability,
    action,
    resource: params.path ?? params.command ?? params.url ?? "",
    params,
    decision: "rule-denied",
    result: "denied",
    error: reason,
    durationMs: 0,
    requestedBy
  };
}

// src/sandbox/shell-cap.ts
import { execFile } from "child_process";
import { v4 as uuidv47 } from "uuid";
var logger22 = createLogger("sandbox:shell");
var SHELL_EXPANSION_PATTERN = /`|\$\(|\$\{|<\(|>\(|\n/;
var SHELL_REDIRECTION_PATTERN = /(^|\s)(?:>|>>|<|<<|1>|1>>|2>|2>>|&>)/;
function parseCommand(command) {
  const segments = command.split(/\s*(?:\|\||&&|[|;])\s*/);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}
function classifySegment(segment, config) {
  const trimmed = segment.trim();
  const lowered = trimmed.toLowerCase();
  for (const pattern of config.deniedPatterns) {
    if (lowered.includes(pattern.toLowerCase())) {
      return "denied";
    }
  }
  if (SHELL_EXPANSION_PATTERN.test(trimmed) || SHELL_REDIRECTION_PATTERN.test(trimmed)) {
    return "ask";
  }
  const words = trimmed.split(/\s+/);
  for (const safe of config.safeCommands) {
    const safeWords = safe.split(/\s+/);
    if (safeWords.length <= words.length) {
      const baseSlice = words.slice(0, safeWords.length).join(" ");
      if (baseSlice === safe) {
        return "safe";
      }
    }
  }
  for (const ask of config.askCommands) {
    const askWords = ask.split(/\s+/);
    if (askWords.length <= words.length) {
      const baseSlice = words.slice(0, askWords.length).join(" ");
      if (baseSlice === ask) {
        return "ask";
      }
    }
  }
  return "unknown";
}
var MAX_AUDIT_OUTPUT_LENGTH = 1024;
var DEFAULT_TIMEOUT_MS = 3e4;
var MAX_BUFFER_BYTES = 1024 * 1024;
function createShellCapability(config) {
  function checkPermission(request) {
    const command = request.resource;
    const segments = parseCommand(command);
    if (segments.length === 0) {
      return { allowed: false, reason: "Empty command", level: "denied" };
    }
    let needsApproval = false;
    if (segments.length > 1) {
      needsApproval = true;
    }
    for (const segment of segments) {
      const classification = classifySegment(segment, config);
      if (classification === "denied") {
        logger22.warn("Shell command denied", {
          command,
          segment,
          requestedBy: request.requestedBy
        });
        return {
          allowed: false,
          reason: `Command segment denied: "${segment}"`,
          level: "denied"
        };
      }
      if (classification === "ask" || classification === "unknown") {
        needsApproval = true;
      }
    }
    if (needsApproval) {
      return { allowed: true, level: "user-approved" };
    }
    return { allowed: true, level: "auto" };
  }
  async function execute(action, params) {
    const command = params.command;
    const cwd = params.cwd;
    const timeout = params.timeout ?? DEFAULT_TIMEOUT_MS;
    if (!command || typeof command !== "string") {
      const entry = createErrorAuditEntry(
        action,
        command ?? "",
        "Missing or invalid command parameter"
      );
      return {
        success: false,
        output: null,
        error: "Missing or invalid command parameter",
        auditEntry: entry,
        durationMs: 0
      };
    }
    const request = {
      capability: "shell",
      action,
      resource: command,
      requestedBy: params.requestedBy ?? "agent"
    };
    const decision = checkPermission(request);
    if (!decision.allowed) {
      const entry = {
        id: uuidv47(),
        timestamp: /* @__PURE__ */ new Date(),
        capability: "shell",
        action,
        resource: command,
        params: { command, cwd, timeout },
        decision: "rule-denied",
        result: "denied",
        error: decision.reason,
        durationMs: 0,
        requestedBy: request.requestedBy
      };
      logger22.warn("Shell execution denied", { command, reason: decision.reason });
      return {
        success: false,
        output: null,
        error: decision.reason,
        auditEntry: entry,
        durationMs: 0
      };
    }
    if (decision.level === "user-approved" && params.__approvedByUser !== true) {
      const entry = {
        id: uuidv47(),
        timestamp: /* @__PURE__ */ new Date(),
        capability: "shell",
        action,
        resource: command,
        params: { command, cwd, timeout },
        decision: "rule-denied",
        result: "denied",
        error: "Missing explicit user approval token",
        durationMs: 0,
        requestedBy: request.requestedBy
      };
      logger22.warn("Shell execution blocked: missing approval token", { command });
      return {
        success: false,
        output: null,
        error: "Missing explicit user approval token",
        auditEntry: entry,
        durationMs: 0
      };
    }
    const startTime = Date.now();
    try {
      const result = await executeShellCommand(command, { cwd, timeout });
      const durationMs = Date.now() - startTime;
      const outputStr = formatOutput(result);
      const truncatedOutput = outputStr.slice(0, MAX_AUDIT_OUTPUT_LENGTH);
      const entry = {
        id: uuidv47(),
        timestamp: /* @__PURE__ */ new Date(),
        capability: "shell",
        action,
        resource: command,
        params: { command, cwd, timeout },
        decision: decision.level === "auto" ? "auto-approved" : "user-approved",
        result: result.exitCode === 0 ? "success" : "error",
        output: truncatedOutput,
        error: result.exitCode !== 0 ? result.stderr.slice(0, MAX_AUDIT_OUTPUT_LENGTH) : void 0,
        durationMs,
        requestedBy: request.requestedBy
      };
      logger22.info("Shell command executed", {
        command,
        exitCode: result.exitCode,
        durationMs
      });
      return {
        success: result.exitCode === 0,
        output: {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode
        },
        error: result.exitCode !== 0 ? result.stderr : void 0,
        auditEntry: entry,
        durationMs
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);
      const entry = {
        id: uuidv47(),
        timestamp: /* @__PURE__ */ new Date(),
        capability: "shell",
        action,
        resource: command,
        params: { command, cwd, timeout },
        decision: decision.level === "auto" ? "auto-approved" : "user-approved",
        result: "error",
        error: errorMessage.slice(0, MAX_AUDIT_OUTPUT_LENGTH),
        durationMs,
        requestedBy: request.requestedBy
      };
      logger22.error("Shell command failed", { command, error: errorMessage, durationMs });
      return {
        success: false,
        output: null,
        error: errorMessage,
        auditEntry: entry,
        durationMs
      };
    }
  }
  return {
    name: "shell",
    description: "Execute shell commands with safety classification",
    checkPermission,
    execute
  };
}
function executeShellCommand(command, options) {
  return new Promise((resolve, reject) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      {
        timeout: options.timeout,
        maxBuffer: MAX_BUFFER_BYTES,
        cwd: options.cwd
      },
      (error, stdout, stderr) => {
        if (error && !("code" in error)) {
          reject(error);
          return;
        }
        const exitCode = error && "code" in error ? error.code : 0;
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          exitCode
        });
      }
    );
  });
}
function formatOutput(result) {
  const parts = [];
  if (result.stdout) {
    parts.push(`stdout: ${result.stdout}`);
  }
  if (result.stderr) {
    parts.push(`stderr: ${result.stderr}`);
  }
  parts.push(`exitCode: ${result.exitCode}`);
  return parts.join("\n");
}
function createErrorAuditEntry(action, resource, error) {
  return {
    id: uuidv47(),
    timestamp: /* @__PURE__ */ new Date(),
    capability: "shell",
    action,
    resource,
    decision: "error",
    result: "error",
    error,
    durationMs: 0,
    requestedBy: "agent"
  };
}

// src/scheduler/cron.ts
import { v4 as uuidv48 } from "uuid";
var logger23 = createLogger("scheduler:cron");
var cachedCronApi = null;
async function loadDefaultCronApi() {
  if (cachedCronApi) return cachedCronApi;
  const module = await import("node-cron");
  cachedCronApi = {
    schedule: module.schedule,
    validate: module.validate
  };
  return cachedCronApi;
}
function parseTimestamp(value) {
  return value ? new Date(value) : null;
}
function parseLastResult(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
function mapJobRow(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    schedule: row.schedule ?? "",
    task: row.task,
    enabled: Boolean(row.enabled),
    lastRun: parseTimestamp(row.last_run),
    nextRun: parseTimestamp(row.next_run),
    runCount: row.run_count ?? 0,
    lastResult: parseLastResult(row.last_result)
  };
}
function fallbackNaturalScheduleToCron(schedule) {
  const normalized = schedule.trim().toLowerCase();
  if (normalized === "every minute") return "* * * * *";
  if (normalized === "every hour" || normalized === "hourly") return "0 * * * *";
  if (normalized === "every day" || normalized === "daily") return "0 9 * * *";
  if (normalized === "every week" || normalized === "weekly") return "0 9 * * 1";
  if (normalized === "every month" || normalized === "monthly") return "0 9 1 * *";
  const everyMinutes = normalized.match(/^every\s+(\d+)\s+minutes?$/);
  if (everyMinutes?.[1]) {
    const value = Number.parseInt(everyMinutes[1], 10);
    if (value >= 1 && value <= 59) return `*/${value} * * * *`;
  }
  const everyHours = normalized.match(/^every\s+(\d+)\s+hours?$/);
  if (everyHours?.[1]) {
    const value = Number.parseInt(everyHours[1], 10);
    if (value >= 1 && value <= 23) return `0 */${value} * * *`;
  }
  const dailyAt = normalized.match(/^every day at (\d{1,2}):(\d{2})$/);
  if (dailyAt?.[1] && dailyAt[2]) {
    const hour = Number.parseInt(dailyAt[1], 10);
    const minute = Number.parseInt(dailyAt[2], 10);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return `${minute} ${hour} * * *`;
    }
  }
  const weeklyAt = normalized.match(
    /^every (monday|tuesday|wednesday|thursday|friday|saturday|sunday) at (\d{1,2}):(\d{2})$/
  );
  if (weeklyAt?.[1] && weeklyAt[2] && weeklyAt[3]) {
    const dayMap = {
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6
    };
    const day = dayMap[weeklyAt[1]];
    const hour = Number.parseInt(weeklyAt[2], 10);
    const minute = Number.parseInt(weeklyAt[3], 10);
    if (day !== void 0 && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return `${minute} ${hour} * * ${day}`;
    }
  }
  return null;
}
function nextRunFromTask(task) {
  const next = task.getNextRun?.();
  if (!next) return null;
  return Number.isNaN(next.getTime()) ? null : next;
}
async function createCronScheduler(options) {
  const cronApi = options.cronApi ?? await loadDefaultCronApi();
  const activeTasks = /* @__PURE__ */ new Map();
  async function parseSchedule(schedule) {
    const trimmed = schedule.trim();
    if (trimmed.length === 0) {
      throw new Error("Schedule cannot be empty");
    }
    if (cronApi.validate(trimmed)) {
      return trimmed;
    }
    let parsedByLlm = null;
    if (options.parser) {
      parsedByLlm = await options.parser.parseNaturalLanguage(trimmed);
      if (parsedByLlm && cronApi.validate(parsedByLlm)) {
        return parsedByLlm;
      }
    }
    const fallback = fallbackNaturalScheduleToCron(trimmed);
    if (fallback && cronApi.validate(fallback)) {
      return fallback;
    }
    throw new Error(
      `Invalid schedule "${schedule}". Use a cron expression or natural format like "every 30 minutes".`
    );
  }
  function readJobRow(id) {
    const row = options.store.get(
      `SELECT id, name, type, schedule, task, enabled, last_run, next_run, run_count, last_result
			 FROM jobs
			 WHERE id = ?`,
      [id]
    );
    return row ?? null;
  }
  function registerJob(row) {
    if (!row.schedule || !row.enabled) return;
    if (activeTasks.has(row.id)) return;
    const task = cronApi.schedule(
      row.schedule,
      async () => {
        try {
          await runJobNow(row.id);
        } catch (error) {
          logger23.error("Scheduled job execution failed", {
            id: row.id,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      },
      { timezone: options.timezone }
    );
    activeTasks.set(row.id, task);
    const nextRun = nextRunFromTask(task)?.toISOString() ?? null;
    options.store.run("UPDATE jobs SET next_run = ? WHERE id = ?", [nextRun, row.id]);
  }
  function unregisterJob(id) {
    const task = activeTasks.get(id);
    if (!task) return;
    task.stop();
    task.destroy();
    activeTasks.delete(id);
  }
  async function listJobs() {
    const rows = options.store.all(
      `SELECT id, name, type, schedule, task, enabled, last_run, next_run, run_count, last_result
			 FROM jobs
			 ORDER BY name ASC`
    );
    return rows.map(mapJobRow);
  }
  async function getJob(id) {
    const row = readJobRow(id);
    return row ? mapJobRow(row) : null;
  }
  async function runJobNow(id) {
    const row = readJobRow(id);
    if (!row) {
      throw new Error(`Job not found: ${id}`);
    }
    const job = mapJobRow(row);
    const startedAt = Date.now();
    const nowIso = (/* @__PURE__ */ new Date()).toISOString();
    let result;
    try {
      result = await options.runTask(job.task, {
        jobId: job.id,
        jobName: job.name,
        task: job.task
      });
    } catch (error) {
      result = {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
    const task = activeTasks.get(job.id);
    const nextRunIso = task ? nextRunFromTask(task)?.toISOString() ?? null : null;
    const finishedAt = (/* @__PURE__ */ new Date()).toISOString();
    const lastResult = {
      success: result.success,
      output: result.output,
      error: result.error,
      finishedAt
    };
    options.store.run(
      `UPDATE jobs
			 SET last_run = ?, next_run = ?, run_count = COALESCE(run_count, 0) + 1, last_result = ?
			 WHERE id = ?`,
      [nowIso, nextRunIso, JSON.stringify(lastResult), job.id]
    );
    options.auditStore?.log({
      id: uuidv48(),
      timestamp: /* @__PURE__ */ new Date(),
      capability: "scheduler",
      action: "run_job",
      resource: job.id,
      params: {
        jobId: job.id,
        jobName: job.name,
        task: job.task
      },
      decision: "auto-approved",
      result: result.success ? "success" : "error",
      output: JSON.stringify(result.output ?? null).slice(0, 1024),
      error: result.error,
      durationMs: Date.now() - startedAt,
      requestedBy: "scheduler"
    });
    return result;
  }
  async function createJob(job) {
    if (job.task.trim().length === 0) {
      throw new Error("Task cannot be empty");
    }
    const id = uuidv48();
    const schedule = await parseSchedule(job.schedule);
    const name = job.name?.trim() ? job.name.trim() : `job-${id.slice(0, 8)}`;
    const type = job.type?.trim() ? job.type.trim() : "cron";
    options.store.run(
      `INSERT INTO jobs (id, name, type, schedule, task, enabled, run_count)
			 VALUES (?, ?, ?, ?, ?, 1, 0)`,
      [id, name, type, schedule, job.task]
    );
    const row = readJobRow(id);
    if (row) registerJob(row);
    logger23.info("Scheduled job created", { id, name, schedule });
    return id;
  }
  async function enableJob(id) {
    const row = readJobRow(id);
    if (!row) throw new Error(`Job not found: ${id}`);
    options.store.run("UPDATE jobs SET enabled = 1 WHERE id = ?", [id]);
    registerJob({ ...row, enabled: 1 });
  }
  async function disableJob(id) {
    const row = readJobRow(id);
    if (!row) throw new Error(`Job not found: ${id}`);
    options.store.run("UPDATE jobs SET enabled = 0, next_run = NULL WHERE id = ?", [id]);
    unregisterJob(id);
  }
  async function deleteJob(id) {
    unregisterJob(id);
    options.store.run("DELETE FROM jobs WHERE id = ?", [id]);
  }
  async function start() {
    const rows = options.store.all(
      `SELECT id, name, type, schedule, task, enabled, last_run, next_run, run_count, last_result
			 FROM jobs
			 WHERE enabled = 1`
    );
    for (const row of rows) {
      registerJob(row);
    }
  }
  function stop() {
    for (const task of activeTasks.values()) {
      task.stop();
      task.destroy();
    }
    activeTasks.clear();
  }
  return {
    start,
    stop,
    createJob,
    listJobs,
    getJob,
    enableJob,
    disableJob,
    deleteJob,
    runJobNow,
    parseSchedule
  };
}

// src/scheduler/heartbeat.ts
import { readFile } from "fs/promises";
import os from "os";
import { v4 as uuidv49 } from "uuid";
var logger24 = createLogger("scheduler:heartbeat");
function defaultReadChecklist(path2) {
  return readFile(path2, "utf-8");
}
function collectSystemState() {
  const safeNumber = (fn, fallback = 0) => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  const safeNumbers = (fn, fallback = [0, 0, 0]) => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  return {
    platform: process.platform,
    uptimeSeconds: Math.floor(safeNumber(() => os.uptime(), 0)),
    loadAverage: safeNumbers(() => os.loadavg()),
    freeMemoryBytes: safeNumber(() => os.freemem(), 0),
    totalMemoryBytes: safeNumber(() => os.totalmem(), 0)
  };
}
function buildHeartbeatPrompt(checklist, systemState) {
  return [
    "Review these heartbeat items and take action if needed.",
    "",
    "Checklist:",
    checklist.trim(),
    "",
    "Current system state:",
    JSON.stringify(systemState, null, 2)
  ].join("\n");
}
function createHeartbeat(options) {
  const intervalMs = Math.max(1, options.intervalMinutes ?? 30) * 6e4;
  const readChecklist = options.readChecklist ?? defaultReadChecklist;
  let timer = null;
  let running = false;
  async function runOnce() {
    const startedAt = /* @__PURE__ */ new Date();
    let checklist = "";
    try {
      checklist = await readChecklist(options.heartbeatFile);
    } catch {
      checklist = "# Heartbeat checklist missing\n- No checklist file found. Ask user to create one.";
    }
    const systemState = collectSystemState();
    const prompt = buildHeartbeatPrompt(checklist, systemState);
    let result;
    try {
      result = await options.runTask(prompt);
    } catch (error) {
      result = {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
    const finishedAt = /* @__PURE__ */ new Date();
    const report = {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      checklistPath: options.heartbeatFile,
      checklistLength: checklist.length,
      systemState,
      result
    };
    options.auditStore?.log({
      id: uuidv49(),
      timestamp: finishedAt,
      capability: "heartbeat",
      action: "run",
      resource: options.heartbeatFile,
      params: {
        checklistLength: checklist.length,
        systemState
      },
      decision: "auto-approved",
      result: result.success ? "success" : "error",
      output: JSON.stringify(result.output ?? null).slice(0, 1024),
      error: result.error,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      requestedBy: "heartbeat"
    });
    options.onRun?.(report);
    return report;
  }
  function start() {
    if (running) return;
    running = true;
    timer = setInterval(() => {
      runOnce().catch((error) => {
        logger24.error("Heartbeat run failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, intervalMs);
  }
  function stop() {
    running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }
  return {
    start,
    stop,
    runOnce,
    isRunning: () => running
  };
}

// src/scheduler/triggers.ts
import { watch } from "fs";
import { createServer as createServer2 } from "http";
var logger25 = createLogger("scheduler:triggers");
function eventMatches(eventType, configured) {
  if (eventType === "change") {
    return configured.includes("change");
  }
  if (eventType === "rename") {
    return configured.includes("add") || configured.includes("unlink") || configured.includes("rename");
  }
  return false;
}
function fillTemplate(template, values) {
  let output = template;
  for (const [key, value] of Object.entries(values)) {
    output = output.replaceAll(`{${key}}`, value);
  }
  return output;
}
async function readBody2(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}
function json2(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}
function defaultWatchFactory(path2, listener) {
  return watch(path2, listener);
}
function parsePayload(body) {
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}
function createWebhookRequestHandler(options) {
  const hookMap = new Map(options.hooks.map((hook) => [hook.id, hook]));
  return async function handle(request) {
    if (request.method !== "POST") {
      return { status: 404, body: { error: "Not found" } };
    }
    const match = request.url.match(/^\/hooks\/([a-zA-Z0-9_-]+)$/);
    if (!match?.[1]) {
      return { status: 404, body: { error: "Not found" } };
    }
    const hookId = match[1];
    const hook = hookMap.get(hookId);
    if (!hook) {
      return { status: 404, body: { error: "Unknown hook" } };
    }
    const header = request.authorizationHeader ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token || token !== hook.token) {
      return { status: 401, body: { error: "Unauthorized" } };
    }
    const payload = parsePayload(request.body);
    const task = fillTemplate(hook.task, {
      payload: typeof payload === "string" ? payload : JSON.stringify(payload)
    });
    void options.runTask(task, {
      source: "webhook",
      hookId,
      payload
    });
    return { status: 202, body: { accepted: true } };
  };
}
function createTriggerEngine(options) {
  const watchers = [];
  const watchFactory = options.watchFactory ?? defaultWatchFactory;
  let server = null;
  let webhookPort = null;
  function startFileWatchers() {
    for (const watcherConfig of options.fileWatchers ?? []) {
      try {
        const watcher = watchFactory(watcherConfig.path, (eventType, filename) => {
          if (!eventMatches(eventType, watcherConfig.events)) return;
          const fileNameValue = filename?.toString() ?? "";
          const task = fillTemplate(watcherConfig.task, {
            filename: fileNameValue,
            event: eventType,
            path: watcherConfig.path
          });
          void options.runTask(task, {
            source: "file_watcher",
            watcherPath: watcherConfig.path,
            filename: fileNameValue
          }).catch((error) => {
            logger25.error("File watcher trigger failed", {
              path: watcherConfig.path,
              error: error instanceof Error ? error.message : String(error)
            });
          });
        });
        watchers.push(watcher);
      } catch (error) {
        logger25.warn("File watcher could not be started", {
          path: watcherConfig.path,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
  function startWebhookServer(webhooks) {
    if (!webhooks.enabled) return Promise.resolve();
    const handler = createWebhookRequestHandler({
      hooks: webhooks.hooks,
      runTask: options.runTask
    });
    server = createServer2(async (req, res) => {
      try {
        if (!req.url || !req.method) {
          json2(res, 404, { error: "Not found" });
          return;
        }
        const body = await readBody2(req);
        const result = await handler({
          method: req.method,
          url: req.url,
          authorizationHeader: req.headers.authorization,
          body
        });
        json2(res, result.status, result.body);
      } catch (error) {
        json2(res, 500, {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    });
    return new Promise((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(webhooks.port, webhooks.host ?? "127.0.0.1", () => {
        const address = server?.address();
        if (address && typeof address !== "string") {
          webhookPort = address.port;
        }
        resolve();
      });
    });
  }
  async function start() {
    startFileWatchers();
    if (options.webhooks) {
      await startWebhookServer(options.webhooks);
    }
  }
  async function stop() {
    for (const watcher of watchers) {
      watcher.close();
    }
    watchers.length = 0;
    if (server) {
      await new Promise((resolve, reject) => {
        server?.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
    server = null;
    webhookPort = null;
  }
  return {
    start,
    stop,
    getWebhookPort: () => webhookPort
  };
}

// src/index.ts
var program = new Command();
var logger26 = createLogger("main");
function resolvePath(value, mamaHome) {
  if (value === "~") return process.env.HOME ?? mamaHome;
  if (value.startsWith("~/")) {
    return value.replace("~", process.env.HOME ?? mamaHome);
  }
  return value;
}
function initAppConfig(configPath) {
  const configResult = initConfig(configPath);
  if (!configResult.ok) {
    throw configResult.error;
  }
  return getConfig();
}
function createRuntimeServices(config, mamaHome) {
  const memoryStore = createMemoryStore();
  const claudeProvider = config.llm.providers.claude.apiKey ? createClaudeProvider({
    apiKey: config.llm.providers.claude.apiKey,
    defaultModel: config.llm.providers.claude.defaultModel
  }) : void 0;
  const ollamaProvider = createOllamaProvider({
    host: config.llm.providers.ollama.host,
    apiKey: config.llm.providers.ollama.apiKey,
    defaultModel: config.llm.providers.ollama.defaultModel,
    embeddingModel: config.llm.providers.ollama.embeddingModel
  });
  const router = createLLMRouter({
    config,
    claudeProvider,
    ollamaProvider,
    usageStore: memoryStore
  });
  const embeddings = createEmbeddingService({
    embedder: (text) => ollamaProvider.embed(text)
  });
  const episodicMemory = createEpisodicMemory({
    store: memoryStore,
    embeddings,
    defaultTopK: config.memory.searchTopK
  });
  const consolidatedMemory = createConsolidatedMemoryStore({
    store: memoryStore,
    embeddings,
    defaultTopK: config.memory.searchTopK
  });
  const soul = createSoul({
    soulPath: resolvePath(config.agent.soulPath, mamaHome),
    userName: config.user.name,
    agentName: config.agent.name
  });
  const decayEngine = createDecayEngine({
    store: memoryStore,
    consolidated: consolidatedMemory
  });
  const retrieval = createMemoryRetrievalPipeline({
    store: memoryStore,
    episodic: episodicMemory,
    consolidated: consolidatedMemory,
    maxMemoryResults: 10,
    maxRecentEpisodes: 20,
    recentWindowHours: 24
  });
  const consolidationEngine = createConsolidationEngine({
    router,
    store: memoryStore,
    episodic: episodicMemory,
    consolidated: consolidatedMemory,
    embeddings,
    soul,
    decay: decayEngine,
    minEpisodesToConsolidate: config.memory.consolidation.minEpisodesToConsolidate
  });
  return {
    router,
    soul,
    memoryStore,
    episodicMemory,
    consolidatedMemory,
    retrieval,
    consolidationEngine
  };
}
function createAppRuntime(configPath, silentLogs = true) {
  const config = initAppConfig(configPath);
  const mamaHome = ensureMamaHome();
  initLogger({
    level: config.logging.level,
    filePath: resolvePath(config.logging.file, mamaHome),
    silent: silentLogs
  });
  const runtime = createRuntimeServices(config, mamaHome);
  const auditStore = createAuditStore(join5(mamaHome, "mama.db"));
  const sandbox = createSandbox(auditStore);
  const homePath = process.env.HOME ?? mamaHome;
  sandbox.register(createFsCapability(config.sandbox.filesystem, homePath));
  sandbox.register(createShellCapability(config.sandbox.shell));
  sandbox.register(createNetworkCapability(config.sandbox.network));
  function createSessionAgent() {
    return createAgent({
      router: runtime.router,
      workingMemory: createWorkingMemory({ maxTokens: 1e5 }),
      soul: runtime.soul,
      sandbox,
      episodicMemory: runtime.episodicMemory,
      retrieval: runtime.retrieval,
      retrievalTokenBudget: 1200,
      maxIterations: 10
    });
  }
  return {
    config,
    mamaHome,
    runtime,
    auditStore,
    sandbox,
    createSessionAgent,
    close() {
      setScheduler(null);
      auditStore.close();
      runtime.memoryStore.close();
    }
  };
}
function createNaturalScheduleParser(router) {
  return {
    async parseNaturalLanguage(schedule) {
      const response = await router.complete({
        taskType: "simple_tasks",
        maxTokens: 64,
        messages: [
          {
            role: "user",
            content: [
              "Convert this natural schedule into a 5-field cron expression.",
              "Return only the cron expression or INVALID.",
              `Schedule: ${schedule}`
            ].join("\n")
          }
        ]
      });
      const line = response.content.trim().split("\n")[0]?.trim() ?? "";
      if (!line || line.toUpperCase().includes("INVALID")) return null;
      return line.match(/^(\S+\s){4}\S+$/)?.[0] ?? null;
    }
  };
}
async function createScheduler(app, onRun) {
  const scheduler2 = await createCronScheduler({
    store: app.runtime.memoryStore,
    timezone: app.config.user.timezone,
    parser: createNaturalScheduleParser(app.runtime.router),
    auditStore: app.auditStore,
    runTask: async (task, context) => {
      try {
        const response = await app.createSessionAgent().processMessage(task, "api");
        await onRun?.(`Job "${context.jobName}" executed.
${response.content}`, "normal");
        return {
          success: true,
          output: {
            content: response.content,
            model: response.model,
            provider: response.provider
          }
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await onRun?.(`Job "${context.jobName}" failed: ${message}`, "high");
        return { success: false, error: message };
      }
    }
  });
  return scheduler2;
}
function createMemorySearch(app) {
  return async (query) => {
    const [memories, episodes] = await Promise.all([
      app.runtime.consolidatedMemory.search(query, {
        topK: 5,
        includeInactive: true,
        minConfidence: 0
      }),
      app.runtime.episodicMemory.searchSemantic(query, { topK: 5 })
    ]);
    return [
      `Memory search: "${query}"`,
      "",
      "Consolidated:",
      ...memories.map((m) => `- [${m.category}] ${m.content}`),
      "",
      "Episodic:",
      ...episodes.map((e) => `- (${e.role}) ${e.content}`)
    ].filter(Boolean).join("\n");
  };
}
function createCostSnapshot(app) {
  return () => {
    const tracker = app.runtime.router.getCostTracker();
    return {
      todayCostUsd: tracker.getCostToday(),
      monthCostUsd: tracker.getCostThisMonth(),
      totalCostUsd: tracker.getTotalCost(),
      records: tracker.getRecords().length
    };
  };
}
async function runChat(configPath) {
  const app = createAppRuntime(configPath, true);
  logger26.info("Mama starting", { version: "0.1.0" });
  const workingMemory = createWorkingMemory({ maxTokens: 1e5 });
  const agent = createAgent({
    router: app.runtime.router,
    workingMemory,
    soul: app.runtime.soul,
    sandbox: app.sandbox,
    episodicMemory: app.runtime.episodicMemory,
    retrieval: app.runtime.retrieval,
    retrievalTokenBudget: 1200,
    maxIterations: 10
  });
  let lastInteractionAt = Date.now();
  const trackedAgent = {
    ...agent,
    async processMessage(input, channel, options) {
      lastInteractionAt = Date.now();
      return agent.processMessage(input, channel, options);
    }
  };
  const scheduler2 = await createScheduler(app);
  await scheduler2.start();
  setScheduler(scheduler2);
  const cleanup = () => {
    scheduler2.stop();
    app.close();
  };
  process.on("exit", cleanup);
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  const consolidation = createConsolidationScheduler({
    engine: app.runtime.consolidationEngine,
    intervalHours: app.config.memory.consolidation.intervalHours,
    minEpisodesToConsolidate: app.config.memory.consolidation.minEpisodesToConsolidate,
    isIdle: () => Date.now() - lastInteractionAt > 6e4,
    onReport: (report) => {
      if (!report.skipped) logger26.info("Consolidation completed", { report });
    }
  });
  if (app.config.memory.consolidation.enabled) {
    consolidation.start();
  }
  process.on("exit", () => consolidation.stop());
  startTerminal(trackedAgent, app.config.agent.name, app.sandbox);
}
async function runDaemonForeground(configPath) {
  const app = createAppRuntime(configPath, false);
  const memorySearch = createMemorySearch(app);
  const costSnapshot = createCostSnapshot(app);
  let telegramChannel = null;
  const notify = async (text, priority = "normal") => {
    const chatId = app.config.channels.telegram.defaultChatId;
    if (!telegramChannel || !chatId || chatId <= 0) return;
    await telegramChannel.sendProactiveMessage(chatId, text, priority);
  };
  const scheduler2 = await createScheduler(app, notify);
  const heartbeat = createHeartbeat({
    intervalMinutes: app.config.scheduler.heartbeat.intervalMinutes,
    heartbeatFile: resolvePath(app.config.scheduler.heartbeat.heartbeatFile, app.mamaHome),
    auditStore: app.auditStore,
    runTask: async (prompt) => {
      const response = await app.createSessionAgent().processMessage(prompt, "api");
      await notify(`Heartbeat run completed.
${response.content}`, "low");
      return {
        success: true,
        output: response.content
      };
    }
  });
  const triggers = createTriggerEngine({
    fileWatchers: app.config.scheduler.triggers.fileWatchers,
    webhooks: app.config.scheduler.triggers.webhooks,
    runTask: async (task) => {
      await app.createSessionAgent().processMessage(task, "api");
      return { success: true };
    }
  });
  const services = [
    {
      name: "scheduler",
      start: async () => {
        await scheduler2.start();
        setScheduler(scheduler2);
      },
      stop: async () => {
        scheduler2.stop();
        setScheduler(null);
      },
      healthCheck: async () => true
    }
  ];
  if (app.config.scheduler.heartbeat.enabled) {
    services.push({
      name: "heartbeat",
      start: async () => heartbeat.start(),
      stop: async () => heartbeat.stop(),
      healthCheck: async () => heartbeat.isRunning()
    });
  }
  if (app.config.scheduler.triggers.fileWatchers.length > 0 || app.config.scheduler.triggers.webhooks.enabled) {
    services.push({
      name: "triggers",
      start: async () => triggers.start(),
      stop: async () => triggers.stop(),
      healthCheck: async () => true
    });
  }
  if (app.config.channels.telegram.enabled && app.config.channels.telegram.botToken) {
    telegramChannel = createTelegramChannel({
      token: app.config.channels.telegram.botToken,
      allowedUserIds: app.config.user.telegramIds,
      workspacePath: resolvePath(app.config.sandbox.filesystem.workspace, app.mamaHome),
      agent: app.createSessionAgent(),
      adapter: createTelegramHttpAdapter(app.config.channels.telegram.botToken),
      sandbox: app.sandbox,
      scheduler: scheduler2,
      auditStore: app.auditStore,
      memorySearch,
      costSnapshot,
      statusSnapshot: async () => `running | jobs=${(await scheduler2.listJobs()).length}`
    });
    services.push({
      name: "telegram",
      start: async () => telegramChannel?.start(),
      stop: async () => telegramChannel?.stop(),
      healthCheck: async () => true
    });
  }
  if (app.config.channels.api.enabled) {
    const apiChannel = createApiChannel({
      host: app.config.channels.api.host,
      port: app.config.channels.api.port,
      token: app.config.channels.api.token,
      agent: app.createSessionAgent(),
      scheduler: scheduler2,
      auditStore: app.auditStore,
      memorySearch,
      costSnapshot,
      statusSnapshot: async () => ({
        status: "running",
        jobs: (await scheduler2.listJobs()).length
      })
    });
    services.push({
      name: "api",
      start: async () => apiChannel.start(),
      stop: async () => apiChannel.stop(),
      healthCheck: async () => true
    });
  }
  const daemon = createDaemonController({
    pidFile: resolvePath(app.config.daemon.pidFile, app.mamaHome),
    services,
    healthCheckIntervalMs: app.config.daemon.healthCheckIntervalSeconds * 1e3
  });
  await daemon.start();
  logger26.info("Daemon started", {
    services: services.map((service) => service.name)
  });
  const shutdown = async () => {
    await daemon.stop();
    app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await new Promise(() => void 0);
}
program.name("mama").description("Mama \u2014 Personal AI Agent").version("0.1.0");
program.command("chat").description("Start interactive chat with Mama").option("-c, --config <path>", "Path to config file").action(async (options) => {
  try {
    await runChat(options.config);
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}
`);
    process.exitCode = 1;
  }
});
var daemonCommand = program.command("daemon").description("Run Mama in headless daemon mode").option("-c, --config <path>", "Path to config file").option("--foreground", "Run in foreground process");
daemonCommand.action(async (options) => {
  try {
    await runDaemonForeground(options.config);
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}
`);
    process.exitCode = 1;
  }
});
daemonCommand.command("start").option("-c, --config <path>", "Path to config file").description("Start daemon as background process").action((options) => {
  const config = initAppConfig(options.config);
  const mamaHome = ensureMamaHome();
  const pidFile = resolvePath(config.daemon.pidFile, mamaHome);
  const status = getDaemonStatus(pidFile);
  if (status.running) {
    process.stdout.write(`Daemon already running (pid ${status.pid})
`);
    return;
  }
  const args = [process.argv[1] ?? "dist/index.js", "daemon", "--foreground"];
  if (options.config) {
    args.push("--config", options.config);
  }
  const pid = startDetachedDaemonProcess({
    command: process.execPath,
    args,
    cwd: process.cwd()
  });
  process.stdout.write(`Daemon started (pid ${pid}).
`);
});
daemonCommand.command("stop").option("-c, --config <path>", "Path to config file").description("Stop daemon process").action((options) => {
  const config = initAppConfig(options.config);
  const mamaHome = ensureMamaHome();
  const pidFile = resolvePath(config.daemon.pidFile, mamaHome);
  const stopped = stopDaemonProcess(pidFile);
  process.stdout.write(stopped ? "Stop signal sent.\n" : "Daemon is not running.\n");
});
daemonCommand.command("status").option("-c, --config <path>", "Path to config file").description("Check daemon status").action((options) => {
  const config = initAppConfig(options.config);
  const mamaHome = ensureMamaHome();
  const pidFile = resolvePath(config.daemon.pidFile, mamaHome);
  const status = getDaemonStatus(pidFile);
  process.stdout.write(status.running ? `running (pid ${status.pid})
` : "not running\n");
});
daemonCommand.command("logs").option("-c, --config <path>", "Path to config file").option("-n, --lines <n>", "Number of lines", (value) => Number.parseInt(value, 10), 100).description("Show daemon logs").action((options) => {
  const config = initAppConfig(options.config);
  const mamaHome = ensureMamaHome();
  const logs = readDaemonLogs(resolvePath(config.logging.file, mamaHome), options.lines);
  process.stdout.write(`${logs}
`);
});
registerMemoryCommands(program, {
  async resolveServices(configPath) {
    const app = createAppRuntime(configPath, true);
    return {
      store: app.runtime.memoryStore,
      episodic: app.runtime.episodicMemory,
      consolidated: app.runtime.consolidatedMemory,
      consolidation: app.runtime.consolidationEngine,
      close() {
        app.close();
      }
    };
  }
});
registerJobsCommands(program, {
  async resolveScheduler(configPath) {
    const app = createAppRuntime(configPath, true);
    const scheduler2 = await createScheduler(app);
    setScheduler(scheduler2);
    return {
      scheduler: scheduler2,
      close() {
        scheduler2.stop();
        app.close();
      }
    };
  }
});
registerCostCommand(program, {
  async resolveTracker(configPath) {
    const app = createAppRuntime(configPath, true);
    return {
      tracker: app.runtime.router.getCostTracker(),
      close() {
        app.close();
      }
    };
  }
});
registerInitCommand(program);
program.action(() => {
  program.commands.find((command) => command.name() === "chat")?.parse(process.argv);
});
program.parse();
