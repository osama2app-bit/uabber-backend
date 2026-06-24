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
    { id: 1, name: 'الفواكه' },
    { id: 2, name: 'الخضروات' },
    { id: 3, name: 'طعام المطعم' },
    { id: 4, name: 'الفطور' },
    { id: 5, name: 'الملابس' },
    { id: 6, name: 'الألعاب والترفيه' },
    { id: 7, name: 'الأنشطة والهوايات' },
    { id: 8, name: 'احتياجاتي الأساسية' },
    { id: 9, name: 'السوبر ماركت' },
  ];

  for (const category of categories) {
    await prisma.category.upsert({
      where: {
        id: category.id,
      },
      update: {},
      create: {
        id: category.id,
        name: category.name,
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