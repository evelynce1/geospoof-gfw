import { describe, it, expect } from "vitest";
import type { DirectRule, Settings } from "@/shared/types/settings";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import { resolveSiteSettings } from "@/shared/utils/site-locations";
import { isRestrictedUrl } from "@/background/restricted-url";
import { buildPagePayload } from "@/background/page-payload";
import {
  _classifyRequestForTest,
  tabPageUrlCache,
  updateWorkerFilterSettings,
  workerPayloadFor,
} from "@/background/worker-request-filter";
import { resolveAcceptLanguageFor, planAcceptLanguageRules } from "@/background/accept-language";
import { buildOverridesForTab } from "@/background/debugger-spoof";
import {
  ENTRY_DUBLIN,
  TOKYO,
  TOKYO_NAME,
  TOKYO_TZ,
  makeSiteLocation,
} from "../../helpers/site-locations";

function directRule(
  overrides: Partial<DirectRule> & { id: string; kind: DirectRule["kind"]; value: string }
): DirectRule {
  return { enabled: true, source: "local", updatedAt: 0, ...overrides };
}

const DIRECT_RULES: DirectRule[] = [
  directRule({ id: "cn", kind: "domain-suffix", value: "cn" }),
  directRule({ id: "baidu", kind: "domain-suffix", value: "baidu.com" }),
  directRule({ id: "weibo-keyword", kind: "domain-keyword", value: "weibo" }),
  directRule({ id: "cn-ip", kind: "ipv4-cidr", value: "223.5.5.0/24" }),
];

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    enabled: true,
    location: TOKYO,
    timezone: TOKYO_TZ,
    locationName: TOKYO_NAME,
    directRulesEnabled: true,
    directRules: DIRECT_RULES,
    ...overrides,
  };
}

describe("resolveSiteSettings with direct rules", () => {
  it("turns a matched tab off without touching the global switch or main location", () => {
    const settings = makeSettings();
    const r = resolveSiteSettings(settings, "https://www.baidu.com/", isRestrictedUrl);
    expect(r.enabled).toBe(false);
    expect(r.directRule?.id).toBe("baidu");
    expect(r.siteLocation).toBeNull();
    expect(r.settings).toBe(settings);
    expect(settings.enabled).toBe(true);
    expect(settings.location).toEqual(TOKYO);
  });

  it("matches .cn, keywords, and IP literals, and leaves other sites on", () => {
    const settings = makeSettings();
    expect(resolveSiteSettings(settings, "https://example.cn/", isRestrictedUrl).enabled).toBe(
      false
    );
    expect(resolveSiteSettings(settings, "https://www.weibo.com/", isRestrictedUrl).enabled).toBe(
      false
    );
    expect(resolveSiteSettings(settings, "http://223.5.5.5/", isRestrictedUrl).enabled).toBe(false);
    expect(resolveSiteSettings(settings, "http://223.5.6.1/", isRestrictedUrl).enabled).toBe(true);
    expect(resolveSiteSettings(settings, "https://example.com/", isRestrictedUrl).enabled).toBe(
      true
    );
    expect(
      resolveSiteSettings(settings, "https://example.com/", isRestrictedUrl).directRule
    ).toBeNull();
  });

  it("ignores ports and paths: the hostname decides", () => {
    const settings = makeSettings();
    expect(
      resolveSiteSettings(settings, "https://www.baidu.com:8080/some/path", isRestrictedUrl).enabled
    ).toBe(false);
  });

  it("matches a Unicode rule against the punycode host", () => {
    const settings = makeSettings({
      directRules: [directRule({ id: "idn", kind: "domain", value: "例子.com" })],
    });
    expect(resolveSiteSettings(settings, "https://xn--fsqu00a.com/", isRestrictedUrl).enabled).toBe(
      false
    );
    expect(resolveSiteSettings(settings, "https://例子.com/", isRestrictedUrl).enabled).toBe(false);
  });

  it("a manual site location wins over a direct rule for the same tab", () => {
    const siteForBaidu = makeSiteLocation({
      id: "site-baidu",
      patterns: ["baidu.com"],
    });
    const settings = makeSettings({ siteLocations: [siteForBaidu] });
    const r = resolveSiteSettings(settings, "https://www.baidu.com/", isRestrictedUrl);
    expect(r.enabled).toBe(true);
    expect(r.directRule).toBeNull();
    expect(r.siteLocation?.id).toBe("site-baidu");
    expect(r.settings.timezone).toEqual(siteForBaidu.timezone);
  });

  it("does not apply when the switch is off, the rule is disabled, or the list is empty", () => {
    expect(
      resolveSiteSettings(
        makeSettings({ directRulesEnabled: false }),
        "https://www.baidu.com/",
        isRestrictedUrl
      ).enabled
    ).toBe(true);
    expect(
      resolveSiteSettings(
        makeSettings({
          directRules: [
            directRule({ id: "off", kind: "domain-suffix", value: "baidu.com", enabled: false }),
          ],
        }),
        "https://www.baidu.com/",
        isRestrictedUrl
      ).enabled
    ).toBe(true);
    expect(
      resolveSiteSettings(
        makeSettings({ directRules: [] }),
        "https://www.baidu.com/",
        isRestrictedUrl
      ).enabled
    ).toBe(true);
  });

  it("Filters-off and restricted tabs report directRule null, not a direct match", () => {
    const settings = makeSettings({ scopeMode: "denylist", denylist: ["baidu.com"] });
    const denied = resolveSiteSettings(settings, "https://www.baidu.com/", isRestrictedUrl);
    expect(denied.enabled).toBe(false);
    expect(denied.directRule).toBeNull();
    const restricted = resolveSiteSettings(makeSettings(), "chrome://extensions/", isRestrictedUrl);
    expect(restricted.enabled).toBe(false);
    expect(restricted.directRule).toBeNull();
    const masterOff = resolveSiteSettings(
      makeSettings({ enabled: false }),
      "https://www.baidu.com/",
      isRestrictedUrl
    );
    expect(masterOff.enabled).toBe(false);
    expect(masterOff.directRule).toBeNull();
  });
});

