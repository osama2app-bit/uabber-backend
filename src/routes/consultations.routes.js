const express=require('express');
const prisma=require('../config/prisma');
const {auth,adminOnly}=require('../middleware/auth');
const router=express.Router();
router.post('/',auth,async(req,res)=>{
 const {specialist,message,date,time}=req.body; if(!specialist)return res.status(400).json({message:'Specialist required'});
 res.json(await prisma.consultation.create({data:{userId:req.user.id,userName:req.user.fullName,userEmail:req.user.email,specialist,message,date,time}}));
});
router.get('/',auth,adminOnly,async(req,res)=>res.json(await prisma.consultation.findMany({orderBy:{id:'desc'}})));
router.put('/:id/status',auth,adminOnly,async(req,res)=>res.json(await prisma.consultation.update({where:{id:Number(req.params.id)},data:{status:req.body.status,date:req.body.date,time:req.body.time}})));
module.exports=router;
