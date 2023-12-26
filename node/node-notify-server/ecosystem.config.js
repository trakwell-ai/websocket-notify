module.exports = {
  apps : [{
    script: '/notification/apex-websocket-notify-bundle-master/node/node-notify-server/server.js',
    watch: 'true',
  "env_development": {
      "NODE_ENV": "development"
  },
  "env_production" : {
       "NODE_ENV": "production"
  }
  }],
  deploy : {
    production : {
      user : 'root',
      host : '<RUN `curl ifconfig.me` OR ENTER KNOWN PUBLIC IP>',
      ref  : 'origin/master',
      repo : 'git@github.com:trakwell-ai/websocket-notify.git',
      path : '/notification/apex-websocket-notify-bundle-master/node/node-notify-server/',
      'post-deploy' : 'npm install && pm2 reload ecosystem.config.js --env production'
    }
  }
};
