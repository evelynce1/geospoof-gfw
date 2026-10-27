/**
 * Mainland-direct ("大陆直连") rules: pattern grammar, matching, and
 * validation.
 *
 * A matching rule does NOT pick a location. It means "do not spoof this
 * tab": the page sees the real location and timezone, while every other
 * tab keeps the main (VPN-synced) location. The resolver that applies
 * this lives in stage 2; this module is only the grammar and the matcher.
 *
 * Pure: no `browser.*`, no storage, no clock. The only state is the
 * caller-supplied rule list, so the popup, the background, and the tests
 * can never disagree about a host.
 *
 * Grammar (stage 1):
 *   - `DOMAIN,host`            — exact host only
 *   - `DOMAIN-SUFFIX,host`     — host + all subdomains
 *   - `DOMAIN-KEYWORD,word`    — host contains `word` (case-insensitive)
 *   - `IP-CIDR,1.2.3.0/24`     — IPv4 literal in the range (bare IP = /32)
 *   - bare `host`              — same as DOMAIN-SUFFIX
 *   - `*.host`                 — subdomains only, apex excluded
 *   - `.host`                  — same as bare `host`
 *   - `||host^`                — GFWList-style suffix, host part only
 *
 * Domain values may be Unicode; matching also tries their ASCII
 * (A-label) form, because a page URL's hostname is already punycode.
 * Keyword matching does not get that treatment: a Unicode keyword
 * cannot be derived from a punycode host without a decode step.
 *
 * Deliberately NOT in stage 1: regex rules (ReDoS surface), GEOIP /
 * GEOSITE / RULE-SET (they name a database or a provider, not a list of
 * hosts, so they cannot be matched from the host alone), IPv6, schemes,
 * ports, and paths. Those inputs are rejected, never silently reinterpreted.
 * Comment lines (`!`, `#`, `//`), empty lines, `[AutoProxy]` headers, and
 * `@@` lines are skipped, not errors. A line whose policy field (the third
 * comma field, when present) is anything other than `DIRECT` is rejected:
 * turning a PROXY rule into a direct rule would invert the user's intent.
 */

import type { DirectRule, DirectRuleKind } from "@/shared/types/settings";
import { MAX_DIRECT_RULES, MAX_DIRECT_RULE_ID_LENGTH } from "@/shared/types/settings";
import { hostToASCII } from "@/shared/utils/idn";

/** A parsed rule without storage metadata (id, source, timestamps). */
export interface ParsedDirectRule {
  kind: DirectRuleKind;
  value: string;
}

/** Result of parsing a block of rule text, one rule per line. */
export interface ParsedDirectRulesText {
  /** Canonical parsed rules, duplicates removed (first occurrence kept). */
  entries: ParsedDirectRule[];
  /** Lines that were present but not usable, in input order. */
  invalidLines: string[];
  /** Lines skipped as comments, blanks, headers, or `@@` lines. */
  skippedLines: number;
  /** Lines dropped because an identical rule appeared earlier. */
  duplicateLines: string[];
}

const DIRECT_RULE_KINDS = new Set<DirectRuleKind>([
  "domain",
  "domain-suffix",
  "domain-keyword",
  "ipv4-cidr",
]);

const DIRECT_RULE_SOURCES = new Set(["builtin", "local", "import"]);

/** Maximum accepted raw input length before any trimming. */
const MAX_INPUT_LENGTH = 2048;
/** Maximum total length of a normalized DNS hostname. */
const MAX_HOSTNAME_LENGTH = 253;
/** Maximum length of a single DNS label. */
const MAX_LABEL_LENGTH = 63;
/** Maximum length of a keyword value. */
const MAX_KEYWORD_LENGTH = 253;

// ─────────────────────────────── Host helpers ───────────────────────────────

/**
 * Normalize a hostname for matching: NFC, lowercase, one trailing dot
 * stripped. Returns null for empty input and for bracketed IPv6 literals,
 * which stage 1 does not match. This takes a hostname, not a URL and not
 * a host:port pair — callers extract `new URL(url).hostname` first.
 */
