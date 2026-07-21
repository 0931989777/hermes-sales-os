// order-reporter.mjs
// Isolated order detection and Telegram notification module.
// Separated from reply/consultation logic to avoid false reports.
//
// Rules:
// - Only reports orders after the bot has sent a confirmation/chốt đơn message.
// - Deduplicates by Page + customer + date + phone + address.
// - Persists notification state across restarts.
// - Multi-product orders show each product on its own line.

import crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const orderStatePath = join(__dirname, "order-state.json");

// ── State ────────────────────────────────────────────────────────────────────

let orderState = loadOrderState();
const activeNotificationKeys = new Set();
let config = {};

export function initOrderReporter(cfg = {}) {
  config = {
    orderNotifyEnabled: true,
    orderNotifyTelegramChatId: "",
    telegramBotToken: "",
    orderNotifyTimezone: "Asia/Ho_Chi_Minh",
    shopPhone: "",
    ...cfg
  };
}

function loadOrderState() {
  try {
    if (existsSync(orderStatePath)) {
      const parsed = JSON.parse(readFileSync(orderStatePath, "utf8"));
      return {
        notifiedOrders: parsed.notifiedOrders && typeof parsed.notifiedOrders === "object" ? parsed.notifiedOrders : {},
        notifiedOrderContacts: parsed.notifiedOrderContacts && typeof parsed.notifiedOrderContacts === "object" ? parsed.notifiedOrderContacts : {}
      };
    }
  } catch (error) {
    console.warn(`[order-reporter] failed to read state, starting fresh: ${error.message}`);
  }
  return { notifiedOrders: {}, notifiedOrderContacts: {} };
}

function saveOrderState() {
  try {
    writeFileSync(orderStatePath, JSON.stringify(orderState, null, 2), "utf8");
  } catch (error) {
    console.error(`[order-reporter] failed to save state: ${error.message}`);
  }
}

// ── Utility ──────────────────────────────────────────────────────────────────

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/đ/gu, "d")
    .replace(/Đ/gu, "D")
    .toLowerCase();
}

function formatVnd(amount) {
  return `${new Intl.NumberFormat("vi-VN").format(amount)}đ`;
}

function formatOrderNotifyTime(timestamp) {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: config.orderNotifyTimezone,
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour12: false
  }).format(new Date(Number(timestamp || Date.now())));
}

function formatOrderNotifyDateKey(timestamp) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.orderNotifyTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(Number(timestamp || Date.now())));
}

function trimOrderNotifyText(value) {
  const normalized = String(value || "").replace(/\s+/gu, " ").trim();
  return normalized.length > 220 ? `${normalized.slice(0, 217).trim()}...` : normalized;
}

function stripOrderNotifyLinePrefix(value) {
  return String(value || "").replace(/^[\s\-*•]+/u, "").trim();
}

// ── Phone & Address ──────────────────────────────────────────────────────────

function extractPhonesFromText(text) {
  const matches = String(text || "").match(/(?:\+?84|0)(?:[\s.-]*\d){9}\b/gu) || [];
  const shopPhone = normalizePhoneValue(config.shopPhone);
  return [...new Set(matches.map(normalizePhoneValue).filter((phone) => phone && phone !== shopPhone))];
}

function normalizePhoneValue(phone) {
  let normalized = String(phone || "").replace(/[\s.-]/gu, "");
  if (/^\+?84/u.test(normalized)) {
    normalized = "0" + normalized.replace(/^\+?84/u, "");
  }
  return /^0\d{9}$/u.test(normalized) ? normalized : "";
}

function extractDetailedAddressLinesFromText(text) {
  const addressPattern = /(địa chỉ|dia chi|dc|số nhà|so nha|sn|thôn|thon|xã|xa|huyện|huyen|tỉnh|tinh|tp|thành phố|phường|phuong|quận|quan|ấp|ap|bản|ban|đường|duong|ngõ|ngo|ngách|ngach|hẻm|hem|đà nẵng|da nang|hà nội|ha noi|hồ chí minh|ho chi minh|hải phòng|hai phong|cần thơ|can tho|thanh khê|thanh khe)/iu;
  return String(text || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && (addressPattern.test(line) || looksLikeStreetAddress(line)) && isDetailedAddressText(line));
}

