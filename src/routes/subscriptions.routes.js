const express=require('express');
const prisma=require('../config/prisma');
const {auth,adminOnly}=require('../middleware/auth');
const {makeUpload,fileUrl}=require('../utils/upload');
const router=express.Router();
router.post('/payment-requests',auth,makeUpload('receipts','receipt'),async(req,res)=>{
 const {packageName,price}=req.body; if(!packageName||!price||!req.file)return res.status(400).json({message:'Missing fields'});
 res.json(await prisma.paymentRequest.create({data:{userId:req.user.id,packageName,price,receiptUrl:fileUrl(req,'receipts',req.file)}}));
});
router.get('/payment-requests',auth,adminOnly,async(req,res)=>res.json(await prisma.paymentRequest.findMany({orderBy:{id:'desc'},include:{user:true}})));
router.post('/payment-requests/:id/approve',auth,adminOnly,async(req,res)=>{
 const pr=await prisma.paymentRequest.update({where:{id:Number(req.params.id)},data:{status:'APPROVED',decidedAt:new Date()}});
 const months=pr.packageName.includes('سنة')?12:pr.packageName.includes('6')?6:1; const expiry=new Date(); expiry.setMonth(expiry.getMonth()+months);
 await prisma.subscription.create({data:{userId:pr.userId,expiryDate:expiry}});
 res.json({ok:true,expiryDate:expiry});
});
router.post('/payment-requests/:id/reject',auth,adminOnly,async(req,res)=>res.json(await prisma.paymentRequest.update({where:{id:Number(req.params.id)},data:{status:'REJECTED',decidedAt:new Date()}})));
router.get('/me',auth,async(req,res)=>res.json(await prisma.subscription.findFirst({where:{userId:req.user.id,status:'active',expiryDate:{gt:new Date()}},orderBy:{expiryDate:'desc'}})));
module.exports=router;
