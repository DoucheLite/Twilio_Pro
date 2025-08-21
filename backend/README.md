# Backend for Twilio Voice

This service issues Twilio Voice access tokens and exposes APIs used by the frontend dialer.
- Runtime: Node.js + Express
- Env: .env at repo root (see keys below)
- Start: `cd backend && npm start`

## Required environment variables
- TWILIO_ACCOUNT_SID
- TWILIO_API_KEY
- TWILIO_API_SECRET
- TWILIO_TWIML_APP_SID
- TWILIO_VOICE_CALLER_ID

## Local dev
```bash
cd backend
npm install
npm start
# health
curl http://localhost:5001/healthz
# token
curl http://localhost:5001/api/token
```
