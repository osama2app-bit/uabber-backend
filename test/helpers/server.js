// أدوات مشتركة لاختبارات التكامل: تشغيل السيرفر الحقيقي على قاعدة اختبار وإنشاء بيانات.
const { spawn } = require('node:child_process');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const DB_URL = process.env.TEST_DATABASE_URL;
const SECRET = 'helper-test-secret';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer(env = {}) {
  const port = 30000 + Math.floor(Math.random() * 25000);
  const proc = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), DATABASE_URL: DB_URL, JWT_SECRET: SECRET, JOBS_DISABLED: '1', ...env },
    stdio: ['ignore', 'ignore', process.env.TEST_SERVER_LOGS ? 'inherit' : 'ignore'],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 75; i += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch (_) {}
    await wait(200);
  }
  const call = async (method, url, token, body) => {
    if (method === 'GET' || method === 'HEAD') body = undefined;
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    const response = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(isForm || !body ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: isForm ? body : body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  return { proc, base, call, stop: () => proc.kill() };
}

/** بيانات اختبار معزولة بوسم فريد، مع تنظيف كامل في النهاية. */
function fixtures(prisma, tag) {
  const ids = { users: [], profiles: [] };
  return {
    ids,
    async user(name, role = 'USER') {
      const u = await prisma.user.create({
        data: {
          fullName: name,
          email: `${tag}${name}@example.com`,
          passwordHash: 'x',
          role,
          trialExpiryDate: new Date(Date.now() + 86400000),
        },
      });
      ids.users.push(u.id);
      return { ...u, token: jwt.sign({ id: u.id }, SECRET) };
    },
    async specialist(name, { days = 30, specialty = 'speech' } = {}) {
      const u = await this.user(name);
      const p = await prisma.specialistProfile.create({
        data: {
          userId: u.id,
          displayName: `د. ${name}`,
          specialty,
          status: 'APPROVED',
          subscriptionExpiry: days ? new Date(Date.now() + days * 86400000) : null,
        },
      });
      ids.profiles.push(p.id);
      return { user: u, profile: p, token: u.token };
    },
    async cleanup() {
      const profiles = ids.profiles;
      await prisma.consultation.deleteMany({ where: { OR: [{ userId: { in: ids.users } }, { specialistProfileId: { in: profiles } }] } });
      await prisma.specialistAvailability.deleteMany({ where: { specialistProfileId: { in: profiles } } });
      await prisma.specialistSchedule.deleteMany({ where: { specialistProfileId: { in: profiles } } });
      await prisma.specialistProfile.deleteMany({ where: { id: { in: profiles } } });
      await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
    },
  };
}

module.exports = { DB_URL, startServer, fixtures, wait };
