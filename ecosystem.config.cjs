// Une seule instance (fork) : l'anti-doublon et la tâche planifiée sont en
// mémoire process — plusieurs instances enverraient plusieurs fois les mails.
module.exports = {
  apps: [
    {
      name: "API RELAUNCH PWDEXP",
      script: "app.js",
      cwd: "./",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
