import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotEnv(join(__dirname, ".env"));

const config = {
  graphVersion: process.env.META_GRAPH_API_VERSION || "v23.0",
  pageAccessToken: process.env.META_PAGE_ACCESS_TOKEN || "",
  pageAccessTokens: readPageAccessTokens(),
  timezone: process.env.ORDER_SUMMARY_TIMEZONE || "Asia/Ho_Chi_Minh",
  summaryWindow: process.env.ORDER_SUMMARY_WINDOW || "auto",
  shopPhone: normalizePhone(process.env.BAN_MOC_HOTLINE || "0931989777"),
  maxConversations: readIntEnv("ORDER_SUMMARY_MAX_CONVERSATIONS", 100),
  maxMessagesPerConversation: readIntEnv("ORDER_SUMMARY_MAX_MESSAGES", 50)
};

const pageNameFallbacks = new Map([
  ["625538103984936", "BẢN MỘC"],
  ["560889237118933", "Bản Mộc - Hương Vị Tây Bắc"],
  ["109923292016675", "Bản Mộc - Chuẩn Vị Tây Bắc"],
  ["606774605862174", "Bản Mộc - Đặc Sản Tây Bắc"]
]);

const { start, end, label } = getReportWindow();
const summaries = [];

for (const pageId of getConfiguredPageIds()) {
  summaries.push(await summarizePage(pageId));
}

console.log(formatReport(summaries));

async function summarizePage(pageId) {
  const pageAccessToken = getPageAccessToken(pageId);
  const pageName = await getPageName(pageId, pageAccessToken);
  const result = {
    pageId,
    pageName,
    orders: [],
    review: [],
    errors: []
  };

  if (!pageAccessToken) {
    result.errors.push("Chưa có Page Access Token.");
    return result;
  }

  try {
    const conversations = await fetchConversations(pageId, pageAccessToken);
    for (const conversation of conversations) {
      const order = detectClosedOrder(pageId, conversation);
      if (order?.status === "closed") result.orders.push(order);
      if (order?.status === "review") result.review.push(order);
    }
  } catch (error) {
    result.errors.push(error.message);
  }

  result.orders.sort((a, b) => b.latestAt - a.latestAt);
  result.review.sort((a, b) => b.latestAt - a.latestAt);
  return result;
}

async function fetchConversations(pageId, pageAccessToken) {
  const url = new URL(`https://graph.facebook.com/${config.graphVersion}/${pageId}/conversations`);
  url.searchParams.set(
    "fields",
    [
      "id",
      "updated_time",
      "participants",
      `messages.limit(${config.maxMessagesPerConversation}){id,created_time,from,to,message}`
    ].join(",")
  );
  url.searchParams.set("limit", String(Math.max(1, Math.min(config.maxConversations, 100))));
  url.searchParams.set("access_token", pageAccessToken);

  const body = await fetchJson(url);
  return body.data || [];
}

