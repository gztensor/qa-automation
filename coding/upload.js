import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import { globby } from "globby";
import ignore from "ignore";

dotenv.config({ path: "../.env" });

const client = new OpenAI({ apiKey: process.env.OPENAI_KEY });

async function loadIgnore(root) {
  const ig = ignore();
  const patterns = [];
  for (const name of [".gitignore", ".ragignore"]) {
    try {
      patterns.push(await fs.readFile(path.join(root, name), "utf8"));
    } catch {}
  }
  if (patterns.length) ig.add(patterns.join("\n"));
  return (p) => ig.ignores(path.relative(root, p));
}

function isCandidate(p) {
  return /\.(md|txt|json|ya?ml|proto|graphql|py|rs|go|ts|tsx|js|jsx|java|kt|cs|rb|php|cpp|c|sql)$/i.test(p);
}

function remapPathForSupportedUpload(relPath) {
  // Map unsupported extensions to a supported one
  if (relPath.toLowerCase().endsWith(".rs")) return relPath + ".txt";
  return relPath;
}

async function uploadWithPath(vectorStoreId, absPath, repoRoot) {
  const rel = path.relative(repoRoot, absPath).replaceAll("\\", "/");
  let contents = await fs.readFile(absPath, "utf8");

  // Belt-and-suspenders: embed original path in the content so retrieval shows provenance
  const header = `/* FILE: ${rel} */\n`;
  if (!contents.startsWith("/* FILE:")) contents = header + contents;

  const uploadName = remapPathForSupportedUpload(rel); // e.g., src/lib.rs -> src/lib.rs.txt
  const fileObj = await toFile(Buffer.from(contents, "utf8"), uploadName);

  // Two-step: Files API → attach to vector store (stable shape)
  const uploaded = await client.files.create({ file: fileObj, purpose: "assistants" });
  await client.vectorStores.files.create(vectorStoreId, { file_id: uploaded.id });
}

async function main(rootDir = process.argv[2] || ".") {
  const repoRoot = process.env.REPO_ROOT;
  const ignored = await loadIgnore(repoRoot);

  // Get every path under root (we handle ignores manually)
  const paths = await globby([`${repoRoot.replace(/\\/g, "/")}/**/*`], { dot: true });

  // Build the file list with async stat (no await inside Array.filter)
  const files = [];
  for (const p of paths) {
    if (ignored(p)) continue;
    try {
      const st = await fs.stat(p);
      if (st.isFile() && isCandidate(p)) files.push(p);
    } catch {
      // skip unreadable paths
    }
  }

  // 1) Create a vector store
  const vs = await client.vectorStores.create({
    name: `repo-${path.basename(repoRoot)}-${Date.now()}`
  });

  // 2) Upload files (no chunking/streaming)
  //    You can switch to Promise.all for concurrency; sequential is simpler & gentler on rate limits.
  let uploaded = 0;
  for (const f of files) {
    await uploadWithPath(vs.id, f, repoRoot);
    uploaded++;
    console.log(`Uploaded ${f} (${uploaded} of ${files.length})`);
  }

  console.log(`Vector store: ${vs.id}, files uploaded: ${uploaded}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
