/**
 * Secret redaction utility.
 *
 * Patterns adapted from openclaw-ops (MIT License, Cathryn Lavery).
 * @see https://github.com/cathrynlavery/openclaw-ops
 */

export type SecretMatch = {
  pattern: string;
  label: string;
  index: number;
  /** A short context snippet around the match (redacted). */
  snippet: string;
};

type SecretPattern = {
  label: string;
  pattern: RegExp;
  replacement: string;
};

const SECRET_PATTERNS: SecretPattern[] = [
  // Anthropic API keys
  { label: "anthropic-key", pattern: /sk-ant-[a-zA-Z0-9_-]{48,}/g, replacement: "[REDACTED_ANTHROPIC_KEY]" },
  // OpenAI API keys (sk-proj- prefix or legacy sk- with 40+ chars, excluding sk-ant which is Anthropic)
  { label: "openai-key", pattern: /sk-proj-[a-zA-Z0-9_-]{40,}/g, replacement: "[REDACTED_API_KEY]" },
  { label: "openai-key-legacy", pattern: /sk-(?!ant)[a-zA-Z0-9]{40,}/g, replacement: "[REDACTED_API_KEY]" },
  // GitHub personal access tokens
  { label: "github-token", pattern: /ghp_[a-zA-Z0-9]{36}/g, replacement: "[REDACTED_GH_TOKEN]" },
  // Slack bot tokens
  { label: "slack-bot-token", pattern: /xoxb-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24,32}/g, replacement: "[REDACTED_SLACK_TOKEN]" },
  // Slack user tokens
  { label: "slack-user-token", pattern: /xoxp-[0-9]{10,13}/g, replacement: "[REDACTED_SLACK_TOKEN]" },
  // AWS access keys
  { label: "aws-key", pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[REDACTED_AWS_KEY]" },
  // Google API keys
  { label: "google-key", pattern: /AIza[0-9A-Za-z_-]{35}/g, replacement: "[REDACTED_GOOGLE_KEY]" },
  // Stripe live keys
  { label: "stripe-live-key", pattern: /sk_live_[a-zA-Z0-9]{24,}/g, replacement: "[REDACTED_STRIPE_KEY]" },
  // Stripe restricted keys
  { label: "stripe-restricted-key", pattern: /rk_live_[a-zA-Z0-9]{24,}/g, replacement: "[REDACTED_STRIPE_KEY]" },
  // Private keys (RSA PRIVATE KEY, OPENSSH PRIVATE KEY, PRIVATE KEY)
  { label: "private-key", pattern: /-----BEGIN (?:RSA PRIVATE|OPENSSH PRIVATE|PRIVATE) KEY-----/g, replacement: "[REDACTED_PRIVATE_KEY]" },
  // Shopify tokens
  { label: "shopify-token", pattern: /shpat_[a-zA-Z0-9]{32,}/g, replacement: "[REDACTED_SHOPIFY_TOKEN]" },
  // GitLab tokens
  { label: "gitlab-token", pattern: /glpat-[a-zA-Z0-9_-]{20,}/g, replacement: "[REDACTED_GITLAB_TOKEN]" },
  // npm tokens
  { label: "npm-token", pattern: /npm_[a-zA-Z0-9]{36}/g, replacement: "[REDACTED_NPM_TOKEN]" },
  // PyPI tokens
  { label: "pypi-token", pattern: /pypi-[a-zA-Z0-9]{32,}/g, replacement: "[REDACTED_PYPI_TOKEN]" },
  // SendGrid keys
  { label: "sendgrid-key", pattern: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/g, replacement: "[REDACTED_SENDGRID_KEY]" },
  // Square tokens
  { label: "square-token", pattern: /sq0atp-[a-zA-Z0-9_-]{22}/g, replacement: "[REDACTED_SQUARE_TOKEN]" },
  // Twilio SIDs
  { label: "twilio-sid", pattern: /AC[a-f0-9]{32}/g, replacement: "[REDACTED_TWILIO_SID]" },
  // JWTs (long base64 with dots)
  { label: "jwt", pattern: /eyJ[a-zA-Z0-9_-]{20,}\.eyJ[a-zA-Z0-9_-]{20,}/g, replacement: "[REDACTED_JWT]" },
  // DigitalOcean tokens
  { label: "digitalocean-token", pattern: /dop_v1_[a-f0-9]{64}/g, replacement: "[REDACTED_DO_TOKEN]" },
  // Bearer tokens in headers/logs
  { label: "bearer-token", pattern: /Bearer\s+[A-Za-z0-9._-]{20,}/gi, replacement: "Bearer [REDACTED]" },
  // JSON credential fields ("password": "...", "secret": "...", etc.)
  {
    label: "json-credential",
    pattern: /("(?:password|secret|token|api_key|apiKey|auth_token|access_token|refresh_token|client_secret)":\s*")([^"]+)(")/gi,
    replacement: "$1[REDACTED]$3",
  },
];

const PLACEHOLDER_RE = /\b(example|template|placeholder|your-|TODO|sample|demo)\b/i;

/**
 * Replace all secret patterns in `text` with redacted placeholders.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Scan text for secret patterns and return match details.
 * Useful for compliance scoring — tells you what was found and where.
 */
export function scanForSecrets(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];

  for (const { label, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const raw = match[0];
      // Skip obvious placeholders/examples
      if (PLACEHOLDER_RE.test(raw)) continue;

      // Build a short context snippet around the match
      const start = Math.max(0, match.index - 20);
      const end = Math.min(text.length, match.index + raw.length + 20);
      const rawSnippet = text.slice(start, end);
      // Redact the secret in the snippet itself
      const snippet = rawSnippet.replace(raw, `[${label.toUpperCase()}]`);

      matches.push({
        pattern: label,
        label,
        index: match.index,
        snippet: snippet.replace(/\n/g, " "),
      });
    }
  }

  return matches;
}