function detectClosedOrder(pageId, conversation) {
  const messages = (conversation.messages?.data || [])
    .filter((message) => message?.created_time && typeof message.message === "string")
    .sort((a, b) => new Date(a.created_time) - new Date(b.created_time));

  const inWindow = messages.filter((message) => {
    const createdAt = new Date(message.created_time);
    return createdAt >= start && createdAt <= end;
  });
  if (inWindow.length === 0) return null;

  const relevantMessages = messages.filter((message) => new Date(message.created_time) <= end);
  const customerMessages = relevantMessages.filter((message) => String(message?.from?.id || "") !== String(pageId));
  const pageMessages = relevantMessages.filter((message) => String(message?.from?.id || "") === String(pageId));
  const customerWindowMessages = inWindow.filter((message) => String(message?.from?.id || "") !== String(pageId));
  const pageWindowMessages = inWindow.filter((message) => String(message?.from?.id || "") === String(pageId));
  const customerWindowText = customerWindowMessages.map((message) => message.message).join("\n");
  const allCustomerText = customerMessages.map((message) => message.message).join("\n");
  const allPageText = pageMessages.map((message) => message.message).join("\n");
  const combinedText = `${allCustomerText}\n${allPageText}`;
  const confirmationMessage = findOrderConfirmationMessage(pageWindowMessages);
  const manualAcceptanceMessage = confirmationMessage
    ? null
    : findManualOrderAcceptanceMessage(pageWindowMessages, customerWindowMessages);
  const orderEvidenceMessage = confirmationMessage || manualAcceptanceMessage;
  if (!orderEvidenceMessage) return null;

  const confirmationFields = confirmationMessage ? extractConfirmationFields(confirmationMessage.message) : {};
  const confirmationText = Object.values(confirmationFields).filter(Boolean).join("\n");

  const phones = extractPhones(`${confirmationFields.phone || ""}\n${confirmationText}\n${allCustomerText}`);
  const customerProducts = extractProducts(allCustomerText);
  const products = extractProducts(confirmationFields.product || confirmationText);
  const fallbackProducts = customerProducts.length > 0 ? customerProducts : extractProducts(combinedText);
  const quantityLines = [
    confirmationFields.product,
    ...extractMatchingLines(allCustomerText, /(\d+)\s*(túi|tui|can|l|lit|lít|chai|bình|binh)\b/iu)
  ].filter(Boolean);
  const addressLines = [
    confirmationFields.address,
    ...extractAddressLines(allCustomerText)
  ].filter(Boolean);
  const customerIntent = hasOrderIntent(allCustomerText);
  const latestAt = new Date(orderEvidenceMessage.created_time).getTime();
  const lastCustomerLine = lastNonEmpty(customerMessages.map((message) => message.message));

  if (hasPostFulfillmentSignal(lastCustomerLine)) return null;
  if (hasPostFulfillmentSignal(customerWindowText) && !hasExplicitPurchaseSignal(customerWindowText)) return null;
  if (isRequestingMissingOrderInfo(orderEvidenceMessage.message)) return null;

  const base = {
    status: "closed",
    conversationId: conversation.id || "",
    customerName: confirmationFields.customerName || getCustomerName(pageId, conversation, customerMessages),
    latestAt,
    phones,
    products: products.length > 0 ? products : fallbackProducts,
    quantityLines,
    addressLines,
    confirmationFields,
    confirmationText: orderEvidenceMessage.message,
    estimatedTotal: estimateOrderTotal(quantityLines),
    lastCustomerLine,
    lastPageLine: orderEvidenceMessage.message
  };

  const hasProduct = base.products.length > 0 || Boolean(confirmationFields.product);
  const hasQuantity = quantityLines.length > 0;
  const hasAddress = addressLines.length > 0;
  if (phones.length > 0 && hasProduct && (hasQuantity || customerIntent) && hasAddress) return base;

  return null;
}

function formatReport(pageSummaries) {
  const totalOrders = pageSummaries.reduce((sum, page) => sum + page.orders.length, 0);
  const productTotals = collectProductTotals(pageSummaries);
  const lines = [
    `Danh sách đơn hàng khung giờ ${label}`,
    "",
    `- Rượu tam giác mạch: ${formatProductTotal(productTotals.tamGiacMach)}`,
    `- Rượu ngô men lá: ${formatProductTotal(productTotals.ngoMenLa)}`,
    "",
    "__________________",
    "Chi tiết đơn hàng",
    `Tổng đơn: ${totalOrders}`,
    ""
  ].filter(Boolean);

  for (const page of pageSummaries) {
    if (page.orders.length === 0 && page.errors.length === 0) continue;

    lines.push(`* ${page.pageName}: ${page.orders.length} đơn`);
    if (page.errors.length > 0) {
      for (const error of page.errors) lines.push(`- Lỗi đọc dữ liệu: ${error}`);
      lines.push("");
      continue;
    }

    if (page.orders.length === 0) {
      lines.push("Chưa có đơn đủ SĐT + địa chỉ chi tiết.");
    } else {
      page.orders.slice(0, 20).forEach((order, index) => {
        lines.push(formatOrder(order, index + 1));
      });
    }

    lines.push("");
  }

  if (!pageSummaries.some((page) => page.orders.length > 0 || page.errors.length > 0)) {
    lines.push("Chưa có đơn đã xác nhận trong khung này.");
  }

  return lines.join("\n").trim();
}

