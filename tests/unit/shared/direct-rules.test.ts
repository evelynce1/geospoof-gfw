import { describe, it, expect } from "vitest";
import type { DirectRule } from "@/shared/types/settings";
import { DEFAULT_DIRECT_RULES, DEFAULT_SETTINGS, MAX_DIRECT_RULES } from "@/shared/types/settings";
import {
  isSkippedDirectRuleLine,
  matchDirectRule,
  matchesDirectRule,
  normalizeDirectRule,
  normalizeHost,
  parseCidr,
  parseDirectRule,
  parseDirectRulesText,
  parseIPv4,
  validateDirectRules,
} from "@/shared/rules/direct-rules";
import { validateSettings } from "@/background/settings";

function rule(
  overrides: Partial<DirectRule> & { id: string; kind: DirectRule["kind"]; value: string }
): DirectRule {
  return {
    enabled: true,
    source: "local",
    updatedAt: 0,
    ...overrides,
  };
}

describe("normalizeHost", () => {
  it("lowercases and strips one trailing dot", () => {
    expect(normalizeHost("WWW.Baidu.COM.")).toBe("www.baidu.com");
  });

  it("returns null for empty and bracketed IPv6 hosts", () => {
    expect(normalizeHost("")).toBeNull();
    expect(normalizeHost("[::1]")).toBeNull();
  });
});

describe("parseIPv4 and parseCidr", () => {
  it("parses dotted quads and rejects bad ones", () => {
    expect(parseIPv4("223.5.5.5")).toBe(223 * 256 ** 3 + 5 * 256 ** 2 + 5 * 256 + 5);
    expect(parseIPv4("256.0.0.1")).toBeNull();
    expect(parseIPv4("1.2.3")).toBeNull();
    expect(parseIPv4("1.2.3.4.5")).toBeNull();
  });

  it("canonicalizes host bits and bare IPs", () => {
    expect(parseCidr("223.5.5.5/24")).toBe("223.5.5.0/24");
    expect(parseCidr("223.5.5.5")).toBe("223.5.5.5/32");
    expect(parseCidr("0.0.0.0/0")).toBe("0.0.0.0/0");
    expect(parseCidr("1.2.3.4/33")).toBeNull();
    expect(parseCidr("1.2.3.4/")).toBeNull();
    expect(parseCidr("1.2.3.4/abc")).toBeNull();
  });
});

describe("parseDirectRule", () => {
  it("treats a bare domain as a suffix", () => {
    expect(parseDirectRule("baidu.com")).toEqual({ kind: "domain-suffix", value: "baidu.com" });
    expect(parseDirectRule("cn")).toEqual({ kind: "domain-suffix", value: "cn" });
  });

  it("parses the comma forms", () => {
    expect(parseDirectRule("DOMAIN,baidu.com")).toEqual({ kind: "domain", value: "baidu.com" });
    expect(parseDirectRule("DOMAIN-SUFFIX,qq.com,DIRECT")).toEqual({
      kind: "domain-suffix",
      value: "qq.com",
    });
    expect(parseDirectRule("DOMAIN-KEYWORD,Baidu")).toEqual({
      kind: "domain-keyword",
      value: "baidu",
    });
    expect(parseDirectRule("IP-CIDR,223.5.5.0/24")).toEqual({
      kind: "ipv4-cidr",
      value: "223.5.5.0/24",
    });
  });

  it("keeps *. and . forms distinct from a bare suffix", () => {
    expect(parseDirectRule("*.baidu.com")).toEqual({
      kind: "domain-suffix",
      value: "*.baidu.com",
    });
    expect(parseDirectRule(".baidu.com")).toEqual({ kind: "domain-suffix", value: "baidu.com" });
  });

  it("parses the GFWList-style suffix form", () => {
    expect(parseDirectRule("||baidu.com^")).toEqual({ kind: "domain-suffix", value: "baidu.com" });
  });

  it("normalizes case and trailing dots", () => {
    expect(parseDirectRule("DOMAIN,WWW.Example.COM.")).toEqual({
      kind: "domain",
      value: "www.example.com",
    });
  });

  it.each([
    "",
    "   ",
    "http://example.com",
    "https://example.com/path",
    "example.com/path",
    "example.com:8080",
    "DOMAIN,",
    "DOMAIN-SUFFIX,",
    "DOMAIN-KEYWORD,",
    "DOMAIN-KEYWORD,a b",
    "IP-CIDR,999.0.0.0/8",
    "IP-CIDR,1.2.3.0/33",
    "IP-CIDR,1.2.3.0/-1",
    "DOMAIN,exa mple.com",
    "DOMAIN,-bad-.com",
    "DOMAIN,*.com",
  ])("rejects %s", (input) => {
    expect(parseDirectRule(input)).toBeNull();
  });

  it("rejects non-DIRECT policies instead of inverting them", () => {
    expect(parseDirectRule("DOMAIN-SUFFIX,example.com,Proxy")).toBeNull();
    expect(parseDirectRule("DOMAIN-SUFFIX,example.com,REJECT")).toBeNull();
  });

  it("rejects unsupported types instead of reinterpreting them", () => {
    expect(parseDirectRule("GEOIP,CN,DIRECT")).toBeNull();
    expect(parseDirectRule("GEOSITE,CN,DIRECT")).toBeNull();
    expect(parseDirectRule("RULE-SET,cn,DIRECT")).toBeNull();
    expect(parseDirectRule("MATCH,DIRECT")).toBeNull();
    expect(parseDirectRule("DOMAIN-REGEX,baidu,DIRECT")).toBeNull();
    expect(parseDirectRule("IP-CIDR6,::1/128,DIRECT")).toBeNull();
  });

  it("returns null for skipped lines (callers distinguish via isSkippedDirectRuleLine)", () => {
    expect(parseDirectRule("! comment")).toBeNull();
    expect(parseDirectRule("@@||example.com^")).toBeNull();
    expect(parseDirectRule("[AutoProxy 0.2.9]")).toBeNull();
  });
});

