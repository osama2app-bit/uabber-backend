const express=require('express');
const prisma=require('../config/prisma');
const {auth,adminOnly}=require('../middleware/auth');
const {makeUpload,fileUrl}=require('../utils/upload');
const router=express.Router();
router.get('/',auth,async(req,res)=>res.json(await prisma.category.findMany({where:{isActive:true},orderBy:{sortOrder:'asc'},include:{items:{where:{isActive:true},orderBy:{sortOrder:'asc'}}}})));
router.get('/admin/all',auth,adminOnly,async(req,res)=>res.json(await prisma.category.findMany({orderBy:{id:'desc'}})));
router.post('/',auth,adminOnly,makeUpload('images','image'),async(req,res)=>{
 const {name,sortOrder}=req.body; if(!name)return res.status(400).json({message:'Name required'});
 const imageUrl=fileUrl(req,'images',req.file);
 res.json(await prisma.category.create({data:{name,imageUrl,sortOrder:Number(sortOrder||0)}}));
});
router.put('/:id',auth,adminOnly,makeUpload('images','image'),async(req,res)=>{
 const data={}; ['name','isActive','sortOrder'].forEach(k=>{if(req.body[k]!==undefined)data[k]=k==='isActive'?req.body[k]==='true':k==='sortOrder'?Number(req.body[k]):req.body[k]});
 if(req.file)data.imageUrl=fileUrl(req,'images',req.file);
 res.json(await prisma.category.update({where:{id:Number(req.params.id)},data}));
});
router.delete('/:id',auth,adminOnly,async(req,res)=>{await prisma.category.delete({where:{id:Number(req.params.id)}});res.json({ok:true});});
module.exports=router;