function cleanOrderField(value) {
  if (!value) return "";
  const text = String(value)
    .replace(/^(tổng tiền|tong tien|tổng|tong)\s*[:：]?\s*/iu, "")
    .trim();
  // Extract just the price portion: first occurrence of number+đ pattern
  const match = text.match(/[\d.,]+\s*đ\b/u);
  return match ? match[0] : (/[\d]/.test(text) ? text : "");
}

function formatOrder(order, index) {
  const fields = order.confirmationFields || {};
  const productAmount = fields.subtotal || (order.estimatedTotal ? formatVnd(estimateProductAmount(order)) : "");
  const shippingAmount = fields.shipping || (order.estimatedTotal ? formatVnd(estimateShippingAmount(order)) : "");
  const totalAmount = cleanOrderField(fields.total) || (order.estimatedTotal ? formatVnd(order.estimatedTotal) : "");

  // Strip prices from product text (e.g. ": 330.000đ")
  const rawProduct = fields.product || formatProductQuantity(order);
  const cleanProduct = rawProduct
    .replace(/\\s*:\\s*[\\d.,]+đ?\\s*/gu, " ")
    .replace(/\\s*•\\s*/gu, " ")
    .replace(/\\s+/gu, " ")
    .trim();

  const rawAddress = fields.address || formatAddress(order);
  const cleanAddress = rawAddress
    .replace(/^(đ\/c|đc|dc|địa chỉ|dia chi)\s*[:：]?\s*/iu, "")
    .replace(/\s*•\s*/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  return [
    "",
    `* Đơn ${index}:`,
    `- Tên khách: ${fields.customerName || order.customerName || "Khách"}`,
    `- Sản phẩm: ${cleanProduct}`,
    `- Phí ship: ${shippingAmount || "chưa rõ"}`,
    `- Tổng tiền: ${totalAmount || "chưa rõ"}`,
    `- Địa chỉ: ${cleanAddress}`,
    `- SĐT: ${fields.phone || order.phones.join(", ") || "chưa thấy"}`
  ].filter(Boolean).join("\n");
}

function collectProductTotals(pageSummaries) {
  const totals = {
    tamGiacMach: new Map(),
    ngoMenLa: new Map()
  };

  for (const page of pageSummaries) {
    for (const order of page.orders) {
      for (const item of extractOrderProductItems(order)) {
        const productKey = item.product === "ngo-men-la" ? "ngoMenLa" : "tamGiacMach";
        const unitKey = `${item.unit}|${item.volume || ""}`;
        const current = totals[productKey].get(unitKey) || { amount: 0, unit: item.unit, volume: item.volume };
        current.amount += item.amount;
        totals[productKey].set(unitKey, current);
      }
    }
  }

  return totals;
}

function extractOrderProductItems(order) {
  const fields = order.confirmationFields || {};

  // Prefer confirmationFields.product — it's the clean, single source of truth.
  // Only fall back to quantityLines + products when confirmationFields is missing.
  if (fields.product) {
    const items = extractProductItemsFromText(fields.product);
    if (items.length > 0) return dedupeProductItems(items);
  }

  // Fallback: try quantityLines + products array
  const texts = [...order.quantityLines].filter(Boolean);
  const items = texts.flatMap(extractProductItemsFromText);
  if (items.length > 0) return dedupeProductItems(items);

  return order.products.flatMap((product) => {
    const normalized = normalizeSearchText(product);
    const quantity = parseQuantityParts(order.quantityLines[0] || "");
    if (!quantity) return [];
    if (/\b(ngo men la|ruou ngo)\b/u.test(normalized)) return [{ product: "ngo-men-la", ...quantity }];
    if (/\b(tam giac mach|mach)\b/u.test(normalized)) return [{ product: "tam-giac-mach", ...quantity }];
    return [];
  });
}

function extractProductItemsFromText(text) {
  const cleaned = String(text || "")
    .replace(/[•·●]\s*/gu, "")           // strip bullet points
    .replace(/\s*:\s*[\d.,]+đ?\s*/gu, " ") // strip price suffixes
    .replace(/\s+/gu, " ")
    .trim();
  const clauses = cleaned
    .split(/\s+(?:và|va)\s+|[,+;]\s*/iu)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const sourceClauses = clauses.length > 0 ? clauses : [String(text || "")];
  const items = [];

  for (const clause of sourceClauses) {
    const normalized = normalizeSearchText(clause);
    const quantity = parseQuantityParts(clause);
    if (!quantity) continue;

    if (/\b(ngo men la|ruou ngo)\b/u.test(normalized) || (/\bmen la\b/u.test(normalized) && !/\btam giac mach\b/u.test(normalized))) {
      items.push({ product: "ngo-men-la", ...quantity });
    }
    if (/\b(tam giac mach|mach)\b/u.test(normalized)) {
      items.push({ product: "tam-giac-mach", ...quantity });
    }
  }

  if (items.length > 0) return items;

  const normalized = normalizeSearchText(text);
  const quantity = parseQuantityParts(text);
  if (!quantity) return [];
  if (/\b(ngo men la|ruou ngo)\b/u.test(normalized)) return [{ product: "ngo-men-la", ...quantity }];
  if (/\b(tam giac mach|mach)\b/u.test(normalized)) return [{ product: "tam-giac-mach", ...quantity }];
  return [];
}

function parseQuantityParts(line) {
  const match = String(line || "").match(/\b(\d+)\s*(túi|tui|can|l|lit|lít|chai|bình|binh)\b(?:\s*(\d+)\s*(l|lit|lít))?/iu);
  if (!match) return null;
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = normalizeUnit(match[2]);
  const volume = match[3] ? `${match[3]}L` : unit === "túi" ? "5L" : "";
  return { amount, unit, volume };
}

function dedupeProductItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.product}|${item.amount}|${item.unit}|${item.volume}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatProductTotal(totalMap) {
  if (!totalMap || totalMap.size === 0) return "0";
  return [...totalMap.values()]
    .sort((a, b) => `${a.unit}${a.volume}`.localeCompare(`${b.unit}${b.volume}`, "vi"))
    .map((item) => `${item.amount} ${item.unit}${item.volume ? ` ${item.volume}` : ""}`)
    .join(", ");
}

