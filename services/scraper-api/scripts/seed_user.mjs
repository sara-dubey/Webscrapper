import bcrypt from "bcryptjs";
import { prisma } from "../src/db/prisma.js";

async function main() {
  const email = "test@test.com";
  const plain = "password123";

  const password = await bcrypt.hash(plain, 10);

  await prisma.userAccount.upsert({
    where: { email },
    update: { password },
    create: { email, password },
  });

  console.log("seeded:", email);
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
