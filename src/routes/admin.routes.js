const express=require('express');
const prisma=require('../config/prisma');
const {auth,adminOnly}=require('../middleware/auth');
const router=express.Router();
router.get('/users',auth,adminOnly,async(req,res)=>res.json(await prisma.user.findMany({orderBy:{id:'desc'},select:{id:true,fullName:true,email:true,role:true,isActive:true,trialExpiryDate:true,createdAt:true}})));
router.put('/users/:id/toggle',auth,adminOnly,async(req,res)=>{const u=await prisma.user.findUnique({where:{id:Number(req.params.id)}}); if(!u||u.role==='ADMIN')return res.status(400).json({message:'Cannot modify'}); res.json(await prisma.user.update({where:{id:u.id},data:{isActive:!u.isActive}}));});
router.get('/stats',auth,adminOnly,async(req,res)=>{
 const [users,activeUsers,categories,items,pendingSubscriptions,consultations]=await Promise.all([prisma.user.count(),prisma.user.count({where:{isActive:true}}),prisma.category.count(),prisma.item.count(),prisma.paymentRequest.count({where:{status:'PENDING'}}),prisma.consultation.count({where:{status:'NEW'}})]);
 res.json({users,activeUsers,categories,items,pendingSubscriptions,consultations});
});
module.exports=router;