function estimateProductAmount(order) {
  if (!order.quantityLines || order.quantityLines.length === 0) return order.estimatedTotal || 0;
  let total = 0;
  for (const line of order.quantityLines) {
    const match = String(line || "").match(/\b(\d+)\s*(túi|tui|can)\b/iu);
    if (!match) continue;
    const amount = Number.parseInt(match[1], 10);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const unit = normalizeSearchText(match[2]);
    total += unit === "can" ? amount * 1200000 : amount * 330000;
  }
  return total || order.estimatedTotal || 0;
}

function estimateShippingAmount(order) {
  if (!order.quantityLines || order.quantityLines.length === 0) return 0;
  let totalBags = 0;
  let hasCan = false;
  for (const line of order.quantityLines) {
    const match = String(line || "").match(/\b(\d+)\s*(túi|tui|can)\b/iu);
    if (!match) continue;
    const amount = Number.parseInt(match[1], 10);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const unit = normalizeSearchText(match[2]);
    if (unit === "can") { hasCan = true; }
    else { totalBags += amount; }
  }
  // Free shipping for 2+ bags or any can
  if (hasCan || totalBags >= 2) return 0;
  if (totalBags === 1) return 20000;
  return 0;
}

function formatProductQuantity(order) {
  const product = order.products.join(", ") || "chưa rõ sản phẩm";
  const quantity = formatQuantity(order.quantityLines[0]);
  return `${product} - ${quantity}`;
}

function formatQuantity(line) {
  const text = trimLine(line || "");
  const match = text.match(/\b(\d+)\s*(túi|tui|can|l|lit|lít|chai|bình|binh)\b(?:\s*(\d+)\s*(l|lit|lít))?/iu);
  if (!match) return "chưa rõ số lượng";

  const amount = match[1].padStart(2, "0");
  const unit = normalizeUnit(match[2]);
  const volume = match[3] ? ` ${match[3]}L` : "";
  return `${amount} ${unit}${volume}`;
}

function normalizeUnit(unit) {
  const normalized = normalizeSearchText(unit);
  if (normalized === "tui") return "túi";
  if (normalized === "l" || normalized === "lit") return "L";
  if (normalized === "binh") return "bình";
  return unit;
}

