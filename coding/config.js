import fs from "node:fs/promises";
import path from "node:path";

/**
 * Load config.json from the current working directory.
 * If the file doesn't exist, returns {}.
 * @returns {Promise<object>}
 */
export async function loadConfig() {
  const file = path.resolve(process.cwd(), "config.json");
  try {
    const data = await fs.readFile(file, "utf8");
    return JSON.parse(data);
  } catch (err) {
    if (err && err.code === "ENOENT") return {};
    // Re-throw JSON parse errors or other IO errors
    throw err;
  }
}

/**
 * Save the given config object to config.json in the current working directory.
 * @param {object} config
 * @returns {Promise<void>}
 */
export async function saveConfig(config) {
  const file = path.resolve(process.cwd(), "config.json");
  const json = JSON.stringify(config ?? {}, null, 2) + "\n";
  await fs.writeFile(file, json, "utf8");
}
