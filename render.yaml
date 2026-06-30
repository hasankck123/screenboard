services:
  - type: web
    name: screenboard
    runtime: node
    plan: free
    buildCommand: npm install
    startCommand: npm start
    healthCheckPath: /healthz
    envVars:
      - key: NODE_ENV
        value: production
      - key: PRESENTER_PASSWORD
        sync: false
      - key: MAX_PRESENTERS
        value: "2"
