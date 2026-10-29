import express from "express";
import { apiKeyMiddleware } from "./middlewares/apiKey.middleware.js";
import { errorHandler } from "./middlewares/error.middleware.js";
import remindersRoutes from "./reminders/routes.js";

/** Application Express (sans listen ni tâche planifiée : cf. ../app.js). */
export const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));

app.get("/health", (req, res) => res.json({ status: "ok" }));
app.use("/api/reminders", apiKeyMiddleware, remindersRoutes);

app.use((req, res) =>
  res.status(404).json({ error: "NOT_FOUND", message: "Route inconnue." }),
);
app.use(errorHandler);