function formatAddress(order) {
  if (!order.addressLines.length) return "chưa thấy";
  return cleanAddress(order.addressLines.at(-1)) || "chưa thấy";
}

function cleanAddress(value) {
  let text = trimFieldValue(value);
  const addressMarker = text.match(/(?:^|[\s.])(?:đc|dc|địa chỉ|dia chi)\.?\s*/iu);
  if (addressMarker?.index !== undefined) text = text.slice(addressMarker.index + addressMarker[0].length);
  text = text.replace(/(?:^|[\s.])(?:đt|dt|sdt|số điện thoại|so dien thoai)\.?\s*.*$/iu, "");
  return trimFieldValue(text)
    .replace(/(?:\+?84|0)(?:[\s.-]*\d){9}\b/gu, "")
    .replace(/\s*([,.])\s*/gu, "$1 ")
    .replace(/[,.]\s*$/u, "")
    .replace(/,\s*(anh|chị|chi)\s+(?=(hà nội|ha noi|hồ chí minh|ho chi minh|đà nẵng|da nang)\b)/giu, ", ")
    .replace(/\s+/gu, " ")
    .trim();
}

function formatOrderNote(order) {
  const pageLine = trimLine(order.lastPageLine || "");
  if (/(xác nhận|xac nhan|chốt đơn|chot don|lên đơn|len don)/iu.test(normalizeSearchText(pageLine))) {
    return "Đã xác nhận đơn.";
  }
  if (hasManualAcceptanceSignal(pageLine)) return "Đã nhận thông tin.";

  const note = trimLine(order.lastCustomerLine || pageLine);
  if (!note) return "";
  return note.length > 100 ? `${note.slice(0, 97).trim()}...` : note;
}

function findOrderConfirmationMessage(messages) {
  return [...messages].reverse().find((message) => isOrderConfirmationMessage(message.message)) || null;
}

function findManualOrderAcceptanceMessage(pageMessages, customerMessages) {
  const lastCustomerOrderAt = [...customerMessages].reverse()
    .find((message) => hasNewOrderSignal(message.message))?.created_time;
  if (!lastCustomerOrderAt) return null;

  const lastCustomerTimestamp = new Date(lastCustomerOrderAt).getTime();
  return [...pageMessages].reverse().find((message) => {
    if (new Date(message.created_time).getTime() < lastCustomerTimestamp) return false;
    if (isRequestingMissingOrderInfo(message.message)) return false;
    return hasManualAcceptanceSignal(message.message);
  }) || null;
}

function isOrderConfirmationMessage(text) {
  const fields = extractConfirmationFields(text);
  const hasStructuredConfirmation = Boolean(fields.product && fields.address && fields.phone);
  const hasConfirmationPhrase = hasPageConfirmation(text);
  const hasOrderDetails = extractPhones(text).length > 0 &&
    extractProducts(text).length > 0 &&
    extractAddressLines(text).length > 0;
  return hasStructuredConfirmation || (hasConfirmationPhrase && hasOrderDetails);
}

function extractConfirmationFields(text) {
  const fields = {
    customerName: "",
    product: "",
    subtotal: "",
    shipping: "",
    total: "",
    address: "",
    phone: ""
  };
  const labelMap = new Map([
    ["khach hang", "customerName"],
    ["ten khach", "customerName"],
    ["san pham", "product"],
    ["tong tien hang", "subtotal"],
    ["tien hang", "subtotal"],
    ["tong tien", "total"],
    ["tong cong", "total"],
    ["thanh tien", "total"],
    ["phi van chuyen", "shipping"],
    ["phi ship", "shipping"],
    ["dia chi giao hang", "address"],
    ["dia chi", "address"],
    ["dc", "address"],
    ["so dien thoai", "phone"],
    ["dien thoai", "phone"],
    ["sdt", "phone"]
  ]);
  let activeField = "";

  for (const rawLine of normalizeConfirmationLines(text).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;

    const labelMatch = line.match(/^([^:：]{1,32})[:：]\s*(.*)$/u);
    if (labelMatch) {
      const normalizedLabel = normalizeSearchText(labelMatch[1]).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim();
      const field = labelMap.get(normalizedLabel);
      if (field) {
        activeField = field;
        fields[field] = field === "total" && fields[field]
          ? trimLine(labelMatch[2])
          : appendField(fields[field], labelMatch[2]);
        continue;
      }
    }

    if (isConfirmationFooterLine(line) || isOrderAmountLine(line)) {
      activeField = "";
      continue;
    }

    if (activeField) fields[activeField] = appendField(fields[activeField], line);
  }

  const parsedPhones = extractPhones(fields.phone || text);
  if (parsedPhones.length > 0) fields.phone = parsedPhones.join(", ");
  fields.product = cleanProduct(fields.product);
  fields.address = cleanAddress(fields.address);
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, trimFieldValue(value)]));
}

