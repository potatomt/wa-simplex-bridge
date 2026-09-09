// pm2 process file:  pm2 start ecosystem.config.cjs
// Configuration is read from .env by the app itself (via dotenv), so this file
// holds no secrets and is safe to commit.
module.exports = {
  apps: [
    {
      name: 'wa-simplex-bridge',
      script: 'bridge.mjs',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      time: true,
    },
  ],
};
