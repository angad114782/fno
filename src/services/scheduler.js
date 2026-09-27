// Mon-Fri DAILY_REPORT_TIME (report timezone) pe Telegram day report.
const config = require('../config/env');
const notifier = require('./notifier');
const { sendDayReport } = require('./reportService');

function startScheduler() {
  const at = config.dailyReportTime;
  if (!at || !notifier.enabled()) return null;
  if (!/^\d{2}:\d{2}$/.test(at)) {
    console.warn(`Invalid DAILY_REPORT_TIME "${at}", expected HH:MM`);
    return null;
  }
  let lastSent = null;
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const timer = setInterval(async () => {
    const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
    const hhmm = `${parts.hour}:${parts.minute}`;
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    if (['Sat', 'Sun'].includes(parts.weekday) || hhmm !== at || lastSent === day) return;
    lastSent = day;
    try {
      await sendDayReport(day);
    } catch (err) {
      console.error('Daily report failed:', err.message);
    }
  }, 30 * 1000);
  timer.unref();
  console.log(`Daily Telegram report scheduled at ${at} (${config.timezone})`);
  return timer;
}

module.exports = { startScheduler };
