import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const candidates = [
  path.join(root, "node_modules", "react-pdf", "node_modules", "pdfjs-dist", "build", "pdf.worker.min.mjs"),
  path.join(root, "node_modules", "pdfjs-dist", "build", "pdf.worker.min.mjs"),
];

let source = "";
for (const candidate of candidates) {
  try {
    await fs.access(candidate);
    source = candidate;
    break;
  } catch {
    // continue
  }
}

if (!source) {
  throw new Error("Could not find pdf.worker.min.mjs in node_modules.");
}

const targetDir = path.join(root, "public");
const target = path.join(targetDir, "pdf.worker.min.mjs");
await fs.mkdir(targetDir, { recursive: true });
await fs.copyFile(source, target);
console.log(`Synced PDF worker: ${path.relative(root, source)} -> ${path.relative(root, target)}`);
