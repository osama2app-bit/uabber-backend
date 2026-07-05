const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function resetCategoryIdSequence() {
  // PostgreSQL sequence can become behind when old seed inserted fixed IDs.
  // This makes the next Category id greater than the current MAX(id).
  await prisma.$executeRawUnsafe(`
    SELECT setval(
      pg_get_serial_sequence('"Category"', 'id'),
      COALESCE((SELECT MAX(id) FROM "Category"), 1),
      true
    )
  `);
}

async function main() {
  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 10);

  const passwordHash = await bcrypt.hash('Admin@123', 10);

  await prisma.user.upsert({
    where: { email: 'admin@uabber.com' },
    update: {},
    create: {
      fullName: 'مدير أُعبر',
      email: 'admin@uabber.com',
      passwordHash,
      role: 'ADMIN',
      trialExpiryDate: expiry,
    },
  });

  const categories = [
    'الفواكه',
    'الخضروات',
    'طعام المطعم',
    'الفطور',
    'الملابس',
    'الألعاب والترفيه',
    'الأنشطة والهوايات',
    'احتياجاتي الأساسية',
    'السوبر ماركت',
  ];

  for (const name of categories) {
    const exists = await prisma.category.findFirst({ where: { name } });

    if (!exists) {
      await prisma.category.create({
        data: {
          name,
          isActive: true,
        },
      });
    }
  }

  await resetCategoryIdSequence();

  console.log('Admin ready');
  console.log('Categories ready');
}

main()
  .catch((error) => {
    console.error('Seed error:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
