/**
 * Popup Mainland-direct rules (geospoof-gfw, stage 3): the minimal editor
 * in the Filters tab — one switch, one large text box, one Save button.
 *
 * The popup never decides what a rule means: it sends the raw text to the
 * background, which re-parses it, and the status line reports the
 * background's counts (saved, invalid, duplicates, truncated). No
 * per-rule enable/delete/search, no file import/export, no test box:
 * those are explicitly out of the minimal first version.
 */

import type { DirectRule, Settings } from "@/shared/types/settings";
import type { DirectRulesResponse } from "@/shared/types/messages";

/** Render one stored rule back to the text form the parser accepts. */
export function directRuleToText(rule: DirectRule): string {
  switch (rule.kind) {
    case "domain":
      return `DOMAIN,${rule.value}`;
    case "domain-suffix":
      return rule.value;
    case "domain-keyword":
      return `DOMAIN-KEYWORD,${rule.value}`;
    case "ipv4-cidr":
      return `IP-CIDR,${rule.value}`;
    default:
      return rule.value;
  }
}

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function showStatus(text: string): void {
  const status = el<HTMLElement>("directRulesStatus");
  if (!status) return;
  status.textContent = text;
  status.style.display = "block";
}

/**
 * Fill the editor from `settings`. Deliberately does NOT clear the
 * status line: a save handler refreshes the settings right after a
 * save, and clearing here would eat the "Saved …" message it just set.
 */
export function renderDirectRules(settings: Settings): void {
  const toggle = el<HTMLInputElement>("directRulesToggle");
  if (toggle) {
    toggle.checked = settings.directRulesEnabled !== false;
  }
  const textarea = el<HTMLTextAreaElement>("directRulesTextarea");
  if (textarea) {
    textarea.value = (settings.directRules ?? []).map(directRuleToText).join("\n");
  }
  const count = el<HTMLElement>("directRulesCount");
  if (count) {
    const n = settings.directRules?.length ?? 0;
    count.textContent = n === 1 ? "1 rule" : `${n} rules`;
  }
}

let wired = false;

/** Test-only reset for the once-only wiring, mirroring site-locations. */
export function __resetDirectRulesForTest(): void {
  wired = false;
}

/** Wire the Save button once. Safe to call on every popup open. */
export function initDirectRules(): void {
  if (wired) return;
  wired = true;
  const save = el<HTMLButtonElement>("directRulesSave");
  if (!save) return;
  save.addEventListener("click", () => {
    void (async () => {
      const toggle = el<HTMLInputElement>("directRulesToggle");
      const textarea = el<HTMLTextAreaElement>("directRulesTextarea");
      if (!toggle || !textarea) return;
      const enabled = toggle.checked;
      const text = textarea.value;
      save.disabled = true;
      try {
        const response = (await browser.runtime.sendMessage({
          type: "SET_DIRECT_RULES",
          payload: { enabled, text },
        })) as DirectRulesResponse;
        if (!response || !("success" in response) || !response.success) {
          showStatus("⚠️ Change not saved");
          return;
        }
        const parts = [`Saved ${response.saved} ${response.saved === 1 ? "rule" : "rules"}.`];
        if (response.invalid > 0) {
          parts.push(
            `${response.invalid} invalid ${response.invalid === 1 ? "line" : "lines"} skipped.`
          );
        }
        if (response.duplicates > 0) {
          parts.push(
            `${response.duplicates} duplicate ${response.duplicates === 1 ? "line" : "lines"} skipped.`
          );
        }
        if (response.truncated > 0) {
          parts.push(`${response.truncated} lines dropped: the list is capped at 2000 rules.`);
        }
        showStatus(parts.join(" "));
        // Refresh from the background so the box shows the canonical
        // stored form (case and CIDR normalization, deduping) and the
        // count, without clearing the status line just set.
        const settings = (await browser.runtime.sendMessage({
          type: "GET_SETTINGS",
        })) as Settings;
        renderDirectRules(settings);
      } catch (error: unknown) {
        console.error("Failed to save direct rules:", error);
        showStatus("⚠️ Change not saved");
      } finally {
        save.disabled = false;
      }
    })();
  });
}
