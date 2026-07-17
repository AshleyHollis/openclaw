// Whatsapp plugin module reads Baileys' persisted LID mapping entries.
import fs from "node:fs";
import path from "node:path";
import { normalizeE164 } from "openclaw/plugin-sdk/account-resolution";
import { CONFIG_DIR, resolveUserPath } from "openclaw/plugin-sdk/text-utility-runtime";

export type WhatsAppLidMappingFileOptions = {
  authDir?: string;
  lidMappingDirs?: string[];
};

function resolveLidMappingDirs(options?: WhatsAppLidMappingFileOptions): string[] {
  const dirs = new Set<string>();
  const addDir = (dir?: string | null) => {
    if (dir) {
      dirs.add(resolveUserPath(dir));
    }
  };
  addDir(options?.authDir);
  for (const dir of options?.lidMappingDirs ?? []) {
    addDir(dir);
  }
  addDir(CONFIG_DIR);
  addDir(path.join(CONFIG_DIR, "credentials"));
  return [...dirs];
}

function readLidToPnMappingFile(mappingPath: string): string | null {
  try {
    const data = fs.readFileSync(mappingPath, "utf8");
    const phone = JSON.parse(data) as string | number | null;
    if (phone === null || phone === undefined) {
      return null;
    }
    const candidate = String(phone).trim();
    return /^\+?\d+$/.test(candidate) ? normalizeE164(candidate) : null;
  } catch {
    // Missing, unreadable, and malformed candidates do not establish a mapping.
    return null;
  }
}

export function readWhatsAppLidToPnMappings(params: {
  lid: string;
  mappingDirs: readonly string[];
}): string[] {
  const mappings = new Set<string>();
  const mappingFilename = `lid-mapping-${params.lid}_reverse.json`;
  const mappingDirs = new Set(params.mappingDirs.map((dir) => resolveUserPath(dir)));
  for (const dir of mappingDirs) {
    const mapping = readLidToPnMappingFile(path.join(dir, mappingFilename));
    if (mapping) {
      mappings.add(mapping);
    }
  }
  return [...mappings];
}

export function readWhatsAppLidToPnMapping(params: {
  lid: string;
  options?: WhatsAppLidMappingFileOptions;
}): string | null {
  const mappingFilename = `lid-mapping-${params.lid}_reverse.json`;
  for (const dir of resolveLidMappingDirs(params.options)) {
    const mapping = readLidToPnMappingFile(path.join(dir, mappingFilename));
    if (mapping) {
      return mapping;
    }
  }
  return null;
}

export function readWhatsAppPnToLidMapping(params: {
  phoneDigits: string;
  options?: WhatsAppLidMappingFileOptions;
}): string | null {
  const mappingFilename = `lid-mapping-${params.phoneDigits}.json`;
  for (const dir of resolveLidMappingDirs(params.options)) {
    try {
      const data = fs.readFileSync(path.join(dir, mappingFilename), "utf8");
      const lid = JSON.parse(data) as string | number | null;
      if (lid === null || lid === undefined) {
        continue;
      }
      const candidate = String(lid).trim();
      if (/^\d+$/.test(candidate)) {
        return candidate;
      }
    } catch {
      // Missing, unreadable, and malformed candidates do not establish a mapping.
    }
  }
  return null;
}
