import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotEnv(join(__dirname, ".env"));

const chatId = process.env.ORDER_NOTIFY_TELEGRAM_CHAT_ID || "";
const botToken = process.env.TELEGRAM_BOT_TOKEN || readOpenClawTelegramBotToken();

if (!chatId) throw new Error("ORDER_NOTIFY_TELEGRAM_CHAT_ID is not configured.");
if (!botToken) throw new Error("Telegram bot token is not configured.");

const summary = await runNodeScript("order-summary.mjs", {
  ORDER_SUMMARY_WINDOW: process.env.ORDER_SUMMARY_WINDOW || "auto"
});

await sendTelegramMessage(summary.trim() || "Bao cao don hang khong co noi dung.");

function runNodeScript(scriptName, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(__dirname, scriptName)], {
      cwd: __dirname,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(stdout);
      reject(new Error(`${scriptName} exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function sendTelegramMessage(text) {
  for (const chunk of splitMessage(text, 3900)) {
    const url = new URL(`https://api.telegram.org/bot${botToken}/sendMessage`);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true
      })
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`Telegram sendMessage HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
    }
  }
}

function splitMessage(text, maxChars) {
  const normalized = String(text || "").trim();
  if (!normalized) return [""];
  if (normalized.length <= maxChars) return [normalized];

  const chunks = [];
  let remaining = normalized;
  while (remaining.length > maxChars) {
    const splitAt = Math.max(
      remaining.lastIndexOf("\n\n", maxChars),
      remaining.lastIndexOf("\n", maxChars),
      remaining.lastIndexOf(" ", maxChars)
    );
    const end = splitAt > maxChars * 0.5 ? splitAt : maxChars;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function readOpenClawTelegramBotToken() {
  const configPath = process.env.OPENCLAW_CONFIG_PATH ||
    join(process.env.HOME || "", ".openclaw/openclaw.json");
  if (!configPath || !existsSync(configPath)) return "";

  try {
    const body = JSON.parse(readFileSync(configPath, "utf8"));
    return body?.channels?.telegram?.botToken || "";
  } catch {
    return "";
  }
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;

  const content = readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex < 0) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    const rawValue = trimmed.slice(equalsIndex + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = unquoteEnvValue(rawValue);
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