describe("isSkippedDirectRuleLine", () => {
  it.each(["", "   ", "! hi", "# hi", "// hi", "[AutoProxy]", "@@||x.com^"])("skips %s", (line) => {
    expect(isSkippedDirectRuleLine(line)).toBe(true);
  });

  it("does not skip real rules", () => {
    expect(isSkippedDirectRuleLine("baidu.com")).toBe(false);
    expect(isSkippedDirectRuleLine("GEOIP,CN,DIRECT")).toBe(false);
  });
});

describe("parseDirectRulesText", () => {
  it("parses, dedupes, counts skipped and invalid lines", () => {
    const text = [
      "! a comment",
      "",
      "baidu.com",
      "DOMAIN-SUFFIX,baidu.com,DIRECT",
      "DOMAIN,qq.com",
      "GEOIP,CN,DIRECT",
      "not a rule!!!",
      "@@||example.com^",
    ].join("\n");
    const result = parseDirectRulesText(text);
    expect(result.entries).toEqual([
      { kind: "domain-suffix", value: "baidu.com" },
      { kind: "domain", value: "qq.com" },
    ]);
    expect(result.invalidLines).toEqual(["GEOIP,CN,DIRECT", "not a rule!!!"]);
    expect(result.skippedLines).toBe(3);
    expect(result.duplicateLines).toEqual(["DOMAIN-SUFFIX,baidu.com,DIRECT"]);
  });
});

describe("normalizeDirectRule and validateDirectRules", () => {
  it("keeps a valid rule and copies it", () => {
    const input = rule({ id: "r1", kind: "domain-suffix", value: "baidu.com" });
    const normalized = normalizeDirectRule(input);
    expect(normalized).toEqual(input);
    expect(normalized).not.toBe(input);
  });

  it.each([
    null,
    "nope",
    { id: "", kind: "domain", value: "example.com", enabled: true, source: "local", updatedAt: 0 },
    { id: "r", kind: "domain", value: "Example.COM", enabled: true, source: "local", updatedAt: 0 },
    {
      id: "r",
      kind: "domain",
      value: "example.com.",
      enabled: true,
      source: "local",
      updatedAt: 0,
    },
    {
      id: "r",
      kind: "ipv4-cidr",
      value: "223.5.5.5/24",
      enabled: true,
      source: "local",
      updatedAt: 0,
    },
    { id: "r", kind: "nope", value: "example.com", enabled: true, source: "local", updatedAt: 0 },
    {
      id: "r",
      kind: "domain",
      value: "example.com",
      enabled: "yes",
      source: "local",
      updatedAt: 0,
    },
    { id: "r", kind: "domain", value: "example.com", enabled: true, source: "other", updatedAt: 0 },
  ])("drops invalid stored rule %s", (input) => {
    expect(normalizeDirectRule(input)).toBeNull();
  });

  it("dedupes by id and by kind+value, and caps the list", () => {
    const rules = [
      rule({ id: "a", kind: "domain-suffix", value: "baidu.com" }),
      rule({ id: "a", kind: "domain", value: "qq.com" }),
      rule({ id: "b", kind: "domain-suffix", value: "baidu.com" }),
      rule({ id: "c", kind: "domain", value: "qq.com", enabled: false }),
    ];
    expect(validateDirectRules(rules).map((r) => r.id)).toEqual(["a", "c"]);
    expect(validateDirectRules("nope")).toEqual([]);
    const many = Array.from({ length: MAX_DIRECT_RULES + 5 }, (_, i) =>
      rule({ id: `r${i}`, kind: "domain", value: `host${i}.example.com` })
    );
    expect(validateDirectRules(many)).toHaveLength(MAX_DIRECT_RULES);
  });
});

