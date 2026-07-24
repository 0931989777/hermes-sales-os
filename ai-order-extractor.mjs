// ai-order-extractor.mjs — AI-first order extraction with deterministic validator
// Calls Hermes directly with provider HermesBM (not through adapter).
import { execFileSync } from 'node:child_process';

// ═══════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════
function readEnv(name, fallback = '') {
  return process.env[name] || fallback;
}

const HERMES_BIN = readEnv('HERMES_DIRECT_BIN', '/home/HMBM/.hermes/hermes-agent/venv/bin/hermes');
const HERMES_PROVIDER = readEnv('HERMES_DIRECT_PROVIDER', 'HermesBM');
const HERMES_MODEL = readEnv('HERMES_DIRECT_MODEL', 'HermesBM');
const HERMES_TIMEOUT_SECONDS = Math.max(5, Number(readEnv('AI_ORDER_EXTRACTION_TIMEOUT_SECONDS', '25')) || 25);

// ═══════════════════════════════════════════════════
// Known products — single source of truth for pricing
// ═══════════════════════════════════════════════════
export const KNOWN_PRODUCTS = {
  'ngo_men_la': {
    id: 'ngo_men_la',
    name: 'rượu ngô men lá',
    price5L: 330000,
    price20L: 1200000
  },
  'tam_giac_mach': {
    id: 'tam_giac_mach',
    name: 'rượu tam giác mạch',
    price5L: 330000,
    price20L: 1200000
  }
};

// ═══════════════════════════════════════════════════
// Placeholder address patterns
// ═══════════════════════════════════════════════════
const ADDRESS_PLACEHOLDER_PATTERNS = [
  /^(cũ|cu|như cũ|nhu cu|địa chỉ cũ|dia chi cu|địa chỉ như cũ|dia chi nhu cu|chỗ cũ|cho cu|về chỗ cũ|ve cho cu|gửi chỗ cũ|gui cho cu)$/iu,
];

