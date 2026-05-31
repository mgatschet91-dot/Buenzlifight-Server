module.exports = {
  apps: [
    {
      name: 'meinort-api',
      script: 'index.js',
      cwd: './server-core',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '../logs/api-error.log',
      out_file: '../logs/api-out.log',
      merge_logs: true,
    },
    {
      name: 'meinort-client',
      script: 'node_modules/next/dist/bin/next',
      args: 'start',
      cwd: './mapGame',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 4466,
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '../logs/client-error.log',
      out_file: '../logs/client-out.log',
      merge_logs: true,
    },
  ],
};
