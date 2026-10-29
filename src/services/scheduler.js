import { logger } from "../../config/logger.js";

/**
 * Planifie une tâche récurrente :
 * - Mode normal : exécution quotidienne à heure/minute fixe, du lundi au vendredi.
 * - Mode test : exécution toutes les `delta` secondes (toujours en sautant le week-end).
 *
 * @returns {Function} stop() — annule la planification.
 */
export function scheduleDailyTask(taskFn, hour = 0, minute = 0, delta = 0) {
  if (typeof taskFn !== "function") {
    throw new Error("Le premier paramètre doit être une fonction.");
  }

  let timer = null;
  let stopped = false;
  let running = false;

  function isWeekend(date) {
    const day = date.getDay();
    return day === 0 || day === 6;
  }

  function nextWeekdayAtTime(fromDate, h, m) {
    const next = new Date(fromDate);
    next.setSeconds(0, 0);
    next.setHours(h, m, 0, 0);

    if (next <= fromDate) {
      next.setDate(next.getDate() + 1);
      next.setHours(h, m, 0, 0);
    }

    while (isWeekend(next)) {
      next.setDate(next.getDate() + 1);
      next.setHours(h, m, 0, 0);
    }

    return next;
  }

  function nextWeekdayFrom(fromDate, secondsDelta) {
    const next = new Date(fromDate.getTime() + secondsDelta * 1000);
    while (isWeekend(next)) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }

  async function safeRunTask() {
    if (stopped) return;

    if (running) {
      logger.warn("[scheduler] Tâche déjà en cours, exécution ignorée.");
      return;
    }

    running = true;
    try {
      await Promise.resolve(taskFn());
    } catch (err) {
      logger.error(`[scheduler] Erreur pendant l'exécution de la tâche : ${err.message}`);
    } finally {
      running = false;
    }
  }

  function scheduleNext() {
    if (stopped) return;

    const now = new Date();

    if (!delta) {
      const next = nextWeekdayAtTime(now, hour, minute);
      const delay = Math.max(0, next.getTime() - now.getTime());

      logger.info(`[scheduler] Prochaine exécution : ${next.toLocaleString()} (dans ${Math.round(delay / 1000)}s)`);

      timer = setTimeout(async () => {
        await safeRunTask();
        scheduleNext();
      }, delay);

      return;
    }

    if (isWeekend(now)) {
      const next = nextWeekdayAtTime(now, now.getHours(), now.getMinutes());
      const delay = Math.max(0, next.getTime() - now.getTime());

      logger.info(`[scheduler] Week-end détecté. Reprise le ${next.toLocaleString()}.`);

      timer = setTimeout(() => scheduleNext(), delay);
      return;
    }

    const next = nextWeekdayFrom(now, delta);
    const delay = Math.max(0, next.getTime() - now.getTime());

    timer = setTimeout(async () => {
      await safeRunTask();
      scheduleNext();
    }, delay);
  }

  scheduleNext();

  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
