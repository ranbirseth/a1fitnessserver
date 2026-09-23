/**
 * Temporary WhatsApp reminder flow debug logging (Phase 15).
 *
 * Prints a consistent `[WHATSAPP] -->` prefix so the reminder flow can be
 * traced from the request down to the Meta API call. Errors use
 * `[WHATSAPP] --> ERROR:` (recoverable step failure) and
 * `[WHATSAPP] --> BREAK:` (flow aborted).
 *
 * Disable everything by setting WHATSAPP_DEBUG=false. Nothing sensitive is ever
 * logged here: no access tokens, credentials, Authorization headers, passwords,
 * refresh tokens, or full phone numbers (use maskPhone for those).
 */

/**
 * Whether debug logging is enabled. Read lazily (per call) so it honours
 * environments that load dotenv AFTER this module is required.
 */
const enabled = () => String(process.env.WHATSAPP_DEBUG || "true").trim().toLowerCase() !== "false";

/** Normal flow log: `[WHATSAPP] --> ...` */
function log(...args) {
  if (enabled()) console.log("[WHATSAPP] -->", ...args);
}

/** Step failed but the flow can continue: `[WHATSAPP] --> ERROR: ...` */
function error(...args) {
  if (enabled()) console.error("[WHATSAPP] --> ERROR:", ...args);
}

/** Flow aborted at this step: `[WHATSAPP] --> BREAK: ...` */
function breakLog(...args) {
  if (enabled()) console.error("[WHATSAPP] --> BREAK:", ...args);
}

/**
 * Mask a phone number for debug output: shows only the first 2 and last 2
 * digits, e.g. 919876543210 -> 91********10.
 */
function maskPhone(phone) {
  const digits = String(phone === null || phone === undefined ? "" : phone).replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `${digits.slice(0, 2)}${"*".repeat(digits.length - 4)}${digits.slice(-2)}`;
}

/**
 * Print a SAFE configuration snapshot. `cfg` must come from
 * WhatsAppService.getSafeConfig() (booleans + non-secret values only).
 * Never pass the access token or credentials anywhere near this function.
 */
function logConfig(cfg) {
  if (!enabled()) return;
  log("-- WhatsApp configuration diagnostics --");
  log(`WhatsApp enabled: ${String(cfg.enabled)}`);
  log(`WhatsApp provider: ${cfg.provider || "(not set)"}`);
  log(`Phone number ID configured: ${String(cfg.hasPhoneNumberId)}`);
  log(`Access token configured: ${String(cfg.hasAccessToken)}`);
  log(`Business account ID configured: ${String(cfg.hasBusinessAccountId)}`);
  log(`Template configured: ${String(Boolean(cfg.templateName))} (name=${cfg.templateName || "n/a"}, language=${cfg.templateLanguage || "n/a"})`);
  log(`API version: ${cfg.apiVersion || "n/a"}; country code: ${cfg.countryCode || "n/a"}`);
  log(`Provider ready: ${String(cfg.configured)}`);
}

module.exports = { log, error, breakLog, maskPhone, logConfig, enabled };