function appendField(current, next) {
  const value = trimFieldValue(next);
  if (!value) return current || "";
  return current ? `${current} ${value}` : value;
}

function cleanProduct(value) {
  return trimLine(String(value || "").split(/\s+-\s*(?:Tổng tiền hàng|Tiền hàng|Tổng tiền|Phí vận chuyển|Phí ship|Tổng cộng|Thành tiền)\s*:/iu)[0])
    .replace(/\s+(anh|chị|chi)\s+.+$/iu, "")
    .trim();
}

function isOrderAmountLine(line) {
  const normalized = normalizeSearchText(line)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return /^(tong tien hang|tien hang|tong tien|phi van chuyen|phi ship|tong cong|thanh tien)\b/u.test(normalized);
}

function normalizeConfirmationLines(text) {
  return String(text || "")
    .replace(/\s+-\s*(Khách hàng|Tên khách|Sản phẩm|Tổng tiền hàng|Tiền hàng|Tổng tiền|Phí vận chuyển|Phí ship|Tổng cộng|Thành tiền|Địa chỉ giao hàng|Địa chỉ|Số điện thoại|Điện thoại|SĐT)\s*:/giu, "\n- $1:")
    .replace(/\s+(Khách hàng|Tên khách|Sản phẩm|Tổng tiền hàng|Tiền hàng|Tổng tiền|Phí vận chuyển|Phí ship|Tổng cộng|Thành tiền|Địa chỉ giao hàng|Địa chỉ|Số điện thoại|Điện thoại|SĐT)\s*:/giu, "\n$1:");
}

function isConfirmationFooterLine(line) {
  const normalized = normalizeSearchText(line);
  return /^(em cam on|cam on|ben em se|trong luc cho|shop cam on|ban moc cam on|da len don|don hang se)/u.test(normalized);
}

function extractPhones(text) {
  const matches = String(text || "").match(/(?:\+?84|0)(?:[\s.-]*\d){9}\b/gu) || [];
  return [...new Set(matches.map(normalizePhone).filter((phone) => phone && phone !== config.shopPhone))];
}

function extractProducts(text) {
  const normalized = normalizeSearchText(text);
  const products = [];
  if (/\b(ngo men la|ruou ngo)\b/u.test(normalized) || /\bmen la\b/u.test(normalized)) products.push("rượu ngô men lá");
  if (/\b(tam giac mach|mach)\b/u.test(normalized)) products.push("rượu tam giác mạch");
  if (/\bruou\b/u.test(normalized) && products.length === 0) products.push("rượu");
  return products;
}

function extractAddressLines(text) {
  const addressPattern = /(địa chỉ|dia chi|đc|dc|số nhà|so nha|thôn|thon|xã|xa|huyện|huyen|tỉnh|tinh|tp|tt|thành phố|phường|phuong|quận|quan|ấp|ap|bản|ban|đường|duong|ngõ|ngo|ngách|ngach|hẻm|hem)/iu;
  return String(text || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && addressPattern.test(line) && isDetailedAddressLine(line))
    .slice(-3);
}

function isDetailedAddressLine(line) {
  const normalized = normalizeSearchText(line)
    .replace(/(?:\+?84|0)(?:[\s.-]*\d){9}\b/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length < 18) return false;

  const locationMarkers = [
    /\b(dia chi|dc|so nha|sn|thon|xom|ap|ban|duong|ngo|ngach|hem|to dan pho|tdp)\b/u,
    /\b(xa|phuong|thi tran|tt)\b/u,
    /\b(huyen|quan|thi xa|thanh pho|tp)\b/u,
    /\b(tinh)\b/u
  ];
  const markerCount = locationMarkers.filter((pattern) => pattern.test(normalized)).length;
  if (markerCount >= 2) return true;
  if (/\bdc\b/u.test(normalized) && normalized.length >= 25) return true;

  const commaParts = String(line).split(/[,\n]/u).map((part) => part.trim()).filter(Boolean);
  return normalized.length >= 35 && commaParts.length >= 2;
}

