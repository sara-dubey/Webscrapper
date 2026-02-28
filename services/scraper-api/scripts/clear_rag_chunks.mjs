import "dotenv/config";

import { prisma } from "../src/db/prisma.js";

async function main() {
  const before = await prisma.ragChunk.count();
  const deleted = await prisma.ragChunk.deleteMany({});
  const after = await prisma.ragChunk.count();

  console.log(`RAG chunks before: ${before}`);
  console.log(`Deleted rows: ${deleted.count}`);
  console.log(`RAG chunks after: ${after}`);
}

main()
  .catch((err) => {
    console.error(`[fatal] ${String(err?.message || err)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

