import "./config/env.js"; // doit rester le premier import
import { logger } from "./config/logger.js";
import { app } from "./src/app.js";
import { runScheduledReminders } from "./src/reminders/controllers.js";
import { getReminderConfig } from "./src/reminders/utils.js";
import { scheduleDailyTask } from "./src/services/scheduler.js";

const IS_PROD = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT) || 3001;

app.listen(port, () => {
  logger.info(
    `[APP] api.relaunch.pwdexp démarrée sur le port ${port} (${process.env.NODE_ENV || "development"}).`,
  );
});

// Relance automatique (jours ouvrés) : paliers PWD_REMINDER_TIERS + expirés.
// Production uniquement, pour ne jamais relancer de vrais comptes depuis un
// poste de dev.
const cfg = getReminderConfig();
if (IS_PROD && cfg.scheduleEnabled) {
  scheduleDailyTask(
    () => runScheduledReminders(),
    cfg.scheduleHour,
    cfg.scheduleMinute,
  );
} else {
  logger.info(
    "[APP] Relance automatique désactivée (hors production ou PWD_REMINDER_SCHEDULE_ENABLED=false).",
  );
}
