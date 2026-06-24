const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const prisma = require('../config/prisma');
const { auth } = require('../middleware/auth');
const router = express.Router();
function sign(user){return jwt.sign({id:user.id,role:user.role},process.env.JWT_SECRET,{expiresIn:'30d'});}
router.post('/register', async (req,res)=>{
  const { fullName, email, password } = req.body;
  if(!fullName || !email || !password) return res.status(400).json({message:'Missing fields'});
  const exists = await prisma.user.findUnique({where:{email: email.toLowerCase()}});
  if(exists) return res.status(409).json({message:'Email already exists'});
  const expiry = new Date(); expiry.setDate(expiry.getDate()+30);
  const passwordHash = await bcrypt.hash(password,10);
  const user = await prisma.user.create({data:{fullName,email:email.toLowerCase(),passwordHash,trialExpiryDate:expiry}});
  res.json({token:sign(user), user:{id:user.id,fullName:user.fullName,email:user.email,role:user.role,trialExpiryDate:user.trialExpiryDate}});
});
router.post('/login', async (req,res)=>{
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({where:{email:String(email||'').toLowerCase()}});
  if(!user) return res.status(401).json({message:'Invalid credentials'});
  const ok = await bcrypt.compare(password||'', user.passwordHash);
  if(!ok) return res.status(401).json({message:'Invalid credentials'});
  if(!user.isActive) return res.status(403).json({message:'Account suspended'});
  res.json({token:sign(user), user:{id:user.id,fullName:user.fullName,email:user.email,role:user.role,trialExpiryDate:user.trialExpiryDate}});
});
router.get('/me', auth, async (req,res)=>res.json({user:{id:req.user.id,fullName:req.user.fullName,email:req.user.email,role:req.user.role,trialExpiryDate:req.user.trialExpiryDate}}));
module.exports = router;
