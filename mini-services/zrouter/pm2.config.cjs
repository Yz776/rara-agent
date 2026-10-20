/**
 * KRouter Production PM2 Configuration
 * 
 * Usage:
 *   pm2 start pm2.config.cjs
 *   pm2 save
 *   pm2 startup
 */

module.exports = {
  apps: [{
    name: 'krouter',
    script: './src/index.ts',
    interpreter: 'C:\\nvm4w\\nodejs\\node_modules\\bun\\bin\\bun.exe',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    
    // Environment variables
    env: {
      NODE_ENV: 'production',
      PORT: 3333,
    },
    
    // Error handling
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: './logs/krouter-error.log',
    out_file: './logs/krouter-out.log',
    
    // Logging
    min_uptime: '10s',
    max_restarts: 10,
    restart_delay: 4000,
    
    // Process manager settings
    wait_ready: false,
    listen_timeout: 10000,
    
    cwd: __dirname,
  }],
  
  // Ecosystem file metadata
  meta: {
    version: '2.0.0',
    description: 'KRouter AI Gateway - Production Deployment',
    author: 'Your Name',
  },
};