export function normalizeHost(host: string): string | null {
  const normalized = host.normalize("NFC").toLowerCase();
  const trimmed = normalized.trim();
  if (trimmed.length === 0 || trimmed.startsWith("[")) {
    return null;
  }
  const withoutDot = trimmed.length > 1 && trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  return withoutDot.length > 0 ? withoutDot : null;
}

/** True when `cp` is allowed in a host label: `[a-z0-9-]` or non-ASCII. */
function isAllowedLabelChar(cp: number): boolean {
  if (cp > 0x7f) {
    return true;
  }
  return (
    (cp >= 0x61 && cp <= 0x7a) || // a–z
    (cp >= 0x30 && cp <= 0x39) || // 0–9
    cp === 0x2d // hyphen-minus
  );
}

/** True when `value` is a valid (already normalized) domain or suffix base. */
function isValidDomainValue(value: string): boolean {
  if (value.length === 0 || value.length > MAX_HOSTNAME_LENGTH) {
    return false;
  }
  for (const label of value.split(".")) {
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH) {
      return false;
    }
    if (label.startsWith("-") || label.endsWith("-")) {
      return false;
    }
    for (const ch of label) {
      const cp = ch.codePointAt(0);
      if (cp === undefined || !isAllowedLabelChar(cp)) {
        return false;
      }
    }
  }
  return true;
}

/** True when `value` is a valid (already normalized) keyword. */
function isValidKeywordValue(value: string): boolean {
  if (value.length === 0 || value.length > MAX_KEYWORD_LENGTH) {
    return false;
  }
  // A keyword is matched against the host with `includes`, so it must not
  // carry characters that only make sense in another grammar.
  return !/[\s,/:@*?^|[\]]/.test(value);
}

// ─────────────────────────────── IPv4 helpers ───────────────────────────────

/** Parse a dotted IPv4 literal into an unsigned 32-bit number, or null. */
export function parseIPv4(value: string): number | null {
  const octets = value.split(".");
  if (octets.length !== 4) {
    return null;
  }
  let result = 0;
  for (const octet of octets) {
    if (!/^[0-9]{1,3}$/.test(octet)) {
      return null;
    }
    const num = Number(octet);
    if (num > 255) {
      return null;
    }
    result = result * 256 + num;
  }
  return result >>> 0;
}

/** Render an unsigned 32-bit number as a dotted IPv4 literal. */
function ipv4ToString(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(
    "."
  );
}

/**
 * Canonicalize an IPv4 CIDR: `1.2.3.0/24`, or a bare IP as `/32`.
 * Host bits are cleared, so `1.2.3.4/24` canonicalizes to `1.2.3.0/24`.
 * Returns null for bad IPs, bad prefixes, and anything else.
 */
export function parseCidr(value: string): string | null {
  const slash = value.indexOf("/");
  const ipPart = slash === -1 ? value : value.slice(0, slash);
  const prefixPart = slash === -1 ? "32" : value.slice(slash + 1);
  const ip = parseIPv4(ipPart);
  if (ip === null) {
    return null;
  }
  if (!/^[0-9]{1,2}$/.test(prefixPart)) {
    return null;
  }
  const prefix = Number(prefixPart);
  if (prefix < 0 || prefix > 32) {
    return null;
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ip & mask) >>> 0;
  return `${ipv4ToString(network)}/${prefix}`;
}

// ─────────────────────────────── Parsing ───────────────────────────────

/** True when a text line carries no rule: blank, comment, header, `@@`. */
export function isSkippedDirectRuleLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length === 0 ||
    trimmed.startsWith("!") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("@@")
  );
}