function extractMatchingLines(text, pattern) {
  return String(text || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => pattern.test(line))
    .slice(-3);
}

function hasOrderIntent(text) {
  return /(chốt|chot|đặt|dat|lấy|lay|gửi|gui|ship|cod|lên đơn|len don|cho (em|anh|chị|chi|mình|minh|tôi|toi)|mua)/iu.test(normalizeSearchText(text));
}

function hasExplicitPurchaseSignal(text) {
  return /(chốt|chot|đặt|dat|lấy|lay|lên đơn|len don|mua|cho (em|anh|chị|chi|mình|minh|tôi|toi)\s+\d+)/iu.test(normalizeSearchText(text));
}

function hasNewOrderSignal(text) {
  const value = String(text || "");
  if (!value.trim()) return false;
  return hasOrderIntent(value) ||
    extractPhones(value).length > 0 ||
    extractAddressLines(value).length > 0 ||
    (extractProducts(value).length > 0 && extractMatchingLines(value, /(\d+)\s*(túi|tui|can|l|lit|lít|chai|bình|binh)\b/iu).length > 0);
}

function hasPostFulfillmentSignal(text) {
  const normalized = normalizeSearchText(text);
  return /\b(da nhan hang|nhan duoc hang|nhan hang roi|hang da giao|giao thanh cong|da giao hang|da ve toi|hang ve roi|u?ong ngon|ruou ngon|anh em uong|dung thu thay|cam on shop|thanks shop|thank shop)\b/u.test(normalized);
}

function hasManualAcceptanceSignal(text) {
  const normalized = normalizeSearchText(text);
  return /\b(nhan thong tin|da nhan thong tin|cam on.*ung ho|gui don|len hang|chot don|xac nhan don|nhan don)\b/u.test(normalized);
}

function isRequestingMissingOrderInfo(text) {
  const normalized = normalizeSearchText(text);
  return /(cho em xin them|xin them|gui giup em|bo sung giup em|con thieu|chua du|chua co).*(so dien thoai|sdt|dien thoai|dia chi|thon|xom|xa|phuong|huyen|quan|tinh|thanh pho|tp)/u.test(normalized) ||
    /(so dien thoai|sdt|dien thoai|dia chi|thon|xom|xa|phuong|huyen|quan|tinh|thanh pho|tp).*(cho em xin them|xin them|gui giup em|bo sung giup em|con thieu|chua du|chua co)/u.test(normalized);
}

function hasPageConfirmation(text) {
  return /(chốt đơn|chot don|lên đơn|len don|xác nhận đơn|xac nhan don|đã chốt|da chot|đã lên đơn|da len don|đơn của anh|don cua anh|đơn của chị|don cua chi)/iu.test(normalizeSearchText(text));
}

function estimateOrderTotal(quantityLines) {
  const text = quantityLines.find(Boolean) || "";
  const match = String(text).match(/\b(\d+)\s*(túi|tui|can)\b/iu);
  if (!match) return 0;
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const unit = normalizeSearchText(match[2]);
  if (unit === "can") return amount * 1200000;
  return amount * 330000 + (amount === 1 ? 20000 : 0);
}

function formatVnd(amount) {
  return `${new Intl.NumberFormat("vi-VN").format(amount)}đ`;
}

function normalizePhone(phone) {
  return String(phone || "").replace(/[^\d+]/gu, "").replace(/^\+84/u, "0");
}

function getCustomerName(pageId, conversation, customerMessages) {
  const participants = conversation.participants?.data || [];
  const customer = participants.find((participant) =>
    participant?.id && String(participant.id) !== String(pageId)
  );
  return customer?.name || customerMessages.find((message) => message?.from?.name)?.from?.name || "";
}

