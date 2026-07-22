import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize, sep } from "node:path";
import {
  initOrderReporter,
  processOrderNotification,
  isOrderNotified,
  markOrderNotified,
  mergeNotifiedKeys,
  formatTelegramReport,
  detectOrder,
  hasPageConfirmedOrder,
  isOrderConfirmationMessage as isOrderConfirmationPageMessageFromReporter,
  extractOrderNotifyProduct as extractOrderNotifyProductFromReporter,
  getOrderContactKey as getOrderContactKeyFromReporter,
  getOrderNotificationKey as getOrderNotificationKeyFromReporter,
  processPendingLeadNotification,
  sendDuePendingLeads
} from "./order-reporter.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workspaceDir = dirname(__dirname);
loadDotEnv(join(__dirname, ".env"));

const profileCache = new Map();
const messengerPollStatePath = join(__dirname, "poll-state.json");
let messengerPollState = readMessengerPollState();
let messengerPollRunning = false;
let messengerMainPollRunning = false;
let commentPollRunning = false;
const commentPollWarnings = new Map();
const activeMessengerSenders = new Set();
let openclawUnavailableUntil = 0;

const config = {
  port: readIntEnv("PORT", 3020),
  webhookPath: process.env.PUBLIC_WEBHOOK_PATH || "/webhook",
  publicBaseUrl: stripTrailingSlash(process.env.PUBLIC_BASE_URL || "https://banmoc.tino.page"),
  assetPath: ensurePathPrefix(process.env.PUBLIC_ASSET_PATH || "/messenger-assets/"),
  verifyToken: process.env.META_VERIFY_TOKEN || "",
  pageAccessToken: process.env.META_PAGE_ACCESS_TOKEN || "",
  pageAccessTokens: readPageAccessTokens(),
  appSecret: process.env.META_APP_SECRET || "",
  graphVersion: process.env.META_GRAPH_API_VERSION || "v23.0",
  openclawBaseUrl: stripTrailingSlash(process.env.OPENCLAW_BASE_URL || "http://127.0.0.1:18789"),
  openclawAuthToken: process.env.OPENCLAW_AUTH_TOKEN || "",
  openclawModel: process.env.OPENCLAW_MODEL || "openclaw/default",
  openclawTransport: process.env.OPENCLAW_TRANSPORT || "auto",
  openclawCliBin: process.env.OPENCLAW_CLI_BIN || "openclaw",
  openclawCliTimeoutSeconds: readIntEnv("OPENCLAW_CLI_TIMEOUT_SECONDS", 180),
  visionEnabled: readBoolEnv("VISION_ENABLED", true),
  visionBaseUrl: stripTrailingSlash(process.env.VISION_BASE_URL || "http://127.0.0.1:20128/v1"),
  visionModel: process.env.VISION_MODEL || "openrouter/google/gemma-4-26b-a4b-it:free",
  visionTimeoutSeconds: readIntEnv("VISION_TIMEOUT_SECONDS", 45),
  visionMaxImageBytes: readIntEnv("VISION_MAX_IMAGE_BYTES", 5 * 1024 * 1024),
  hermesCliBin: process.env.HERMES_CLI_BIN || "/usr/local/bin/banmoc-hermes-hmbm",
  hermesCliTimeoutSeconds: readIntEnv("HERMES_CLI_TIMEOUT_SECONDS", 35),
  fastSalesReplyEnabled: readBoolEnv("FAST_SALES_REPLY_ENABLED", false),
  maxReplyChars: readIntEnv("MAX_REPLY_CHARS", 1900),
  shopPhone: normalizePhoneValue(process.env.BAN_MOC_HOTLINE || "0931989777"),
  orderNotifyEnabled: readBoolEnv("ORDER_NOTIFY_ENABLED", true),
  orderNotifyTelegramChatId: process.env.ORDER_NOTIFY_TELEGRAM_CHAT_ID || "",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || readOpenClawTelegramBotToken(),
  orderNotifyTimezone: process.env.ORDER_NOTIFY_TIMEZONE || "Asia/Ho_Chi_Minh",
  messengerPollFallbackEnabled: readBoolEnv("MESSENGER_POLL_FALLBACK_ENABLED", false),
  messengerPollMainPageId: process.env.MESSENGER_POLL_MAIN_PAGE_ID || "625538103984936",
  messengerPollMainIntervalSeconds: readIntEnv("MESSENGER_POLL_MAIN_INTERVAL_SECONDS", 10),
  messengerPollMainLookbackSeconds: readIntEnv("MESSENGER_POLL_MAIN_LOOKBACK_SECONDS", 7200),
  messengerPollIntervalSeconds: readIntEnv("MESSENGER_POLL_INTERVAL_SECONDS", 30),
  messengerPollLookbackSeconds: readIntEnv("MESSENGER_POLL_LOOKBACK_SECONDS", 3600),
  messengerPollMinMessageAgeSeconds: readIntEnv("MESSENGER_POLL_MIN_MESSAGE_AGE_SECONDS", 20),
  messengerReplyMinCustomerAgeSeconds: readIntEnv("MESSENGER_REPLY_MIN_CUSTOMER_AGE_SECONDS", 45),
  messengerPollMaxConversations: readIntEnv("MESSENGER_POLL_MAX_CONVERSATIONS", 20),
  adminPauseMinutes: readIntEnv("ADMIN_PAUSE_MINUTES", 5),
  salesFollowUpEnabled: readBoolEnv("SALES_FOLLOW_UP_ENABLED", true),
  salesFollowUpDelayMinutes: readIntEnv("SALES_FOLLOW_UP_DELAY_MINUTES", 30),
  commentPollFallbackEnabled: readBoolEnv("COMMENT_POLL_FALLBACK_ENABLED", false),
  commentPollIntervalSeconds: readIntEnv("COMMENT_POLL_INTERVAL_SECONDS", 60),
  commentPollLookbackSeconds: readIntEnv("COMMENT_POLL_LOOKBACK_SECONDS", 86400),
  commentPollMaxPosts: readIntEnv("COMMENT_POLL_MAX_POSTS", 10),
  commentPollMaxCommentsPerPost: readIntEnv("COMMENT_POLL_MAX_COMMENTS_PER_POST", 25),
  systemPrompt: readPrompt()
};

// Init order-reporter with shared config
initOrderReporter({
  orderNotifyEnabled: config.orderNotifyEnabled,
  orderNotifyTelegramChatId: config.orderNotifyTelegramChatId,
  telegramBotToken: config.telegramBotToken,
  orderNotifyTimezone: config.orderNotifyTimezone,
  shopPhone: config.shopPhone
});

// Migrate existing notified orders from poll-state.json to order-state.json
mergeNotifiedKeys(messengerPollState.notifiedOrders || {}, messengerPollState.notifiedOrderContacts || {});

const publicDir = join(__dirname, "public");
const landingDir = join(workspaceDir, "ban-moc-landing");
const pageNameFallbacks = new Map([
  ["625538103984936", "BẢN MỘC"],
  ["560889237118933", "Bản Mộc - Hương Vị Tây Bắc"],
  ["109923292016675", "Bản Mộc - Chuẩn Vị Tây Bắc"],
  ["606774605862174", "Bản Mộc - Đặc Sản Tây Bắc"]
]);
const productMediaRules = [
  {
    name: "ruou-giay-to",
    matches: [
      "giay to ruou",
      "giay to",
      "giay to ve ruou",
      "giay to lien quan den ruou",
      "giay to lien quan toi ruou",
      "giay to lien quan den san pham",
      "giay to lien quan toi san pham",
      "giay to lien quan den sp",
      "giay to lien quan toi sp",
      "giay phep ruou",
      "giay phep",
      "giay phep san xuat ruou",
      "giay chung nhan ruou",
      "giay chung nhan",
      "chung nhan an toan thuc pham",
      "chung nhan",
      "an toan thuc pham",
      "dang ky kinh doanh",
      "kiem dinh",
      "kiem nghiem",
      "phieu kiem nghiem",
      "phieu ket qua thu nghiem",
      "ket qua thu nghiem",
      "test report",
      "phap ly",
      "hop phap",
      "co giay to khong",
      "co giay phep khong",
      "co chung nhan khong"
    ],
    imagePaths: [
      "ruou-giay-to-an-toan-thuc-pham.jpg",
      "ruou-giay-dang-ky-kinh-doanh.jpg",
      "ruou-giay-phep-san-xuat.jpg",
      "ruou-giay-kiem-nghiem-ngo-men-la.jpg"
    ]
  },
  {
    name: "can-20l-packaging",
    matches: ["quy cach dong goi", "dong goi can", "dong can", "can 20l", "can 20 l", "can 20 lit", "20l", "20 lit"],
    imagePaths: [
      "can-20l-packaging.jpg"
    ]
  },
  {
    name: "feedback-khach-hang",
    matches: [
      "feedback",
      "phan hoi khach",
      "khach danh gia",
      "danh gia cua khach",
      "khach nhan xet",
      "nhan xet cua khach",
      "co ai mua chua",
      "co khach nao mua chua",
      "co ngon khong",
      "co ngon ko",
      "co ngon k",
      "ruou ngon khong",
      "ruou ngon ko",
      "ruou ngon k",
      "uong ngon khong",
      "uong ngon ko",
      "uong ngon k",
      "chat luong khong",
      "chat luong ko",
      "chat luong k",
      "chat luong the nao",
      "co tot khong",
      "co tot ko",
      "co tot k",
      "dang phan van",
      "phan van",
      "co nen mua khong",
      "co nen mua ko",
      "co nen mua k",
      "mua thu co on khong",
      "mua thu co on ko",
      "mua thu co on k",
      "so khong ngon",
      "so ko ngon",
      "so k ngon",
      "so khong hop",
      "so ko hop",
      "so k hop"
    ],
    imagePaths: [
      "feedback-khach-hang-01.jpg",
      "feedback-khach-hang-02.jpg",
      "feedback-khach-hang-03.jpg",
      "feedback-khach-hang-04.jpg",
      "feedback-khach-hang-05.jpg",
      "feedback-khach-hang-06.jpg",
      "feedback-khach-hang-07.jpg",
      "feedback-khach-hang-08.jpg",
      "feedback-khach-hang-09.jpg",
      "feedback-khach-hang-10.jpg",
      "feedback-khach-hang-11.jpg",
      "feedback-khach-hang-12.jpg",
      "feedback-khach-hang-13.jpg",
      "feedback-khach-hang-14.jpg"
    ],
    maxImages: 4
  },
  {
    name: "anh-san-pham",
    matches: [
      "anh san pham",
      "hinh san pham",
      "hinh anh san pham",
      "cho xem anh",
      "cho xem hinh",
      "gui anh",
      "gui hinh",
      "xem anh",
      "xem hinh",
      "co anh khong",
      "co hinh khong"
    ],
    imagePaths: [
      "tam-giac-mach-product.jpg",
      "ngo-men-la-product.jpg"
    ]
  },
  {
    name: "tam-giac-mach",
    matches: [
      "tam giac mach",
      "ruou tam giac mach",
      "r tam giac mach",
      "tam giac moc",
      "ruou tam giac moc",
      "r tam giac moc"
    ],
    imagePaths: [
      "tam-giac-mach-product.jpg",
      "tam-giac-mach-ingredient.jpg"
    ]
  },
  {
    name: "ngo-men-la",
    matches: ["ngo men la", "ruou ngo men la", "ruou ngo"],
    imagePaths: [
      "ngo-men-la-product.jpg",
      "ngo-men-la-ingredient.jpg"
    ]
  }
];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        service: process.env.SERVICE_NAME || "messenger-openclaw-bridge",
        transport: config.openclawTransport
      });
    }

    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/privacy") {
      return sendHtml(res, 200, buildPrivacyPolicyHtml());
    }

    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/terms") {
      return sendHtml(res, 200, buildTermsHtml());
    }

    if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith(config.assetPath)) {
      return sendPublicAsset(url, res, req.method === "HEAD");
    }

    if ((req.method === "GET" || req.method === "HEAD") && (url.pathname === "/landing" || url.pathname.startsWith("/landing/"))) {
      return sendLandingAsset(url, res, req.method === "HEAD");
    }

    if (req.method === "GET" && url.pathname === config.webhookPath) {
      return handleWebhookVerify(url, res);
    }

    if (req.method === "POST" && url.pathname === config.webhookPath) {
      const rawBody = await readRequestBody(req);
      if (!verifyMetaSignature(req, rawBody)) {
        return sendJson(res, 403, { ok: false, error: "invalid_signature" });
      }

      sendJson(res, 200, { ok: true });
      processMessengerWebhook(rawBody).catch((error) => {
        console.error("[messenger] async processing failed:", error);
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      return sendText(res, 200, "Messenger OpenClaw bridge is running.\n");
    }

    sendJson(res, 404, { ok: false, error: "not_found" });
  } catch (error) {
    console.error("[server] request failed:", error);
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: "internal_error" });
    }
  }
});

if (!process.env.NODE_TEST_CONTEXT) {
  server.listen(config.port, () => {
    console.log(`Hermes HMBM Messenger bot listening on http://127.0.0.1:${config.port}`);
    console.log(`Webhook path: ${config.webhookPath}`);
    if (config.messengerPollFallbackEnabled) {
      startMessengerPollFallback();
    }
    if (config.commentPollFallbackEnabled) {
      startCommentPollFallback();
    }
  });
}

function handleWebhookVerify(url, res) {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token && token === config.verifyToken && challenge) {
    return sendText(res, 200, challenge);
  }

  return sendJson(res, 403, { ok: false, error: "verification_failed" });
}

async function processMessengerWebhook(rawBody) {
  const payload = JSON.parse(rawBody.toString("utf8"));
  if (payload.object !== "page") return;

  for (const entry of payload.entry || []) {
    for (const event of entry.messaging || []) {
      await handleMessengerEvent(event, entry.id);
    }
    for (const change of entry.changes || []) {
      await handlePageChange(change, entry.id);
    }
  }
}

async function handlePageChange(change, entryPageId) {
  if (change?.field !== "feed") return;

  const value = change.value || {};
  if (value.item !== "comment" || value.verb !== "add") return;

  const pageId = entryPageId || "";
  const commentId = value.comment_id || value.id || "";
  const text = typeof value.message === "string" ? value.message.trim() : "";
  const from = value.from || {};

  if (!pageId || !commentId || !text) return;
  if (from.id && String(from.id) === String(pageId)) return;

  const customerProfile = {
    id: from.id || "",
    name: from.name || "",
    firstName: "",
    lastName: "",
    gender: ""
  };

  try {
    const reply = await askOpenClaw(pageId, `comment:${commentId}`, customerProfile, text, {
      channel: "facebook-comment",
      sessionNamespace: "facebook-comment:v1",
      userMessage: buildOpenClawCommentMessage(pageId, commentId, value.post_id || "", customerProfile, text)
    });
    const normalizedReply = normalizeCustomerAddressing(reply, customerProfile);
    if (normalizedReply) {
      await sendFacebookCommentReply(pageId, commentId, normalizedReply);
    }
  } catch (error) {
    console.error("[facebook-comment] failed to reply:", error);
  }
}