function isDetailedAddressText(line) {
  const normalized = normalizeSearchText(line)
    .replace(/(?:\+?84|0)(?:[\s.-]*\d){9}\b/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length < 18) return false;

  const markers = [
    /\b(so nha|sn|thon|xom|ap|ban|duong|ngo|ngach|hem|to dan pho|tdp)\b/u,
    /\b(xa|phuong|thi tran)\b/u,
    /\b(huyen|quan|thi xa|thanh pho|tp)\b/u,
    /\b(tinh)\b/u
  ];
  const markerCount = markers.filter((pattern) => pattern.test(normalized)).length;
  if (markerCount >= 2) return true;
  if (looksLikeStreetAddress(line)) return true;

  const words = normalized.split(/\s+/u).filter((w) => w.length > 1);
  return words.length >= 7 && /\d/u.test(normalized) && /[a-z]/u.test(normalized);
}

function looksLikeStreetAddress(line) {
  return /\d+\s+(đường|duong|phố|pho|ngõ|ngo|ngách|ngach|hẻm|hem)/iu.test(line) || /\b(c12|k\d|khu\s+\d|kdc|cum|kcn)\b/iu.test(normalizeSearchText(line));
}

function cleanOrderNotifyAddress(value) {
  let text = trimOrderNotifyText(value)
    .replace(/^(địa chỉ|dia chi|đc|dc)\s*[:：.]?\s*/iu, "")
    .replace(/.*(địa chỉ|dia chi|đc|dc)\s*[:：.]?\s*/iu, "")  // strip everything before last Dia chi:
    .replace(/(?:sđt|sdt|số điện thoại|so dien thoai|đt|dt)\s*[:：.]?\s*(?:\+?84|0)(?:[\s.-]*\d){9}\b/giu, "")
    .replace(/(?:\+?84|0)(?:[\s.-]*\d){9}\b/gu, "");
  text = text.replace(/\s*([,.])\s*/gu, "$1 ").replace(/[,.]\s*$/u, "").replace(/\s+/gu, " ").trim();
  return text;
}

// ── Order Confirmation Detection ─────────────────────────────────────────────

