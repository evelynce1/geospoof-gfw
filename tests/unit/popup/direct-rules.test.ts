import { describe, test, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Settings } from "@/shared/types/settings";
import { DEFAULT_SETTINGS } from "@/shared/types/settings";
import {
  __resetDirectRulesForTest,
  directRuleToText,
  initDirectRules,
  renderDirectRules,
} from "@/popup/direct-rules";
import { TOKYO, TOKYO_NAME, TOKYO_TZ } from "../../helpers/site-locations";

const BODY = (() => {
  const html = readFileSync("assets/popup.html", "utf8");
  return new DOMParser().parseFromString(html, "text/html").body.innerHTML;
})();

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    enabled: true,
    location: TOKYO,
    timezone: TOKYO_TZ,
    locationName: TOKYO_NAME,
    directRulesEnabled: true,
    directRules: [
      {
        id: "builtin-cn-suffix",
        kind: "domain-suffix",
        value: "cn",
        enabled: true,
        source: "builtin",
        updatedAt: 0,
      },
      {
        id: "direct-1",
        kind: "domain",
        value: "baidu.com",
        enabled: true,
        source: "local",
        updatedAt: 1,
      },
      {
        id: "direct-2",
        kind: "domain-suffix",
        value: "*.example.com",
        enabled: true,
        source: "local",
        updatedAt: 2,
      },
      {
        id: "direct-3",
        kind: "domain-keyword",
        value: "weibo",
        enabled: true,
        source: "local",
        updatedAt: 3,
      },
      {
        id: "direct-4",
        kind: "ipv4-cidr",
        value: "223.5.5.0/24",
        enabled: true,
        source: "local",
        updatedAt: 4,
      },
    ],
    ...overrides,
  };
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node as T;
}

beforeEach(() => {
  document.body.innerHTML = BODY;
  __resetDirectRulesForTest();
  vi.clearAllMocks();
});

describe("directRuleToText", () => {
  test("round-trips every kind to a parseable line", () => {
    const settings = makeSettings();
    expect(settings.directRules.map(directRuleToText)).toEqual([
      "cn",
      "DOMAIN,baidu.com",
      "*.example.com",
      "DOMAIN-KEYWORD,weibo",
      "IP-CIDR,223.5.5.0/24",
    ]);
  });
});

describe("renderDirectRules", () => {
  test("fills the toggle, the text box, and the count", () => {
    renderDirectRules(makeSettings());
    expect(byId<HTMLInputElement>("directRulesToggle").checked).toBe(true);
    expect(byId<HTMLTextAreaElement>("directRulesTextarea").value).toBe(
      "cn\nDOMAIN,baidu.com\n*.example.com\nDOMAIN-KEYWORD,weibo\nIP-CIDR,223.5.5.0/24"
    );
    expect(byId("directRulesCount").textContent).toBe("5 rules");
  });

  test("switch off and empty list render as such", () => {
    renderDirectRules(makeSettings({ directRulesEnabled: false, directRules: [] }));
    expect(byId<HTMLInputElement>("directRulesToggle").checked).toBe(false);
    expect(byId<HTMLTextAreaElement>("directRulesTextarea").value).toBe("");
    expect(byId("directRulesCount").textContent).toBe("0 rules");
  });
});

describe("initDirectRules save flow", () => {
  test("sends raw text to the background and reports its counts", async () => {
    renderDirectRules(makeSettings());
    const sendMessage = vi.mocked(browser.runtime.sendMessage);
    const calls: Array<{ type: string; payload?: unknown }> = [];
    sendMessage.mockImplementation((message: unknown) => {
      const m = message as { type: string; payload?: unknown };
      calls.push(m);
      if (m.type === "SET_DIRECT_RULES") {
        return Promise.resolve({
          success: true,
          saved: 3,
          invalid: 2,
          skipped: 1,
          duplicates: 1,
          truncated: 0,
        });
      }
      if (m.type === "GET_SETTINGS") {
        return Promise.resolve(
          makeSettings({
            directRules: [
              {
                id: "builtin-cn-suffix",
                kind: "domain-suffix",
                value: "cn",
                enabled: true,
                source: "builtin",
                updatedAt: 0,
              },
            ],
          })
        );
      }
      return Promise.resolve(undefined);
    });

    initDirectRules();
    byId<HTMLTextAreaElement>("directRulesTextarea").value =
      "baidu.com\nGEOIP,CN,DIRECT\nbaidu.com\n! comment";
    byId<HTMLInputElement>("directRulesToggle").checked = true;
    byId<HTMLButtonElement>("directRulesSave").click();
    await vi.waitFor(() => {
      expect(byId("directRulesStatus").textContent).toContain("Saved 3 rules.");
    });
    expect(byId("directRulesStatus").textContent).toContain("2 invalid lines skipped.");
    expect(byId("directRulesStatus").textContent).toContain("1 duplicate line skipped.");
    // The box refreshes to the canonical stored form after a save.
    expect(byId<HTMLTextAreaElement>("directRulesTextarea").value).toBe("cn");
    expect(byId("directRulesCount").textContent).toBe("1 rule");
    expect(calls[0]).toEqual({
      type: "SET_DIRECT_RULES",
      payload: {
        enabled: true,
        text: "baidu.com\nGEOIP,CN,DIRECT\nbaidu.com\n! comment",
      },
    });
  });

  test("a failed save shows the error and keeps the user's text", async () => {
    renderDirectRules(makeSettings());
    const sendMessage = vi.mocked(browser.runtime.sendMessage);
    sendMessage.mockResolvedValue({ error: "STORAGE_ERROR" });
    initDirectRules();
    byId<HTMLTextAreaElement>("directRulesTextarea").value = "qq.com";
    byId<HTMLButtonElement>("directRulesSave").click();
    await vi.waitFor(() => {
      expect(byId("directRulesStatus").textContent).toBe("⚠️ Change not saved");
    });
    expect(byId<HTMLTextAreaElement>("directRulesTextarea").value).toBe("qq.com");
  });
});