async function handleMessengerEvent(event, entryPageId) {
  const message = event?.message;
  const isEcho = Boolean(message?.is_echo);
  const pageId = isEcho ? (entryPageId || event?.sender?.id || "") : (event?.recipient?.id || entryPageId || "");
  const senderId = isEcho ? event?.recipient?.id : event?.sender?.id;
  const messageId = message?.mid || "";

  if (!senderId || !message) return;
  if (isEcho) {
    handleMessengerEcho(event, pageId);
    return;
  }
  if (messageId && hasProcessedMessengerMessage(pageId, messageId)) {
    console.log(`[messenger] skipped duplicate message page=${pageId || "unknown"} sender=${senderId} mid=${messageId}`);
    return;
  }

  const text = typeof message.text === "string" ? message.text.trim() : "";

  // Facebook reactions (likes, hearts, etc.) — skip silently
  // Facebook may send reactions as:
  //   1. { reaction: {...} } object
  //   2. text emoji "👍"
  //   3. sticker attachment (type: "sticker" or like emoji sticker)
  const isReaction = Boolean(message?.reaction);
  const isReactionEmoji = !isReaction && text && /^[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{1F44D}\u{2764}\u{1F44F}\u{1F60D}\u{1F606}\u{1F62E}\u{1F622}\u{1F621}\u{1F620}\u{1F480}]+$/u.test(text) && text.length <= 4;
  const isReactionSticker = !isReaction && !isReactionEmoji && !text && (message?.attachments || []).some(
    (att) => att?.type === "sticker" || att?.type === "reaction" || String(att?.payload?.sticker_id || "").startsWith("3692")
  );
  if (isReaction || isReactionEmoji || isReactionSticker) {
    if (messageId) markMessengerMessageProcessed(pageId, messageId);
    console.log(`[messenger] skipped reaction/like page=${pageId || "unknown"} sender=${senderId}`);
    return;
  }

  const imageAttachments = getMessengerImageAttachments(message);
  if (!text && imageAttachments.length === 0) {
    if (messageId) markMessengerMessageProcessed(pageId, messageId);
    console.log(`[messenger] skipped non-text message page=${pageId || "unknown"} sender=${senderId} mid=${messageId || "unknown"}`);
    return;
  }
  clearPendingSalesFollowUp(pageId, senderId);
  const customerProfile = await getMessengerProfile(pageId, senderId);
  const imageDescriptions = await describeMessengerImageAttachments(pageId, senderId, imageAttachments);
  const effectiveText = buildMessengerEffectiveText(text, imageDescriptions);
  await maybeNotifyNewOrder(pageId, senderId, customerProfile, [
    { id: messageId, created_time: new Date(event.timestamp || Date.now()).toISOString(), from: { id: senderId }, message: effectiveText }
  ], {
    sourceMessageId: messageId,
    sourceAt: Number(event.timestamp || Date.now())
  }).catch((error) => {
    console.error(`[order-notify] webhook notification failed page=${pageId || "unknown"} sender=${senderId}:`, error);
  });

  if (isMessengerAdminPaused(pageId, senderId)) {
    if (messageId) markMessengerMessageProcessed(pageId, messageId);
    console.log(`[messenger] skipped admin-paused conversation page=${pageId || "unknown"} sender=${senderId}`);
    return;
  }

  const activeKey = getActiveMessengerSenderKey(pageId, senderId);
  if (activeMessengerSenders.has(activeKey)) {
    if (messageId) markMessengerMessageProcessed(pageId, messageId);
    console.log(`[messenger] skipped concurrent duplicate page=${pageId || "unknown"} sender=${senderId}`);
    return;
  }

  activeMessengerSenders.add(activeKey);
  if (messageId) markMessengerMessageProcessed(pageId, messageId);
  try {
    console.log(`[messenger] received ${imageAttachments.length ? "image/text" : "text"} page=${pageId || "unknown"} sender=${senderId} chars=${effectiveText.length} images=${imageAttachments.length}`);
    await safeSendSenderAction(pageId, senderId, "typing_on");
    const fallbackMessages = [
      { id: messageId, created_time: new Date(event.timestamp || Date.now()).toISOString(), from: { id: senderId }, message: effectiveText }
    ];
    const recentMessages = ensureCurrentMessengerMessageInHistory(
      await getRecentMessengerMessagesForUser(pageId, senderId, fallbackMessages),
      fallbackMessages[0]
    );
    const conversationHistory = formatMessengerConversationHistory(pageId, recentMessages);
    await maybeNotifyNewOrder(pageId, senderId, customerProfile, recentMessages, {
      sourceMessageId: messageId,
      sourceAt: Number(event.timestamp || Date.now())
    }).catch((error) => {
      console.error(`[order-notify] webhook history notification failed page=${pageId || "unknown"} sender=${senderId}:`, error);
    });
    const sourceAt = Number(event.timestamp || Date.now());
    if (await shouldSkipMessengerReplyBecausePageAnswered(pageId, senderId, sourceAt)) {
      console.log(`[messenger] skipped reply because page already answered page=${pageId || "unknown"} sender=${senderId}`);
      return;
    }
    const detectedOrder = detectNewOrderForNotification(pageId, senderId, customerProfile, recentMessages, {
      sourceAt,
      sourceMessageId: messageId
    });
    if (detectedOrder && shouldConfirmOrderDetailsFromCustomer(effectiveText, recentMessages, pageId)) {
      // Validate phone: if customer sent an invalid phone, ask again
      const phoneText = effectiveText.replace(/[\s.\-]/gu, "").trim();
      const looksLikePhone = /^\d{8,12}$/.test(phoneText) || /^0\d+$/.test(phoneText);
      if (looksLikePhone && phoneText.length !== 10) {
        const askPhoneAgain = `Dạ anh/chị cho em xin lại số điện thoại ạ. Số anh/chị vừa gửi có vẻ chưa đúng (cần đủ 10 số ạ).`;
        console.log(`[messenger] invalid phone detected, asking again page=${pageId || "unknown"} sender=${senderId}`);
        await safeSendMessengerText(pageId, senderId, askPhoneAgain, "messenger");
        return;
      }
      const confirmationReply = buildOrderDetailsConfirmationReply(detectedOrder, customerProfile);
      console.log(`[messenger] confirming detected order page=${pageId || "unknown"} sender=${senderId}`);
      await safeSendMessengerText(pageId, senderId, confirmationReply, "messenger");
      // Block product images for 5 min after order confirmation
      messengerPollState.lastOrderConfirmations = messengerPollState.lastOrderConfirmations || {};
      messengerPollState.lastOrderConfirmations[`order-confirm:${pageId || "unknown"}:${senderId}`] = Date.now();
      saveMessengerPollState();
      await maybeNotifyNewOrder(pageId, senderId, customerProfile, [
        ...recentMessages,
        { id: `bot-confirmed:${messageId}:${Date.now()}`, created_time: new Date().toISOString(), from: { id: pageId }, message: confirmationReply }
      ], { confirmed: true, sourceMessageId: messageId, sourceAt }).catch((error) => {
        console.error(`[messenger] order notification failed page=${pageId || "unknown"} sender=${senderId}:`, error?.message || error);
      });
      clearPendingSalesFollowUp(pageId, senderId);
      return;
    }
    const reply = await askOpenClaw(pageId, senderId, customerProfile, effectiveText, {
      conversationHistory
    });
    const normalizedReply = normalizeCustomerAddressing(reply, customerProfile) || "Minh chua co cau tra loi phu hop luc nay.";
    const safeReply = filterUnsafeReplyContent(normalizedReply, senderId, pageId);
    if (await shouldSkipMessengerReplyBecausePageAnswered(pageId, senderId, sourceAt)) {
      console.log(`[messenger] skipped sending OpenClaw reply because page answered during processing page=${pageId || "unknown"} sender=${senderId}`);
      return;
    }
    const sent = await safeSendMessengerText(pageId, senderId, safeReply, "messenger");
    if (sent) {
      recordMessengerBotSent(pageId, senderId, messageId || "", safeReply);
      console.log(`[messenger] sent OpenClaw reply page=${pageId || "unknown"} recipient=${senderId} chars=${safeReply.length}`);
      maybeScheduleSalesFollowUp(pageId, senderId, customerProfile, effectiveText, Date.now());
    }
  } catch (error) {
    console.error("[messenger] failed to reply:", error);
    if (isPermanentMessengerSendError(error)) {
      console.warn(`[messenger] not sending error fallback because recipient is unavailable page=${pageId || "unknown"} recipient=${senderId}`);
    } else {
      await safeSendMessengerText(pageId, senderId, "Xin loi, minh dang gap loi khi xu ly tin nhan nay.", "messenger");
    }
  } finally {
    activeMessengerSenders.delete(activeKey);
    await safeSendSenderAction(pageId, senderId, "typing_off").catch(() => {});
  }
}

function handleMessengerEcho(event, pageId) {
  const recipientId = event?.recipient?.id || "";
  const text = typeof event?.message?.text === "string" ? event.message.text.trim() : "";
  if (!pageId || !recipientId || !text) return;

  const sentAt = Number(event.timestamp || Date.now());
  if (isRecentBotSent(pageId, recipientId, sentAt)) {
    return;
  }

  markMessengerAdminPaused(pageId, recipientId, sentAt);
}

function startMessengerPollFallback() {
  const intervalMs = Math.max(config.messengerPollIntervalSeconds, 10) * 1000;
  const mainIntervalMs = Math.max(config.messengerPollMainIntervalSeconds, 5) * 1000;
  console.log(`[messenger-poll] fallback enabled interval=${Math.round(intervalMs / 1000)}s main=${Math.round(mainIntervalMs / 1000)}s`);
  setTimeout(() => {
    pollMainMessengerInboxFallback().catch((error) => {
      console.error("[messenger-poll] initial main poll failed:", error);
    });
    pollMessengerInboxFallback().catch((error) => {
      console.error("[messenger-poll] initial poll failed:", error);
    });
    processDueSalesFollowUps().catch((error) => {
      console.error("[sales-follow-up] initial check failed:", error);
    });
  }, 2000);
  setInterval(() => {
    pollMainMessengerInboxFallback().catch((error) => {
      console.error("[messenger-poll] main poll failed:", error);
    });
  }, mainIntervalMs);
  setInterval(() => {
    pollMessengerInboxFallback().catch((error) => {
      console.error("[messenger-poll] poll failed:", error);
    });
    processDueSalesFollowUps().catch((error) => {
      console.error("[sales-follow-up] check failed:", error);
    });
  }, intervalMs);
}

function startCommentPollFallback() {
  const intervalMs = Math.max(config.commentPollIntervalSeconds, 30) * 1000;
  console.log(`[facebook-comment-poll] fallback enabled interval=${Math.round(intervalMs / 1000)}s`);
  setTimeout(() => {
    pollFacebookCommentsFallback().catch((error) => {
      console.error("[facebook-comment-poll] initial poll failed:", error);
    });
  }, 4000);
  setInterval(() => {
    pollFacebookCommentsFallback().catch((error) => {
      console.error("[facebook-comment-poll] poll failed:", error);
    });
  }, intervalMs);
}

async function pollFacebookCommentsFallback() {
  if (commentPollRunning) return;
  commentPollRunning = true;
  try {
    for (const pageId of getConfiguredPageIds()) {
      await pollPageFeedComments(pageId);
    }
  } finally {
    commentPollRunning = false;
  }
}