function parseCommaRule(input: string): ParsedDirectRule | null {
  const parts = input.split(",");
  const type = parts[0].trim().toUpperCase();
  const rawValue = parts[1] === undefined ? "" : parts[1].trim();
  if (rawValue.length === 0) {
    return null;
  }
  // A policy field, when present, must say DIRECT. A PROXY / REJECT /
  // group rule pasted into a direct-rule list must not silently become
  // a direct rule; it is invalid here and counted as such by the caller.
  if (parts.length >= 3) {
    const policy = parts[2].trim().toUpperCase();
    if (policy !== "" && policy !== "DIRECT") {
      return null;
    }
  }
  switch (type) {
    case "DOMAIN": {
      const value = normalizeHost(rawValue);
      return value !== null && isValidDomainValue(value) ? { kind: "domain", value } : null;
    }
    case "DOMAIN-SUFFIX": {
      const value = normalizeHost(rawValue);
      return value !== null && isValidDomainValue(value) ? { kind: "domain-suffix", value } : null;
    }
    case "DOMAIN-KEYWORD": {
      const value = rawValue.normalize("NFC").toLowerCase();
      return isValidKeywordValue(value) ? { kind: "domain-keyword", value } : null;
    }
    case "IP-CIDR": {
      const value = parseCidr(rawValue);
      return value !== null ? { kind: "ipv4-cidr", value } : null;
    }
    default:
      // GEOIP, GEOSITE, RULE-SET, MATCH, DOMAIN-REGEX, IP-CIDR6, and
      // anything else: unsupported in stage 1, rejected, never reinterpreted.
      return null;
  }
}

function parseBareRule(input: string): ParsedDirectRule | null {
  if (input.startsWith("*.")) {
    const base = normalizeHost(input.slice(2));
    return base !== null && isValidDomainValue(base)
      ? { kind: "domain-suffix", value: `*.${base}` }
      : null;
  }
  if (input.startsWith(".")) {
    const base = normalizeHost(input.slice(1));
    return base !== null && isValidDomainValue(base)
      ? { kind: "domain-suffix", value: base }
      : null;
  }
  if (/^[0-9.]+$/.test(input)) {
    const value = parseCidr(input);
    return value !== null ? { kind: "ipv4-cidr", value } : null;
  }
  const value = normalizeHost(input);
  return value !== null && isValidDomainValue(value) ? { kind: "domain-suffix", value } : null;
}

/**
 * Parse one rule from user input, or null when it is skipped, invalid,
 * or of an unsupported type. Skipped lines (comments, `@@`, headers)
 * also return null; callers that need the distinction use
 * `isSkippedDirectRuleLine` first, as `parseDirectRulesText` does.
 */
export function parseDirectRule(input: string): ParsedDirectRule | null {
  if (typeof input !== "string" || input.length > MAX_INPUT_LENGTH) {
    return null;
  }
  const trimmed = input.trim();
  if (trimmed.length === 0 || isSkippedDirectRuleLine(trimmed)) {
    return null;
  }
  if (trimmed.startsWith("||")) {
    // GFWList-style suffix: `||host^`, host part only, path ignored.
    const rest = trimmed.slice(2).split(/[/^]/, 1)[0] ?? "";
    const value = normalizeHost(rest);
    return value !== null && isValidDomainValue(value) ? { kind: "domain-suffix", value } : null;
  }
  if (trimmed.startsWith("|")) {
    return null;
  }
  if (trimmed.includes("://")) {
    return null;
  }
  return trimmed.includes(",") ? parseCommaRule(trimmed) : parseBareRule(trimmed);
}

/**
 * Parse a block of rule text, one rule per line. Duplicates are removed
 * by canonical kind+value, keeping the first occurrence. Unsupported
 * types land in `invalidLines`, not in `skippedLines`, so a pasted list
 * cannot silently lose rules the user thought were applied.
 */
export function parseDirectRulesText(text: string): ParsedDirectRulesText {
  const entries: ParsedDirectRule[] = [];
  const invalidLines: string[] = [];
  const duplicateLines: string[] = [];
  let skippedLines = 0;
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (isSkippedDirectRuleLine(trimmed)) {
      skippedLines += 1;
      continue;
    }
    const parsed = parseDirectRule(trimmed);
    if (parsed === null) {
      invalidLines.push(trimmed);
      continue;
    }
    const key = `${parsed.kind}:${parsed.value}`;
    if (seen.has(key)) {
      duplicateLines.push(trimmed);
      continue;
    }
    seen.add(key);
    entries.push(parsed);
  }
  return { entries, invalidLines, skippedLines, duplicateLines };
}

