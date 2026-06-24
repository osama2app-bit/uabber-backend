const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();
async function main(){
 const expiry=new Date(); expiry.setFullYear(expiry.getFullYear()+10);
 const passwordHash=await bcrypt.hash('Admin@123',10);
 await prisma.user.upsert({where:{email:'admin@uabber.com'},update:{},create:{fullName:'مدير أُعبر',email:'admin@uabber.com',passwordHash,role:'ADMIN',trialExpiryDate:expiry}});
 console.log('Admin ready: admin@uabber.com / Admin@123');
}
main().finally(()=>prisma.$disconnect());
