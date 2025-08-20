# Twilio Voice Dialer Troubleshooting Guide

## Fixed Issues

### ✅ CORS Configuration
- **Problem**: CORS errors blocking API calls from frontend to backend
- **Solution**: Updated CORS to allow all localhost origins with proper preflight handling
- **Status**: Fixed

### ✅ Device Call Handling
- **Problem**: `c.on is not a function` error when trying to make calls
- **Solution**: Fixed `device.connect()` to use async/await and proper Promise handling
- **Status**: Fixed

### ✅ Event Listener Attachment
- **Problem**: Call event listeners weren't being attached properly
- **Solution**: Attach listeners after the call Promise resolves
- **Status**: Fixed

## Current Issues to Address

### 🔧 TwiML App Configuration (Error 31005)

**Problem**: ConnectionError 31005 indicates TwiML App webhook URL configuration issue

**Required Setup**:
1. **Create TwiML App** in Twilio Console:
   - Go to Twilio Console → Voice → TwiML Apps
   - Create new TwiML App
   - Set Voice Request URL to: `http://localhost:5001/api/voice/outgoing`
   - Set HTTP Method to: `POST`

2. **Environment Variables** (add to `.env`):
   ```
   TWILIO_TWIML_APP_SID=your_twiml_app_sid_here
   CALLER_ID=your_twilio_phone_number_here
   ```

3. **Verify TwiML App Settings**:
   - Voice Request URL: `http://localhost:5001/api/voice/outgoing`
   - HTTP Method: `POST`
   - Status: Active

### 🔧 Public URL for Production

**For local development**: Use ngrok or similar to expose localhost
```bash
# Install ngrok
npm install -g ngrok

# Expose backend
ngrok http 5001

# Update TwiML App Voice URL to ngrok URL
# Example: https://abc123.ngrok.io/api/voice/outgoing
```

## Testing Steps

### 1. Test Device Registration
```bash
# Backend smoke test
cd backend
npm run smoke
# Expected: Health: 200, Token: 200 ok
```

### 2. Test CORS (Direct API Calls)
- Open `test-cors.html` in browser
- Click "Test Token API"
- Expected: ✅ Success! Token received

### 3. Test Twilio SDK
- Open `test-sdk.html` in browser
- Expected: ✅ Twilio SDK loaded successfully!

### 4. Test Complete App
```bash
# Terminal 1: Backend
cd backend
npm start

# Terminal 2: Frontend
cd frontend
npm start
```

Visit `http://localhost:3000` and check:
- Device status: `offline` → `registering` → `ready`
- No CORS errors in browser console
- Call button enables when entering phone number

### 5. Test Call Initiation
1. Enter a valid phone number (e.g., `+1234567890`)
2. Click "Call" button
3. Check browser console for any errors
4. Check backend logs for TwiML requests

## Common Error Codes

### 31005 - ConnectionError
- **Cause**: TwiML App webhook URL not configured or unreachable
- **Solution**: Verify TwiML App Voice Request URL points to your backend

### 31208 - PermissionDeniedError
- **Cause**: Browser microphone permission denied
- **Solution**: Allow microphone access when prompted

### CORS Errors
- **Cause**: Cross-origin requests blocked
- **Solution**: Backend CORS now allows all localhost origins

## Debug Information

### Backend Logs
The backend now logs:
- CORS blocked origins
- TwiML request details
- TwiML response content
- Token generation success/failure

### Frontend Console
Check browser console for:
- Device registration status
- Call connection attempts
- Error messages with codes

## Environment Checklist

- [ ] `.env` file exists in project root
- [ ] `TWILIO_ACCOUNT_SID` set
- [ ] `TWILIO_API_KEY_SID` set
- [ ] `TWILIO_API_KEY_SECRET` set
- [ ] `TWILIO_TWIML_APP_SID` set (for outgoing calls)
- [ ] `CALLER_ID` set (for outgoing calls)
- [ ] TwiML App Voice URL configured
- [ ] Backend running on port 5001
- [ ] Frontend running on port 3000
- [ ] No firewall blocking localhost connections 