// ─────────────────────────────── Validation ───────────────────────────────

/** Dedupe key for a stored rule: kind + canonical value. */
function directRuleKey(rule: ParsedDirectRule): string {
  return `${rule.kind}:${rule.value}`;
}

/**
 * Repair one stored rule, or null when it cannot be repaired. A value
 * that is not already in canonical form (wrong case, trailing dot,
 * host bits set in a CIDR, non-canonical network) is dropped rather than
 * silently rewritten, matching the defensive load-time stance of the
 * site-location validator: hand-edited storage must not change meaning.
 */
export function normalizeDirectRule(rule: unknown): DirectRule | null {
  if (!rule || typeof rule !== "object") {
    return null;
  }
  const candidate = rule as Record<string, unknown>;
  const { id, kind, value, enabled, source, updatedAt } = candidate;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > MAX_DIRECT_RULE_ID_LENGTH ||
    typeof kind !== "string" ||
    !DIRECT_RULE_KINDS.has(kind as DirectRuleKind) ||
    typeof value !== "string" ||
    typeof enabled !== "boolean" ||
    typeof source !== "string" ||
    !DIRECT_RULE_SOURCES.has(source)
  ) {
    return null;
  }
  const parsed = parseDirectRuleForKind(kind as DirectRuleKind, value);
  if (parsed === null || parsed.value !== value) {
    return null;
  }
  return {
    id,
    kind: kind as DirectRuleKind,
    value,
    enabled,
    source: source as DirectRule["source"],
    updatedAt:
      typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt >= 0 ? updatedAt : 0,
  };
}

/** Parse `value` as if it were written for `kind`, without a type prefix. */
function parseDirectRuleForKind(kind: DirectRuleKind, value: string): ParsedDirectRule | null {
  switch (kind) {
    case "domain": {
      const normalized = normalizeHost(value);
      return normalized !== null && normalized === value && isValidDomainValue(value)
        ? { kind, value }
        : null;
    }
    case "domain-suffix": {
      if (value.startsWith("*.")) {
        const base = value.slice(2);
        const normalized = normalizeHost(base);
        return normalized !== null && normalized === base && isValidDomainValue(base)
          ? { kind, value }
          : null;
      }
      const normalized = normalizeHost(value);
      return normalized !== null && normalized === value && isValidDomainValue(value)
        ? { kind, value }
        : null;
    }
    case "domain-keyword":
      return isValidKeywordValue(value) && value === value.toLowerCase() ? { kind, value } : null;
    case "ipv4-cidr": {
      const canonical = parseCidr(value);
      return canonical !== null && canonical === value ? { kind, value } : null;
    }
    default:
      return null;
  }
}

/**
 * Repair a stored direct-rule list: drop invalid entries, drop duplicate
 * ids and duplicate kind+value pairs (first occurrence kept), cap at
 * `MAX_DIRECT_RULES`. A non-array input repairs to `[]`; the settings
 * layer decides when an absent list means the built-in defaults instead.
 */
export function validateDirectRules(value: unknown): DirectRule[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: DirectRule[] = [];
  const seenIds = new Set<string>();
  const seenKeys = new Set<string>();
  for (const raw of value) {
    if (out.length >= MAX_DIRECT_RULES) {
      break;
    }
    const normalized = normalizeDirectRule(raw);
    if (normalized === null || seenIds.has(normalized.id)) {
      continue;
    }
    const key = directRuleKey(normalized);
    if (seenKeys.has(key)) {
      continue;
    }
    seenIds.add(normalized.id);
    seenKeys.add(key);
    out.push(normalized);
  }
  return out;
}

// ─────────────────────────────── Matching ───────────────────────────────

/**
 * How specific a matching rule is, compared lexicographically (positive
 * when `a` is more specific). The outcome is always "do not spoof", so
 * specificity only decides which rule is reported as the match:
 *   - tier: CIDR (3) > exact domain (2) > suffix (1) > keyword (0)
 *   - detail: CIDR prefix length, domain label count, keyword length
 *   - subdomainsOnly: 1 for `*.base`, which excludes the apex and is
 *     narrower than the bare base for the same host
 */
