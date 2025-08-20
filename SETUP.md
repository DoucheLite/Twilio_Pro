# Twilio Voice Dialer Setup Guide

## Environment Variables Required

Create a `.env` file in the project root with the following variables:

### Required for Device Registration (Token Generation)
```
TWILIO_ACCOUNT_SID=your_account_sid_here
TWILIO_API_KEY_SID=your_api_key_sid_here
TWILIO_API_KEY_SECRET=your_api_key_secret_here
```

### Optional: For Outgoing Calls to Real Phone Numbers
```
TWILIO_TWIML_APP_SID=your_twiml_app_sid_here
CALLER_ID=your_twilio_phone_number_here
```

### Optional: For Webhook Signature Validation
```
TWILIO_AUTH_TOKEN=your_auth_token_here
PUBLIC_BASE_URL=https://yourdomain.com
```

### Optional: Configuration
```
CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
TOKEN_TTL_SECONDS=3600
PORT=5001
```

## How to Get Twilio Credentials

1. **Account SID**: Found in your Twilio Console dashboard
2. **API Key SID & Secret**: Create in Twilio Console → Settings → API Keys
3. **Twiml App SID**: Create in Twilio Console → Voice → TwiML Apps
4. **Caller ID**: Your verified Twilio phone number

## Testing the Setup

### 1. Test Backend
```bash
cd backend
npm run smoke
```
Expected output: `Health: 200`, `Token: 200 ok`

### 2. Test CORS (Direct API Calls)
Open `test-cors.html` in your browser and click "Test Token API"

### 3. Test Twilio SDK
Open `test-sdk.html` in your browser to verify SDK loads

### 4. Test Complete App
```bash
# Terminal 1: Start backend
cd backend
npm start

# Terminal 2: Start frontend  
cd frontend
npm start
```

Visit `http://localhost:3000` and check:
- Device status shows "ready"
- No CORS errors in browser console
- Call button enables when entering a phone number

## Troubleshooting

### CORS Errors
- Backend CORS is configured to allow `localhost:3000`
- Frontend now makes direct API calls to `http://localhost:5001`
- Proxy is disabled in favor of direct calls

### Device Stuck on "offline"
- Check that `.env` file exists with required credentials
- Verify token endpoint returns 200 in backend logs
- Check browser console for JavaScript errors

### Twilio SDK Not Loading
- Verify `frontend/public/twilio.min.js` exists and is valid
- Check browser console for script loading errors 