const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const expiry = new Date();
  expiry.setFullYear(expiry.getFullYear() + 10);

  const passwordHash = await bcrypt.hash('Admin@123', 10);

  await prisma.user.upsert({
    where: {
      email: 'admin@uabber.com',
    },
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
    await prisma.category.upsert({
      where: { name },
      update: {},
      create: {
        name,
        isActive: true,
      },
    });
  }

  console.log('Admin ready');
  console.log('Categories ready');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());