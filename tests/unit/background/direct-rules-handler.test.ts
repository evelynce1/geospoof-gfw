import { describe, test, expect, beforeEach, vi } from "vitest";
import { handleMessage, handleSetDirectRules } from "@/background/messages";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleSetDirectRules", () => {
  test("parses, dedupes, and stores the list, reporting counts", async () => {
    const result = await handleSetDirectRules({
      enabled: true,
      text: [
        "baidu.com",
        "DOMAIN-SUFFIX,qq.com,DIRECT",
        "baidu.com",
        "GEOIP,CN,DIRECT",
        "! a comment",
        "",
        "DOMAIN-KEYWORD,weibo",
        "IP-CIDR,223.5.5.0/24",
      ].join("\n"),
    });
    expect(result).toEqual({
      success: true,
      saved: 4,
      invalid: 1,
      skipped: 2,
      duplicates: 1,
      truncated: 0,
    });
    // The stored list is canonical and re-loadable.
    const { loadSettings } = await import("@/background/settings");
    const settings = await loadSettings();
    expect(settings.directRulesEnabled).toBe(true);
    expect(settings.directRules.map((r) => `${r.kind}:${r.value}`)).toEqual([
      "domain-suffix:baidu.com",
      "domain-suffix:qq.com",
      "domain-keyword:weibo",
      "ipv4-cidr:223.5.5.0/24",
    ]);
  });

  test("keeps the built-in .cn rule's id and source when it is still present", async () => {
    const first = await handleSetDirectRules({ enabled: true, text: "cn\nbaidu.com" });
    expect(first).toMatchObject({ success: true, saved: 2 });
    const { loadSettings } = await import("@/background/settings");
    const before = await loadSettings();
    expect(before.directRules.find((r) => r.value === "cn")).toMatchObject({
      id: "builtin-cn-suffix",
      source: "builtin",
    });
    await handleSetDirectRules({ enabled: true, text: "cn\nqq.com" });
    const after = await loadSettings();
    expect(after.directRules.find((r) => r.value === "cn")).toMatchObject({
      id: "builtin-cn-suffix",
      source: "builtin",
    });
    expect(after.directRules.map((r) => r.value)).toEqual(["cn", "qq.com"]);
  });

  test("empty text stores an empty list, not the defaults", async () => {
    const result = await handleSetDirectRules({ enabled: false, text: "" });
    expect(result).toMatchObject({ success: true, saved: 0 });
    const { loadSettings } = await import("@/background/settings");
    const settings = await loadSettings();
    expect(settings.directRulesEnabled).toBe(false);
    expect(settings.directRules).toEqual([]);
  });

  test("is reachable through the message router", async () => {
    const result = await handleMessage(
      {
        type: "SET_DIRECT_RULES",
        payload: { enabled: true, text: "baidu.com" },
      },
      {}
    );
    expect(result).toMatchObject({ success: true, saved: 1 });
  });

  test("rejects a bad payload without touching storage", async () => {
    expect(await handleSetDirectRules({ enabled: "yes", text: "baidu.com" } as never)).toEqual({
      error: "INVALID_PAYLOAD",
    });
    expect(await handleSetDirectRules({ enabled: true, text: 42 } as never)).toEqual({
      error: "INVALID_PAYLOAD",
    });
  });
});
