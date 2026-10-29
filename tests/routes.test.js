import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// Ni AD ni SMTP réels : les deux services d'I/O sont simulés.
vi.mock("../src/services/ad.service.js", () => ({
  getPasswordExpirations: vi.fn(),
}));
vi.mock("../src/services/mail.service.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sendTemplatedMail: vi.fn(),
}));

const { getPasswordExpirations } = await import("../src/services/ad.service.js");
const { sendTemplatedMail } = await import("../src/services/mail.service.js");
const { app } = await import("../src/app.js");
const { runScheduledReminders } = await import("../src/reminders/controllers.js");

const account = (overrides = {}) => ({
  sAMAccountName: "jdupont",
  email: "jean.dupont@example.com",
  displayName: "Jean Dupont",
  givenName: "Jean",
  mustChangeAtNextLogon: false,
  isExpired: false,
  neverExpires: false,
  daysRemaining: 7,
  expiresAt: "2026-10-29T08:00:00.000Z",
  pwdLastSet: "2026-07-31T08:00:00.000Z",
  ...overrides,
});

let server;
let base;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server.close());

let n = 0;
beforeEach(() => {
  // Email unique par test : l'anti-doublon est en mémoire du module.
  n++;
  vi.mocked(sendTemplatedMail).mockResolvedValue({ messageId: "x" });
});

const post = (path, body, key = process.env.API_KEY) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
    body: JSON.stringify(body),
  });

describe("authentification", () => {
  it("refuse sans clé API", async () => {
    const res = await post("/api/reminders", {}, null);
    expect(res.status).toBe(401);
  });

  it("refuse une mauvaise clé API", async () => {
    const res = await post("/api/reminders", {}, "nope");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/reminders/user", () => {
  it("relance l'utilisateur, redirigé vers BASE_RECIPIENT_EMAIL hors prod", async () => {
    const email = `user${n}@x.fr`;
    vi.mocked(getPasswordExpirations).mockResolvedValue([account({ email })]);

    const res = await post("/api/reminders/user", { email: email.toUpperCase() });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ email, status: "expiring", result: "sent" });
    expect(getPasswordExpirations).toHaveBeenCalledWith({ email });
    const mail = vi.mocked(sendTemplatedMail).mock.calls[0][0];
    expect(mail.to).toBe(process.env.BASE_RECIPIENT_EMAIL);
    expect(mail.subject).toBe(`[DEV → ${email}] Votre mot de passe expire dans 7 jours`);
  });

  it("bloque une seconde relance immédiate (429)", async () => {
    const email = `user${n}@x.fr`;
    vi.mocked(getPasswordExpirations).mockResolvedValue([account({ email })]);

    expect((await post("/api/reminders/user", { email })).status).toBe(200);
    const res = await post("/api/reminders/user", { email });
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("PWD_REMINDER_TOO_RECENT");
  });

  it("404 si aucun compte AD", async () => {
    vi.mocked(getPasswordExpirations).mockResolvedValue([]);
    const res = await post("/api/reminders/user", { email: `nobody${n}@x.fr` });
    expect(res.status).toBe(404);
  });

  it("422 si le mot de passe n'expire jamais", async () => {
    const email = `never${n}@x.fr`;
    vi.mocked(getPasswordExpirations).mockResolvedValue([
      account({ email, neverExpires: true, daysRemaining: null }),
    ]);
    const res = await post("/api/reminders/user", { email });
    expect(res.status).toBe(422);
  });

  it("400 si l'email est invalide", async () => {
    const res = await post("/api/reminders/user", { email: "pas-un-email" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/reminders", () => {
  const accounts = () => [
    account({ email: `a${n}@x.fr`, daysRemaining: 3 }),
    account({ email: `b${n}@x.fr`, daysRemaining: 60 }),
    account({ email: `c${n}@x.fr`, isExpired: true, daysRemaining: -2 }),
  ];

  it("dryRun : liste sans rien envoyer", async () => {
    vi.mocked(getPasswordExpirations).mockResolvedValue(accounts());
    const res = await post("/api/reminders", { dryRun: true });
    const body = await res.json();

    expect(body).toMatchObject({ dryRun: true, days: 15, total: 2 });
    expect(sendTemplatedMail).not.toHaveBeenCalled();
  });

  it("envoie aux comptes concernés et continue malgré un échec SMTP", async () => {
    vi.mocked(getPasswordExpirations).mockResolvedValue(accounts());
    vi.mocked(sendTemplatedMail)
      .mockRejectedValueOnce(new Error("SMTP down"))
      .mockResolvedValue({ messageId: "x" });

    const body = await (await post("/api/reminders", { days: 5 })).json();

    expect(body).toMatchObject({ dryRun: false, total: 2, sent: 1, failed: 1 });
  });
});

describe("routes GET (dev, navigateur)", () => {
  it("dryRun avec la clé dans l'URL", async () => {
    vi.mocked(getPasswordExpirations).mockResolvedValue([
      account({ email: `g${n}@x.fr`, daysRemaining: 3 }),
    ]);
    const res = await fetch(
      `${base}/api/reminders?key=${process.env.API_KEY}&dryRun=true&days=5`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dryRun: true, days: 5, total: 1 });
    expect(sendTemplatedMail).not.toHaveBeenCalled();
  });

  it("relance un utilisateur via GET", async () => {
    const email = `gu${n}@x.fr`;
    vi.mocked(getPasswordExpirations).mockResolvedValue([account({ email })]);
    const res = await fetch(
      `${base}/api/reminders/user?key=${process.env.API_KEY}&email=${email}`,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).result).toBe("sent");
  });

  it("refuse sans clé", async () => {
    const res = await fetch(`${base}/api/reminders/user?email=a@x.fr`);
    expect(res.status).toBe(401);
  });
});

describe("tâche planifiée", () => {
  it("relance uniquement les paliers du jour", async () => {
    vi.mocked(getPasswordExpirations).mockResolvedValue([
      account({ email: `t15-${n}@x.fr`, daysRemaining: 15 }),
      account({ email: `t10-${n}@x.fr`, daysRemaining: 10 }),
    ]);
    const summary = await runScheduledReminders(new Date("2026-09-29T08:00:00"));
    expect(summary).toMatchObject({ total: 1, sent: 1 });
  });
});
