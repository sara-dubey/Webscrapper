const PASSWORD_POLICY = Object.freeze({
  minLength: 12,
  requiresUppercase: true,
  requiresLowercase: true,
  requiresNumber: true,
  requiresSpecial: true,
  disallowWhitespace: true,
  disallowEmailPart: true,
});

const COMMON_WEAK_PASSWORDS = new Set([
  "password",
  "password123",
  "123456",
  "12345678",
  "qwerty",
  "letmein",
  "admin",
  "welcome",
  "iloveyou",
]);

const COMMON_PATTERNS = [/1234/i, /qwerty/i, /password/i, /letmein/i, /admin/i];

export function getPasswordPolicy() {
  return PASSWORD_POLICY;
}

export function getPasswordRuleText() {
  return [
    "Use at least 12 characters.",
    "Include uppercase, lowercase, number, and symbol.",
    "Do not use spaces.",
    "Do not include your email name.",
    "Avoid common passwords and obvious patterns.",
  ];
}

export function checkPasswordStrength(password, { email = "" } = {}) {
  const value = String(password || "");
  const normalized = value.toLowerCase();
  const errors = [];

  if (value.length < PASSWORD_POLICY.minLength) {
    errors.push("Password must be at least 12 characters long.");
  }

  if (PASSWORD_POLICY.requiresLowercase && !/[a-z]/.test(value)) {
    errors.push("Password must include a lowercase letter.");
  }

  if (PASSWORD_POLICY.requiresUppercase && !/[A-Z]/.test(value)) {
    errors.push("Password must include an uppercase letter.");
  }

  if (PASSWORD_POLICY.requiresNumber && !/\d/.test(value)) {
    errors.push("Password must include a number.");
  }

  if (PASSWORD_POLICY.requiresSpecial && !/[^A-Za-z0-9]/.test(value)) {
    errors.push("Password must include a special character.");
  }

  if (PASSWORD_POLICY.disallowWhitespace && /\s/.test(value)) {
    errors.push("Password cannot contain spaces.");
  }

  const emailName = String(email || "")
    .trim()
    .toLowerCase()
    .split("@")[0];
  if (PASSWORD_POLICY.disallowEmailPart && emailName && emailName.length >= 3 && normalized.includes(emailName)) {
    errors.push("Password cannot include your email username.");
  }

  if (COMMON_WEAK_PASSWORDS.has(normalized)) {
    errors.push("Password is too common.");
  }

  if (/(.)\1{3,}/.test(value)) {
    errors.push("Password cannot contain long repeated characters.");
  }

  if (COMMON_PATTERNS.some((rx) => rx.test(value))) {
    errors.push("Password contains an easy-to-guess pattern.");
  }

  return {
    ok: errors.length === 0,
    errors,
    policy: getPasswordPolicy(),
    hints: getPasswordRuleText(),
  };
}