async function getPageName(pageId, pageAccessToken) {
  if (!pageAccessToken) return pageNameFallbacks.get(pageId) || "Page";
  try {
    const url = new URL(`https://graph.facebook.com/${config.graphVersion}/${pageId}`);
    url.searchParams.set("fields", "name");
    url.searchParams.set("access_token", pageAccessToken);
    const body = await fetchJson(url);
    return body.name || pageNameFallbacks.get(pageId) || "Page";
  } catch {
    return pageNameFallbacks.get(pageId) || "Page";
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Meta HTTP ${response.status}: ${bodyText.slice(0, 220)}`);
  }
  return JSON.parse(bodyText);
}

function getReportWindow() {
  const now = new Date();
  const parts = getZonedParts(now, config.timezone);
  const todayLocalDate = `${parts.year}-${parts.month}-${parts.day}`;
  const previousDay = addDaysLocalDate(parts, -1);
  const windowName = resolveSummaryWindow(parts);
  const startLocal = windowName === "13-21"
    ? `${todayLocalDate}T13:00:00`
    : `${previousDay}T21:00:00`;
  const endLocal = windowName === "13-21"
    ? `${todayLocalDate}T21:00:00`
    : `${todayLocalDate}T13:00:00`;
  const startDate = zonedTimeToUtc(startLocal, config.timezone);
  const endTargetDate = zonedTimeToUtc(endLocal, config.timezone);
  let endDate = endTargetDate;
  if (now < endDate) endDate = now;
  const targetEndHour = windowName === "13-21" ? "21h" : "13h";
  const endLabel = endDate.getTime() === endTargetDate.getTime()
    ? `${targetEndHour} ngày ${formatLocalDate(endDate)}`
    : `${formatTime(endDate.getTime()).replace(":", "h")}p ngày ${formatLocalDate(endDate)}`;
  return {
    start: startDate,
    end: endDate,
    label: `${windowName === "13-21" ? "13h" : "21h"} ngày ${formatLocalDate(startDate)} tới ${endLabel}`
  };
}

function resolveSummaryWindow(parts) {
  if (config.summaryWindow === "13-21" || config.summaryWindow === "21-13") {
    return config.summaryWindow;
  }

  const localMinute = Number(parts.hour) * 60 + Number(parts.minute);
  return localMinute >= 17 * 60 ? "13-21" : "21-13";
}

function addDaysLocalDate(parts, days) {
  const date = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + days));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function getZonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute };
}

function zonedTimeToUtc(localIso, timeZone) {
  const utcGuess = new Date(`${localIso}Z`);
  const offsetMs = getTimezoneOffsetMs(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - offsetMs);
}

function getTimezoneOffsetMs(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(parts.year, Number(parts.month) - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: config.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(timestamp));
}

function formatLocalDate(date) {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: config.timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(new Date(date));
}

function lastNonEmpty(lines) {
  return [...lines].reverse().find((line) => String(line || "").trim()) || "";
}

function trimLine(value) {
  const normalized = String(value || "").replace(/\s+/gu, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

function trimFieldValue(value) {
  return trimLine(value).replace(/\s+-$/u, "").trim();
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/đ/gu, "d")
    .replace(/Đ/gu, "D")
    .toLowerCase();
}

function getPageAccessToken(pageId) {
  if (pageId && config.pageAccessTokens.has(pageId)) return config.pageAccessTokens.get(pageId);
  return config.pageAccessToken;
}

function getConfiguredPageIds() {
  return [...config.pageAccessTokens.keys()];
}

function readPageAccessTokens() {
  const rawValues = [
    process.env.META_PAGE_ACCESS_TOKENS || "",
    process.env.META_PAGE_ACCESS_TOKENS_EXTRA || ""
  ];
  const tokens = new Map();
  for (const rawValue of rawValues) {
    for (const pair of rawValue.split(",")) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const equalsIndex = trimmed.indexOf("=");
      if (equalsIndex <= 0) continue;
      const pageId = trimmed.slice(0, equalsIndex).trim();
      const token = trimmed.slice(equalsIndex + 1).trim();
      if (pageId && token) tokens.set(pageId, token);
    }
  }
  return tokens;
}

function readIntEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) ? value : fallback;
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
