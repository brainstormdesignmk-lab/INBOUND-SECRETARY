module.exports = {
  apps: [
    {
      name: 'metropolis-lina',
      script: './dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '300M',
      restart_delay: 3000,
      env: { NODE_ENV: 'production' },
    },
  ],
};
