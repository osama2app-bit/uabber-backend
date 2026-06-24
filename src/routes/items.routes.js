const express=require('express');
const prisma=require('../config/prisma');
const {auth,adminOnly}=require('../middleware/auth');
const {makeUpload,fileUrl}=require('../utils/upload');
const multer=require('multer');
const path=require('path'); const fs=require('fs');
const router=express.Router();
function multiUpload(){
 ['images','audio'].forEach(f=>fs.mkdirSync(path.join(__dirname,'../../uploads',f),{recursive:true}));
 const storage=multer.diskStorage({destination:(req,file,cb)=>cb(null,path.join(__dirname,'../../uploads',file.fieldname==='audio'?'audio':'images')),filename:(_,file,cb)=>cb(null,`${Date.now()}-${Math.round(Math.random()*1e9)}${path.extname(file.originalname).toLowerCase()}`)});
 return multer({storage,limits:{fileSize:20*1024*1024}}).fields([{name:'image',maxCount:1},{name:'audio',maxCount:1}]);
}
router.get('/',auth,async(req,res)=>res.json(await prisma.item.findMany({where:{isActive:true},orderBy:{sortOrder:'asc'}})));
router.get('/category/:categoryId',auth,async(req,res)=>res.json(await prisma.item.findMany({where:{categoryId:Number(req.params.categoryId),isActive:true},orderBy:{sortOrder:'asc'}})));
router.get('/admin/all',auth,adminOnly,async(req,res)=>res.json(await prisma.item.findMany({orderBy:{id:'desc'},include:{category:true}})));
router.post('/',auth,adminOnly,multiUpload(),async(req,res)=>{
 const {categoryId,title,speechText,sortOrder}=req.body;
 if(!categoryId||!title||!speechText||!req.files?.image?.[0])return res.status(400).json({message:'categoryId, title, speechText, image required'});
 const imageUrl=fileUrl(req,'images',req.files.image[0]); const audioUrl=req.files?.audio?.[0]?fileUrl(req,'audio',req.files.audio[0]):null;
 res.json(await prisma.item.create({data:{categoryId:Number(categoryId),title,speechText,imageUrl,audioUrl,sortOrder:Number(sortOrder||0)}}));
});
router.put('/:id',auth,adminOnly,multiUpload(),async(req,res)=>{
 const data={}; ['categoryId','title','speechText','isActive','sortOrder'].forEach(k=>{if(req.body[k]!==undefined)data[k]=['categoryId','sortOrder'].includes(k)?Number(req.body[k]):k==='isActive'?req.body[k]==='true':req.body[k]});
 if(req.files?.image?.[0])data.imageUrl=fileUrl(req,'images',req.files.image[0]);
 if(req.files?.audio?.[0])data.audioUrl=fileUrl(req,'audio',req.files.audio[0]);
 res.json(await prisma.item.update({where:{id:Number(req.params.id)},data}));
});
router.delete('/:id',auth,adminOnly,async(req,res)=>{await prisma.item.delete({where:{id:Number(req.params.id)}});res.json({ok:true});});
module.exports=router;
