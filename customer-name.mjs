const VIETNAMESE_SURNAMES = new Set([
  "nguyen", "tran", "le", "pham", "hoang", "huynh", "phan", "vu", "vo",
  "dang", "bui", "do", "ho", "ngo", "duong", "ly", "dinh", "truong", "mai",
  "cao", "luong", "ta", "thai", "to", "trinh", "dao", "lam", "ton", "chung"
]);

export function extractCustomerShortName(customerProfile = {}) {
  const metaFirstName = cleanNameParts(customerProfile.firstName);
  if (metaFirstName.length > 0) return metaFirstName.at(-1);

  const fullName = cleanNameParts(customerProfile.name);
  if (fullName.length === 0) return "";
  if (fullName.length === 1) return fullName[0];

  const finalPart = fullName.at(-1);
  if (fullName.length >= 3 && VIETNAMESE_SURNAMES.has(normalizeNamePart(finalPart))) {
    return fullName.at(-2);
  }
  return finalPart;
}

export function mergeStructuredCustomerProfile(fallbackProfile = {}, structuredProfile = {}) {
  return {
    ...fallbackProfile,
    ...structuredProfile,
    id: structuredProfile.id || fallbackProfile.id || "",
    name: structuredProfile.name || fallbackProfile.name || "",
    firstName: structuredProfile.firstName || fallbackProfile.firstName || "",
    lastName: structuredProfile.lastName || fallbackProfile.lastName || "",
    gender: structuredProfile.gender || fallbackProfile.gender || ""
  };
}

function cleanNameParts(name) {
  return String(name || "").trim().split(/\s+/u).filter(Boolean);
}

function normalizeNamePart(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/đ/giu, "d")
    .toLowerCase();
}