async function pollPageFeedComments(pageId) {
  const pageAccessToken = getPageAccessToken(pageId);
  if (!pageId || !pageAccessToken) return;

  const url = new URL(`https://graph.facebook.com/${config.graphVersion}/${pageId}/feed`);
  const commentLimit = Math.max(1, config.commentPollMaxCommentsPerPost);
  url.searchParams.set(
    "fields",
    [
      "id",
      "created_time",
      `comments.order(reverse_chronological).limit(${commentLimit}){id,message,created_time,from,comments.order(reverse_chronological).limit(10){id,message,created_time,from}}`
    ].join(",")
  );
  url.searchParams.set("limit", String(Math.max(1, config.commentPollMaxPosts)));
  url.searchParams.set("access_token", pageAccessToken);

  const response = await fetch(url);
  const bodyText = await response.text();
  if (!response.ok) {
    warnCommentPoll(pageId, "feed lookup failed", `HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
    return;
  }

  const body = JSON.parse(bodyText);
  for (const post of body.data || []) {
    await processPolledPostComments(pageId, post);
  }
}

async function processPolledPostComments(pageId, post) {
  const comments = (post?.comments?.data || [])
    .filter((comment) => comment?.id && comment?.created_time)
    .sort((a, b) => new Date(a.created_time) - new Date(b.created_time));
  if (comments.length === 0) return;

  const now = Date.now();
  const lookbackMs = Math.max(config.commentPollLookbackSeconds, 300) * 1000;
  const minAgeMs = Math.max(config.messengerPollMinMessageAgeSeconds, 5) * 1000;

  for (const comment of comments) {
    const createdAt = new Date(comment.created_time).getTime();
    const text = typeof comment.message === "string" ? comment.message.trim() : "";
    const from = comment.from || {};
    if (!text || String(from.id || "") === String(pageId)) continue;
    if (now - createdAt > lookbackMs || now - createdAt < minAgeMs) continue;

    const stateKey = `${pageId}:${comment.id}`;
    if (messengerPollState.processedComments?.[stateKey]) continue;
    if (hasPageReplyAfterComment(pageId, comment, createdAt)) {
      markCommentProcessed(stateKey, createdAt);
      continue;
    }

    if (shouldSkipAutoReplyForClosingText(text)) {
      markCommentProcessed(stateKey, createdAt);
      console.log(`[facebook-comment-poll] skipped closing customer comment page=${pageId} comment=${comment.id}`);
      continue;
    }

    const customerProfile = {
      id: from.id || "",
      name: from.name || "",
      firstName: "",
      lastName: "",
      gender: ""
    };

    try {
      console.log(`[facebook-comment-poll] detected unreplied comment page=${pageId} comment=${comment.id}`);
      const reply = await askOpenClaw(pageId, `comment:${comment.id}`, customerProfile, text, {
        channel: "facebook-comment-poll",
        sessionNamespace: "facebook-comment:v1",
        userMessage: buildOpenClawCommentMessage(pageId, comment.id, post.id || "", customerProfile, text)
      });
      const normalizedReply = normalizeCustomerAddressing(reply, customerProfile);
      if (normalizedReply) {
        await sendFacebookCommentReply(pageId, comment.id, normalizedReply);
      }
      markCommentProcessed(stateKey, createdAt);
    } catch (error) {
      console.error(`[facebook-comment-poll] failed to reply page=${pageId} comment=${comment.id}:`, error);
    }
  }
}

function hasPageReplyAfterComment(pageId, comment, commentCreatedAt) {
  return (comment.comments?.data || []).some((reply) => {
    const replyCreatedAt = new Date(reply?.created_time || 0).getTime();
    return String(reply?.from?.id || "") === String(pageId) && replyCreatedAt >= commentCreatedAt;
  });
}

function markCommentProcessed(stateKey, createdAt) {
  messengerPollState.processedComments = messengerPollState.processedComments || {};
  messengerPollState.processedComments[stateKey] = createdAt || Date.now();
  saveMessengerPollState();
}

function warnCommentPoll(pageId, reason, detail) {
  const key = `${pageId}:${reason}`;
  const now = Date.now();
  const lastWarnedAt = commentPollWarnings.get(key) || 0;
  if (now - lastWarnedAt < 10 * 60 * 1000) return;
  commentPollWarnings.set(key, now);
  console.warn(`[facebook-comment-poll] ${reason} page=${pageId}: ${detail}`);
}

async function pollMessengerInboxFallback() {
  if (messengerPollRunning) return;
  messengerPollRunning = true;
  try {
    await pollConfiguredPagesInboxFallback(getConfiguredPageIds());
  } finally {
    messengerPollRunning = false;
  }
}

async function pollMainMessengerInboxFallback() {
  const pageId = config.messengerPollMainPageId;
  if (!pageId) return;

  if (messengerMainPollRunning) return;
  messengerMainPollRunning = true;
  try {
    await pollConfiguredPagesInboxFallback([pageId], {
      lookbackSeconds: config.messengerPollMainLookbackSeconds
    });
  } finally {
    messengerMainPollRunning = false;
  }
}

async function pollConfiguredPagesInboxFallback(pageIds, options = {}) {
  const uniquePageIds = [...new Set((pageIds || []).filter(Boolean))];
  for (const pageId of uniquePageIds) {
    await pollPageConversations(pageId, options);
  }
}

async function pollPageConversations(pageId, options = {}) {
  const pageAccessToken = getPageAccessToken(pageId);
  if (!pageId || !pageAccessToken) return;

  const url = new URL(`https://graph.facebook.com/${config.graphVersion}/${pageId}/conversations`);
  url.searchParams.set("fields", "id,updated_time,participants,messages.limit(10){id,created_time,from,to,message}");
  url.searchParams.set("limit", String(Math.max(1, config.messengerPollMaxConversations)));
  url.searchParams.set("access_token", pageAccessToken);

  const response = await fetch(url);
  const bodyText = await response.text();
  if (!response.ok) {
    console.warn(`[messenger-poll] conversations lookup failed page=${pageId}: HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
    return;
  }

  const body = JSON.parse(bodyText);
  for (const conversation of body.data || []) {
    await processPolledConversation(pageId, conversation, options);
  }
}

async function processPolledConversation(pageId, conversation, options = {}) {
  const conversationId = conversation?.id || "";
  if (!conversationId) return;

  const messages = (conversation.messages?.data || [])
    .filter((message) => message?.created_time)
    .sort((a, b) => new Date(a.created_time) - new Date(b.created_time));
  if (messages.length === 0) return;

  const now = Date.now();
  const lookbackMs = Math.max(Number(options.lookbackSeconds || config.messengerPollLookbackSeconds), 60) * 1000;
  const minAgeMs = Math.max(config.messengerPollMinMessageAgeSeconds, 5) * 1000;
  const recentCustomerMessages = messages.filter((message) => {
    const createdAt = new Date(message.created_time).getTime();
    const text = typeof message.message === "string" ? message.message.trim() : "";
    return (
      text &&
      String(message?.from?.id || "") !== String(pageId) &&
      now - createdAt <= lookbackMs
    );
  });
  const latestCustomerMessage = recentCustomerMessages.at(-1);
  const notificationCustomerProfile = latestCustomerMessage
    ? getPolledCustomerProfile(pageId, conversation, latestCustomerMessage)
    : null;
  if (notificationCustomerProfile?.id) {
    await maybeNotifyNewOrder(pageId, notificationCustomerProfile.id, notificationCustomerProfile, messages, {
      sourceMessageId: latestCustomerMessage.id || `${conversationId}:${new Date(latestCustomerMessage.created_time).getTime()}`,
      sourceAt: new Date(latestCustomerMessage.created_time).getTime()
    }).catch((error) => {
      console.error(`[order-notify] conversation scan notification failed page=${pageId || "unknown"} sender=${notificationCustomerProfile.id}:`, error);
    });
  }

  const lastPageMessageAt = Math.max(
    0,
    ...messages
      .filter((message) => String(message?.from?.id || "") === String(pageId))
      .map((message) => new Date(message.created_time).getTime())
  );
  const pendingCustomerMessages = messages.filter((message) => {
    const createdAt = new Date(message.created_time).getTime();
    const text = typeof message.message === "string" ? message.message.trim() : "";
    return (
      text &&
      String(message?.from?.id || "") !== String(pageId) &&
      createdAt >= lastPageMessageAt &&
      now - createdAt <= lookbackMs &&
      now - createdAt >= minAgeMs
    );
  });
  if (pendingCustomerMessages.length === 0) return;

  const latestMessage = pendingCustomerMessages[pendingCustomerMessages.length - 1];
  const latestMessageAt = new Date(latestMessage.created_time).getTime();
  const stateKey = `${pageId}:${conversationId}`;
  if ((messengerPollState.processedConversations?.[stateKey] || 0) >= latestMessageAt) {
    return;
  }

  const customerProfile = getPolledCustomerProfile(pageId, conversation, latestMessage);
  if (!customerProfile?.id) return;
  const activeKey = getActiveMessengerSenderKey(pageId, customerProfile.id);
  if (activeMessengerSenders.has(activeKey)) {
    console.log(`[messenger-poll] skipped active webhook reply page=${pageId} sender=${customerProfile.id}`);
    return;
  }
  activeMessengerSenders.add(activeKey);
  clearPendingSalesFollowUp(pageId, customerProfile.id);

  // Skip if bot already replied to this conversation recently (prevents duplicate poll replies)
  const lastBotSentAt = Number(
    messengerPollState.botSentMessages?.[getMessengerConversationKey(pageId, customerProfile.id)] || 0
  );
  if (lastBotSentAt >= latestMessageAt) {
    activeMessengerSenders.delete(activeKey);
    console.log(`[messenger-poll] skipped already-answered conversation page=${pageId} sender=${customerProfile.id}`);
    return;
  }

  const text = pendingCustomerMessages
    .map((message) => message.message.trim())
    .filter(Boolean)
    .join("\n");
  if (!text) {
    activeMessengerSenders.delete(activeKey);
    return;
  }
  if (isMessengerRetryDelayed(pageId, conversationId, customerProfile.id, latestMessageAt, now)) {
    activeMessengerSenders.delete(activeKey);
    console.log(`[messenger-poll] delayed retry page=${pageId} sender=${customerProfile.id}`);
    return;
  }

  messengerPollState.processedConversations = messengerPollState.processedConversations || {};
  messengerPollState.processedConversations[stateKey] = latestMessageAt;
  saveMessengerPollState();

  try {
    const detectedOrder = await maybeNotifyNewOrder(pageId, customerProfile.id, customerProfile, messages, {
      sourceMessageId: latestMessage.id || `${conversationId}:${latestMessageAt}`,
      sourceAt: latestMessageAt,
      sendNotification: false
    }).catch((error) => {
      console.error(`[order-notify] poll notification failed page=${pageId || "unknown"} sender=${customerProfile.id}:`, error);
      return null;
    });
    const lastManualPageMessageAt = getLastManualPageMessageAt(pageId, customerProfile.id, messages);
    if (lastManualPageMessageAt > 0) {
      markMessengerAdminPaused(pageId, customerProfile.id, lastManualPageMessageAt);
    }
    if (isMessengerAdminPaused(pageId, customerProfile.id, now)) {
      console.log(`[messenger-poll] skipped admin-paused conversation page=${pageId} sender=${customerProfile.id}`);
      return;
    }
    if (shouldSkipAutoReplyForClosingText(text)) {
      console.log(`[messenger-poll] skipped closing customer text page=${pageId} sender=${customerProfile.id}`);
      return;
    }
    if (detectedOrder && shouldConfirmOrderDetailsFromCustomer(text, messages, pageId)) {
      // Validate phone: if customer sent an invalid phone, ask again
      const phoneText = text.replace(/[\s.\-]/gu, "").trim();
      const looksLikePhone = /^\d{8,12}$/.test(phoneText) || /^0\d+$/.test(phoneText);
      if (looksLikePhone && phoneText.length !== 10) {
        const askPhoneAgain = `Dạ anh/chị cho em xin lại số điện thoại ạ. Số anh/chị vừa gửi có vẻ chưa đúng (cần đủ 10 số ạ).`;
        console.log(`[messenger-poll] invalid phone detected, asking again page=${pageId} sender=${customerProfile.id}`);
        await safeSendMessengerText(pageId, customerProfile.id, askPhoneAgain, "messenger-poll");
        return;
      }
      const confirmationReply = buildOrderDetailsConfirmationReply(detectedOrder, customerProfile);
      console.log(`[messenger-poll] confirming detected order page=${pageId} sender=${customerProfile.id}`);
      await sendSenderAction(pageId, customerProfile.id, "typing_on").catch(() => {});
      // Block product images for 5 min after order confirmation
      messengerPollState.lastOrderConfirmations = messengerPollState.lastOrderConfirmations || {};
      messengerPollState.lastOrderConfirmations[`order-confirm:${pageId}:${customerProfile.id}`] = Date.now();
      saveMessengerPollState();
      if (await shouldSkipMessengerReplyBecausePageAnswered(pageId, customerProfile.id, latestMessageAt)) {
        console.log(`[messenger-poll] skipped sending order confirmation because page answered during processing page=${pageId} sender=${customerProfile.id}`);
        return;
      }
      await sendMessengerText(pageId, customerProfile.id, confirmationReply);
      await maybeNotifyNewOrder(pageId, customerProfile.id, customerProfile, [
        ...messages,
        {
          id: `bot-confirmed:${conversationId}:${Date.now()}`,
          created_time: new Date().toISOString(),
          from: { id: pageId },
          message: confirmationReply
        }
      ], {
        confirmed: true,
        sourceMessageId: latestMessage.id || `${conversationId}:${latestMessageAt}`,
        sourceAt: latestMessageAt
      }).catch((error) => {
        console.error(`[order-notify] confirmed poll notification failed page=${pageId || "unknown"} sender=${customerProfile.id}:`, error);
      });
      clearPendingMessengerRetry(pageId, conversationId, customerProfile.id);
      clearPendingSalesFollowUp(pageId, customerProfile.id);
      console.log(`[messenger-poll] sent order confirmation page=${pageId} recipient=${customerProfile.id}`);
      return;
    }
    console.log(`[messenger-poll] detected unreplied customer text page=${pageId} sender=${customerProfile.id} messages=${pendingCustomerMessages.length}`);
    await sendSenderAction(pageId, customerProfile.id, "typing_on").catch(() => {});
    const reply = await askOpenClaw(pageId, customerProfile.id, customerProfile, text, {
      channel: "facebook-messenger-poll",
      conversationHistory: formatMessengerConversationHistory(pageId, messages)
    });
    const normalizedReply = normalizeCustomerAddressing(reply, customerProfile) || "Minh chua co cau tra loi phu hop luc nay.";
    const safeReply = filterUnsafeReplyContent(normalizedReply, customerProfile.id, pageId);
    if (await shouldSkipMessengerReplyBecausePageAnswered(pageId, customerProfile.id, latestMessageAt)) {
      console.log(`[messenger-poll] skipped sending OpenClaw reply because page answered during processing page=${pageId} sender=${customerProfile.id}`);
      return;
    }
    await sendMessengerText(pageId, customerProfile.id, safeReply);
    await sendProductMediaForMessage(pageId, customerProfile.id, text);
    maybeScheduleSalesFollowUp(pageId, customerProfile.id, customerProfile, text, latestMessageAt);
    clearPendingMessengerRetry(pageId, conversationId, customerProfile.id);
    console.log(`[messenger-poll] sent fallback OpenClaw reply page=${pageId} recipient=${customerProfile.id} chars=${safeReply.length}`);
  } catch (error) {
    const isPermanentSendFailure = isPermanentMessengerSendError(error);
    if (!isPermanentSendFailure && messengerPollState.processedConversations?.[stateKey] === latestMessageAt) {
      delete messengerPollState.processedConversations[stateKey];
      saveMessengerPollState();
    }
    recordPendingMessengerRetry(pageId, conversationId, customerProfile.id, latestMessageAt, error);
    console.error(`[messenger-poll] failed to reply page=${pageId} conversation=${conversationId}:`, error);
  } finally {
    activeMessengerSenders.delete(activeKey);
    await sendSenderAction(pageId, customerProfile.id, "typing_off").catch(() => {});
  }
}

function getActiveMessengerSenderKey(pageId, senderId) {
  return `${pageId || "unknown"}:${senderId}`;
}

function getMessengerConversationKey(pageId, recipientId) {
  return `${pageId || "unknown"}:${recipientId}`;
}

function getAdminPauseMs() {
  return Math.max(config.adminPauseMinutes, 1) * 60 * 1000;
}

function markMessengerAdminPaused(pageId, recipientId, sourceAt = Date.now()) {
  const pauseUntil = Number(sourceAt || Date.now()) + getAdminPauseMs();
  if (pauseUntil <= Date.now()) return;

  messengerPollState.adminPauses = messengerPollState.adminPauses || {};
  messengerPollState.adminPauses[getMessengerConversationKey(pageId, recipientId)] = {
    sourceAt: Number(sourceAt || Date.now()),
    pauseUntil
  };
  clearPendingSalesFollowUp(pageId, recipientId);
  saveMessengerPollState();
  console.log(`[messenger] admin pause page=${pageId || "unknown"} recipient=${recipientId} until=${new Date(pauseUntil).toISOString()}`);
}

function isMessengerAdminPaused(pageId, recipientId, now = Date.now()) {
  const key = getMessengerConversationKey(pageId, recipientId);
  const pause = messengerPollState.adminPauses?.[key];
  if (!pause) return false;

  if (Number(pause.pauseUntil || 0) > now) return true;

  delete messengerPollState.adminPauses[key];
  saveMessengerPollState();
  return false;
}

function recordMessengerBotSent(pageId, recipientId, sentAt = Date.now()) {
  messengerPollState.botSentMessages = messengerPollState.botSentMessages || {};
  messengerPollState.botSentMessages[getMessengerConversationKey(pageId, recipientId)] = Number(sentAt || Date.now());
  saveMessengerPollState();
}

function getMessengerRetryKey(pageId, conversationId, recipientId) {
  return `${pageId || "unknown"}:${conversationId || "unknown"}:${recipientId || "unknown"}`;
}

function isMessengerRetryDelayed(pageId, conversationId, recipientId, latestMessageAt, now = Date.now()) {
  const retry = messengerPollState.pendingMessengerRetries?.[getMessengerRetryKey(pageId, conversationId, recipientId)];
  if (!retry) return false;
  if (Number(retry.latestMessageAt || 0) !== Number(latestMessageAt || 0)) {
    clearPendingMessengerRetry(pageId, conversationId, recipientId);
    return false;
  }
  return Number(retry.nextAttemptAt || 0) > now;
}

function recordPendingMessengerRetry(pageId, conversationId, recipientId, latestMessageAt, error) {
  if (isPermanentMessengerSendError(error)) {
    clearPendingMessengerRetry(pageId, conversationId, recipientId);
    console.warn(`[messenger-poll] not retrying permanent Messenger send error page=${pageId} recipient=${recipientId}: ${String(error?.message || error || "").slice(0, 220)}`);
    return;
  }

  messengerPollState.pendingMessengerRetries = messengerPollState.pendingMessengerRetries || {};
  const key = getMessengerRetryKey(pageId, conversationId, recipientId);
  const previous = messengerPollState.pendingMessengerRetries[key] || {};
  const attempts = Number(previous.attempts || 0) + 1;
  const delaysMinutes = isTransientOpenClawError(error)
    ? [0.25, 0.5, 1, 2, 5]
    : [1, 2, 5, 10, 15, 30];
  const delayMinutes = delaysMinutes[Math.min(attempts - 1, delaysMinutes.length - 1)];
  const nextAttemptAt = Date.now() + delayMinutes * 60 * 1000;
  messengerPollState.pendingMessengerRetries[key] = {
    pageId,
    conversationId,
    recipientId,
    latestMessageAt,
    attempts,
    nextAttemptAt,
    lastErrorAt: Date.now(),
    lastError: String(error?.message || error || "").slice(0, 300)
  };
  saveMessengerPollState();
  console.warn(`[messenger-poll] retry scheduled page=${pageId} recipient=${recipientId} attempts=${attempts} next=${new Date(nextAttemptAt).toISOString()}`);
}

function isPermanentMessengerSendError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("messenger send api http 400") &&
    (message.includes("\"code\":551") ||
      message.includes("error_subcode\":1545041") ||
      message.includes("người này hiện không có mặt"))
  );
}

function isUnsupportedMessengerProfileLookup(errorOrBody) {
  const message = String(errorOrBody?.message || errorOrBody || "").toLowerCase();
  return (
    message.includes("unsupported get request") ||
    message.includes("graphmethodexception") ||
    message.includes("object with id") ||
    message.includes("missing permissions")
  );
}

async function safeSendSenderAction(pageId, recipientId, senderAction) {
  try {
    await sendSenderAction(pageId, recipientId, senderAction);
  } catch (error) {
    if (isPermanentMessengerSendError(error)) {
      console.warn(`[messenger] skipped sender_action=${senderAction} because recipient is unavailable page=${pageId || "unknown"} recipient=${recipientId}`);
      return false;
    }
    throw error;
  }
}

async function safeSendMessengerText(pageId, recipientId, text, context = "messenger") {
  try {
    await sendMessengerText(pageId, recipientId, text);
    return true;
  } catch (error) {
    if (isPermanentMessengerSendError(error)) {
      console.warn(`[${context}] skipped text reply because recipient is unavailable page=${pageId || "unknown"} recipient=${recipientId}`);
      return false;
    }
    throw error;
  }
}

function isTransientOpenClawError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return [
    "gateway closed",
    "abnormal closure",
    "app-server connection closed",
    "connection closed before this turn finished",
    "could not determine a reset time",
    "usage limit",
    "billing error",
    "rate_limit",
    "timeout"
  ].some((needle) => message.includes(needle));
}

function clearPendingMessengerRetry(pageId, conversationId, recipientId) {
  const retries = messengerPollState.pendingMessengerRetries;
  if (!retries || typeof retries !== "object") return;
  const key = getMessengerRetryKey(pageId, conversationId, recipientId);
  if (!retries[key]) return;
  delete retries[key];
  saveMessengerPollState();
}

function isRecentBotSent(pageId, recipientId, compareAt = Date.now()) {
  const sentAt = Number(messengerPollState.botSentMessages?.[getMessengerConversationKey(pageId, recipientId)] || 0);
  if (!sentAt) return false;

  const toleranceMs = 2 * 60 * 1000;
  return Math.abs(Number(compareAt || Date.now()) - sentAt) <= toleranceMs || Date.now() - sentAt <= toleranceMs;
}

function getLastManualPageMessageAt(pageId, recipientId, messages) {
  const cutoff = Date.now() - getAdminPauseMs();
  return Math.max(
    0,
    ...messages
      .filter((message) => String(message?.from?.id || "") === String(pageId))
      .filter((message) => !isMetaAutoPageMessage(message?.message || ""))
      .map((message) => new Date(message.created_time).getTime())
      .filter((createdAt) => createdAt >= cutoff)
  );
}

function isMetaAutoPageMessage(text) {
  const normalized = normalizeSearchText(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return false;

  return (
    normalized.includes("da tra loi mot quang cao") ||
    /^chao\s+\S+.*chung toi co the giup gi cho ban$/u.test(normalized) ||
    /^chao\s+\S+.*ban dang tim ruou tam giac mach ha giang chuan vi$/u.test(normalized) ||
    /^ruou tam giac mach men la co nong do tu 25\s*28 do$/u.test(normalized) ||
    /^ruou tam giac mach.*\b25\s*28 do\b/u.test(normalized) ||
    /^ruou duoc nau tu hat tam giac mach.*men la rung truyen thong.*chung cat thu cong/u.test(normalized) ||
    /^ruou ngo.*\b27\s*30 do\b/u.test(normalized)
  );
}

function getPolledCustomerProfile(pageId, conversation, latestMessage) {
  const customerId = latestMessage?.from?.id || "";
  const participants = conversation.participants?.data || [];
  const customer = participants.find((participant) =>
    participant?.id && String(participant.id) === String(customerId)
  ) || participants.find((participant) =>
    participant?.id && String(participant.id) !== String(pageId)
  );

  const name = customer?.name || latestMessage?.from?.name || "";
  return {
    id: customerId || customer?.id || "",
    name,
    firstName: "",
    lastName: "",
    gender: ""
  };
}

function shouldSkipAutoReplyForClosingText(text) {
  const normalized = normalizeSearchText(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return true;

  const closingTexts = new Set([
    "ok",
    "oke",
    "oki",
    "okay",
    "da",
    "vang",
    "uh",
    "um",
    "cam on",
    "cam on shop",
    "cam on ban",
    "thanks",
    "thank you",
    "tks",
    "duoc roi",
    "duoc a",
    "biet roi",
    "tam biet",
    "bye"
  ]);
  if (closingTexts.has(normalized)) return true;

  return [
    /^ok\s+(cam on|shop|ban|nhe|a)$/u,
    /^(da|vang)\s+(cam on|ok|duoc|nhe|a)$/u,
    /^(khong can|thoi|de minh xem|de toi xem|co gi minh lien he lai)$/u,
    /^(minh nhan duoc roi|da nhan duoc roi|nhan duoc roi)$/u
  ].some((pattern) => pattern.test(normalized));
}

async function maybeNotifyNewOrder(pageId, recipientId, customerProfile, messages, options = {}) {
  const result = await processOrderNotification(pageId, recipientId, customerProfile, messages, options);
  if (result.notified) {
    clearPendingSalesFollowUp(pageId, recipientId);
  }
  // Also check for pending leads (SĐT+địa chỉ but not chốt yet)
  if (!result.notified && result.order) {
    processPendingLeadNotification(pageId, recipientId, customerProfile, messages, options)
      .catch((error) => console.error(`[pending-lead] notify failed page=${pageId || "unknown"} sender=${recipientId}:`, error));
  }
  return result.order;
}

function hasConfirmedOrderMessageAfterCustomer(messages, pageId, customerSourceAt = 0) {
  return hasPageConfirmedOrder(messages, pageId, customerSourceAt);
}

function isOrderConfirmationPageMessage(text) {
  return isOrderConfirmationPageMessageFromReporter(text);
}

function detectNewOrderForNotification(pageId, recipientId, customerProfile, messages, options = {}) {
  const recentMessages = (messages || [])
    .filter((message) => message?.created_time && typeof message.message === "string")
    .sort((a, b) => new Date(a.created_time) - new Date(b.created_time))
    .slice(-12);
  const customerMessages = recentMessages
    .filter((message) => String(message?.from?.id || "") !== String(pageId));
  if (customerMessages.length === 0) return null;

  const allCustomerText = customerMessages.map((message) => message.message).join("\n");
  const allRecentText = recentMessages.map((message) => message.message).join("\n");

  // Only use RECENT customer messages for order detection (within last 10 minutes)
  // This prevents old order data from triggering false confirmations
  const tenMinAgo = Date.now() - 10 * 60 * 1000;
  const recentCustomerMessages = customerMessages.filter(
    (message) => new Date(message.created_time).getTime() >= tenMinAgo
  );
  const recentCustomerText = recentCustomerMessages.map((message) => message.message).join("\n");

  const phones = extractPhonesFromText(allCustomerText);
  const address = cleanOrderNotifyAddress(extractDetailedAddressLinesFromText(allCustomerText).at(-1) || "");
  const product = extractOrderNotifyProduct(allRecentText) || extractOrderNotifyProduct(allCustomerText);
  if (phones.length === 0 || !address || !product) return null;

  // Require at least ONE of phone/address to be from recent messages (not just old history)
  const phonesRecent = extractPhonesFromText(recentCustomerText);
  const addressRecent = cleanOrderNotifyAddress(extractDetailedAddressLinesFromText(recentCustomerText).at(-1) || "");
  if (phonesRecent.length === 0 && !addressRecent) return null;

  const sourceAt = Number(options.sourceAt || new Date(customerMessages.at(-1).created_time).getTime() || Date.now());
  const quantities = parseOrderNotifyQuantities(product);
  const quantity = quantities[0] || parseOrderNotifyQuantity(allCustomerText);
  const productAmount = estimateOrderNotifyProductAmount(quantities.length > 0 ? quantities : quantity);
  const shippingAmount = estimateOrderNotifyShippingAmount(quantities.length > 0 ? quantities : quantity, productAmount);
  const totalAmount = productAmount ? productAmount + shippingAmount : 0;

  return {
    pageId,
    pageName: pageNameFallbacks.get(String(pageId)) || `Page ${pageId || "unknown"}`,
    recipientId,
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

function shouldConfirmOrderDetailsFromCustomer(text, messages, pageId) {
  const customerText = String(text || "");

  // Customer is asking about EXISTING order — NOT a new order
  const normalizedCustomer = normalizeSearchText(customerText);
  const isOrderInquiry = [
    /\b(lau the|chua toi|chua nhan|chua thay|bao gio|khi nao|den noi|sao chua|van chua)\b/u,
    /\b(don hang|giao hang|ship)\s+(cua|anh|chi|em|minh)\b/u,
    /\b(hang|cua anh|cua chi)\s+(lau|chua|sao)\b/u,
  ].some((p) => p.test(normalizedCustomer));

  // Customer is complaining about delivery — treat as after-sales, not new order
  if (isOrderInquiry && normalizedCustomer.length < 100) {
    return false;
  }

  // DON'T re-confirm if we already confirmed for this customer recently (within 5 minutes)
  const senderId = messages?.[0]?.from?.id;
  const lastOrderConfirmKey = `order-confirm:${pageId || "unknown"}:${senderId || "unknown"}`;
  const lastOrderConfirmAt = Number(messengerPollState.lastOrderConfirmations?.[lastOrderConfirmKey] || 0);
  if (lastOrderConfirmAt && (Date.now() - lastOrderConfirmAt) < 5 * 60 * 1000) {
    return false;
  }
  const recentMessages = (messages || [])
    .filter((message) => message?.created_time && typeof message.message === "string")
    .sort((a, b) => new Date(a.created_time) - new Date(b.created_time))
    .slice(-10);

  // Also check recent CUSTOMER messages (not just current) for phone/address
  const recentCustomerMessages = recentMessages
    .filter((message) => String(message?.from?.id || "") !== String(pageId));
  const recentCustomerText = recentCustomerMessages
    .map((message) => message.message)
    .join("\n");

  const pageText = recentMessages
    .filter((message) => String(message?.from?.id || "") === String(pageId))
    .map((message) => message.message)
    .join("\n");
  const normalizedPage = normalizeSearchText(pageText)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  // Customer gave contact info in current message OR recent messages
  const customerGavePhone = extractPhonesFromText(customerText).length > 0 || extractPhonesFromText(recentCustomerText).length > 0;
  const customerGaveAddress = extractDetailedAddressLinesFromText(customerText).length > 0 || extractDetailedAddressLinesFromText(recentCustomerText).length > 0;
  const customerGaveContactDetails = customerGavePhone || customerGaveAddress;

  // Page asked for order details
  const pageAskedForOrderDetails = [
    /\b(cho em xin|xin so dien thoai|xin sdt|xin dia chi|dia chi nhan hang|sdt|so dien thoai)\b/u,
    /\b(len don|chot don|don 1|tong)\b/u
  ].some((pattern) => pattern.test(normalizedPage));

  // Fallback: if customer sent only a phone number (digit-only, 9-11 chars)
  // and page asked for phone in recent messages, treat as contact details
  const phoneOnlyText = customerText.replace(/[\s.\-]/gu, "").trim();
  const isPhoneOnly = /^\d{10}$/.test(phoneOnlyText);
  const pageAskedForPhone = /\b(so dien thoai|sdt|phone)\b/u.test(normalizedPage);
  if (!customerGaveContactDetails && isPhoneOnly && pageAskedForPhone) {
    return true;
  }

  return customerGaveContactDetails && pageAskedForOrderDetails;
}

function buildOrderDetailsConfirmationReply(order, customerProfile = {}) {
  const customerShortName = extractCustomerShortName(customerProfile);
  const greetingName = customerShortName ? `Anh ${customerShortName}` : "Anh/chị";
  const lines = [
    `Dạ em nhận được thông tin của ${greetingName} rồi ạ.`,
    "",
    `• Sản phẩm: ${order.product}`,
    `• SĐT: ${order.phone}`,
    `• Địa chỉ: ${order.address}`
  ];
  if (order.totalAmount) {
    lines.push(`• Tổng tiền: ${formatVnd(order.totalAmount)}`);
  }
  lines.push("");
  lines.push("Em chốt đơn và chuyển bộ phận đóng hàng/giao hàng cho mình nhé. Bên em lưu địa chỉ rõ để tránh thất lạc đơn và giúp đơn hàng được giao tới tay mình nhanh hơn ạ.");
  return lines.join("\n");
}

function getOrderNotificationKey(order) {
  return getOrderNotificationKeyFromReporter(order);
}

function getOrderNotificationContactKey(order) {
  return getOrderContactKeyFromReporter(order);
}

function formatOrderNotification(order) {
  return formatTelegramReport(order);
}

async function sendTelegramOrderNotification(text) {
  // Delegated to order-reporter; this wrapper kept for backward compatibility.
  // Direct callers should use processOrderNotification instead.
  const url = new URL(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: config.orderNotifyTelegramChatId,
      text,
      disable_web_page_preview: true
    })
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Telegram notify HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
  }
}

function extractOrderNotifyProduct(text) {
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
      return `${products.join(", ")} - ${formatOrderNotifyQuantity(quantity)}`;
    }
    return cleanOrderNotifyProduct(chosenLine);
  }

  const products = extractOrderNotifyProductNames(text);
  const quantity = parseOrderNotifyQuantity(text);
  if (products.length === 0) return "";
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

function extractOrderNotifyProductNames(text) {
  const normalized = normalizeSearchText(text);
  const products = [];
  if (/\b(ngo men la|ruou ngo)\b/u.test(normalized) || (/\bmen la\b/u.test(normalized) && !/\btam giac mach\b/u.test(normalized))) {
    products.push("rượu ngô men lá");
  }
  if (/\b(tam giac mach|tâm giac mach|mach)\b/u.test(normalized)) products.push("rượu tam giác mạch");
  if (/\bruou\b/u.test(normalized) && products.length === 0) products.push("rượu");
  return products;
}

function cleanOrderNotifyProduct(value) {
  return stripOrderNotifyLinePrefix(trimOrderNotifyText(value))
    .replace(/^(sản phẩm|san pham)\s*[:：-]\s*/iu, "")
    .replace(/\s+(sđt|sdt|số điện thoại|so dien thoai|địa chỉ|dia chi|đc|dc)\s*[:：].*$/iu, "")
    .trim();
}

function stripOrderNotifyLinePrefix(value) {
  return String(value || "").replace(/^[\s\-*•]+/u, "").trim();
}

function parseOrderNotifyQuantity(text) {
  const match = String(text || "").match(/\b(\d+)\s*(túi|tui|can|l|lit|lít)\b(?:\s*(\d+)\s*(l|lit|lít))?/iu);
  if (!match) return null;
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const rawUnit = normalizeSearchText(match[2]);
  let unit, adjustedAmount;
  if (rawUnit === "tui") {
    unit = "túi";
    adjustedAmount = amount;
  } else if (rawUnit === "can") {
    unit = "can";
    adjustedAmount = amount;
  } else {
    // "l", "lit", "lít" — normalize based on amount
    if (amount >= 20) {
      unit = "can";
      adjustedAmount = Math.round(amount / 20);
    } else if (amount === 5) {
      unit = "túi";
      adjustedAmount = 1;
    } else if (amount >= 10) {
      unit = "can";
      adjustedAmount = 1;
    } else {
      // small amount zl — unlikely, treat as túi
      unit = "túi";
      adjustedAmount = amount;
    }
  }
  const volume = match[3] ? `${match[3]}L` : unit === "túi" ? "5L" : unit === "can" ? "20L" : "";
  return { amount: adjustedAmount, unit, volume };
}

function parseOrderNotifyQuantities(text) {
  return String(text || "")
    .split(/\s*;\s*/u)
    .map((part) => parseOrderNotifyQuantity(part))
    .filter(Boolean);
}

function formatOrderNotifyQuantity(quantity) {
  return `${String(quantity.amount).padStart(2, "0")} ${quantity.unit}${quantity.volume ? ` ${quantity.volume}` : ""}`;
}

function estimateOrderNotifyProductAmount(quantityOrQuantities) {
  const quantities = Array.isArray(quantityOrQuantities) ? quantityOrQuantities : [quantityOrQuantities].filter(Boolean);
  if (quantities.length === 0) return 0;
  return quantities.reduce((total, quantity) => {
    if (quantity.unit === "can") return total + quantity.amount * 1200000;
    if (quantity.unit === "túi") return total + quantity.amount * 330000;
    return total;
  }, 0);
}

function estimateOrderNotifyShippingAmount(quantityOrQuantities, productAmount) {
  const quantities = Array.isArray(quantityOrQuantities) ? quantityOrQuantities : [quantityOrQuantities].filter(Boolean);
  if (quantities.length === 0 || !productAmount) return 0;
  const totalBags = quantities
    .filter((quantity) => quantity.unit === "túi")
    .reduce((total, quantity) => total + quantity.amount, 0);
  const hasOtherUnits = quantities.some((quantity) => quantity.unit !== "túi");
  if (!hasOtherUnits && totalBags === 1) return 20000;
  return 0;
}

function cleanOrderNotifyAddress(value) {
  let text = trimOrderNotifyText(value)
    .replace(/^(địa chỉ|dia chi|đc|dc)\s*[:：.]?\s*/iu, "")
    .replace(/(?:sđt|sdt|số điện thoại|so dien thoai|đt|dt)\s*[:：.]?\s*.*$/iu, "")
    .replace(/(?:\+?84|0)(?:[\s.-]*\d){9}\b/gu, "");
  text = text.replace(/\s*([,.])\s*/gu, "$1 ").replace(/[,.]\s*$/u, "").replace(/\s+/gu, " ").trim();
  return text;
}

function trimOrderNotifyText(value) {
  const normalized = String(value || "").replace(/\s+/gu, " ").trim();
  return normalized.length > 220 ? `${normalized.slice(0, 217).trim()}...` : normalized;
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

function maybeScheduleSalesFollowUp(pageId, recipientId, customerProfile, text, sourceMessageAt) {
  if (!config.salesFollowUpEnabled || !pageId || !recipientId) return;
  if (!shouldScheduleSalesFollowUpForText(text)) return;

  const delayMs = Math.max(config.salesFollowUpDelayMinutes, 1) * 60 * 1000;
  const key = getSalesFollowUpKey(pageId, recipientId);
  messengerPollState.pendingSalesFollowUps = messengerPollState.pendingSalesFollowUps || {};
  messengerPollState.pendingSalesFollowUps[key] = {
    pageId,
    recipientId,
    sourceMessageAt,
    scheduledAt: sourceMessageAt + delayMs,
    customerName: customerProfile?.name || "",
    customerFirstName: customerProfile?.firstName || ""
  };
  saveMessengerPollState();
  console.log(`[sales-follow-up] scheduled page=${pageId} recipient=${recipientId} delay=${Math.round(delayMs / 60000)}m`);
}

function shouldScheduleSalesFollowUpForText(text) {
  if (shouldSkipAutoReplyForClosingText(text)) return false;

  const normalized = normalizeSearchText(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return false;

  if (extractPhonesFromText(text).length > 0 && extractDetailedAddressLinesFromText(text).length > 0) {
    return false;
  }

  const mentionsProduct = /\b(ruou|ngo men la|tam giac mach|men la|can|tui|lit|l)\b/u.test(normalized);
  const buyingIntent = /\b(mua|dat|lay|chot|gui|ship|cod|len don|cho anh|cho chi|cho em|cho minh|cho toi|uong thu)\b/u.test(normalized);
  const hesitation = /\b(phan van|dang xem|de xem|can nhac|so|ngai|chua biet|co ngon|chat luong|co nen|mua thu|thu truoc)\b/u.test(normalized);

  return (mentionsProduct && buyingIntent) || (mentionsProduct && hesitation) || (buyingIntent && hesitation);
}

function clearPendingSalesFollowUp(pageId, recipientId) {
  const key = getSalesFollowUpKey(pageId, recipientId);
  if (!messengerPollState.pendingSalesFollowUps?.[key]) return;

  delete messengerPollState.pendingSalesFollowUps[key];
  saveMessengerPollState();
  console.log(`[sales-follow-up] cleared page=${pageId} recipient=${recipientId}`);
}

async function processDueSalesFollowUps() {
  if (!config.salesFollowUpEnabled) return;

  const pending = messengerPollState.pendingSalesFollowUps || {};
  const dueEntries = Object.entries(pending).filter(([, item]) => Number(item?.scheduledAt || 0) <= Date.now());
  for (const [key, item] of dueEntries) {
    try {
      const shouldSend = await shouldSendSalesFollowUp(item);
      if (shouldSend) {
        await sendMessengerText(item.pageId, item.recipientId, buildSalesFollowUpText(item));
        console.log(`[sales-follow-up] sent page=${item.pageId} recipient=${item.recipientId}`);
      } else {
        console.log(`[sales-follow-up] skipped page=${item.pageId} recipient=${item.recipientId}`);
      }
      delete messengerPollState.pendingSalesFollowUps[key];
      saveMessengerPollState();
    } catch (error) {
      console.error(`[sales-follow-up] failed page=${item?.pageId} recipient=${item?.recipientId}:`, error);
    }
  }
}

async function shouldSendSalesFollowUp(item) {
  if (!item?.pageId || !item?.recipientId || !item?.sourceMessageAt) return false;

  const conversation = await fetchRecentMessengerConversationForUser(item.pageId, item.recipientId);
  const messages = (conversation?.messages?.data || [])
    .filter((message) => message?.created_time)
    .sort((a, b) => new Date(a.created_time) - new Date(b.created_time));

  if (hasClosedOrderSignals(messages, item.pageId)) {
    return false;
  }

  const latestCustomerAt = Math.max(
    0,
    ...messages
      .filter((message) => String(message?.from?.id || "") !== String(item.pageId))
      .map((message) => new Date(message.created_time).getTime())
  );
  if (latestCustomerAt > Number(item.sourceMessageAt)) return false;

  const latestPageAt = Math.max(
    0,
    ...messages
      .filter((message) => String(message?.from?.id || "") === String(item.pageId))
      .map((message) => new Date(message.created_time).getTime())
  );
  return latestPageAt <= Number(item.sourceMessageAt) + 2 * 60 * 1000;
}

function hasClosedOrderSignals(messages, pageId) {
  const recentMessages = (messages || [])
    .filter((message) => typeof message?.message === "string")
    .slice(-20);
  if (recentMessages.length === 0) return false;

  const allText = recentMessages.map((message) => message.message).join("\n");
  const customerText = recentMessages
    .filter((message) => String(message?.from?.id || "") !== String(pageId))
    .map((message) => message.message)
    .join("\n");
  const pageText = recentMessages
    .filter((message) => String(message?.from?.id || "") === String(pageId))
    .map((message) => message.message)
    .join("\n");

  const normalizedAll = normalizeSearchText(allText)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const normalizedPage = normalizeSearchText(pageText)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  const hasCustomerOrderDetails =
    extractPhonesFromText(customerText).length > 0 &&
    extractOrderNotifyProduct(customerText) &&
    (extractDetailedAddressLinesFromText(customerText).length > 0 || hasCustomerAddressConfirmation(customerText));

  const pageConfirmedOrder = [
    /\b(cam on).{0,80}\b(tin tuong|ung ho)\b/u,
    /\b(trong luc cho nhan hang|cho nhan hang|don dang duoc xu ly)\b/u,
    /\b(da len don|len don xong|xac nhan don|chot don|da chot)\b/u,
    /\b(gui dung chat luong|don vi van chuyen|ma van don)\b/u
  ].some((pattern) => pattern.test(normalizedPage));

  const conversationClosed = [
    /\b(don da xac nhan|da xac nhan don|xac nhan don)\b/u,
    /\b(cu gui ve dia chi tren|dia chi tren dung|ship ve do duoc)\b/u
  ].some((pattern) => pattern.test(normalizedAll));

  return pageConfirmedOrder || conversationClosed || Boolean(hasCustomerOrderDetails && /\b(cam on|da|vang|ok|oke|gui|ship|chot|lay)\b/u.test(normalizedAll));
}

function hasCustomerAddressConfirmation(text) {
  const normalized = normalizeSearchText(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return false;
  return [
    /\b(dia chi tren dung|dung dia chi tren|cu gui ve dia chi tren)\b/u,
    /\b(ship ve do duoc|gui ve do duoc|nhan o do duoc)\b/u,
    /\b(dung roi|chinh xac roi|dia chi dung roi)\b/u
  ].some((pattern) => pattern.test(normalized));
}

async function fetchRecentMessengerConversationForUser(pageId, recipientId) {
  const pageAccessToken = getPageAccessToken(pageId);
  if (!pageAccessToken) throw new Error(`No Page Access Token configured for Page ID ${pageId}`);

  const url = new URL(`https://graph.facebook.com/${config.graphVersion}/${pageId}/conversations`);
  url.searchParams.set("user_id", recipientId);
  url.searchParams.set("fields", "id,messages.limit(10){id,created_time,from,message}");
  url.searchParams.set("access_token", pageAccessToken);

  const response = await fetch(url);
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Messenger conversation lookup HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
  }

  const body = JSON.parse(bodyText);
  return body.data?.[0] || null;
}

async function getRecentMessengerMessagesForUser(pageId, recipientId, fallbackMessages = []) {
  try {
    const conversation = await fetchRecentMessengerConversationForUser(pageId, recipientId);
    const messages = conversation?.messages?.data || [];
    return messages.length ? messages : fallbackMessages;
  } catch (error) {
    console.warn(`[messenger] conversation messages lookup failed page=${pageId || "unknown"} recipient=${recipientId}: ${error.message}`);
    return fallbackMessages;
  }
}

async function shouldSkipMessengerReplyBecausePageAnswered(pageId, recipientId, sourceAt) {
  if (!pageId || !recipientId || !sourceAt) return false;

  const minAgeMs = Math.max(config.messengerReplyMinCustomerAgeSeconds, 0) * 1000;
  const waitMs = minAgeMs - (Date.now() - Number(sourceAt));
  if (waitMs > 0) {
    await sleep(Math.min(waitMs, 90_000));
  }

  const conversation = await fetchRecentMessengerConversationForUser(pageId, recipientId);
  const sourceTime = Number(sourceAt);
  const pageReply = (conversation?.messages?.data || [])
    .filter((message) => String(message?.from?.id || "") === String(pageId))
    .filter((message) => !isMetaAutoPageMessage(message?.message || ""))
    .map((message) => ({
      ...message,
      createdAt: new Date(message.created_time).getTime()
    }))
    .find((message) => Number(message.createdAt || 0) > sourceTime + 1000);

  return Boolean(pageReply);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function buildSalesFollowUpText(item) {
  const customerShortName = extractCustomerShortName({
    name: item.customerName || "",
    firstName: item.customerFirstName || ""
  });
  const address = customerShortName ? `Anh ${customerShortName}` : "Anh/chị";
  return `${address} ơi, mình còn quan tâm rượu Bản Mộc không ạ? Nếu mình muốn lấy thử, em hỗ trợ chốt đơn luôn; anh/chị gửi giúp em SĐT, địa chỉ nhận hàng và sản phẩm/số lượng mình muốn lấy nhé.`;
}

function extractPhonesFromText(text) {
  const matches = String(text || "").match(/(?:\+?84|0)(?:[\s.-]*\d){9}\b/gu) || [];
  return [...new Set(matches.map(normalizePhoneValue).filter((phone) => phone && phone !== config.shopPhone))];
}

function extractDetailedAddressLinesFromText(text) {
  const addressPattern = /(địa chỉ|dia chi|dc|số nhà|so nha|sn|thôn|thon|xã|xa|huyện|huyen|tỉnh|tinh|tp|thành phố|phường|phuong|quận|quan|ấp|ap|bản|ban|đường|duong|ngõ|ngo|ngách|ngach|hẻm|hem|đà nẵng|da nang|hà nội|ha noi|hồ chí minh|ho chi minh|hải phòng|hai phong|cần thơ|can tho|thanh khê|thanh khe)/iu;
  return String(text || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && (addressPattern.test(line) || looksLikeStreetAddress(line)) && isDetailedAddressText(line) && !isPriceOrQuestionLine(line));
}

function isPriceOrQuestionLine(line) {
  const normalized = normalizeSearchText(line);
  return /\b(gia|giam|bao nhieu|tien|tong|thanh toan|chuyen khoan)\b/u.test(normalized)
    && !/\b(so nha|sn|thon|xom|ap|ban|duong|ngo|ngach|hem|xa|phuong|huyen|quan|tp|tinh)\b/u.test(normalized);
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

  const commaParts = String(line).split(/[,\n]/u).map((part) => part.trim()).filter(Boolean);
  return normalized.length >= 35 && commaParts.length >= 2;
}

function looksLikeStreetAddress(line) {
  const normalized = normalizeSearchText(line)
    .replace(/(?:\+?84|0)(?:[\s.-]*\d){9}\b/gu, " ")
    .replace(/[^\p{L}\p{N}/,\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length < 15) return false;
  const hasHouseNumber = /\b\d+[a-z]?(?:\/\d+[a-z]?)?\b/u.test(normalized);
  const commaParts = normalized.split(/[,]/u).map((part) => part.trim()).filter(Boolean);
  const hasKnownPlace = /\b(da nang|ha noi|ho chi minh|hai phong|can tho|thanh khe|cam le|ngu hanh son|son tra|lien chieu|hai chau|thanh xuan|go vap|binh thanh|thu duc)\b/u.test(normalized);
  return hasHouseNumber && (commaParts.length >= 2 || hasKnownPlace);
}

function getSalesFollowUpKey(pageId, recipientId) {
  return `${pageId || "unknown"}:${recipientId}`;
}

async function sendProductMediaForMessage(pageId, recipientId, text) {
  // NEVER send product images during order flow — only when customer explicitly asks
  if (!isExplicitProductMediaRequest(text)) {
    console.log(`[messenger-media] skipped because customer did not ask for images page=${pageId || "unknown"} recipient=${recipientId}`);
    return;
  }

  // Block images if bot recently sent an order confirmation (within 24 hours — covers the entire order lifecycle)
  const lastOrderConfirmKey = `order-confirm:${pageId || "unknown"}:${recipientId}`;
  const lastOrderConfirmAt = Number(messengerPollState.lastOrderConfirmations?.[lastOrderConfirmKey] || 0);
  if (lastOrderConfirmAt && (Date.now() - lastOrderConfirmAt) < 24 * 60 * 60 * 1000) {
    console.log(`[messenger-media] BLOCKED images — order was confirmed for this customer page=${pageId || "unknown"} recipient=${recipientId}`);
    return;
  }

  const matchedRules = getMatchedProductMediaRules(text);
  if (matchedRules.length === 0) {
    console.log(`[messenger-media] skipped because image request is not a product/legal/feedback request page=${pageId || "unknown"} recipient=${recipientId}`);
    return;
  }
  for (const rule of matchedRules) {
    for (const imagePath of selectRuleImagePaths(rule)) {
      await sendMessengerImage(pageId, recipientId, buildAssetUrl(imagePath));
    }
  }
}

function isExplicitProductMediaRequest(text) {
  const normalized = normalizeSearchText(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return false;

  return [
    /\b(anh|hinh|hinh anh|photo|picture|pic)\b/u,
    /\b(gui|cho|xin|xem|co)\s+(anh|hinh|hinh anh|photo|picture|pic)\b/u,
    /\b(cho xem|xem thu|xem mau|xem san pham|xem hang|xem can|xem tui)\b/u,
    /\b(anh|hinh)\s+(san pham|ruou|tui|can|giay to|giay phep|kiem nghiem|feedback|khach hang)\b/u
  ].some((pattern) => pattern.test(normalized));
}

function selectRuleImagePaths(rule) {
  const imagePaths = Array.isArray(rule.imagePaths) ? rule.imagePaths : [];
  const maxImages = Number.isFinite(rule.maxImages) ? rule.maxImages : imagePaths.length;
  if (imagePaths.length <= maxImages) return imagePaths;

  const shuffled = [...imagePaths];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(0, index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled.slice(0, maxImages);
}

function getMatchedProductMediaRules(text) {
  const normalizedText = normalizeSearchText(text);
  return productMediaRules.filter((rule) =>
    rule.matches.some((phrase) => normalizedText.includes(phrase))
  );
}

async function getRecentMessengerConversationHistory(pageId, recipientId, fallbackMessages = []) {
  try {
    const conversation = await fetchRecentMessengerConversationForUser(pageId, recipientId);
    const messages = conversation?.messages?.data || [];
    return formatMessengerConversationHistory(pageId, messages.length ? messages : fallbackMessages);
  } catch (error) {
    console.warn(`[messenger] conversation history lookup failed page=${pageId || "unknown"} recipient=${recipientId}: ${error.message}`);
    return formatMessengerConversationHistory(pageId, fallbackMessages);
  }
}

function formatMessengerConversationHistory(pageId, messages) {
  const lines = (messages || [])
    .filter((message) => message?.created_time && typeof message.message === "string" && message.message.trim())
    .sort((a, b) => new Date(a.created_time) - new Date(b.created_time))
    .slice(-10)
    .map((message) => {
      const speaker = String(message?.from?.id || "") === String(pageId) ? "Page/admin/bot" : "Khach";
      return `${speaker}: ${message.message.trim()}`;
    });

  return lines.join("\n");
}

function ensureCurrentMessengerMessageInHistory(messages, currentMessage) {
  const existing = Array.isArray(messages) ? [...messages] : [];
  const currentText = typeof currentMessage?.message === "string" ? currentMessage.message.trim() : "";
  if (!currentText) return existing;

  const currentId = currentMessage?.id || "";
  const alreadyIncluded = existing.some((message) => {
    if (currentId && message?.id && String(message.id) === String(currentId)) return true;
    return typeof message?.message === "string" && message.message.trim() === currentText;
  });

  return alreadyIncluded ? existing : [...existing, currentMessage];
}

function getMessengerImageAttachments(message) {
  return (message?.attachments || [])
    .filter((attachment) => attachment?.type === "image" && attachment?.payload?.url)
    .map((attachment) => ({
      type: attachment.type,
      url: String(attachment.payload.url),
      title: attachment.title || "",
      stickerId: attachment.payload?.sticker_id || ""
    }));
}

function buildMessengerEffectiveText(text, imageDescriptions = []) {
  const cleanText = String(text || "").trim();
  const cleanDescriptions = imageDescriptions
    .map((description) => String(description || "").trim())
    .filter(Boolean);

  if (cleanDescriptions.length === 0) {
    return cleanText || "[Khach vua gui anh/tep dinh kem nhung he thong chua doc duoc noi dung chi tiet.]";
  }

  const imageText = cleanDescriptions
    .map((description, index) => `Anh ${index + 1}: ${description}`)
    .join("\n");

  if (!cleanText) {
    return [
      "[Khach vua gui anh trong Messenger. Mo ta anh do he thong nhin anh tao ra:]",
      imageText
    ].join("\n");
  }

  return [
    cleanText,
    "",
    "[Khach co gui kem anh. Mo ta anh do he thong nhin anh tao ra:]",
    imageText
  ].join("\n");
}

async function describeMessengerImageAttachments(pageId, senderId, imageAttachments) {
  if (!config.visionEnabled || imageAttachments.length === 0) return [];

  const descriptions = [];
  for (const [index, attachment] of imageAttachments.entries()) {
    try {
      const description = await describeMessengerImageAttachment(attachment.url);
      descriptions.push(description || "Khong doc duoc noi dung anh.");
      console.log(`[messenger-vision] described image page=${pageId || "unknown"} sender=${senderId} index=${index + 1}`);
    } catch (error) {
      console.warn(`[messenger-vision] failed image description page=${pageId || "unknown"} sender=${senderId} index=${index + 1}: ${error.message}`);
      descriptions.push("Khach vua gui anh, nhung he thong chua doc duoc chi tiet anh. Hay xac nhan da nhan anh va hoi lai ngan gon neu can.");
    }
  }
  return descriptions;
}

async function describeMessengerImageAttachment(imageUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(config.visionTimeoutSeconds, 10) * 1000);
  try {
    const imageReference = await loadImageReferenceForVision(imageUrl, controller.signal);
    const response = await fetch(`${config.visionBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.visionModel,
        temperature: 0.1,
        max_tokens: 260,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  "Hay mo ta ngan gon anh khach gui cho nhan vien ban hang ruou Ban Moc.",
                  "Tap trung vao noi dung co ich: anh la bien lai/chuyen khoan, dia chi, so dien thoai, san pham, so luong, hay anh chup san pham/hoi dap.",
                  "Neu co chu trong anh, doc lai phan chu quan trong. Tra loi tieng Viet, 1-4 cau, khong doan qua muc."
                ].join(" ")
              },
              {
                type: "image_url",
                image_url: { url: imageReference }
              }
            ]
          }
        ]
      })
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`vision HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
    }

    const body = parsePossiblyPaddedJson(bodyText);
    return body?.choices?.[0]?.message?.content?.trim() || "";
  } finally {
    clearTimeout(timeout);
  }
}

async function loadImageReferenceForVision(imageUrl, signal) {
  try {
    const response = await fetch(imageUrl, { signal });
    if (!response.ok) {
      throw new Error(`image fetch HTTP ${response.status}`);
    }

    const contentType = (response.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
    if (!contentType.startsWith("image/")) {
      throw new Error(`image fetch returned ${contentType || "unknown content-type"}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > config.visionMaxImageBytes) {
      throw new Error(`image too large: ${bytes.length} bytes`);
    }

    return `data:${contentType};base64,${bytes.toString("base64")}`;
  } catch (error) {
    console.warn(`[messenger-vision] using original image URL because local fetch failed: ${error.message}`);
    return imageUrl;
  }
}

function parsePossiblyPaddedJson(text) {
  const raw = String(text || "").trim();
  try {
    return JSON.parse(raw);
  } catch {}

  const start = raw.indexOf("{");
  if (start < 0) throw new Error("missing JSON object");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(raw.slice(start, index + 1));
      }
    }
  }

  throw new Error("unterminated JSON object");
}

async function askOpenClaw(pageId, senderId, customerProfile, text, options = {}) {
  if (config.fastSalesReplyEnabled) {
    const fastReply = buildFastSalesReply(text);
    if (fastReply) {
      console.log(`[openclaw] using fast sales reply page=${pageId || "unknown"} sender=${senderId}`);
      return fastReply;
    }
  }

  if (Date.now() < openclawUnavailableUntil) {
    const fallbackReply = buildEmergencySalesReply(text, options);
    if (fallbackReply) {
      console.warn(`[openclaw] circuit open, using emergency sales reply page=${pageId || "unknown"} sender=${senderId}`);
      return fallbackReply;
    }
  }

  try {
    if (config.openclawTransport === "hermes") {
      return await askHermesCli(pageId, senderId, customerProfile, text, options);
    }

    if (config.openclawTransport === "cli") {
      return await askOpenClawCli(pageId, senderId, customerProfile, text, options);
    }

    if (config.openclawTransport !== "auto" && config.openclawTransport !== "http") {
      throw new Error(`Unsupported OPENCLAW_TRANSPORT: ${config.openclawTransport}`);
    }

    try {
      return await askOpenClawHttp(pageId, senderId, customerProfile, text, options);
    } catch (error) {
      if (config.openclawTransport === "http") throw error;

      console.warn("[openclaw] HTTP transport failed, falling back to CLI:", error.message);
      return await askOpenClawCli(pageId, senderId, customerProfile, text, options);
    }
  } catch (error) {
    const fallbackReply = buildEmergencySalesReply(text, options);
    if (fallbackReply) {
      openclawUnavailableUntil = Date.now() + 2 * 60 * 1000;
      console.warn(`[openclaw] model failed, using emergency sales reply page=${pageId || "unknown"} sender=${senderId}: ${error.message}`);
      return fallbackReply;
    }
    throw error;
  }
}

function buildFastSalesReply(text) {
  const normalized = normalizeSearchText(text);
  const asksPrice = /\b(gia|bao gia|bao nhieu|ib|inbox|xin gia|cho gia|tu van gia|5l|5 l|20l|20 l|can|tui|lit|lit)\b/u.test(normalized);
  const asksColor = isProductColorQuestion(normalized);
  const asksImage = !asksColor && /\b(anh|hinh|hinh anh|mau san pham|mau hang|xem|cho xem|gui anh|gui hinh|co anh|co hinh)\b/u.test(normalized);
  const defersPurchase = /\b(de sau|de tet|tet mua|chua lay|chua mua|chua can|chua dat|khi nao lay|luc nao lay|bao sau|mua sau|lay sau|de khi nao|chua lay dau|chua lay dau e)\b/u.test(normalized);
  const orderIntent = /\b(mua|lay|dat|chot|ship|gui|len don|cho em|cho anh|cho chi)\b/u.test(normalized);
  const mentionsProduct = /\b(ruou|ngo|men la|tam giac mach|ban moc)\b/u.test(normalized);

  if (defersPurchase) {
    return buildEmergencySalesReply(text);
  }

  if (asksPrice || asksColor || asksImage || (mentionsProduct && !orderIntent)) {
    return buildEmergencySalesReply(text);
  }

  return "";
}

function buildEmergencySalesReply(text, options = {}) {
  const normalized = normalizeSearchText(text);
  const history = normalizeSearchText(options.conversationHistory || "");
  const combined = `${history}\n${normalized}`;
  const asksPrice = /\b(gia|bao gia|bao nhieu|ib|inbox|xin gia|cho gia|tu van gia|5l|5 l|20l|20 l|can|tui|lit|lit)\b/u.test(normalized);
  const asksColor = isProductColorQuestion(normalized);
  const asksImage = !asksColor && /\b(anh|hinh|hinh anh|mau san pham|mau hang|xem|cho xem|gui anh|gui hinh|co anh|co hinh)\b/u.test(normalized);
  const defersPurchase = /\b(de sau|de tet|tet mua|chua lay|chua mua|chua can|chua dat|khi nao lay|luc nao lay|bao sau|mua sau|lay sau|de khi nao|chua lay dau|chua lay dau e)\b/u.test(normalized);
  const orderIntent = /\b(mua|lay|dat|chot|ship|gui|len don|cho em|cho anh|cho chi)\b/u.test(normalized);
  const asksQuality = /\b(ngon|dau dau|nhuc dau|chat luong|dam bao|co dau dau|khong dau dau|ko dau dau|k dau dau)\b/u.test(normalized);
  const asksTaste = /\b(vi|huong|huong vi|mui|thom|hau|em|gat|nong|de uong|uong the nao|nhu the nao)\b/u.test(normalized);
  const complainsContext = /\b(xem tu tren|tra loi theo dong|doc lai|lon xon|lung tung|khong dung|ko dung|k dung)\b/u.test(normalized);
  const mentionsTamGiacMach = /\b(tam giac mach|mach)\b/u.test(combined);
  const mentionsNgo = /\b(ngo|ngo men la|ruou ngo)\b/u.test(combined);
  const mentionsProduct = /\b(ruou|ngo|men la|tam giac mach|ban moc)\b/u.test(normalized);
  const orderSignal = detectEmergencyOrderSignal(text, normalized);

  if (asksColor) {
    return [
      "Dạ rượu bên em là màu trắng trong ạ.",
      "",
      "- Màu rượu: trắng trong, không phải vàng nhạt.",
      "- Lý do: đây là rượu chưng cất xong hạ thổ, không phải dòng rượu ngâm.",
      "- Chất lượng: bên em không dùng phẩm màu hay chất tạo màu gì hết ạ."
    ].join("\n");
  }

  if ((asksTaste || complainsContext) && mentionsTamGiacMach) {
    return [
      "Dạ em xin lỗi Anh NT, để em trả lời đúng ý mình ạ. Rượu tam giác mạch bên em có thông tin như sau ạ:",
      "",
      "- Nồng độ: khoảng 25-28 độ, không gắt và không nóng.",
      "- Hương vị: thanh nhẹ, thơm thoang thoảng mùi hoa rừng, hậu hơi ngọt.",
      "- Cảm giác uống: êm, mềm và dễ vào hơn dòng ngô men lá.",
      "- Phù hợp: hợp với mình thích rượu nhẹ, dễ uống hoặc dùng trong bữa ăn ạ."
    ].join("\n");
  }

  if (asksQuality) {
    const productText = mentionsTamGiacMach
      ? "rượu tam giác mạch bên em uống thanh nhẹ, êm, không gắt"
      : mentionsNgo
        ? "rượu ngô men lá bên em thơm men lá, vị đậm hơn nhưng vẫn êm"
        : "rượu bên em nấu thủ công từ men lá, không pha cồn công nghiệp hay hóa chất";
    return `Dạ bên em đảm bảo ${productText} ạ. Về việc đau đầu thì thường phụ thuộc cơ địa và lượng uống, nhưng rượu Bản Mộc là rượu men lá nấu chuẩn, không dùng cồn công nghiệp nên uống đúng lượng sẽ êm hơn. Mình dùng lần đầu thì nên uống vừa phải và để rượu nghỉ/chill trước khi uống sẽ ngon hơn ạ.`;
  }

  if (defersPurchase) {
    return "Dạ em lưu ý thông tin của anh/chị rồi ạ. Khi nào mình cần lấy rượu hoặc chốt đơn thì nhắn em, em hỗ trợ tư vấn và lên đơn nhanh cho mình ạ.";
  }

  if (orderSignal) {
    const products = extractEmergencySpecificProductNames(normalized);
    const quantity = parseOrderNotifyQuantity(text);
    const hasPhone = extractPhonesFromText(text).length > 0;
    const hasAddress = extractDetailedAddressLinesFromText(text).length > 0 || hasEmergencyAddressMarker(normalized);

    if (products.length === 0) {
      const quantityText = quantity ? ` ${formatOrderNotifyQuantity(quantity)}` : "";
      return `Dạ em nhận thông tin${quantityText} của anh/chị rồi ạ. Anh/chị muốn chọn loại nào ạ: rượu ngô men lá, rượu tam giác mạch, hay mỗi loại một phần ạ?`;
    }

    if (!hasPhone || !hasAddress) {
      const missing = [];
      if (!hasPhone) missing.push("SĐT");
      if (!hasAddress) missing.push("địa chỉ nhận hàng cụ thể");
      return `Dạ em nhận nhu cầu lấy ${quantity ? formatOrderNotifyQuantity(quantity) : "rượu"} ${products.join(", ")} rồi ạ. Anh/chị gửi giúp em ${missing.join(" và ")} để em lên đơn chính xác nhé.`;
    }

    return `Dạ em đã nhận thông tin đặt ${quantity ? formatOrderNotifyQuantity(quantity) : "rượu"} ${products.join(", ")} của anh/chị rồi ạ. Em kiểm tra lại đơn và lên hàng cho mình nhé.`;
  }

  if (asksPrice) {
    return [
      "Dạ, giá rượu bên em hiện tại như sau ạ:",
      "",
      "Rượu ngô men lá Hà Giang và Rượu tam giác mạch Hà Giang:",
      "",
      "- Túi 5L: 330.000đ",
      "- Can 20L: 1.200.000đ",
      "- Ship 1 túi 5L: 20.000đ, từ 2 túi miễn phí vận chuyển toàn quốc.",
      "",
      "Anh đang quan tâm sản phẩm nào để em tư vấn kỹ hơn cho mình ạ?"
    ].join("\n");
  }

  if (orderIntent) {
    return [
      "Dạ để em lên đơn chính xác, anh/chị cho em xin giúp:",
      "",
      "- Tên người nhận:",
      "- Số điện thoại:",
      "- Sản phẩm và số lượng:",
      "- Địa chỉ (cũ) nhận hàng cụ thể:",
      "",
      "Địa chỉ càng rõ thì đơn càng tránh thất lạc và giao nhanh hơn ạ. Nếu địa chỉ anh/chị đã gửi là đúng và nhận được hàng thì anh/chị xác nhận lại giúp em nhé."
    ].join("\n");
  }

  if (asksImage) {
    return "Dạ em gửi ảnh sản phẩm để anh/chị xem thêm ạ.";
  }

  if (complainsContext) {
    return "Dạ em xin lỗi anh/chị, em sẽ bám đúng nội dung mình đang hỏi. Anh/chị nhắn lại giúp em ý chính cần em trả lời, em tư vấn thẳng vào phần đó ạ.";
  }

  if (mentionsProduct && mentionsTamGiacMach) {
    return [
      "Dạ rượu Tam Giác Mạch bên em có thông tin như sau ạ:",
      "",
      "- Nồng độ: khoảng 25-28 độ.",
      "- Nguyên liệu: hạt tam giác mạch, men lá ngọt, nước suối tinh khiết.",
      "- Hương vị: thanh nhẹ, hậu ngọt, thơm thoang thoảng như hoa rừng.",
      "- Phù hợp: dễ uống, hợp dùng trong bữa ăn hoặc làm quà biếu ạ."
    ].join("\n");
  }

  if (mentionsProduct && mentionsNgo) {
    return [
      "Dạ rượu ngô men lá bên em có thông tin như sau ạ:",
      "",
      "- Nồng độ: khoảng 27-30 độ.",
      "- Nguyên liệu: ngô bản địa, men lá rừng và nước suối tự nhiên.",
      "- Hương vị: thơm nhẹ mùi men lá, vị đậm đà và êm sâu.",
      "- Phù hợp: hợp với mình thích dòng rượu truyền thống Hà Giang rõ vị hơn ạ."
    ].join("\n");
  }

  return "";
}

function detectEmergencyOrderSignal(text, normalizedText = normalizeSearchText(text)) {
  const normalized = normalizedText
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized) return false;

  const hasQuantity = /\b\d+\s*(tui|can|lit|l)\b/u.test(normalized) || /\b\d+\s*tui\s*\d+\s*l\b/u.test(normalized);
  const buyingIntent = /\b(mua|dat|lay|chot|ship|gui|len don|cho em|cho anh|cho chi|cho minh|cho toi|uong thu|thu truoc|lay thu)\b/u.test(normalized);
  const hasPhone = extractPhonesFromText(text).length > 0;
  const hasAddress = extractDetailedAddressLinesFromText(text).length > 0 || hasEmergencyAddressMarker(normalized);

  return Boolean((hasQuantity && (buyingIntent || hasPhone || hasAddress)) || (buyingIntent && hasPhone && hasAddress));
}

function extractEmergencySpecificProductNames(normalizedText) {
  const products = [];
  if (/\b(ngo men la|ruou ngo)\b/u.test(normalizedText) || (/\bmen la\b/u.test(normalizedText) && !/\btam giac mach\b/u.test(normalizedText))) {
    products.push("rượu ngô men lá");
  }
  if (/\b(tam giac mach|mach)\b/u.test(normalizedText)) products.push("rượu tam giác mạch");
  return products;
}

function hasEmergencyAddressMarker(normalizedText) {
  return /\b(dia chi|dc|so nha|sn|thon|xom|ap|ban|duong|ngo|ngach|hem|to dan pho|tdp|xa|phuong|thi tran|huyen|quan|thi xa|thanh pho|tp|tinh)\b/u.test(normalizedText);
}

function isProductColorQuestion(normalizedText) {
  const text = String(normalizedText || "");
  return /\b(mau gi|mau sac|co mau gi|ruou mau|mau ruou|mau nhu the nao|mau the nao|vang nhat|trang trong)\b/u.test(text);
}

async function askOpenClawHttp(pageId, senderId, customerProfile, text, options = {}) {
  const url = `${config.openclawBaseUrl}/v1/chat/completions`;
  const headers = {
    "content-type": "application/json",
    "x-openclaw-message-channel": options.channel || "facebook-messenger"
  };
  if (config.openclawAuthToken) {
    headers.authorization = `Bearer ${config.openclawAuthToken}`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.openclawModel,
      user: `${options.sessionNamespace || "messenger"}:${pageId || "unknown"}:${senderId}`,
      messages: [
        { role: "system", content: config.systemPrompt },
        { role: "user", content: options.userMessage || buildOpenClawUserMessage(pageId, senderId, customerProfile, text, options) }
      ]
    })
  });

  const bodyText = await response.text();
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok) {
    throw new Error(`OpenClaw HTTP ${response.status}: ${bodyText.slice(0, 500)}`);
  }
  if (!contentType.includes("application/json")) {
    throw new Error(`OpenClaw HTTP returned non-JSON content-type: ${contentType || "unknown"}`);
  }

  const body = JSON.parse(bodyText);
  return body?.choices?.[0]?.message?.content?.trim() || "";
}

async function askOpenClawCli(pageId, senderId, customerProfile, text, options = {}) {
  const sessionNamespace = options.sessionNamespace || "messenger:v3";
  const sessionKey = `agent:main:${sanitizeSessionPart(sessionNamespace)}:${sanitizeSessionPart(pageId)}:${sanitizeSessionPart(senderId)}`;
  const message = [
    config.systemPrompt,
    "",
    options.userMessage || buildOpenClawUserMessage(pageId, senderId, customerProfile, text, options)
  ].join("\n");

  const args = [
    "agent",
    "--json",
    "--session-key",
    sessionKey,
    "--message",
    message,
    "--timeout",
    String(config.openclawCliTimeoutSeconds)
  ];

  const result = await runCommand(config.openclawCliBin, args, {
    timeoutMs: config.openclawCliTimeoutSeconds * 1000 + 5000
  });
  const parsed = JSON.parse(result.stdout);

  if (parsed.status && parsed.status !== "ok") {
    throw new Error(`OpenClaw CLI status ${parsed.status}: ${JSON.stringify(parsed).slice(0, 500)}`);
  }

  const payloadText = parsed?.result?.payloads
    ?.map((payload) => payload?.text)
    .filter(Boolean)
    .join("\n")
    .trim();

  return (
    payloadText ||
    parsed?.result?.finalAssistantVisibleText?.trim() ||
    parsed?.result?.finalAssistantRawText?.trim() ||
    ""
  );
}

async function askHermesCli(pageId, senderId, customerProfile, text, options = {}) {
  const message = [
    config.systemPrompt,
    "",
    options.userMessage || buildOpenClawUserMessage(pageId, senderId, customerProfile, text, options),
    "",
    "Truoc khi tra loi, hay doc ky toan bo lich su hoi thoai va noi dung khach hoi de hieu dung cau hoi. Tra loi bang tieng Viet ngan gon, dung vai tro nhan vien ban hang Ban Moc. Khong nhac den he thong noi bo. Khong chao hoi neu khach dang trong mach hoi thoai. QUAN TRONG: Khong bao gio hua mien ship cho don 1 tui (phai tinh 20k ship). Khong hua hen ngay gio giao hang cu the (chi noi se giao som nhat co the). KHONG TU Y NOI VE CHUYEN KHOAN / THANH TOAN — ben em chi ship COD, khach khong can chuyen khoan truoc."
  ].join("\n");

  const result = await runCommand(config.hermesCliBin, [message], {
    timeoutMs: config.hermesCliTimeoutSeconds * 1000 + 5000
  });

  const output = result.stdout.trim();
  if (looksLikeHermesCliFailure(output)) {
    throw new Error(`Hermes CLI model failure: ${output.slice(0, 300)}`);
  }

  return output;
}

function looksLikeHermesCliFailure(output) {
  const normalized = String(output || "").trim();
  if (!normalized) return false;

  return (
    /^API call failed after \d+ retries:/i.test(normalized) ||
    /^HTTP 5\d\d:/i.test(normalized) ||
    /No available channel for model/i.test(normalized) ||
    /\bdistributor\b/i.test(normalized)
  );
}



/**
 * Hard content filter — blocks fabricated/hallucinated content before sending.
 * Returns filtered text (original if safe, fallback if blocked).
 */
function filterUnsafeReplyContent(text, senderId, pageId) {
  if (!text || typeof text !== "string") return text || "";
  const normalized = normalizeSearchText(text);

  // 1. Block fabricated bank transfer / payment talk
  const bannedPaymentPhrases = [
    /chuyen\s*khoan/iu,
    /(xac\s*nhan|da\s*nhan\s*duoc)\s+thanh\s*toan/iu,
    /anh\s*chuyen\s*khoan/iu,
    /da\s*nhan\s*duoc\s*anh.*(chuyen\s*khoan|thanh\s*toan)/iu,
    /kiem\s*tra.*(thanh\s*toan|chuyen\s*khoan)/iu,
  ];

  for (const pattern of bannedPaymentPhrases) {
    if (pattern.test(normalized)) {
      console.warn(`[content-filter] BLOCKED fabricated payment content page=${pageId || "unknown"} sender=${senderId}: ${text.slice(0, 100)}`);
      return "Dạ em xin lỗi anh/chị, em trả lời chưa đúng ạ. Anh/chị cho em hỏi lại ý mình cần em hỗ trợ thêm gì ạ?";
    }
  }

  // 2. Block "đã nhận được ảnh" when customer likely didn't send one
  if (/da\s*nhan\s*duoc\s*anh/iu.test(normalized) && normalized.length < 300) {
    console.warn(`[content-filter] BLOCKED likely-fabricated photo claim page=${pageId || "unknown"} sender=${senderId}: ${text.slice(0, 100)}`);
    return "Dạ em xin lỗi anh/chị, em trả lời chưa đúng ạ. Anh/chị cho em hỏi lại ý mình cần em hỗ trợ thêm gì ạ?";
  }

  return text;
}

function normalizeCustomerAddressing(reply, customerProfile) {
  const customerShortName = extractCustomerShortName(customerProfile);
  if (!reply || !customerShortName) return reply || "";

  const preferredAddress = `Anh ${customerShortName}`;
  const escapedName = escapeRegExp(customerShortName);
  const normalized = String(reply)
    .replace(new RegExp(`anh\\s*\\/?\\s*chị\\s+${escapedName}`, "giu"), preferredAddress)
    .replace(new RegExp(`chị\\s*\\/\\s*anh\\s+${escapedName}`, "giu"), preferredAddress)
    .replace(new RegExp(`chị\\s+${escapedName}`, "giu"), preferredAddress)
    .replace(/anh\s*\/?\s*chị/giu, preferredAddress)
    .replace(/chị\s*\/\s*anh/giu, preferredAddress);

  return addDefaultAddressTitle(normalized, customerShortName, preferredAddress);
}

function addDefaultAddressTitle(text, customerShortName, preferredAddress) {
  const escapedName = escapeRegExp(customerShortName);
  return String(text).replace(new RegExp(`(?<!\\p{L})${escapedName}(?!\\p{L})`, "giu"), (match, offset, fullText) => {
    const before = fullText.slice(Math.max(0, offset - 8), offset).toLowerCase();
    if (/(^|\s)(anh|chị)\s$/u.test(before)) return match;
    return preferredAddress;
  });
}

async function sendMessengerText(pageId, recipientId, text) {
  for (const chunk of splitMessage(text, config.maxReplyChars)) {
    await callMessengerSendApi(pageId, {
      recipient: { id: recipientId },
      message: { text: chunk }
    });
    recordMessengerBotSent(pageId, recipientId);
  }
}

async function sendMessengerImage(pageId, recipientId, imageUrl) {
  await callMessengerSendApi(pageId, {
    recipient: { id: recipientId },
    message: {
      attachment: {
        type: "image",
        payload: {
          url: imageUrl,
          is_reusable: true
        }
      }
    }
  });
  recordMessengerBotSent(pageId, recipientId);
  console.log(`[messenger] sent image page=${pageId || "unknown"} recipient=${recipientId}`);
}

async function sendFacebookCommentReply(pageId, commentId, text) {
  const pageAccessToken = getPageAccessToken(pageId);
  if (!pageAccessToken) {
    throw new Error(`No Page Access Token configured for Page ID ${pageId}`);
  }

  for (const chunk of splitMessage(text, config.maxReplyChars)) {
    const url = new URL(`https://graph.facebook.com/${config.graphVersion}/${commentId}/comments`);
    const response = await fetch(url, {
      method: "POST",
      body: new URLSearchParams({
        message: chunk,
        access_token: pageAccessToken
      })
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`Facebook Comment API HTTP ${response.status}: ${bodyText.slice(0, 500)}`);
    }
    console.log(`[facebook-comment] sent OpenClaw reply page=${pageId || "unknown"} comment=${commentId} chars=${chunk.length}`);
  }
}

async function sendSenderAction(pageId, recipientId, senderAction) {
  await callMessengerSendApi(pageId, {
    recipient: { id: recipientId },
    sender_action: senderAction
  });
}

async function callMessengerSendApi(pageId, payload) {
  const pageAccessToken = getPageAccessToken(pageId);
  if (!pageAccessToken) {
    throw new Error(`Missing Page Access Token for Page ID ${pageId || "unknown"}`);
  }

  const url = new URL(`https://graph.facebook.com/${config.graphVersion}/me/messages`);
  url.searchParams.set("access_token", pageAccessToken);

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Messenger Send API HTTP ${response.status}: ${bodyText.slice(0, 500)}`);
  }
}

async function getMessengerProfile(pageId, senderId) {
  const cacheKey = `${pageId || "unknown"}:${senderId}`;
  const cached = profileCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.profile;

  const pageAccessToken = getPageAccessToken(pageId);
  if (!pageAccessToken) return null;

  const url = new URL(`https://graph.facebook.com/${config.graphVersion}/${senderId}`);
  url.searchParams.set("fields", "first_name,last_name,gender");
  url.searchParams.set("access_token", pageAccessToken);

  try {
    const response = await fetch(url);
    const bodyText = await response.text();
    if (!response.ok) {
      if (isUnsupportedMessengerProfileLookup(bodyText)) {
        console.log(`[messenger] profile lookup unavailable for ${senderId}; trying conversation participants fallback`);
      } else {
        console.warn(`[messenger] profile lookup failed for ${senderId}: HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
      }
      return getMessengerConversationProfile(pageId, senderId, pageAccessToken);
    }

    const body = JSON.parse(bodyText);
    const name = [body.first_name, body.last_name].filter(Boolean).join(" ").trim() || body.name || "";
    const profile = {
      id: senderId,
      name,
      firstName: body.first_name || "",
      lastName: body.last_name || "",
      gender: body.gender || ""
    };
    profileCache.set(cacheKey, { profile, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
    return profile;
  } catch (error) {
    console.warn(`[messenger] profile lookup failed for ${senderId}: ${error.message}`);
    return getMessengerConversationProfile(pageId, senderId, pageAccessToken);
  }
}

async function getMessengerConversationProfile(pageId, senderId, pageAccessToken) {
  if (!pageId || !pageAccessToken) return null;

  const url = new URL(`https://graph.facebook.com/${config.graphVersion}/${pageId}/conversations`);
  url.searchParams.set("user_id", senderId);
  url.searchParams.set("fields", "participants");
  url.searchParams.set("access_token", pageAccessToken);

  try {
    const response = await fetch(url);
    const bodyText = await response.text();
    if (!response.ok) {
      if (isUnsupportedMessengerProfileLookup(bodyText)) {
        console.log(`[messenger] conversation profile lookup unavailable for ${senderId}`);
      } else {
        console.warn(`[messenger] conversation profile lookup failed for ${senderId}: HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
      }
      return null;
    }

    const body = JSON.parse(bodyText);
    const participants = body.data?.[0]?.participants?.data || [];
    const customer = participants.find((participant) =>
      participant?.id && String(participant.id) !== String(pageId)
    );
    const name = customer?.name || "";
    if (!name) return null;

    const profile = {
      id: senderId,
      name,
      firstName: "",
      lastName: "",
      gender: ""
    };
    const cacheKey = `${pageId || "unknown"}:${senderId}`;
    profileCache.set(cacheKey, { profile, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
    return profile;
  } catch (error) {
    console.warn(`[messenger] conversation profile lookup failed for ${senderId}: ${error.message}`);
    return null;
  }
}

function verifyMetaSignature(req, rawBody) {
  if (!config.appSecret) return true;

  const signatureHeader = req.headers["x-hub-signature-256"];
  if (typeof signatureHeader !== "string" || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", config.appSecret)
    .update(rawBody)
    .digest("hex");
  const actual = signatureHeader.slice("sha256=".length);

  return timingSafeEqualHex(actual, expected);
}

function timingSafeEqualHex(a, b) {
  const aBuffer = Buffer.from(a, "hex");
  const bBuffer = Buffer.from(b, "hex");
  return aBuffer.length === bBuffer.length && crypto.timingSafeEqual(aBuffer, bBuffer);
}

function splitMessage(text, maxChars) {
  const normalized = String(text || "").trim();
  if (!normalized) return [""];
  if (normalized.length <= maxChars) return [normalized];

  const chunks = [];
  let remaining = normalized;
  while (remaining.length > maxChars) {
    const splitAt = Math.max(
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

function buildOpenClawUserMessage(pageId, senderId, customerProfile, text, options = {}) {
  const customerName = customerProfile?.name || "";
  const customerShortName = extractCustomerShortName(customerProfile);
  const customerGender = customerProfile?.gender || "";
  const addressTerm =
    customerGender === "male" ? "anh" :
    customerGender === "female" ? "chị" :
    "anh/chị";
  const recommendedAddress =
    customerShortName ? `Anh ${customerShortName}` :
    addressTerm;

  const conversationHistory = String(options.conversationHistory || "").trim();
  const lines = [
    `Page ID: ${pageId || "unknown"}`,
    `Facebook Messenger sender ID: ${senderId}`,
    customerName ? `Ten khach hang: ${customerName}` : "Ten khach hang: chua lay duoc tu Meta",
    customerShortName ? `Ten goi ngan cua khach: ${customerShortName}` : "Ten goi ngan cua khach: chua lay duoc tu Meta",
    customerGender ? `Gioi tinh Meta tra ve: ${customerGender}` : "Gioi tinh Meta tra ve: khong co",
    `Cach goi nen dung: ${recommendedAddress}`,
    ""
  ];

  if (conversationHistory) {
    lines.push(
      "Lich su gan nhat cua cuoc chat:",
      conversationHistory,
      "",
      "Truoc khi tra loi, hay doc lich su tren de xac dinh viec can lam tiep theo. Bat buoc tra loi dung cau hoi moi nhat trong mach hoi thoai, khong quay lai cau chao/gioi thieu/gia neu khach dang hoi ve huong vi, chat luong, dau dau, hoac dang phan nan bot tra loi sai.",
      "Neu khach noi 'xem tu tren', 'tra loi theo dong trao doi', 'doc lai o tren' thi hay xin loi ngan gon va tra loi truc tiep cau hoi lien quan ngay truoc do trong lich su. Khong gui anh, khong hoi lai nhu cau chung.",
      "Neu khach dang hoi ve rieng tam giac mach, chi tu van tam giac mach; khong liet ke rượu ngô/gia chung tru khi khach hoi gia."
    );
  }

  lines.push("", "Tin nhan khach vua gui:", text);
  return lines.join("\n");
}

function buildOpenClawCommentMessage(pageId, commentId, postId, customerProfile, text) {
  const customerName = customerProfile?.name || "";
  const customerShortName = extractCustomerShortName(customerProfile);
  const recommendedAddress = customerShortName ? `Anh ${customerShortName}` : "anh/chị";

  return [
    "Ngu canh: Day la binh luan cong khai tren Facebook Page, khong phai tin nhan rieng.",
    `Page ID: ${pageId || "unknown"}`,
    `Facebook comment ID: ${commentId}`,
    postId ? `Facebook post ID: ${postId}` : "Facebook post ID: khong co",
    customerName ? `Ten khach hang: ${customerName}` : "Ten khach hang: chua lay duoc tu Meta",
    customerShortName ? `Ten goi ngan cua khach: ${customerShortName}` : "Ten goi ngan cua khach: chua lay duoc tu Meta",
    `Cach goi nen dung: ${recommendedAddress}`,
    "",
    "Yeu cau khi tra loi binh luan:",
    "- Tra loi ngan gon, than thien, tu nhien nhu nhan vien shop.",
    "- Khong hoi xin dia chi, so dien thoai ngay tren binh luan cong khai.",
    "- Neu khach co nhu cau dat hang hoac can tu van rieng, moi khach nhan tin inbox Page hoac lien he Hotline/Zalo 0931989777.",
    "- Neu khach hoi gia, co the tra loi gia ngan gon va moi inbox de tu van ky hon.",
    "",
    "Binh luan khach vua gui:",
    text
  ].join("\n");
}

function extractCustomerShortName(customerProfile) {
  const candidates = [
    customerProfile?.name,
    customerProfile?.firstName
  ];

  for (const candidate of candidates) {
    const shortName = lastNamePart(candidate);
    if (shortName) return shortName;
  }

  return "";
}

function lastNamePart(name) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return parts[parts.length - 1] || "";
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspaceDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs || 185000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
      }
    });
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function buildPrivacyPolicyHtml() {
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chinh sach quyen rieng tu - Ban Moc</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; max-width: 860px; margin: 40px auto; padding: 0 20px; color: #17202a; }
    h1, h2 { line-height: 1.25; }
  </style>
</head>
<body>
  <h1>Chinh sach quyen rieng tu - Ban Moc</h1>
  <p>Cap nhat: 02/07/2026</p>
  <p>Ung dung Openclaw duoc Ban Moc su dung de ho tro tra loi tin nhan khach hang tren Facebook Messenger.</p>
  <h2>Du lieu chung toi xu ly</h2>
  <p>Khi khach hang nhan tin voi Trang cua Ban Moc, ung dung co the xu ly noi dung tin nhan, ID nguoi gui Messenger va thong tin ho so cong khai do Meta cung cap nhu ten hien thi de phan hoi phu hop.</p>
  <h2>Muc dich su dung</h2>
  <p>Du lieu chi duoc dung de tu van san pham, tra loi cau hoi, ho tro dat hang va cham soc khach hang cua Ban Moc.</p>
  <h2>Chia se du lieu</h2>
  <p>Ban Moc khong ban du lieu ca nhan va khong chia se du lieu tin nhan voi ben thu ba cho muc dich quang cao doc lap.</p>
  <h2>Luu tru va bao mat</h2>
  <p>Du lieu duoc xu ly tren he thong may chu cua Ban Moc/OpenClaw va chi duoc truy cap boi nguoi quan tri duoc uy quyen.</p>
  <h2>Yeu cau xoa du lieu</h2>
  <p>Khach hang co the yeu cau xoa du lieu lien quan den tin nhan bang cach lien he Hotline/Zalo: 0931989777.</p>
  <h2>Lien he</h2>
  <p>Ban Moc - SN375 Tran Phu, thi tran Vinh Tuy, H. Bac Quang, Ha Giang. Hotline/Zalo: 0931989777.</p>
</body>
</html>`;
}

function buildTermsHtml() {
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dieu khoan su dung - Ban Moc</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; max-width: 860px; margin: 40px auto; padding: 0 20px; color: #17202a; }
    h1, h2 { line-height: 1.25; }
  </style>
</head>
<body>
  <h1>Dieu khoan su dung - Ban Moc</h1>
  <p>Cap nhat: 02/07/2026</p>
  <p>Ung dung Openclaw ho tro Ban Moc tra loi tin nhan khach hang tren Facebook Messenger. Thong tin tu van co muc dich ho tro ban hang va cham soc khach hang.</p>
  <h2>Lien he</h2>
  <p>Ban Moc - Hotline/Zalo: 0931989777.</p>
</body>
</html>`;
}

function sendPublicAsset(url, res, headOnly = false) {
  const relativePath = decodeURIComponent(url.pathname.slice(config.assetPath.length));
  const normalizedPath = normalize(relativePath);
  if (
    !relativePath ||
    normalizedPath.startsWith("..") ||
    normalizedPath.startsWith(sep) ||
    normalizedPath.includes(`${sep}..${sep}`)
  ) {
    return sendJson(res, 400, { ok: false, error: "invalid_asset_path" });
  }

  const assetPath = join(publicDir, normalizedPath);
  if (!existsSync(assetPath)) {
    return sendJson(res, 404, { ok: false, error: "asset_not_found" });
  }

  res.writeHead(200, {
    "content-type": getMimeType(assetPath),
    "cache-control": "public, max-age=31536000, immutable"
  });
  res.end(headOnly ? undefined : readFileSync(assetPath));
}

function sendLandingAsset(url, res, headOnly = false) {
  if (url.pathname === "/landing") {
    res.writeHead(302, { location: "/landing/" });
    return res.end();
  }

  const relativePath = decodeURIComponent(url.pathname.slice("/landing/".length)) || "index.html";
  const normalizedPath = normalize(relativePath);
  if (
    normalizedPath.startsWith("..") ||
    normalizedPath.startsWith(sep) ||
    normalizedPath.includes(`${sep}..${sep}`)
  ) {
    return sendJson(res, 400, { ok: false, error: "invalid_landing_path" });
  }

  const assetPath = join(landingDir, normalizedPath);
  if (!existsSync(assetPath)) {
    return sendJson(res, 404, { ok: false, error: "landing_asset_not_found" });
  }

  res.writeHead(200, {
    "content-type": getMimeType(assetPath),
    "cache-control": "public, max-age=300"
  });
  res.end(headOnly ? undefined : readFileSync(assetPath));
}

function buildAssetUrl(path) {
  return `${config.publicBaseUrl}${config.assetPath}${encodeURI(path)}`;
}

function getMimeType(path) {
  switch (extname(path).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function readIntEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function readBoolEnv(name, fallback = false) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function readMessengerPollState() {
  if (!existsSync(messengerPollStatePath)) {
    return {
      processedConversations: {},
      processedComments: {},
      processedMessengerMessages: {},
      pendingSalesFollowUps: {},
      pendingMessengerRetries: {},
      adminPauses: {},
      botSentMessages: {},
      notifiedOrders: {},
      notifiedOrderContacts: {}
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(messengerPollStatePath, "utf8"));
    return {
      processedConversations: parsed.processedConversations && typeof parsed.processedConversations === "object"
        ? parsed.processedConversations
        : {},
      processedComments: parsed.processedComments && typeof parsed.processedComments === "object"
        ? parsed.processedComments
        : {},
      processedMessengerMessages: parsed.processedMessengerMessages && typeof parsed.processedMessengerMessages === "object"
        ? parsed.processedMessengerMessages
        : {},
      pendingSalesFollowUps: parsed.pendingSalesFollowUps && typeof parsed.pendingSalesFollowUps === "object"
        ? parsed.pendingSalesFollowUps
        : {},
      pendingMessengerRetries: parsed.pendingMessengerRetries && typeof parsed.pendingMessengerRetries === "object"
        ? parsed.pendingMessengerRetries
        : {},
      adminPauses: parsed.adminPauses && typeof parsed.adminPauses === "object"
        ? parsed.adminPauses
        : {},
      botSentMessages: parsed.botSentMessages && typeof parsed.botSentMessages === "object"
        ? parsed.botSentMessages
        : {},
      notifiedOrders: parsed.notifiedOrders && typeof parsed.notifiedOrders === "object"
        ? parsed.notifiedOrders
        : {},
      notifiedOrderContacts: parsed.notifiedOrderContacts && typeof parsed.notifiedOrderContacts === "object"
        ? parsed.notifiedOrderContacts
        : {}
    };
  } catch (error) {
    console.warn(`[messenger-poll] failed to read state, starting fresh: ${error.message}`);
    return {
      processedConversations: {},
      processedComments: {},
      processedMessengerMessages: {},
      pendingSalesFollowUps: {},
      pendingMessengerRetries: {},
      adminPauses: {},
      botSentMessages: {},
      notifiedOrders: {},
      notifiedOrderContacts: {}
    };
  }
}

function hasProcessedMessengerMessage(pageId, messageId) {
  const key = getMessengerMessageStateKey(pageId, messageId);
  return Boolean(messengerPollState.processedMessengerMessages?.[key]);
}

function markMessengerMessageProcessed(pageId, messageId) {
  messengerPollState.processedMessengerMessages = messengerPollState.processedMessengerMessages || {};
  messengerPollState.processedMessengerMessages[getMessengerMessageStateKey(pageId, messageId)] = Date.now();
  saveMessengerPollState();
}

function getMessengerMessageStateKey(pageId, messageId) {
  return `${pageId || "unknown"}:${messageId}`;
}

function pruneMessengerPollState() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const bucketName of ["processedConversations", "processedComments", "processedMessengerMessages", "botSentMessages"]) {
    const bucket = messengerPollState[bucketName];
    if (!bucket || typeof bucket !== "object") continue;
    for (const [key, value] of Object.entries(bucket)) {
      if (Number(value) < cutoff) {
        delete bucket[key];
      }
    }
  }

  const orderNotificationCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const notifiedOrders = messengerPollState.notifiedOrders;
  if (notifiedOrders && typeof notifiedOrders === "object") {
    for (const [key, value] of Object.entries(notifiedOrders)) {
      if (Number(value) < orderNotificationCutoff) {
        delete notifiedOrders[key];
      }
    }
  }
  const notifiedOrderContacts = messengerPollState.notifiedOrderContacts;
  if (notifiedOrderContacts && typeof notifiedOrderContacts === "object") {
    for (const [key, value] of Object.entries(notifiedOrderContacts)) {
      if (Number(value) < orderNotificationCutoff) {
        delete notifiedOrderContacts[key];
      }
    }
  }

  const pendingCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const pending = messengerPollState.pendingSalesFollowUps;
  if (pending && typeof pending === "object") {
    for (const [key, value] of Object.entries(pending)) {
      if (Number(value?.scheduledAt || 0) < pendingCutoff) {
        delete pending[key];
      }
    }
  }

  const retryCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const retries = messengerPollState.pendingMessengerRetries;
  if (retries && typeof retries === "object") {
    for (const [key, value] of Object.entries(retries)) {
      if (Number(value?.lastErrorAt || 0) < retryCutoff) {
        delete retries[key];
      }
    }
  }

  const pauses = messengerPollState.adminPauses;
  if (pauses && typeof pauses === "object") {
    for (const [key, value] of Object.entries(pauses)) {
      if (Number(value?.pauseUntil || 0) <= Date.now()) {
        delete pauses[key];
      }
    }
  }
}

function saveMessengerPollState() {
  pruneMessengerPollState();
  writeFileSync(messengerPollStatePath, JSON.stringify(messengerPollState, null, 2));
}

function getPageAccessToken(pageId) {
  if (pageId && config.pageAccessTokens.has(pageId)) {
    return config.pageAccessTokens.get(pageId);
  }

  if (pageId && config.pageAccessTokens.size > 0) {
    console.warn(`[config] No Page Access Token configured for Page ID ${pageId}; using fallback token.`);
  }

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
      if (equalsIndex <= 0) {
        console.warn(`[config] Ignoring invalid META_PAGE_ACCESS_TOKENS entry: ${trimmed}`);
        continue;
      }

      const pageId = trimmed.slice(0, equalsIndex).trim();
      const token = trimmed.slice(equalsIndex + 1).trim();
      if (pageId && token) {
        tokens.set(pageId, token);
      }
    }
  }

  return tokens;
}

function readOpenClawTelegramBotToken() {
  const configPath = process.env.OPENCLAW_CONFIG_PATH || "/opt/openclaw/config/openclaw.json";
  if (!existsSync(configPath)) return "";

  try {
    const body = JSON.parse(readFileSync(configPath, "utf8"));
    return body?.channels?.telegram?.botToken || "";
  } catch (error) {
    console.warn(`[config] Failed to read Telegram bot token from OpenClaw config: ${error.message}`);
    return "";
  }
}

function normalizePhoneValue(phone) {
  return String(phone || "").replace(/[^\d+]/gu, "").replace(/^\+84/u, "0");
}

function readPrompt() {
  const promptFile = process.env.BOT_SYSTEM_PROMPT_FILE;
  if (promptFile) {
    const path = promptFile.startsWith("/") ? promptFile : join(__dirname, promptFile);
    if (existsSync(path)) {
      return readFileSync(path, "utf8").trim();
    }
    console.warn(`[config] BOT_SYSTEM_PROMPT_FILE not found: ${path}`);
  }

  return (
    process.env.BOT_SYSTEM_PROMPT ||
    "Ban la tro ly AI tra loi tren Facebook Messenger. Tra loi bang tieng Viet, ngan gon, than thien, va hoi lai khi chua ro."
  );
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/u, "");
}

function ensurePathPrefix(value) {
  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  return withLeadingSlash.endsWith("/") ? withLeadingSlash : `${withLeadingSlash}/`;
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/đ/gu, "d")
    .replace(/Đ/gu, "D")
    .toLowerCase();
}

function sanitizeSessionPart(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9_.:-]/gu, "_");
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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

export const __test = {
  buildEmergencySalesReply,
  buildOrderDetailsConfirmationReply,
  detectNewOrderForNotification,
  getOrderNotificationContactKey,
  hasConfirmedOrderMessageAfterCustomer,
  extractDetailedAddressLinesFromText,
  extractOrderNotifyProduct,
  isOrderConfirmationPageMessage,
  isMetaAutoPageMessage,
  isExplicitProductMediaRequest,
  shouldConfirmOrderDetailsFromCustomer,
  getMatchedProductMediaRules
};