export function isOrderConfirmationMessage(text) {
  const normalized = normalizeSearchText(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return false;
  const hasOrderVerb = /\b(chot don|len don|xac nhan|nhan duoc thong tin|chuyen bo phan dong hang|giao hang)\b/u.test(normalized);
  const hasOrderFields =
    /\bsan pham\b/u.test(normalized) &&
    /\b(sdt|so dien thoai)\b/u.test(normalized) &&
    /\b(dia chi|dc)\b/u.test(normalized);
  return hasOrderVerb && hasOrderFields;
}

export function hasPageConfirmedOrder(messages, pageId, customerSourceAt = 0) {
  const sourceAt = Number(customerSourceAt || 0);
  // Find the LATEST confirmation message, not just any
  let latestConfirmedAt = 0;
  let latestConfirmed = null;
  for (const message of (messages || [])) {
    if (String(message?.from?.id || "") !== String(pageId)) continue;
    const createdAt = new Date(message?.created_time || 0).getTime();
    if (sourceAt && createdAt < sourceAt) continue;
    if (isOrderConfirmationMessage(message.message)) {
      if (createdAt > latestConfirmedAt) {
        latestConfirmedAt = createdAt;
        latestConfirmed = message;
      }
    }
  }
  return latestConfirmed ? latestConfirmed.message : false;
}

// ── Product Extraction ───────────────────────────────────────────────────────

export function extractOrderNotifyProduct(text) {
  const lines = String(text || "")
    .split(/\r?\n/u)
    .map((line) => trimOrderNotifyText(line))
    .filter(Boolean);
  const productBlock = extractOrderNotifyProductBlock(lines);
  if (productBlock) return productBlock;

  const candidates = lines
    .map((line, index) => ({ line, index, score: getOrderNotifyProductLineScore(line) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => a.score - b.score || a.index - b.index);
  const chosenLine = candidates.at(-1)?.line;
  if (chosenLine) {
    const products = extractOrderNotifyProductNames(chosenLine);
    const quantity = parseOrderNotifyQuantity(chosenLine);
    if (products.length > 0 && quantity) {
      // Multi-product: apply quantity to each product separately
      return products.map((p) => `${p} - ${formatOrderNotifyQuantity(quantity)}`).join("; ");
    }
    return cleanOrderNotifyProduct(chosenLine);
  }

  const products = extractOrderNotifyProductNames(text);
  const quantity = parseOrderNotifyQuantity(text);
  if (products.length === 0) return "";
  if (products.length > 1 && quantity) {
    return products.map((p) => `${p} - ${formatOrderNotifyQuantity(quantity)}`).join("; ");
  }
  return `${products.join(", ")}${quantity ? ` - ${formatOrderNotifyQuantity(quantity)}` : ""}`;
}

function extractOrderNotifyProductBlock(lines) {
  const fieldIndex = lines.findLastIndex((line) => /^(sản phẩm|san pham)\s*[:：]?\s*$/iu.test(stripOrderNotifyLinePrefix(line)));
  if (fieldIndex < 0) return "";

  const productLines = [];
  for (const line of lines.slice(fieldIndex + 1)) {
    const cleaned = stripOrderNotifyLinePrefix(line);
    if (/^(tổng|tong|số tiền|so tien|phí ship|phi ship|địa chỉ|dia chi|sđt|sdt|số điện thoại|so dien thoai|khách hàng|khach hang)\b/iu.test(cleaned)) {
      break;
    }
    if (getOrderNotifyProductLineScore(cleaned) > 0) {
      productLines.push(cleaned);
    }
  }

  const items = productLines
    .map((line) => formatOrderNotifyProductLine(line))
    .filter(Boolean);
  return dedupeOrderNotifyProductItems(items).join("; ");
}

function formatOrderNotifyProductLine(line) {
  const products = extractOrderNotifyProductNames(line);
  const quantity = parseOrderNotifyQuantity(line);
  if (products.length === 0) return "";
  if (!quantity) return cleanOrderNotifyProduct(line);
  return `${products.join(", ")} - ${formatOrderNotifyQuantity(quantity)}`;
}

function dedupeOrderNotifyProductItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = normalizeSearchText(item).replace(/\s+/gu, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function getOrderNotifyProductLineScore(line) {
  const normalized = normalizeSearchText(line);
  const cleaned = stripOrderNotifyLinePrefix(line);
  const cleanedNormalized = normalizeSearchText(cleaned);
  const products = extractOrderNotifyProductNames(line);
  const quantity = parseOrderNotifyQuantity(line);
  const isFieldLine = /^(sản phẩm|san pham)\s*[:：-]/iu.test(cleaned);
  const hasOrderVerb = /\b(chot|dat|mua|lay|len don|don)\b/u.test(normalized);
  const isAdviceLine = /\b(luu y|thuong thuc|van chuyen|thoi tiet|nong|soc|dung ngay|noi thoang mat|ngay)\b/u.test(normalized);

  if (isFieldLine && products.length > 0) return quantity ? 100 : 90;
  if (isFieldLine) return 70;
  if (isAdviceLine) return 0;
  if (products.length === 0) return 0;
  if (products.length === 1 && products[0] === "rượu" && !quantity && !hasOrderVerb) return 0;
  if (quantity && products.some((product) => product !== "rượu")) return 80;
  if (quantity && /\b(ruou|rượu)\b/u.test(cleanedNormalized)) return 75;
  if (hasOrderVerb && products.some((product) => product !== "rượu")) return 60;
  return 0;
}

export function extractOrderNotifyProductNames(text) {
  const normalized = normalizeSearchText(text);
  const products = [];
  if (/\b(ngo men la|ruou ngo)\b/u.test(normalized) || (/\bmen la\b/u.test(normalized) && !/\btam giac mach\b/u.test(normalized))) {
    products.push("rượu ngô men lá");
  }
  if (/\b(tam giac mach|mach)\b/u.test(normalized)) products.push("rượu tam giác mạch");
  if (/\bruou\b/u.test(normalized) && products.length === 0) products.push("rượu");
  return products;
}

function cleanOrderNotifyProduct(value) {
  return stripOrderNotifyLinePrefix(trimOrderNotifyText(value))
    .replace(/^(sản phẩm|san pham)\s*[:：-]\s*/iu, "")
    .replace(/\s+(sđt|sdt|số điện thoại|so dien thoai|địa chỉ|dia chi|đc|dc)\s*[:：].*$/iu, "")
    .trim();
}

export function parseOrderNotifyQuantity(text) {
  const match = String(text || "").match(/\b(\d+)\s*(túi|tui|can|l|lit|lít)\b(?:\s*(\d+)\s*(l|lit|lít))?/iu);
  if (!match) return null;
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = normalizeSearchText(match[2]) === "tui" ? "túi" : normalizeSearchText(match[2]);
  const volume = match[3] ? `${match[3]}L` : unit === "túi" ? "5L" : "";
  return { amount, unit, volume };
}

export function parseOrderNotifyQuantities(text) {
  return String(text || "")
    .split(/\s*;\s*/u)
    .map((part) => parseOrderNotifyQuantity(part))
    .filter(Boolean);
}

export function formatOrderNotifyQuantity(quantity) {
  return `${String(quantity.amount).padStart(2, "0")} ${quantity.unit}${quantity.volume ? ` ${quantity.volume}` : ""}`;
}

export function estimateOrderNotifyProductAmount(quantityOrQuantities) {
  const quantities = Array.isArray(quantityOrQuantities) ? quantityOrQuantities : [quantityOrQuantities].filter(Boolean);
  if (quantities.length === 0) return 0;
  return quantities.reduce((total, quantity) => {
    if (quantity.unit === "can") return total + quantity.amount * 1200000;
    if (quantity.unit === "túi") return total + quantity.amount * 330000;
    return total;
  }, 0);
}

export function estimateOrderNotifyShippingAmount(quantityOrQuantities, productAmount) {
  const quantities = Array.isArray(quantityOrQuantities) ? quantityOrQuantities : [quantityOrQuantities].filter(Boolean);
  if (quantities.length === 0 || !productAmount) return 0;
  const totalBags = quantities
    .filter((quantity) => quantity.unit === "túi")
    .reduce((total, quantity) => total + quantity.amount, 0);
  const hasOtherUnits = quantities.some((quantity) => quantity.unit !== "túi");
  if (!hasOtherUnits && totalBags === 1) return 20000;
  return 0;
}

// ── Order Detection ──────────────────────────────────────────────────────────

export function detectOrder(pageId, customerId, customerProfile, messages, options = {}) {
  const recentMessages = (messages || [])
    .filter((message) => message?.created_time && typeof message.message === "string")
    .sort((a, b) => new Date(a.created_time) - new Date(b.created_time))
    .slice(-24);  // Wider window to catch product qty from earlier confirmation
  const customerMessages = recentMessages
    .filter((message) => String(message?.from?.id || "") !== String(pageId));
  if (customerMessages.length === 0) return null;

  const allCustomerText = customerMessages.map((message) => message.message).join("\n");
  const allRecentText = recentMessages.map((message) => message.message).join("\n");
  const phones = extractPhonesFromText(allRecentText);  // Check ALL messages including bot replies
  const address = cleanOrderNotifyAddress(extractDetailedAddressLinesFromText(allCustomerText).at(-1) || "");
  const product = extractOrderNotifyProduct(allRecentText) || extractOrderNotifyProduct(allCustomerText);
  if (phones.length === 0 || !address || !product) return null;

  const pageNameFallbacks = new Map([
    ["625538103984936", "BẢN MỘC"],
    ["560889237118933", "Bản Mộc - Hương Vị Tây Bắc"],
    ["109923292016675", "Bản Mộc - Chuẩn Vị Tây Bắc"],
    ["606774605862174", "Bản Mộc - Đặc Sản Tây Bắc"]
  ]);

  const sourceAt = Number(options.sourceAt || new Date(customerMessages.at(-1).created_time).getTime() || Date.now());
  const quantities = parseOrderNotifyQuantities(product);
  const quantity = quantities[0] || parseOrderNotifyQuantity(allCustomerText);
  const productAmount = estimateOrderNotifyProductAmount(quantities.length > 0 ? quantities : quantity);
  const shippingAmount = estimateOrderNotifyShippingAmount(quantities.length > 0 ? quantities : quantity, productAmount);
  const totalAmount = productAmount ? productAmount + shippingAmount : 0;

  return {
    pageId,
    pageName: pageNameFallbacks.get(String(pageId)) || `Page ${pageId || "unknown"}`,
    recipientId: customerId,
    customerName: customerProfile?.name || customerMessages.at(-1)?.from?.name || "Khách",
    product,
    phone: phones[0],
    address,
    productAmount,
    shippingAmount,
    totalAmount,
    sourceAt,
    sourceMessageId: options.sourceMessageId || customerMessages.at(-1)?.id || "",
    signatureDate: formatOrderNotifyDateKey(sourceAt)
  };
}

// ── Dedup ────────────────────────────────────────────────────────────────────

export function getOrderNotificationKey(order) {
  const signature = [
    order.pageId,
    order.recipientId,
    order.signatureDate,
    order.phone,
    normalizeSearchText(order.product).replace(/\s+/gu, " ").trim(),
    normalizeSearchText(order.address).replace(/\s+/gu, " ").trim()
  ].join("|");
  return crypto.createHash("sha256").update(signature).digest("hex");
}

export function getOrderContactKey(order) {
  const signature = [
    order.pageId,
    order.recipientId,
    order.signatureDate,
    order.phone,
    normalizeSearchText(order.address).replace(/\s+/gu, " ").trim()
  ].join("|");
  return crypto.createHash("sha256").update(signature).digest("hex");
}

export function isOrderNotified(order) {
  const notificationKey = getOrderNotificationKey(order);
  const contactKey = getOrderContactKey(order);
  const persisted = orderState.notifiedOrders[notificationKey] || orderState.notifiedOrderContacts[contactKey];
  const active = activeNotificationKeys.has(notificationKey) || activeNotificationKeys.has(contactKey);
  return Boolean(persisted || active);
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function formatTelegramReport(order) {
  const lines = ["Đơn hàng mới", ""];

  lines.push(`• Page: ${order.pageName}`);
  lines.push(`• Tên khách: ${order.customerName || "Khách"}`);

  const productItems = (order.product || "").split(/\s*;\s*/u).map((s) => s.trim()).filter(Boolean);
  if (productItems.length > 1) {
    lines.push("• Sản phẩm:");
    for (const item of productItems) {
      // Strip price suffix like ": 330.000đ" from product items
      const cleanItem = item.replace(/\s*:\s*[\d.,]+đ?\s*$/u, "").trim();
      lines.push(`  - ${cleanItem}`);
    }
  } else {
    const cleanItem = (productItems[0] || order.product).replace(/\s*:\s*[\d.,]+đ?\s*$/u, "").trim();
    lines.push(`• Sản phẩm: ${cleanItem}`);
  }

  lines.push(`• Phí ship: ${order.productAmount ? formatVnd(order.shippingAmount) : "chưa rõ"}`);
  lines.push(`• Tổng tiền: ${order.totalAmount ? formatVnd(order.totalAmount) : "chưa rõ"}`);
  lines.push(`• Địa chỉ: ${order.address}`);
  lines.push(`• SĐT: ${order.phone}`);
  lines.push(`• Thời gian: ${formatOrderNotifyTime(order.sourceAt)}`);

  return lines.join("\n");
}

// ── Telegram Send ────────────────────────────────────────────────────────────

async function sendTelegramReport(reportText) {
  const url = new URL(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: config.orderNotifyTelegramChatId,
      text: reportText,
      disable_web_page_preview: true
    })
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Telegram notify HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
  }
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Detect, deduplicate, and notify a new order via Telegram.
 *
 * @param {string} pageId - Facebook Page ID
 * @param {string} customerId - Customer PSID
 * @param {object} customerProfile - { name, firstName, ... }
 * @param {Array} messages - Conversation messages
 * @param {object} options - { confirmed, sourceAt, sourceMessageId, sendNotification }
 * @returns {Promise<{notified: boolean, order: object|null}>}
 */
export async function processOrderNotification(pageId, customerId, customerProfile, messages, options = {}) {
  if (!config.orderNotifyEnabled || !config.orderNotifyTelegramChatId || !config.telegramBotToken) {
    return { notified: false, order: null };
  }

  const order = detectOrder(pageId, customerId, customerProfile, messages, options);
  if (!order) return { notified: false, order: null };

  // Don't send unless the bot has confirmed the order
  if (!options.confirmed && !hasPageConfirmedOrder(messages, pageId, order.sourceAt)) {
    return { notified: false, order };
  }

  if (options.sendNotification === false) {
    return { notified: false, order };
  }

  // Dedup check
  if (isOrderNotified(order)) {
    return { notified: false, order };
  }

  // Mark as in-progress
  const notificationKey = getOrderNotificationKey(order);
  const contactKey = getOrderContactKey(order);
  activeNotificationKeys.add(notificationKey);
  activeNotificationKeys.add(contactKey);

  try {
    const reportText = formatTelegramReport(order);
    await sendTelegramReport(reportText);

    // Persist
    orderState.notifiedOrders[notificationKey] = Date.now();
    orderState.notifiedOrderContacts[contactKey] = Date.now();
    saveOrderState();

    console.log(`[order-reporter] sent telegram notification page=${pageId || "unknown"} customer=${customerId}`);
    return { notified: true, order };
  } catch (error) {
    console.error(`[order-reporter] telegram send failed:`, error);
    throw error;
  } finally {
    activeNotificationKeys.delete(notificationKey);
    activeNotificationKeys.delete(contactKey);
  }
}

// ── State Management ─────────────────────────────────────────────────────────

export function markOrderNotified(order) {
  const notificationKey = getOrderNotificationKey(order);
  const contactKey = getOrderContactKey(order);
  orderState.notifiedOrders[notificationKey] = Date.now();
  orderState.notifiedOrderContacts[contactKey] = Date.now();
  saveOrderState();
}

export function getNotifiedOrderKeys() {
  return {
    notifiedOrders: { ...orderState.notifiedOrders },
    notifiedOrderContacts: { ...orderState.notifiedOrderContacts }
  };
}

export function mergeNotifiedKeys(orders = {}, contacts = {}) {
  let changed = false;
  for (const [key, value] of Object.entries(orders)) {
    if (!orderState.notifiedOrders[key]) {
      orderState.notifiedOrders[key] = value;
      changed = true;
    }
  }
  for (const [key, value] of Object.entries(contacts)) {
    if (!orderState.notifiedOrderContacts[key]) {
      orderState.notifiedOrderContacts[key] = value;
      changed = true;
    }
  }
  if (changed) saveOrderState();
}

// ── Pending Order Notification (leads with SĐT+địa chỉ but not chốt yet) ─────

const pendingLeadStateKey = `pending_leads`;

function getPendingLeadKey(pageId, recipientId, dateKey, phone, address) {
  const signature = [pageId, recipientId, dateKey, phone, normalizeSearchText(address).replace(/\s+/gu, " ").trim()].join("|");
  return crypto.createHash("sha256").update(signature).digest("hex");
}

function isPendingLeadNotified(key) {
  const leads = orderState[pendingLeadStateKey] || {};
  return Boolean(leads[key]);
}

function isOrderContactAlreadyNotified(key) {
  return Boolean(orderState.notifiedOrderContacts?.[key]);
}

function markPendingLeadNotified(key) {
  orderState[pendingLeadStateKey] = orderState[pendingLeadStateKey] || {};
  orderState[pendingLeadStateKey][key] = Date.now();
  saveOrderState();
}

function formatPendingLeadReport(order) {
  const lines = ["🔔 Khách tiềm năng (chưa chốt đơn)", ""];
  lines.push(`• Page: ${order.pageName}`);
  lines.push(`• Tên khách: ${order.customerName || "Khách"}`);
  const productItems = (order.product || "").split(/\s*;\s*/u).map((s) => s.trim()).filter(Boolean);
  if (productItems.length > 1) {
    lines.push("• Sản phẩm quan tâm:");
    for (const item of productItems) {
      const cleanItem = item.replace(/\s*:\s*[\d.,]+đ?\s*$/u, "").trim();
      lines.push(`  - ${cleanItem}`);
    }
  } else {
    const cleanItem = (productItems[0] || order.product).replace(/\s*:\s*[\d.,]+đ?\s*$/u, "").trim();
    lines.push(`• Sản phẩm quan tâm: ${cleanItem}`);
  }
  lines.push(`• SĐT: ${order.phone}`);
  lines.push(`• Địa chỉ: ${order.address}`);
  lines.push(`• Thời gian: ${formatOrderNotifyTime(order.sourceAt)}`);
  lines.push("");
  lines.push("👉 Khách đã để lại SĐT + địa chỉ nhưng bot chưa chốt đơn. Cần liên hệ lại.");
  return lines.join("\n");
}

/**
 * Record a potential lead for later notification.
 * Only sends Telegram notification after a delay if bot hasn't confirmed by then.
 */
export async function processPendingLeadNotification(pageId, customerId, customerProfile, messages, options = {}) {
  if (!config.orderNotifyEnabled || !config.orderNotifyTelegramChatId || !config.telegramBotToken) {
    return { notified: false };
  }

  const order = detectOrder(pageId, customerId, customerProfile, messages, options);
  if (!order) return { notified: false };

  // Already confirmed -> don't record as pending
  if (options.confirmed || hasPageConfirmedOrder(messages, pageId, order.sourceAt)) {
    return { notified: false };
  }

  const dateKey = formatOrderNotifyDateKey(order.sourceAt);
  const leadKey = getPendingLeadKey(pageId, customerId, dateKey, order.phone, order.address);

  // Already recorded, sent as a pending lead, or confirmed as a real order.
  if (isPendingLeadNotified(leadKey) || isOrderContactAlreadyNotified(leadKey) || isPendingLeadRecorded(leadKey)) {
    return { notified: false };
  }

  // Record the lead with current timestamp (will send after delay)
  recordPendingLead(leadKey, order);
  console.log(`[order-reporter] recorded pending lead page=${pageId || "unknown"} customer=${customerId} (will notify after delay)`);
  return { notified: false, recorded: true };
}

// ── Pending Lead State (delayed notification) ──────────────────────────

function isPendingLeadRecorded(key) {
  const recorded = orderState.pending_leads_recorded || {};
  return Boolean(recorded[key]);
}

function recordPendingLead(key, order) {
  orderState.pending_leads_recorded = orderState.pending_leads_recorded || {};
  orderState.pending_leads_recorded[key] = {
    recordedAt: Date.now(),
    order: {
      pageId: order.pageId,
      pageName: order.pageName,
      recipientId: order.recipientId,
      customerName: order.customerName,
      product: order.product,
      phone: order.phone,
      address: order.address,
      sourceAt: order.sourceAt
    }
  };
  saveOrderState();
}

function getRecordedPendingLeads() {
  return orderState.pending_leads_recorded || {};
}

function clearPendingLeadRecord(key) {
  if (orderState.pending_leads_recorded?.[key]) {
    delete orderState.pending_leads_recorded[key];
    saveOrderState();
  }
}

/**
 * Check recorded pending leads and send notifications for those
 * that have been waiting longer than the configured delay.
 * Returns array of lead keys that were notified.
 */
export async function sendDuePendingLeads() {
  if (!config.orderNotifyEnabled || !config.orderNotifyTelegramChatId || !config.telegramBotToken) {
    return [];
  }

  const delayMs = Math.max(config.pendingLeadDelayMinutes || 10, 3) * 60 * 1000;
  const now = Date.now();
  const recorded = { ...getRecordedPendingLeads() };
  const notified = [];

  for (const [key, data] of Object.entries(recorded)) {
    if (!data || typeof data !== 'object') { clearPendingLeadRecord(key); continue; }
    const recordedAt = Number(data.recordedAt || 0);
    if (!recordedAt || now - recordedAt < delayMs) continue;
    if (isPendingLeadNotified(key)) { clearPendingLeadRecord(key); continue; }

    // Time's up - send notification
    const order = data.order;
    if (!order) { clearPendingLeadRecord(key); continue; }

    try {
      const reportText = formatPendingLeadReport(order);
      await sendTelegramReport(reportText);
      markPendingLeadNotified(key);
      clearPendingLeadRecord(key);
      notified.push(key);
      console.log(`[order-reporter] sent due pending lead notification page=${order.pageId || "unknown"} customer=${order.recipientId}`);
    } catch (error) {
      console.error(`[order-reporter] due pending lead failed:`, error);
    }
  }

  return notified;
}
