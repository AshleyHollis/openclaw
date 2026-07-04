// Tests OpenClaw home directory resolution.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import {
  displayPath,
  displayString,
  expandHomePrefix,
  resolveEffectiveHomeDir,
  resolveHomeDir,
  resolveHomeRelativePath,
  resolveOsHomeDir,
  resolveOsHomeRelativePath,
  resolveRequiredHomeDir,
  resolveUserPath,
  shortenHomeInString,
  shortenHomePath,
} from "./home-dir.js";

describe("resolveEffectiveHomeDir", () => {
  it.each([
    {
      name: "prefers OPENCLAW_HOME over HOME and USERPROFILE",
      env: {
        OPENCLAW_HOME: " /srv/openclaw-home ",
        HOME: "/home/other",
        USERPROFILE: "C:/Users/other",
      } as NodeJS.ProcessEnv,
      homedir: () => "/fallback",
      expected: "/srv/openclaw-home",
    },
    {
      name: "falls back to HOME",
      env: { HOME: " /home/alice " } as NodeJS.ProcessEnv,
      expected: "/home/alice",
    },
    {
      name: "falls back to USERPROFILE when HOME is blank",
      env: {
        HOME: "   ",
        USERPROFILE: " C:/Users/alice ",
      } as NodeJS.ProcessEnv,
      expected: "C:/Users/alice",
    },
    {
      name: "falls back to homedir when env values are blank",
      env: {
        OPENCLAW_HOME: " ",
        HOME: " ",
        USERPROFILE: "\t",
      } as NodeJS.ProcessEnv,
      homedir: () => " /fallback ",
      expected: "/fallback",
    },
    {
      name: "treats literal undefined env values as unset",
      env: {
        OPENCLAW_HOME: "undefined",
        HOME: "undefined",
        USERPROFILE: "null",
      } as NodeJS.ProcessEnv,
      homedir: () => " /fallback ",
      expected: "/fallback",
    },
  ])("$name", ({ env, homedir, expected }) => {
    expect(resolveEffectiveHomeDir(env, homedir)).toBe(path.resolve(expected));
  });

  it.each([
    {
      name: "expands ~/ using HOME",
      env: {
        OPENCLAW_HOME: "~/svc",
        HOME: "/home/alice",
      } as NodeJS.ProcessEnv,
      expected: "/home/alice/svc",
    },
    {
      name: "expands ~\\\\ using USERPROFILE",
      env: {
        OPENCLAW_HOME: "~\\svc",
        HOME: " ",
        USERPROFILE: "C:/Users/alice",
      } as NodeJS.ProcessEnv,
      expected: "C:/Users/alice\\svc",
    },
  ])("$name", ({ env, expected }) => {
    expect(resolveEffectiveHomeDir(env)).toBe(path.resolve(expected));
  });

  it("derives home from PREFIX on Android/Termux when HOME is unset", () => {
    const env = {
      PREFIX: "/data/data/com.termux/files/usr",
      ANDROID_DATA: "/data",
    } as NodeJS.ProcessEnv;
    expect(resolveEffectiveHomeDir(env, () => "/home")).toBe(
      path.resolve("/data/data/com.termux/files/home"),
    );
  });

  it("prefers HOME over PREFIX-derived path on Termux", () => {
    const env = {
      HOME: "/data/data/com.termux/files/home",
      PREFIX: "/data/data/com.termux/files/usr",
      ANDROID_DATA: "/data",
    } as NodeJS.ProcessEnv;
    expect(resolveEffectiveHomeDir(env)).toBe(path.resolve("/data/data/com.termux/files/home"));
  });

  it("ignores PREFIX without com.termux to avoid false positives in generic chroots", () => {
    const env = {
      PREFIX: "/usr",
      ANDROID_DATA: "/data",
    } as NodeJS.ProcessEnv;
    expect(resolveEffectiveHomeDir(env, () => "/fallback")).toBe(path.resolve("/fallback"));
  });

  it("ignores PREFIX values that only mention com.termux outside the Termux app root", () => {
    const env = {
      PREFIX: "/tmp/com.termux/usr",
      ANDROID_DATA: "/data",
    } as NodeJS.ProcessEnv;
    expect(resolveEffectiveHomeDir(env, () => "/fallback")).toBe(path.resolve("/fallback"));
  });

  it("uses Termux PREFIX for tilde expansion when HOME is unset", () => {
    const env = {
      OPENCLAW_HOME: "~/workspace",
      PREFIX: "/data/data/com.termux/files/usr",
      ANDROID_DATA: "/data",
    } as NodeJS.ProcessEnv;
    expect(
      resolveEffectiveHomeDir(env, () => {
        throw new Error("no homedir");
      }),
    ).toBe(path.resolve("/data/data/com.termux/files/home/workspace"));
  });

  it("expands OPENCLAW_HOME when set to ~", () => {
    const env = {
      OPENCLAW_HOME: "~/svc",
      HOME: "/home/alice",
    } as NodeJS.ProcessEnv;

    expect(resolveEffectiveHomeDir(env)).toBe(path.resolve("/home/alice/svc"));
  });
});

