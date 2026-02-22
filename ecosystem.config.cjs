module.exports = {
  apps: [
    {
      name: 'calculator-demo',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        PORT: 3080
      }
    }
  ]
};