describe("matchDirectRule", () => {
  const rules = [
    rule({ id: "suffix-cn", kind: "domain-suffix", value: "cn" }),
    rule({ id: "suffix-baidu", kind: "domain-suffix", value: "baidu.com" }),
    rule({ id: "exact-api", kind: "domain", value: "api.baidu.com" }),
    rule({ id: "sub-only", kind: "domain-suffix", value: "*.example.com" }),
    rule({ id: "keyword", kind: "domain-keyword", value: "weibo" }),
    rule({ id: "cidr", kind: "ipv4-cidr", value: "223.5.5.0/24" }),
    rule({ id: "disabled", kind: "domain-suffix", value: "disabled.com", enabled: false }),
  ];

  it("matches suffixes at the apex and in subdomains", () => {
    expect(matchDirectRule("baidu.com", rules)?.id).toBe("suffix-baidu");
    expect(matchDirectRule("www.baidu.com", rules)?.id).toBe("suffix-baidu");
    expect(matchDirectRule("baidu.cn", rules)?.id).toBe("suffix-cn");
    expect(matchDirectRule("notbaidu.com", rules)).toBeNull();
  });

  it("prefers exact over suffix", () => {
    expect(matchDirectRule("api.baidu.com", rules)?.id).toBe("exact-api");
  });

  it("excludes the apex for *. suffixes", () => {
    expect(matchDirectRule("example.com", rules)).toBeNull();
    expect(matchDirectRule("www.example.com", rules)?.id).toBe("sub-only");
  });

  it("matches keywords and ignores disabled rules", () => {
    expect(matchDirectRule("www.weibo.com", rules)?.id).toBe("keyword");
    expect(matchDirectRule("www.disabled.com", rules)).toBeNull();
  });

  it("matches IPv4 literals only against CIDR rules, at the boundaries", () => {
    expect(matchDirectRule("223.5.5.0", rules)?.id).toBe("cidr");
    expect(matchDirectRule("223.5.5.255", rules)?.id).toBe("cidr");
    expect(matchDirectRule("223.5.6.1", rules)).toBeNull();
    // An exact domain rule matches an IP literal only as a literal string;
    // a CIDR rule never matches a domain host.
    expect(
      matchDirectRule("223.5.5.5", [rule({ id: "x", kind: "domain", value: "223.5.5.5" })])?.id
    ).toBe("x");
    expect(
      matchesDirectRule("example.com", [rule({ id: "y", kind: "ipv4-cidr", value: "0.0.0.0/0" })])
    ).toBe(false);
  });

  it("prefers the longest CIDR prefix", () => {
    const cidrRules = [
      rule({ id: "wide", kind: "ipv4-cidr", value: "223.0.0.0/8" }),
      rule({ id: "narrow", kind: "ipv4-cidr", value: "223.5.5.0/24" }),
    ];
    expect(matchDirectRule("223.5.5.5", cidrRules)?.id).toBe("narrow");
  });

  it("breaks specificity ties by updatedAt, then by id", () => {
    const tied = [
      rule({ id: "b", kind: "domain-suffix", value: "example.com", updatedAt: 10 }),
      rule({ id: "a", kind: "domain-suffix", value: "example.com", updatedAt: 10 }),
      rule({ id: "c", kind: "domain-suffix", value: "example.com", updatedAt: 5 }),
    ];
    // Same kind+value would dedupe in storage; this tests the matcher in
    // isolation, where the tie-break must still be deterministic.
    expect(matchDirectRule("example.com", tied)?.id).toBe("a");
    const newer = [
      rule({ id: "a", kind: "domain-suffix", value: "example.com", updatedAt: 1 }),
      rule({ id: "b", kind: "domain-suffix", value: "example.com", updatedAt: 2 }),
    ];
    expect(matchDirectRule("example.com", newer)?.id).toBe("b");
  });

  it("returns null for unusable hosts", () => {
    expect(matchDirectRule("", rules)).toBeNull();
    expect(matchDirectRule("[::1]", rules)).toBeNull();
  });
});

describe("direct-rule settings defaults", () => {
  it("ships only the .cn suffix rule, enabled", () => {
    expect(DEFAULT_DIRECT_RULES).toEqual([
      {
        id: "builtin-cn-suffix",
        kind: "domain-suffix",
        value: "cn",
        enabled: true,
        source: "builtin",
        updatedAt: 0,
      },
    ]);
    expect(DEFAULT_SETTINGS.directRulesEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.directRules).toEqual(DEFAULT_DIRECT_RULES);
  });

  it("validateSettings: absent list gets defaults, stored [] stays [], bad entries drop", () => {
    expect(validateSettings({}).directRulesEnabled).toBe(true);
    expect(validateSettings({}).directRules).toEqual(DEFAULT_DIRECT_RULES);
    expect(validateSettings({ directRules: [] }).directRules).toEqual([]);
    expect(
      validateSettings({
        directRulesEnabled: false,
        directRules: [
          rule({ id: "ok", kind: "domain-suffix", value: "baidu.com" }),
          {
            id: "bad",
            kind: "domain",
            value: "Example.COM",
            enabled: true,
            source: "local",
            updatedAt: 0,
          },
        ],
      })
    ).toMatchObject({
      directRulesEnabled: false,
      directRules: [rule({ id: "ok", kind: "domain-suffix", value: "baidu.com" })],
    });
    expect(
      validateSettings({ directRulesEnabled: "yes" as unknown as boolean }).directRulesEnabled
    ).toBe(true);
  });
});