type DirectRuleSpecificity = readonly [tier: number, detail: number, subdomainsOnly: 0 | 1];

function directRuleSpecificity(rule: DirectRule): DirectRuleSpecificity {
  switch (rule.kind) {
    case "ipv4-cidr": {
      const prefix = Number(rule.value.split("/")[1] ?? "0");
      return [3, prefix, 0];
    }
    case "domain":
      return [2, rule.value.split(".").length, 0];
    case "domain-suffix": {
      const subdomainsOnly = rule.value.startsWith("*.") ? 1 : 0;
      const base = subdomainsOnly === 1 ? rule.value.slice(2) : rule.value;
      return [1, base.split(".").length, subdomainsOnly];
    }
    case "domain-keyword":
      return [0, rule.value.length, 0];
    default:
      return [0, 0, 0];
  }
}

function compareSpecificity(a: DirectRuleSpecificity, b: DirectRuleSpecificity): number {
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * The ASCII (A-label) forms of a domain value. A URL's hostname is already
 * ASCII, so a Unicode rule such as `例子.com` would never match its own
 * punycode host without this; a pure-ASCII value yields just itself.
 */
function domainForms(value: string): string[] {
  let asciiOnly = true;
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || cp > 0x7f) {
      asciiOnly = false;
      break;
    }
  }
  if (asciiOnly) {
    return [value];
  }
  const ascii = hostToASCII(value);
  return ascii !== null && ascii !== value ? [value, ascii] : [value];
}

/** True when `rule` matches the already-normalized host. */
function ruleMatchesHost(rule: DirectRule, host: string, hostIp: number | null): boolean {
  switch (rule.kind) {
    case "domain":
      return domainForms(rule.value).includes(host);
    case "domain-suffix": {
      if (rule.value.startsWith("*.")) {
        const base = rule.value.slice(2);
        return domainForms(base).some((form) => host !== form && host.endsWith(`.${form}`));
      }
      return domainForms(rule.value).some((form) => host === form || host.endsWith(`.${form}`));
    }
    case "domain-keyword":
      return host.includes(rule.value);
    case "ipv4-cidr": {
      if (hostIp === null) {
        return false;
      }
      const slash = rule.value.indexOf("/");
      const network = parseIPv4(rule.value.slice(0, slash));
      const prefix = Number(rule.value.slice(slash + 1));
      if (network === null || !Number.isFinite(prefix)) {
        return false;
      }
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      return (hostIp & mask) >>> 0 === network;
    }
    default:
      return false;
  }
}

/**
 * The most specific enabled rule matching `host`, or null. Disabled
 * rules never match. Ties go to the higher `updatedAt`, then to the
 * lexicographically smaller `id` (plain `<`, locale-free), so the result
 * does not depend on list order. `host` is a hostname, not a URL.
 */
export function matchDirectRule(host: string, rules: readonly DirectRule[]): DirectRule | null {
  const normalized = normalizeHost(host);
  if (normalized === null) {
    return null;
  }
  const hostIp = parseIPv4(normalized);
  let best: { rule: DirectRule; score: DirectRuleSpecificity } | null = null;
  for (const rule of rules) {
    if (!rule.enabled || !ruleMatchesHost(rule, normalized, hostIp)) {
      continue;
    }
    const score = directRuleSpecificity(rule);
    if (best === null) {
      best = { rule, score };
      continue;
    }
    const cmp = compareSpecificity(score, best.score);
    const wins =
      cmp > 0 ||
      (cmp === 0 &&
        (rule.updatedAt > best.rule.updatedAt ||
          (rule.updatedAt === best.rule.updatedAt && rule.id < best.rule.id)));
    if (wins) {
      best = { rule, score };
    }
  }
  return best === null ? null : best.rule;
}

/** True when any enabled rule matches `host`. */
export function matchesDirectRule(host: string, rules: readonly DirectRule[]): boolean {
  return matchDirectRule(host, rules) !== null;
}