describe("all consumers agree on a direct-rule tab", () => {
  const settings = makeSettings({ localeSpoofing: { mode: "match" } });

  it("page payload is off for the direct tab, on for an overseas tab", async () => {
    const direct = await buildPagePayload(settings, "https://www.baidu.com/");
    expect(direct.enabled).toBe(false);
    const overseas = await buildPagePayload(settings, "https://example.com/");
    expect(overseas.enabled).toBe(true);
    expect(overseas.timezone).toEqual(TOKYO_TZ);
  });

  it("worker payload, Accept-Language, and CDP all turn off together", () => {
    // The worker builder itself still embeds the zone (like the page
    // payload does on a disabled tab); the scope gate is what stops it
    // from ever reaching a direct-rule tab's worker.
    expect(workerPayloadFor(settings, "https://example.com/")).toContain("Asia/Tokyo");
    tabPageUrlCache.clear();
    updateWorkerFilterSettings(settings);
    tabPageUrlCache.set(21, "https://www.baidu.com/");
    tabPageUrlCache.set(22, "https://example.com/");
    const workerDetails = (tabId: number, url: string) => ({
      requestId: `r${tabId}`,
      url,
      type: "script",
      method: "GET",
      tabId,
      frameId: 0,
      requestHeaders: [{ name: "Sec-Fetch-Dest", value: "worker" }],
    });
    expect(_classifyRequestForTest(workerDetails(21, "https://www.baidu.com/worker.js"))).toBe(
      "pass"
    );
    expect(_classifyRequestForTest(workerDetails(22, "https://example.com/worker.js"))).toBe(
      "patch"
    );
    expect(resolveAcceptLanguageFor(settings, "https://www.baidu.com/")).toBeNull();
    expect(resolveAcceptLanguageFor(settings, "https://example.com/")).not.toBeNull();
    expect(buildOverridesForTab(settings, "https://www.baidu.com/")).toBeNull();
    expect(buildOverridesForTab(settings, "https://example.com/")).toEqual({
      timezoneId: "Asia/Tokyo",
    });
  });

  it("a site location still wins in every consumer", async () => {
    const siteForBaidu = makeSiteLocation({ id: "site-baidu", patterns: ["baidu.com"] });
    const s = makeSettings({ localeSpoofing: { mode: "match" }, siteLocations: [siteForBaidu] });
    const payload = await buildPagePayload(s, "https://www.baidu.com/");
    expect(payload.enabled).toBe(true);
    expect(payload.timezone).toEqual(siteForBaidu.timezone);
    expect(buildOverridesForTab(s, "https://www.baidu.com/")).toEqual({
      timezoneId: siteForBaidu.timezone.identifier,
    });
  });

  it("the layered Accept-Language plan excludes the direct tab from the global rule", () => {
    const s = makeSettings({
      localeSpoofing: { mode: "match" },
      siteLocations: [ENTRY_DUBLIN],
    });
    const plan = planAcceptLanguageRules(
      s,
      [
        { id: 21, url: "https://www.baidu.com/" },
        { id: 22, url: "https://example.com/" },
      ],
      { layered: true }
    );
    const global = plan.find((rule) => rule.priority === 1);
    expect(global).toBeDefined();
    if (global && "excludedTabIds" in global.condition) {
      expect(global.condition.excludedTabIds).toContain(21);
      expect(global.condition.excludedTabIds).not.toContain(22);
    } else {
      throw new Error("expected a layered global rule with excludedTabIds");
    }
  });
});
