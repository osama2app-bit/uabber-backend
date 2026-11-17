// مهام الخلفية في السيرفر (تعمل حتى لو كان التطبيق مغلقًا عند المستخدمين):
//   - توليد مواعيد جداول الأخصائيين (كل ساعة) ضمن مدة الاشتراك
//   - إرسال الإشعارات المستحقة وإعادة المحاولة (كل 30 ثانية) — انظر services/notifications
// تُعطّل بـ JOBS_DISABLED=1 (مثلًا في الاختبارات).
const prisma = require('../config/prisma');
const { syncAllSchedules } = require('../services/schedule');
const notifications = require('../services/notifications');

const jobs = [];

function every(name, ms, fn) {
  let running = false;
  const run = async () => {
    if (running) return; // لا تشغيل متداخل لنفس المهمة
    running = true;
    try {
      await fn();
    } catch (error) {
      console.error(`JOB ${name} FAILED:`, error.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, ms);
  timer.unref?.();
  jobs.push({ name, run, timer });
  setTimeout(run, 5000).unref?.();
}

function register(name, ms, fn) {
  if (process.env.JOBS_DISABLED === '1') return;
  every(name, ms, fn);
}

function startJobs() {
  register('schedules', Number(process.env.SCHEDULE_SYNC_MS || 60 * 60 * 1000), () => syncAllSchedules(prisma));
  // الإشعارات المستحقة (التذكير قبل الموعد بخمس دقائق يُرسل في وقته ±30 ثانية)
  register('notifications', Number(process.env.NOTIFICATIONS_TICK_MS || 30 * 1000), () => notifications.processDue());
  return jobs;
}

module.exports = { startJobs, register, jobs };
