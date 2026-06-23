import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configPath, loadConfig, resolveFloating, resolveOpenLinksApp, resolveUseGlimpse, saveConfig } from "../src/config.js";

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function writeSettings(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "handback-config-"));
  const path = join(dir, "settings.json");
  writeFileSync(path, contents, "utf8");
  return path;
}

test("glimpse defaults on when nothing is set", () => {
  withEnv({ HANDBACK_GLIMPSE: undefined, HANDBACK_CONFIG: undefined, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "xdg-")) }, () => {
    assert.equal(resolveUseGlimpse(), true);
  });
});

test("settings.json can disable glimpse", () => {
  const path = writeSettings(JSON.stringify({ glimpse: false }));
  withEnv({ HANDBACK_GLIMPSE: undefined, HANDBACK_CONFIG: path }, () => {
    assert.equal(loadConfig().glimpse, false);
    assert.equal(resolveUseGlimpse(), false);
  });
});

test("HANDBACK_GLIMPSE env overrides the settings file", () => {
  const path = writeSettings(JSON.stringify({ glimpse: false }));
  withEnv({ HANDBACK_GLIMPSE: "1", HANDBACK_CONFIG: path }, () => {
    assert.equal(resolveUseGlimpse(), true);
  });
  withEnv({ HANDBACK_GLIMPSE: "0", HANDBACK_CONFIG: writeSettings(JSON.stringify({ glimpse: true })) }, () => {
    assert.equal(resolveUseGlimpse(), false);
  });
});

test("a malformed settings file is ignored", () => {
  const path = writeSettings("{ not json");
  withEnv({ HANDBACK_GLIMPSE: undefined, HANDBACK_CONFIG: path }, () => {
    assert.deepEqual(loadConfig(), {});
    assert.equal(resolveUseGlimpse(), true);
  });
});

test("floating defaults off and is read from settings", () => {
  withEnv({ HANDBACK_GLIMPSE_FLOATING: undefined, HANDBACK_CONFIG: writeSettings("{}") }, () => {
    assert.equal(resolveFloating(), false);
  });
  withEnv({ HANDBACK_GLIMPSE_FLOATING: undefined, HANDBACK_CONFIG: writeSettings(JSON.stringify({ floating: true })) }, () => {
    assert.equal(resolveFloating(), true);
  });
  withEnv({ HANDBACK_GLIMPSE_FLOATING: "0", HANDBACK_CONFIG: writeSettings(JSON.stringify({ floating: true })) }, () => {
    assert.equal(resolveFloating(), false);
  });
});

test("openLinksApp comes from settings or env, else undefined", () => {
  withEnv({ HANDBACK_GLIMPSE_OPEN_LINKS_APP: undefined, HANDBACK_CONFIG: writeSettings("{}") }, () => {
    assert.equal(resolveOpenLinksApp(), undefined);
  });
  withEnv({ HANDBACK_GLIMPSE_OPEN_LINKS_APP: undefined, HANDBACK_CONFIG: writeSettings(JSON.stringify({ openLinksApp: "Firefox" })) }, () => {
    assert.equal(resolveOpenLinksApp(), "Firefox");
  });
  withEnv({ HANDBACK_GLIMPSE_OPEN_LINKS_APP: "Safari", HANDBACK_CONFIG: writeSettings(JSON.stringify({ openLinksApp: "Firefox" })) }, () => {
    assert.equal(resolveOpenLinksApp(), "Safari");
  });
});

test("saveConfig merges into the settings file", () => {
  const path = writeSettings(JSON.stringify({ glimpse: true }));
  withEnv({ HANDBACK_CONFIG: path }, () => {
    saveConfig({ floating: true });
    assert.deepEqual(loadConfig(), { glimpse: true, floating: true });
    saveConfig({ openLinksApp: "Google Chrome" });
    assert.deepEqual(loadConfig(), { glimpse: true, floating: true, openLinksApp: "Google Chrome" });
    // undefined clears a key on the next write.
    saveConfig({ openLinksApp: undefined });
    assert.equal(loadConfig().openLinksApp, undefined);
  });
});

test("HANDBACK_CONFIG overrides the XDG path", () => {
  withEnv({ HANDBACK_CONFIG: "/custom/settings.json" }, () => {
    assert.equal(configPath(), "/custom/settings.json");
  });
  withEnv({ HANDBACK_CONFIG: undefined, XDG_CONFIG_HOME: "/xdg" }, () => {
    assert.equal(configPath(), join("/xdg", "handback", "settings.json"));
  });
});