describe("resolveRequiredHomeDir", () => {
  it.each([
    {
      name: "returns cwd when no home source is available",
      env: {} as NodeJS.ProcessEnv,
      homedir: () => {
        throw new Error("no home");
      },
      expected: process.cwd(),
    },
    {
      name: "returns a fully resolved path for OPENCLAW_HOME",
      env: { OPENCLAW_HOME: "/custom/home" } as NodeJS.ProcessEnv,
      homedir: () => "/fallback",
      expected: path.resolve("/custom/home"),
    },
    {
      name: "returns cwd when OPENCLAW_HOME is tilde-only and no fallback home exists",
      env: { OPENCLAW_HOME: "~" } as NodeJS.ProcessEnv,
      homedir: () => {
        throw new Error("no home");
      },
      expected: process.cwd(),
    },
  ])("$name", ({ env, homedir, expected }) => {
    expect(resolveRequiredHomeDir(env, homedir)).toBe(expected);
  });
});

describe("resolveOsHomeDir", () => {
  it("ignores OPENCLAW_HOME and uses HOME", () => {
    expect(
      resolveOsHomeDir(
        {
          OPENCLAW_HOME: "/srv/openclaw-home",
          HOME: "/home/alice",
          USERPROFILE: "C:/Users/alice",
        } as NodeJS.ProcessEnv,
        () => "/fallback",
      ),
    ).toBe(path.resolve("/home/alice"));
  });
});

describe("expandHomePrefix", () => {
  it.each([
    {
      name: "expands ~/ using effective home",
      input: "~/x",
      opts: {
        env: { OPENCLAW_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv,
      },
      expected: `${path.resolve("/srv/openclaw-home")}/x`,
    },
    {
      name: "expands exact ~ using explicit home",
      input: "~",
      opts: { home: " /srv/openclaw-home " },
      expected: "/srv/openclaw-home",
    },
    {
      name: "expands ~\\\\ using resolved env home",
      input: "~\\x",
      opts: {
        env: { HOME: "/home/alice" } as NodeJS.ProcessEnv,
      },
      expected: `${path.resolve("/home/alice")}\\x`,
    },
    {
      name: "keeps non-tilde values unchanged",
      input: "/tmp/x",
      expected: "/tmp/x",
    },
  ])("$name", ({ input, opts, expected }) => {
    expect(expandHomePrefix(input, opts)).toBe(expected);
  });
});

describe("resolveHomeRelativePath", () => {
  it.each([
    {
      name: "returns blank input unchanged",
      input: "   ",
      expected: "",
    },
    {
      name: "resolves trimmed relative paths",
      input: " ./tmp/file.txt ",
      expected: path.resolve("./tmp/file.txt"),
    },
    {
      name: "resolves trimmed absolute paths",
      input: " /tmp/file.txt ",
      expected: path.resolve("/tmp/file.txt"),
    },
    {
      name: "expands tilde paths using the resolved home directory",
      input: "~/docs",
      opts: {
        env: { OPENCLAW_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv,
      },
      expected: path.resolve("/srv/openclaw-home/docs"),
    },
    {
      name: "falls back to cwd when tilde paths have no home source",
      input: "~",
      opts: {
        env: {} as NodeJS.ProcessEnv,
        homedir: () => {
          throw new Error("no home");
        },
      },
      expected: path.resolve(process.cwd()),
    },
  ])("$name", ({ input, opts, expected }) => {
    expect(resolveHomeRelativePath(input, opts)).toBe(expected);
  });
});

describe("resolveOsHomeRelativePath", () => {
  it("expands tilde paths using the OS home instead of OPENCLAW_HOME", () => {
    expect(
      resolveOsHomeRelativePath("~/docs", {
        env: {
          OPENCLAW_HOME: "/srv/openclaw-home",
          HOME: "/home/alice",
        } as NodeJS.ProcessEnv,
      }),
    ).toBe(path.resolve("/home/alice/docs"));
  });
});

describe("resolveUserPath", () => {
  it.each([
    { input: "", expected: "" },
    { input: "   ", expected: "" },
    { input: undefined as unknown as string, expected: "" },
    { input: null as unknown as string, expected: "" },
  ])("preserves blank input $input", ({ input, expected }) => {
    expect(resolveUserPath(input)).toBe(expected);
  });

  it("uses the provided home sources", () => {
    const env = { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv;
    expect(resolveUserPath("~/openclaw", env, () => "/fallback")).toBe(
      path.resolve("/tmp/openclaw-home", "openclaw"),
    );
  });
});

describe("resolveHomeDir", () => {
  it("prefers OPENCLAW_HOME over HOME", () => {
    withEnv({ OPENCLAW_HOME: "/srv/openclaw-home", HOME: "/home/other" }, () => {
      expect(resolveHomeDir()).toBe(path.resolve("/srv/openclaw-home"));
    });
  });
});

describe("home path presentation", () => {
  it("uses $OPENCLAW_HOME for paths and embedded diagnostics", () => {
    withEnv({ OPENCLAW_HOME: "/srv/openclaw-home", HOME: "/home/other" }, () => {
      const home = path.resolve("/srv/openclaw-home");
      const configPath = `${home}/.openclaw/openclaw.json`;
      expect(shortenHomePath(configPath)).toBe("$OPENCLAW_HOME/.openclaw/openclaw.json");
      expect(shortenHomeInString(`config: ${configPath}`)).toBe(
        "config: $OPENCLAW_HOME/.openclaw/openclaw.json",
      );
      expect(displayPath(configPath)).toBe("$OPENCLAW_HOME/.openclaw/openclaw.json");
      expect(displayString(`config: ${configPath}`)).toBe(
        "config: $OPENCLAW_HOME/.openclaw/openclaw.json",
      );
    });
  });
});