function isAddressPlaceholder(address) {
  const cleaned = String(address || '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();
  if (!cleaned) return true;
  return ADDRESS_PLACEHOLDER_PATTERNS.some(p => p.test(cleaned));
}

// ═══════════════════════════════════════════════════
// Phone validation
// ═══════════════════════════════════════════════════
function isValidPhone(phone) {
  const digits = String(phone || '').replace(/\D/gu, '');
  return digits.length === 10;
}

function normalizePhone(phone) {
  let digits = String(phone || '').replace(/\D/gu, '');
  if (digits.startsWith('84') && digits.length === 11) digits = '0' + digits.slice(2);
  return digits.length === 10 ? digits : phone;
}

// ═══════════════════════════════════════════════════
// Deterministic order validator — code has final say
// ═══════════════════════════════════════════════════
export function validateAIOrder(aiOrder, knownProducts = KNOWN_PRODUCTS) {
  if (!aiOrder || typeof aiOrder !== 'object') return false;

  const { product, quantity, package: pkg, phone, address, isAddOn } = aiOrder;

  const productDef = knownProducts[product];
  if (!productDef) return false;
  if (!Number.isInteger(quantity) || quantity < 1) return false;
  if (pkg !== '5L' && pkg !== '20L') return false;
  if (!isValidPhone(phone)) return false;
  if (isAddressPlaceholder(address)) return false;

  const unitPrice = pkg === '20L' ? productDef.price20L : productDef.price5L;
  const productAmount = quantity * unitPrice;
  let shippingAmount = 0;
  if (pkg === '5L') {
    shippingAmount = quantity === 1 ? 20000 : 0;
  }

  return {
    product: productDef.id,
    productName: productDef.name,
    quantity,
    package: pkg,
    phone: normalizePhone(phone),
    address,
    isAddOn: Boolean(isAddOn),
    productAmount,
    shippingAmount,
    totalAmount: productAmount + shippingAmount
  };
}

// ═══════════════════════════════════════════════════
// Conversation formatting for AI
// ═══════════════════════════════════════════════════
export function formatConversationForAI(messages, pageId) {
  const pageIdStr = String(pageId || '');
  const ordered = (messages || [])
    .filter(m => m?.created_time && typeof m.message === 'string' && m.message.trim())
    .sort((a, b) => new Date(a.created_time) - new Date(b.created_time))
    .slice(-20);

  if (ordered.length === 0) return '';

  return ordered.map(m => {
    const isPage = pageIdStr && String(m.from?.id || '') === pageIdStr;
    const role = isPage ? 'Page (Bản Mộc)' : 'Khách';
    const name = m.from?.name || '';
    const label = name && !isPage ? `${role} (${name})` : role;
    return `[${label}]: ${m.message.trim()}`;
  }).join('\n');
}

// ═══════════════════════════════════════════════════
// AI extraction prompt
// ═══════════════════════════════════════════════════
function buildExtractionPrompt(messages, pageId) {
  const conversation = formatConversationForAI(messages, pageId);
  return `Bạn là trợ lý trích xuất đơn hàng cho cửa hàng Bản Mộc. Nhiệm vụ: đọc hội thoại và trả về CHỈ MỘT object JSON, không thêm text nào khác.

Sản phẩm đã biết (dùng product id):
- "ngo_men_la": rượu ngô men lá Hà Giang
- "tam_giac_mach": rượu tam giác mạch Hà Giang

Quy tắc trích xuất:
1. Luôn lấy số lượng từ TIN NHẮN MỚI NHẤT của khách, không dùng số lượng cũ.
2. Nếu khách nói "thêm/lấy thêm/gửi thêm/nữa" → isAddOn = true; chỉ kế thừa loại rượu + SĐT + địa chỉ đầy đủ từ xác nhận Page trước đó, KHÔNG kế thừa số lượng.
3. Nếu địa chỉ là "cũ/như cũ/địa chỉ cũ" → không dùng, thay vào đó lấy địa chỉ đầy đủ từ xác nhận Page gần nhất.
4. Package: "5L" nếu khách nói túi/can 5 lít, "20L" nếu khách nói can 20 lít.
5. Nếu không xác định được → trả về {"intent": "unclear"}.
6. Nếu khách chỉ hỏi giá/tư vấn/chưa đặt → trả về {"intent": "inquiry"}.

Hội thoại:
${conversation}

Trả về JSON:`;
}

// ═══════════════════════════════════════════════════
// Main extraction function — calls Hermes directly
// ═══════════════════════════════════════════════════
export function extractOrderFromAI(messages, pageId, recipientId) {
  if (!messages || messages.length === 0) return null;

  try {
    const prompt = buildExtractionPrompt(messages, pageId);
    const timeoutMs = HERMES_TIMEOUT_SECONDS * 1000;

    const stdout = execFileSync(HERMES_BIN, [
      '--provider', HERMES_PROVIDER,
      '-m', HERMES_MODEL,
      '--ignore-rules',
      '-z', prompt
    ], {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      encoding: 'utf-8',
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    if (!stdout || looksLikeFailure(stdout)) {
      console.warn('[ai-order] Hermes returned failure/empty');
      return null;
    }

    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[ai-order] no JSON object in Hermes response');
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]);

    if (parsed.intent === 'unclear' || parsed.intent === 'inquiry') return null;

    const validated = validateAIOrder(parsed, KNOWN_PRODUCTS);
    if (!validated) {
      console.warn('[ai-order] validator rejected AI order:', JSON.stringify(parsed).slice(0, 200));
      return null;
    }

    return validated;
  } catch (err) {
    console.warn('[ai-order] extraction failed:', err.message);
    return null;
  }
}

function looksLikeFailure(output) {
  const s = String(output || '').trim();
  if (!s) return true;
  return /^API call failed/i.test(s) || /^HTTP 5\d\d:/i.test(s) || /distributor/i.test(s);
}
