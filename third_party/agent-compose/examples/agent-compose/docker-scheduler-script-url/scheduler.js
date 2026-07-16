scheduler.cron("daily-review", "0 9 * * *", function dailyReview() {
  return scheduler.agent("Review the current project state.");
});

function main(payload) {
  return { ok: true, payload };
}
